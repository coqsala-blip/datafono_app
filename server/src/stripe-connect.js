const crypto = require('node:crypto');
const { Buffer } = require('node:buffer');
const { resolveConnectMode } = require('./stripe-connect-env');

const ACCOUNT_ID = /^acct_[A-Za-z0-9]+$/;
const INCLUDE = ['configuration.merchant', 'configuration.customer', 'configuration.recipient',
  'defaults', 'requirements', 'identity'];
const MERCHANT_RECIPIENT_CONFIG = {
  customer: {},
  merchant: { capabilities: { card_payments: { requested: true } } },
  // Necesario para Checkout/Terminal destination (transfer_data / on_behalf_of).
  recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } },
};
// Alta inicial sin recipient: en live Stripe a veces rechaza merchant+recipient juntos
// si la plataforma Connect aún no tiene recipient habilitado. El recipient se añade después.
const MERCHANT_CREATE_CONFIG = {
  customer: {},
  merchant: { capabilities: { card_payments: { requested: true } } },
};
const EU_COUNTRIES = new Set('AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE'.split(' '));
const STATE_TTL = 30 * 60 * 1000;
const RETRY_WINDOW = 23 * 60 * 60 * 1000;
const fail = (status, code) => Object.assign(new Error(code), { status, code });
const principal = (user) => Boolean(user?.id &&
  (user.app_metadata?.role === undefined || user.app_metadata?.role === 'principal') &&
  (!user.app_metadata?.company_owner_id || user.app_metadata.company_owner_id === user.id));

module.exports = function createStripeConnect({ env, fetchAuthoritativeUser, updateUserAppMetadata, withAccountLock,
  stripeFactory = (key) => require('stripe')(key), now = Date.now }) {
  let client;
  let clientKey;
  const connectMode = () => resolveConnectMode(env);
  const enabled = () => connectMode().enabled === true;
  const expectLivemode = () => Boolean(connectMode().livemode);
  const config = () => {
    const mode = connectMode();
    if (!mode.enabled) {
      if (mode.code === 'connect_mode_ambiguous') throw fail(503, 'connect_mode_ambiguous');
      if (mode.code === 'connect_live_key_invalid') throw fail(503, 'connect_live_key_invalid');
      if (mode.code === 'connect_test_key_invalid') throw fail(503, 'connect_test_key_invalid');
      throw fail(503, 'connect_test_disabled');
    }
    const approved = String(mode.countries ?? 'ES').split(',').map((country) => country.trim());
    // Entradas vacías (p. ej. "ES,") o códigos no UE → inválido.
    if (!approved.length || approved.some((country) => !country || !EU_COUNTRIES.has(country))) {
      throw fail(503, 'connect_country_config_invalid');
    }
    if (typeof env.STRIPE_CONNECT_STATE_SECRET !== 'string' || Buffer.byteLength(env.STRIPE_CONNECT_STATE_SECRET) < 32) {
      throw fail(503, 'connect_state_secret_missing');
    }
    let origin;
    try {
      origin = new URL(env.PUBLIC_API_URL);
      if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash ||
        (origin.pathname !== '/' && origin.pathname !== '')) throw new Error();
    } catch {
      throw fail(503, 'connect_public_origin_invalid');
    }
    return origin.origin;
  };
  const stripe = () => {
    config();
    const mode = connectMode();
    if (!client || clientKey !== mode.secretKey) {
      clientKey = mode.secretKey;
      client = stripeFactory(mode.secretKey);
    }
    return client;
  };
  const save = async (ownerId, patch) => {
    const result = await updateUserAppMetadata(ownerId, patch);
    if (result?.error || !result?.data?.user) throw fail(503, 'connect_binding_unavailable');
    return result.data.user;
  };
  const freshActor = async (req) => {
    const actor = await fetchAuthoritativeUser(req.user?.id);
    if (!actor || !req.authSessionId || actor.app_metadata?.active_session_id !== req.authSessionId) {
      throw fail(401, 'connect_session_invalid');
    }
    return actor;
  };
  const ownerFor = async (actor, write = false) => {
    if (principal(actor)) return actor;
    const ownerId = actor?.app_metadata?.company_owner_id;
    if (write || actor?.app_metadata?.role !== 'empleado' || !ownerId || ownerId === actor.id) {
      throw fail(403, 'connect_principal_required');
    }
    const owner = await fetchAuthoritativeUser(ownerId);
    if (!principal(owner)) throw fail(403, 'connect_company_invalid');
    return owner;
  };
  const boundCountry = (owner) => {
    const metadata = owner.app_metadata || {};
    if (metadata.stripe_connect_test_country !== undefined) return metadata.stripe_connect_test_country;
    const pending = metadata.stripe_connect_test_creation;
    return pending?.country === undefined ? 'ES' : pending.country;
  };
  const checkAccount = (account, owner, expectedId, country = boundCountry(owner)) => {
    if (!account || !ACCOUNT_ID.test(account.id) || (expectedId && account.id !== expectedId)) {
      throw fail(409, 'connect_account_binding_invalid');
    }
    // Cuenta de test con clave live (o al revés): hay que recrear, no dejar 502 genérico.
    if (account.livemode !== expectLivemode()) throw fail(409, 'connect_account_mode_mismatch');
    if (account.metadata?.supabase_owner_id !== owner.id || account.dashboard !== 'full' ||
      account.defaults?.responsibilities?.fees_collector !== 'stripe' ||
      account.defaults?.responsibilities?.losses_collector !== 'stripe') {
      throw fail(409, 'connect_account_binding_invalid');
    }
    if (!EU_COUNTRIES.has(country) || account.identity?.country !== country) throw fail(409, 'connect_country_mismatch');
    return account;
  };
  const isInaccessibleStripeAccount = (error) => {
    if (!error || error.status) return false;
    const code = String(error.code || '');
    const type = String(error.type || '');
    const message = String(error.message || '');
    // Cuenta de otra plataforma / clave sin permiso / cuenta borrada → recrear alta.
    return code === 'resource_missing' || code === 'account_invalid' || code === 'forbidden'
      || type === 'StripePermissionError'
      || /no such account/i.test(message)
      || /permission denied/i.test(message)
      || /does not have permission to access account/i.test(message);
  };
  const isStaleConnectBinding = (error) =>
    error?.code === 'connect_account_mode_mismatch' || isInaccessibleStripeAccount(error);
  const clearStaleConnectBinding = async (ownerId) => save(ownerId, {
    stripe_connect_test_account_id: null,
    stripe_connect_test_creation: null,
    stripe_connect_test_country: null,
    stripe_connect_test_terminal_location_id: null,
    stripe_connect_test_platform_terminal_location_id: null,
    stripe_connect_test_state_nonce: null,
  });
  const retrieve = async (owner, accountId, country = boundCountry(owner)) => {
    if (!ACCOUNT_ID.test(accountId || '')) throw fail(409, 'connect_account_binding_invalid');
    let account;
    try {
      account = await stripe().v2.core.accounts.retrieve(accountId, { include: INCLUDE });
    } catch (error) {
      if (isInaccessibleStripeAccount(error)) throw fail(409, 'connect_account_mode_mismatch');
      throw error;
    }
    return checkAccount(account, owner, accountId, country);
  };
  /** Cuenta guardada usable, o null si había binding de otro modo (test↔live) y se limpió. */
  const resolveStoredAccount = async (owner, country = boundCountry(owner)) => {
    const accountId = owner.app_metadata?.stripe_connect_test_account_id;
    if (accountId == null || accountId === '') return { owner, account: null };
    if (!ACCOUNT_ID.test(accountId)) {
      console.error('Stripe Connect: clearing invalid account id', String(accountId).slice(0, 24));
      return { owner: await clearStaleConnectBinding(owner.id), account: null };
    }
    try {
      return { owner, account: await retrieve(owner, accountId, country) };
    } catch (error) {
      if (!isStaleConnectBinding(error)) throw error;
      console.error('Stripe Connect: clearing stale account binding', accountId, error?.code || '');
      const cleared = await clearStaleConnectBinding(owner.id);
      return { owner: cleared, account: null };
    }
  };
  const summary = (isEnabled, account = null) => {
    const capabilities = account?.configuration?.merchant?.capabilities;
    const livemode = isEnabled ? expectLivemode() : false;
    return {
      ok: true, enabled: isEnabled, livemode, connected: Boolean(account), accountId: account?.id || null,
      chargesEnabled: capabilities?.card_payments?.status === 'active',
      payoutsEnabled: capabilities?.stripe_balance?.payouts?.status === 'active',
      requirementsPending: Boolean(account && (!account.requirements || !Array.isArray(account.requirements.entries) ||
        account.requirements.entries.length || account.requirements.summary?.minimum_deadline?.status ||
        capabilities?.card_payments?.status !== 'active' || capabilities?.stripe_balance?.payouts?.status !== 'active')),
      // Con Connect activo los cobros online van a la cuenta conectada (sin fallback a plataforma).
      directCharges: isEnabled,
      phase: livemode ? 'connect_live' : 'onboarding_only',
    };
  };
  // Resuelve la cuenta conectada del principal para cobros/consultas.
  // null = Connect desactivado (ruta legacy de plataforma). Con Connect activo nunca cae a plataforma.
  const resolveConnectedAccount = async (req, { requireCharges = false } = {}) => {
    if (!enabled()) return null;
    config();
    const actor = await freshActor(req);
    const owner = await ownerFor(actor);
    const resolved = await resolveStoredAccount(owner);
    if (!resolved.account) throw fail(409, 'connect_not_connected');
    const status = summary(true, resolved.account);
    if (requireCharges && !status.chargesEnabled) throw fail(409, 'connect_charges_not_enabled');
    return {
      accountId: resolved.account.id,
      stripe: stripe(),
      ownerId: resolved.owner.id,
      status,
      owner: resolved.owner,
    };
  };
  // Dirección placeholder válida por país (Stripe valida CP; ES/IT/US exigen state/provincia).
  const terminalAddressFor = (country) => {
    if (country === 'ES') {
      // Stripe Terminal ES: line1, city, state, postal_code, country (state = provincia).
      return { line1: 'Calle Provisional 1', city: 'Madrid', state: 'Madrid', postal_code: '28001', country: 'ES' };
    }
    if (country === 'PT') {
      return { line1: 'Rua Provisoria 1', city: 'Lisboa', postal_code: '1000-001', country: 'PT' };
    }
    if (country === 'IT') {
      return { line1: 'Via Provvisoria 1', city: 'Roma', state: 'RM', postal_code: '00118', country: 'IT' };
    }
    return { line1: 'Provisional street 1', city: 'City', postal_code: '10115', country };
  };
  // Ubicación Terminal en la cuenta conectada (Tap to Pay / lectores). Se crea una vez y se reutiliza.
  const ensureTerminalLocation = async (owner, accountId) => {
    const metadata = owner.app_metadata || {};
    const existing = metadata.stripe_connect_test_terminal_location_id;
    if (typeof existing === 'string' && /^tml_[A-Za-z0-9]+$/.test(existing)) {
      try {
        await stripe().terminal.locations.retrieve(existing, {}, { stripeAccount: accountId });
        return existing;
      } catch {
        // Se recrea si la ubicación ya no existe en la cuenta conectada.
      }
    }
    // Reutilizar una ubicación ya creada en la cuenta conectada.
    try {
      const listed = await stripe().terminal.locations.list({ limit: 5 }, { stripeAccount: accountId });
      const found = Array.isArray(listed?.data) ? listed.data.find((item) => /^tml_[A-Za-z0-9]+$/.test(item?.id || '')) : null;
      if (found) {
        await save(owner.id, { stripe_connect_test_terminal_location_id: found.id });
        return found.id;
      }
    } catch (error) {
      console.warn('Stripe Terminal locations.list (connected) failed:', error?.code || '', error?.message || error);
    }
    const country = boundCountry(owner);
    const rawName = typeof owner.user_metadata?.full_name === 'string' && owner.user_metadata.full_name.trim()
      ? owner.user_metadata.full_name.trim()
      : 'TPV';
    const displayName = rawName.replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 100) || 'TPV';
    let location;
    try {
      location = await stripe().terminal.locations.create({
        display_name: displayName,
        address: terminalAddressFor(country),
      }, { stripeAccount: accountId });
    } catch (error) {
      console.error('Stripe Terminal location create failed:', error?.code || '', error?.message || error);
      const detail = typeof error?.message === 'string' ? error.message.slice(0, 180) : '';
      throw Object.assign(fail(502, 'connect_terminal_location_invalid'), { detail });
    }
    if (typeof location?.id !== 'string' || !/^tml_[A-Za-z0-9]+$/.test(location.id)) {
      throw fail(502, 'connect_terminal_location_invalid');
    }
    await save(owner.id, { stripe_connect_test_terminal_location_id: location.id });
    return location.id;
  };
  // Capacidades v1 locales EUR (plataforma/comercio). Pedir todas; Stripe ignora las no aplicables.
  const localCapabilitiesForCountry = (_country) => ({
    bizum_payments: { requested: true },
    bancontact_payments: { requested: true },
    ideal_payments: { requested: true },
    eps_payments: { requested: true },
    blik_payments: { requested: true },
  });
  // Solicita recipient/transfers (v2) + capacidades v1 (Bizum/locales, transfers) en la cuenta conectada.
  const ensureConnectedCapabilities = async (accountId, country) => {
    try {
      await stripe().v2.core.accounts.update(accountId, {
        configuration: {
          recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } },
          merchant: { capabilities: { card_payments: { requested: true } } },
        },
        include: INCLUDE,
      });
    } catch (error) {
      console.warn('No se pudo actualizar recipient/transfers v2:', error?.code || '', error?.message || error);
    }
    const capabilities = {
      card_payments: { requested: true },
      transfers: { requested: true },
      ...localCapabilitiesForCountry(country),
    };
    try {
      await stripe().accounts.update(accountId, { capabilities });
    } catch (error) {
      console.warn('No se pudieron solicitar capacidades Connect v1:', error?.code || '', error?.message || error);
    }
  };
  // Activa Bizum / MB WAY / Bancontact… en la PMC de la cuenta conectada (QR con on_behalf_of).
  const ensureConnectedLocalPaymentMethods = async (accountId, country) => {
    const supported = new Set(['ES', 'PT', 'BE', 'NL', 'AT', 'DE', 'FR', 'IT', 'PL']);
    if (!supported.has(country)) return;
    await ensureConnectedCapabilities(accountId, country);
    try {
      const listed = await stripe().paymentMethodConfigurations.list({ limit: 10 }, { stripeAccount: accountId });
      const items = Array.isArray(listed?.data) ? listed.data : [];
      const configuration = items.find((item) => item?.is_default === true)
        || items.find((item) => item?.active !== false)
        || items[0];
      if (!configuration?.id) return;
      // Todos los locales EUR en la cuenta conectada (Checkout destination usa PMC plataforma).
      const patch = {
        card: { display_preference: { preference: 'on' } },
        bizum: { display_preference: { preference: 'on' } },
        mb_way: { display_preference: { preference: 'on' } },
        bancontact: { display_preference: { preference: 'on' } },
        ideal: { display_preference: { preference: 'on' } },
        eps: { display_preference: { preference: 'on' } },
        wero: { display_preference: { preference: 'on' } },
        blik: { display_preference: { preference: 'on' } },
      };
      await stripe().paymentMethodConfigurations.update(configuration.id, patch, { stripeAccount: accountId });
    } catch (error) {
      console.warn('No se pudo activar métodos locales en la cuenta Connect:', error?.code || '', error?.message || error);
    }
  };
  const EUR_LOCAL_PMC_NAME = 'TPV QR locales EUR';
  const eurLocalPmcPatch = () => ({
    // Sin tarjeta: el QR es solo apps locales (Bizum, MB WAY, Bancontact…).
    card: { display_preference: { preference: 'off' } },
    bizum: { display_preference: { preference: 'on' } },
    mb_way: { display_preference: { preference: 'on' } },
    bancontact: { display_preference: { preference: 'on' } },
    ideal: { display_preference: { preference: 'on' } },
    eps: { display_preference: { preference: 'on' } },
    wero: { display_preference: { preference: 'on' } },
    blik: { display_preference: { preference: 'on' } },
  });

  // PMC dedicada al QR TPV (card off + todos los locales EUR on). Devuelve id + disponibilidad.
  const ensurePlatformLocalPaymentMethods = async (country) => {
    try {
      try {
        const platform = await stripe().accounts.retrieve();
        if (platform?.id) {
          await stripe().accounts.update(platform.id, {
            capabilities: {
              card_payments: { requested: true },
              ...localCapabilitiesForCountry(country),
            },
          });
        }
      } catch (capError) {
        console.warn('Capacidades plataforma Connect:', capError?.code || '', capError?.message || capError);
      }
      const listed = await stripe().paymentMethodConfigurations.list({ limit: 20 });
      const items = Array.isArray(listed?.data) ? listed.data : [];
      let configuration = items.find((item) => String(item?.name || '') === EUR_LOCAL_PMC_NAME)
        || items.find((item) => String(item?.name || '').toLowerCase().includes('tpv qr'));
      if (!configuration?.id) {
        try {
          configuration = await stripe().paymentMethodConfigurations.create({
            name: EUR_LOCAL_PMC_NAME,
            ...eurLocalPmcPatch(),
          });
        } catch (createError) {
          console.warn('No se pudo crear PMC TPV QR; se usa la default:', createError.message);
          configuration = items.find((item) => item?.is_default === true)
            || items.find((item) => item?.active !== false)
            || items[0];
        }
      }
      if (!configuration?.id) return null;
      const updated = await stripe().paymentMethodConfigurations.update(
        configuration.id,
        eurLocalPmcPatch(),
      );
      const availability = {
        bizum: updated?.bizum?.available ?? null,
        mb_way: updated?.mb_way?.available ?? null,
        bancontact: updated?.bancontact?.available ?? null,
        ideal: updated?.ideal?.available ?? null,
        eps: updated?.eps?.available ?? null,
        wero: updated?.wero?.available ?? null,
        blik: updated?.blik?.available ?? null,
      };
      console.log('PMC TPV QR locales EUR:', { id: configuration.id, ...availability });
      return { id: configuration.id, availability };
    } catch (error) {
      console.warn('No se pudo activar métodos locales en la plataforma Connect:', error?.code || '', error?.message || error);
      return null;
    }
  };
  // Ubicación Terminal en la plataforma Connect (sin Stripe-Account). Sirve para destination/on_behalf_of.
  const ensurePlatformTerminalLocation = async (owner) => {
    const metadata = owner.app_metadata || {};
    const existing = metadata.stripe_connect_test_platform_terminal_location_id;
    if (typeof existing === 'string' && /^tml_[A-Za-z0-9]+$/.test(existing)) {
      try {
        await stripe().terminal.locations.retrieve(existing);
        return existing;
      } catch {
        // tml_ obsoleto (p. ej. tras cambiar de cuenta plataforma): se limpia y recrea.
        try {
          await save(owner.id, { stripe_connect_test_platform_terminal_location_id: null });
        } catch {
          // no bloquea
        }
      }
    }
    // Reutilizar una Location ya existente en la plataforma (evita fallos al recrear).
    try {
      const listed = await stripe().terminal.locations.list({ limit: 10 });
      const found = Array.isArray(listed?.data)
        ? listed.data.find((item) => /^tml_[A-Za-z0-9]+$/.test(item?.id || ''))
        : null;
      if (found) {
        await save(owner.id, { stripe_connect_test_platform_terminal_location_id: found.id });
        return found.id;
      }
    } catch (error) {
      console.warn('Stripe Terminal locations.list (platform) failed:', error?.code || '', error?.message || error);
    }
    const country = boundCountry(owner);
    const rawName = typeof owner.user_metadata?.full_name === 'string' && owner.user_metadata.full_name.trim()
      ? owner.user_metadata.full_name.trim()
      : 'TPV Connect';
    const displayName = rawName.replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 100) || 'TPV Connect';
    let location;
    try {
      location = await stripe().terminal.locations.create({
        display_name: displayName,
        address: terminalAddressFor(country),
      });
    } catch (error) {
      console.error('Stripe Terminal platform location create failed:', error?.code || '', error?.message || error);
      const detail = typeof error?.message === 'string' ? error.message.slice(0, 220) : '';
      throw Object.assign(fail(502, 'connect_terminal_location_invalid'), { detail });
    }
    if (typeof location?.id !== 'string' || !/^tml_[A-Za-z0-9]+$/.test(location.id)) {
      throw fail(502, 'connect_terminal_location_invalid');
    }
    await save(owner.id, { stripe_connect_test_platform_terminal_location_id: location.id });
    return location.id;
  };
  const resolveTerminalContext = async (req) => {
    const connected = await resolveConnectedAccount(req, { requireCharges: true });
    if (!connected) return null;
    // Tap to Pay + Connect: ubicación y ConnectionToken en la plataforma Connect;
    // el PaymentIntent usa on_behalf_of + transfer_data hacia la cuenta conectada.
    // Crear Location en la cuenta conectada suele fallar en cuentas nuevas / test.
    await ensureConnectedCapabilities(connected.accountId, boundCountry(connected.owner));
    const locationId = await ensurePlatformTerminalLocation(connected.owner);
    return { ...connected, locationId, terminalMode: 'destination' };
  };
  const sign = (payload) => crypto.createHmac('sha256', env.STRIPE_CONNECT_STATE_SECRET).update(payload).digest('base64url');
  const mintState = async (owner) => {
    const metadata = owner.app_metadata || {};
    if (!metadata.active_session_id || !metadata.active_device_id) throw fail(409, 'connect_session_unbound');
    const nonce = crypto.randomBytes(24).toString('hex');
    await save(owner.id, { stripe_connect_test_state_nonce: nonce });
    const payload = Buffer.from(JSON.stringify({ owner: owner.id, session: metadata.active_session_id,
      device: metadata.active_device_id, country: boundCountry(owner), nonce, expires: now() + STATE_TTL })).toString('base64url');
    return `${payload}.${sign(payload)}`;
  };
  const readState = (value) => {
    if (typeof value !== 'string' || value.length > 4096) throw fail(400, 'connect_state_invalid');
    const parts = value.split('.');
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) {
      throw fail(400, 'connect_state_invalid');
    }
    const expected = Buffer.from(sign(parts[0]));
    if (!crypto.timingSafeEqual(expected, Buffer.from(parts[1]))) throw fail(400, 'connect_state_invalid');
    let state;
    try { state = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { throw fail(400, 'connect_state_invalid'); }
    if (!state || typeof state.owner !== 'string' || !state.owner || typeof state.session !== 'string' || !state.session ||
      typeof state.device !== 'string' || !state.device || typeof state.nonce !== 'string' || !state.nonce ||
      !EU_COUNTRIES.has(state.country) || !Number.isFinite(state.expires) || state.expires <= now() || state.expires > now() + STATE_TTL) {
      throw fail(400, 'connect_state_invalid');
    }
    return state;
  };
  const stateOwner = async (state) => {
    const owner = await fetchAuthoritativeUser(state.owner);
    const metadata = owner?.app_metadata;
    if (!principal(owner) || state.expires <= now() || metadata?.active_session_id !== state.session ||
      metadata?.active_device_id !== state.device || metadata?.stripe_connect_test_state_nonce !== state.nonce ||
      boundCountry(owner) !== state.country) {
      throw fail(400, 'connect_state_invalid');
    }
    return owner;
  };
  const safeLink = (link, accountId) => {
    let url;
    try { url = new URL(link?.url); } catch { throw fail(502, 'connect_link_invalid'); }
    // Stripe v2: accounts.stripe.com (+ hash). También onboarding/connect/checkout/billing.
    if (link.livemode !== expectLivemode() || link.account !== accountId || url.protocol !== 'https:' || url.username || url.password ||
      url.port || !/^(accounts|onboarding|connect|checkout|billing)\.stripe\.com$/i.test(url.hostname)) {
      throw fail(502, 'connect_link_invalid');
    }
    return url.href;
  };
  const createLink = async (owner, account) => {
    const origin = config();
    const state = await mintState(owner);
    // La cuenta se crea con merchant + customer + recipient: el link debe pedir configs compatibles.
    let link;
    try {
      link = await stripe().v2.core.accountLinks.create({ account: account.id, use_case: {
        type: 'account_onboarding', account_onboarding: {
          configurations: ['merchant', 'customer', 'recipient'],
          return_url: `${origin}/api/stripe/connect/return?state=${encodeURIComponent(state)}`,
          refresh_url: `${origin}/api/stripe/connect/refresh?state=${encodeURIComponent(state)}` },
      } });
    } catch (firstError) {
      if (firstError?.code !== 'configs_must_match_to_use_account_links') throw firstError;
      try {
        link = await stripe().v2.core.accountLinks.create({ account: account.id, use_case: {
          type: 'account_onboarding', account_onboarding: { configurations: ['merchant', 'customer'],
            return_url: `${origin}/api/stripe/connect/return?state=${encodeURIComponent(state)}`,
            refresh_url: `${origin}/api/stripe/connect/refresh?state=${encodeURIComponent(state)}` },
        } });
      } catch (secondError) {
        if (secondError?.code !== 'configs_must_match_to_use_account_links') throw secondError;
        link = await stripe().v2.core.accountLinks.create({ account: account.id, use_case: {
          type: 'account_onboarding', account_onboarding: { configurations: ['merchant'],
            return_url: `${origin}/api/stripe/connect/return?state=${encodeURIComponent(state)}`,
            refresh_url: `${origin}/api/stripe/connect/refresh?state=${encodeURIComponent(state)}` },
        } });
      }
    }
    await stateOwner(readState(state));
    return { url: safeLink(link, account.id), expiresAt: link.expires_at };
  };
  const ensureAccount = async (owner, country) => {
    let metadata = owner.app_metadata || {};
    if ((metadata.stripe_connect_test_account_id || metadata.stripe_connect_test_creation) && boundCountry(owner) !== country) {
      throw fail(409, 'connect_country_mismatch');
    }
    if (country === 'FR') throw fail(503, 'connect_country_requires_supported_onboarding');
    const approvedCountries = String(connectMode().countries || 'ES').split(',').map((value) => value.trim());
    if (!approvedCountries.includes(country)) {
      throw fail(503, 'connect_country_not_approved');
    }
    if (metadata.stripe_connect_test_account_id) {
      const resolved = await resolveStoredAccount(owner, country);
      owner = resolved.owner;
      metadata = owner.app_metadata || {};
      if (resolved.account) return resolved.account;
    }
    let pending = metadata.stripe_connect_test_creation;
    if (!pending) {
      const name = owner.user_metadata?.full_name;
      if (!owner.email_confirmed_at || typeof owner.email !== 'string' || !owner.email.includes('@') ||
        typeof name !== 'string' || !name.trim() || name.length > 200) throw fail(400, 'connect_owner_profile_required');
      pending = { token: crypto.randomBytes(24).toString('hex'), started: now(), email: owner.email, name: name.trim(), country };
      await save(owner.id, { stripe_connect_test_creation: pending });
    } else {
      if (!/^[a-f0-9]{48}$/.test(pending.token || '') || !Number.isFinite(pending.started) ||
        typeof pending.email !== 'string' || typeof pending.name !== 'string') throw fail(409, 'connect_creation_invalid');
      let matches = [];
      try {
        for await (const account of stripe().v2.core.accounts.list({ limit: 100 })) {
          if (account.metadata?.supabase_owner_id === owner.id && account.metadata?.connect_test_creation_token === pending.token) {
            matches.push(account.id);
          }
        }
      } catch (listError) {
        // List en live a veces falla; no bloquear el alta: reiniciar pending y crear de nuevo.
        console.error('Stripe Connect accounts.list failed; resetting pending:', listError?.code || listError?.message || listError);
        pending = { token: crypto.randomBytes(24).toString('hex'), started: now(), email: pending.email, name: pending.name, country };
        await save(owner.id, { stripe_connect_test_creation: pending });
        matches = [];
      }
      if (matches.length > 1) throw fail(409, 'connect_creation_ambiguous');
      if (matches.length === 1) {
        const account = await retrieve(owner, matches[0], country);
        await save(owner.id, { stripe_connect_test_account_id: account.id, stripe_connect_test_country: country, stripe_connect_test_creation: null });
        return account;
      }
      if (now() - pending.started >= RETRY_WINDOW || pending.started > now()) throw fail(409, 'connect_creation_recovery_required');
    }
    const keyPrefix = expectLivemode() ? 'connect-live-v1' : 'connect-test-v1';
    const idempotencyKey = `${keyPrefix}-${crypto.createHash('sha256').update(owner.id).digest('hex')}-${pending.token}`;
    const account = checkAccount(await stripe().v2.core.accounts.create({
      contact_email: pending.email,
      display_name: pending.name,
      identity: {
        country,
        entity_type: 'individual',
        business_details: { registered_name: pending.name },
      },
      dashboard: 'full',
      defaults: {
        currency: 'eur',
        responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' },
      },
      configuration: MERCHANT_CREATE_CONFIG,
      metadata: { supabase_owner_id: owner.id, connect_test_creation_token: pending.token },
      include: INCLUDE,
    }, { idempotencyKey }), owner, undefined, country);
    await save(owner.id, { stripe_connect_test_account_id: account.id, stripe_connect_test_country: country, stripe_connect_test_creation: null });
    // Pedir Bizum/locales en cuanto existe la cuenta (sin que el comercio entre al Dashboard).
    try {
      await ensureConnectedLocalPaymentMethods(account.id, country);
    } catch (localError) {
      console.warn('Métodos locales tras crear cuenta Connect:', localError?.message || localError);
    }
    return account;
  };
  const sanitizeUpstreamHint = (error) => {
    let raw = [error?.type, error?.code, error?.message].filter(Boolean).join(' | ');
    if (!raw) {
      try { raw = typeof error === 'string' ? error : JSON.stringify(error); } catch { raw = String(error); }
    }
    if (!raw || raw === '{}' || raw === 'undefined') raw = 'error_sin_detalle';
    return String(raw)
      .replace(/sk_(live|test)_[A-Za-z0-9]+/g, 'sk_***')
      .replace(/rk_(live|test)_[A-Za-z0-9]+/g, 'rk_***')
      .replace(/whsec_[A-Za-z0-9]+/g, 'whsec_***')
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
      .replace(/credentials/gi, '***')
      .slice(0, 280);
  };
  const handle = (task) => async (req, res) => {
    res.set?.('Cache-Control', 'no-store');
    res.set?.('Referrer-Policy', 'no-referrer');
    try { return await task(req, res); } catch (error) {
      if (error?.code === 'account_token_required') error = fail(503, 'connect_country_requires_supported_onboarding');
      const trusted = error?.status && /^connect_[a-z_]+$/.test(error.code || '');
      if (!trusted) {
        console.error('Stripe Connect upstream:', error?.type || '', error?.code || '', error?.message || error);
      }
      const body = { ok: false,
        code: trusted ? error.code : 'connect_upstream_unavailable',
        error: 'Stripe Connect no disponible para esta solicitud.' };
      if (!trusted) {
        const hint = sanitizeUpstreamHint(error);
        if (hint) body.hint = hint;
        if (typeof error?.code === 'string' && /^[a-z0-9_]+$/i.test(error.code) && error.code.length < 80) {
          body.stripeCode = error.code;
        }
      }
      return res.status(trusted ? error.status : 502).json(body);
    }
  };
  return {
    resolveConnectedAccount,
    resolveTerminalContext,
    ensureConnectedLocalPaymentMethods,
    ensurePlatformLocalPaymentMethods,
    boundCountry,
    status: handle(async (req, res) => {
      const mode = connectMode();
      // Flags mal puestos (test+live, sk inválida) → 503; sin flags → enabled:false.
      if (mode.code && mode.code !== 'connect_disabled') throw fail(503, mode.code);
      if (!mode.enabled) return res.json(summary(false));
      config();
      const actor = await freshActor(req);
      const owner = await ownerFor(actor);
      return withAccountLock(owner.id, async () => {
        const currentActor = await freshActor(req);
        const currentOwner = await ownerFor(currentActor);
        if (currentOwner.id !== owner.id) throw fail(403, 'connect_company_invalid');
        const { account } = await resolveStoredAccount(currentOwner);
        return res.json(summary(true, account));
      });
    }),
    onboarding: handle(async (req, res) => {
      config();
      const country = req.body?.country;
      if (!EU_COUNTRIES.has(country)) throw fail(400, 'connect_country_unsupported');
      const owner = await ownerFor(await freshActor(req), true);
      return withAccountLock(owner.id, async () => {
        const fresh = await ownerFor(await freshActor(req), true);
        if (!fresh.app_metadata?.active_device_id) throw fail(409, 'connect_session_unbound');
        const account = await ensureAccount(fresh, country);
        const current = await ownerFor(await freshActor(req), true);
        const link = await createLink(current, account);
        return res.json({
          ok: true,
          livemode: expectLivemode(),
          phase: expectLivemode() ? 'connect_live' : 'onboarding_only',
          accountId: account.id,
          ...link,
        });
      });
    }),
    return: handle(async (req, res) => {
      config();
      const state = readState(req.query?.state);
      return withAccountLock(state.owner, async () => {
        const owner = await stateOwner(state);
        const accountId = owner.app_metadata?.stripe_connect_test_account_id;
        await retrieve(owner, accountId);
        if (typeof accountId === 'string' && ACCOUNT_ID.test(accountId)) {
          try {
            await ensureConnectedLocalPaymentMethods(accountId, boundCountry(owner) || state.country);
          } catch (localError) {
            console.warn('Métodos locales tras return Connect:', localError?.message || localError);
          }
        }
        await save(owner.id, { stripe_connect_test_state_nonce: null });
        return res.redirect('tpvapp://pago-completado?connect=return');
      });
    }),
    refresh: handle(async (req, res) => {
      config();
      const state = readState(req.query?.state);
      return withAccountLock(state.owner, async () => {
        const owner = await stateOwner(state);
        const account = await retrieve(owner, owner.app_metadata?.stripe_connect_test_account_id);
        const current = await stateOwner(state);
        const link = await createLink(current, account);
        return res.redirect(link.url);
      });
    }),
  };
};