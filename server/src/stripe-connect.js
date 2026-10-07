const crypto = require('node:crypto');
const { Buffer } = require('node:buffer');

const ACCOUNT_ID = /^acct_[A-Za-z0-9]+$/;
const INCLUDE = ['configuration.merchant', 'configuration.customer', 'configuration.recipient',
  'defaults', 'requirements', 'identity'];
const MERCHANT_RECIPIENT_CONFIG = {
  customer: {},
  merchant: { capabilities: { card_payments: { requested: true } } },
  // Necesario para Checkout/Terminal destination (transfer_data / on_behalf_of).
  recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } },
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
  const enabled = () => env.STRIPE_CONNECT_TEST_ENABLED === 'true';
  const config = () => {
    if (!enabled()) throw fail(503, 'connect_test_disabled');
    const approved = (env.STRIPE_CONNECT_TEST_COUNTRIES ?? 'ES').split(',').map((country) => country.trim());
    if (!approved.length || approved.some((country) => !EU_COUNTRIES.has(country))) {
      throw fail(503, 'connect_country_config_invalid');
    }
    if (!/^sk_test_[A-Za-z0-9]+$/.test(env.STRIPE_CONNECT_TEST_SECRET_KEY || '')) {
      throw fail(503, 'connect_test_key_invalid');
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
    client ||= stripeFactory(env.STRIPE_CONNECT_TEST_SECRET_KEY);
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
    if (!account || !ACCOUNT_ID.test(account.id) || (expectedId && account.id !== expectedId) || account.livemode !== false ||
      account.metadata?.supabase_owner_id !== owner.id || account.dashboard !== 'full' ||
      account.defaults?.responsibilities?.fees_collector !== 'stripe' ||
      account.defaults?.responsibilities?.losses_collector !== 'stripe') {
      throw fail(409, 'connect_account_binding_invalid');
    }
    if (!EU_COUNTRIES.has(country) || account.identity?.country !== country) throw fail(409, 'connect_country_mismatch');
    return account;
  };
  const retrieve = async (owner, accountId, country = boundCountry(owner)) => {
    if (!ACCOUNT_ID.test(accountId || '')) throw fail(409, 'connect_account_binding_invalid');
    return checkAccount(await stripe().v2.core.accounts.retrieve(accountId, { include: INCLUDE }), owner, accountId, country);
  };
  const summary = (isEnabled, account = null) => {
    const capabilities = account?.configuration?.merchant?.capabilities;
    return {
      ok: true, enabled: isEnabled, livemode: false, connected: Boolean(account), accountId: account?.id || null,
      chargesEnabled: capabilities?.card_payments?.status === 'active',
      payoutsEnabled: capabilities?.stripe_balance?.payouts?.status === 'active',
      requirementsPending: Boolean(account && (!account.requirements || !Array.isArray(account.requirements.entries) ||
        account.requirements.entries.length || account.requirements.summary?.minimum_deadline?.status ||
        capabilities?.card_payments?.status !== 'active' || capabilities?.stripe_balance?.payouts?.status !== 'active')),
      // Con Connect test activo los cobros online van a la cuenta conectada (sin fallback a plataforma).
      directCharges: isEnabled,
      phase: 'onboarding_only',
    };
  };
  // Resuelve la cuenta conectada del principal para cobros/consultas.
  // null = Connect desactivado (ruta legacy de plataforma). Con Connect activo nunca cae a plataforma.
  const resolveConnectedAccount = async (req, { requireCharges = false } = {}) => {
    if (!enabled()) return null;
    config();
    const actor = await freshActor(req);
    const owner = await ownerFor(actor);
    const accountId = owner.app_metadata?.stripe_connect_test_account_id;
    if (!ACCOUNT_ID.test(accountId || '')) throw fail(409, 'connect_not_connected');
    const account = await retrieve(owner, accountId);
    const status = summary(true, account);
    if (requireCharges && !status.chargesEnabled) throw fail(409, 'connect_charges_not_enabled');
    return { accountId: account.id, stripe: stripe(), ownerId: owner.id, status, owner };
  };
  // Dirección placeholder válida por país (Stripe valida CP; "00000" falla en ES).
  const terminalAddressFor = (country) => {
    if (country === 'ES') {
      return { line1: 'Calle Provisional 1', city: 'Madrid', postal_code: '28001', country: 'ES' };
    }
    if (country === 'PT') {
      return { line1: 'Rua Provisoria 1', city: 'Lisboa', postal_code: '1000-001', country: 'PT' };
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
  // Solicita recipient/transfers (v2) + capacidades v1 (Bizum, transfers) en la cuenta conectada.
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
    };
    if (country === 'ES') capabilities.bizum_payments = { requested: true };
    try {
      await stripe().accounts.update(accountId, { capabilities });
    } catch (error) {
      console.warn('No se pudieron solicitar capacidades Connect v1:', error?.code || '', error?.message || error);
    }
  };
  // Activa Bizum (y locales EU habituales) en la PMC por defecto de la cuenta Connect.
  // Con cobros directos Stripe usa la PMC del comercio, no la de la plataforma.
  const ensureConnectedLocalPaymentMethods = async (accountId, country) => {
    if (country !== 'ES' && country !== 'PT' && country !== 'BE' && country !== 'NL' && country !== 'AT' && country !== 'DE') {
      return;
    }
    await ensureConnectedCapabilities(accountId, country);
    try {
      const listed = await stripe().paymentMethodConfigurations.list({ limit: 10 }, { stripeAccount: accountId });
      const items = Array.isArray(listed?.data) ? listed.data : [];
      const configuration = items.find((item) => item?.is_default === true)
        || items.find((item) => item?.active !== false)
        || items[0];
      if (!configuration?.id) return;
      // Activar preferencias sin sustituir la lista dinámica de Checkout (Klarna, Revolut, etc.).
      const patch = {
        card: { display_preference: { preference: 'on' } },
        klarna: { display_preference: { preference: 'on' } },
        revolut_pay: { display_preference: { preference: 'on' } },
        amazon_pay: { display_preference: { preference: 'on' } },
        link: { display_preference: { preference: 'on' } },
      };
      if (country === 'ES') patch.bizum = { display_preference: { preference: 'on' } };
      if (country === 'PT') patch.mb_way = { display_preference: { preference: 'on' } };
      if (country === 'BE') patch.bancontact = { display_preference: { preference: 'on' } };
      if (country === 'NL') patch.ideal = { display_preference: { preference: 'on' } };
      if (country === 'AT') patch.eps = { display_preference: { preference: 'on' } };
      if (['ES', 'PT', 'BE', 'NL', 'AT', 'DE'].includes(country)) {
        patch.wero = { display_preference: { preference: 'on' } };
        patch.bancontact = patch.bancontact || { display_preference: { preference: 'on' } };
        patch.ideal = patch.ideal || { display_preference: { preference: 'on' } };
        patch.eps = patch.eps || { display_preference: { preference: 'on' } };
        patch.pay_by_bank = { display_preference: { preference: 'on' } };
      }
      await stripe().paymentMethodConfigurations.update(configuration.id, patch, { stripeAccount: accountId });
    } catch (error) {
      // No bloquea el cobro: Checkout puede seguir con tarjeta y otros métodos ya activos.
      console.warn('No se pudo activar métodos locales en la cuenta Connect:', error?.code || '', error?.message || error);
    }
  };
  // Misma activación en la PMC de la plataforma Connect (Checkout destination / sin Stripe-Account).
  const ensurePlatformLocalPaymentMethods = async (country) => {
    try {
      try {
        const platform = await stripe().accounts.retrieve();
        if (platform?.id) {
          await stripe().accounts.update(platform.id, {
            capabilities: {
              card_payments: { requested: true },
              ...(country === 'ES' ? { bizum_payments: { requested: true } } : {}),
            },
          });
        }
      } catch (capError) {
        console.warn('Capacidades plataforma Connect:', capError?.code || '', capError?.message || capError);
      }
      const listed = await stripe().paymentMethodConfigurations.list({ limit: 10 });
      const items = Array.isArray(listed?.data) ? listed.data : [];
      const configuration = items.find((item) => item?.is_default === true)
        || items.find((item) => item?.active !== false)
        || items[0];
      if (!configuration?.id) return;
      const patch = {
        card: { display_preference: { preference: 'on' } },
        klarna: { display_preference: { preference: 'on' } },
        revolut_pay: { display_preference: { preference: 'on' } },
        amazon_pay: { display_preference: { preference: 'on' } },
        link: { display_preference: { preference: 'on' } },
        wero: { display_preference: { preference: 'on' } },
        bancontact: { display_preference: { preference: 'on' } },
        ideal: { display_preference: { preference: 'on' } },
        eps: { display_preference: { preference: 'on' } },
        pay_by_bank: { display_preference: { preference: 'on' } },
      };
      if (country === 'ES') patch.bizum = { display_preference: { preference: 'on' } };
      if (country === 'PT') patch.mb_way = { display_preference: { preference: 'on' } };
      await stripe().paymentMethodConfigurations.update(configuration.id, patch);
    } catch (error) {
      console.warn('No se pudo activar métodos locales en la plataforma Connect:', error?.code || '', error?.message || error);
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
        // recrear
      }
    }
    const country = boundCountry(owner);
    const displayName = typeof owner.user_metadata?.full_name === 'string' && owner.user_metadata.full_name.trim()
      ? owner.user_metadata.full_name.trim().slice(0, 100)
      : 'TPV Connect';
    let location;
    try {
      location = await stripe().terminal.locations.create({
        display_name: displayName.slice(0, 100),
        address: terminalAddressFor(country),
      });
    } catch (error) {
      console.error('Stripe Terminal platform location create failed:', error?.code || '', error?.message || error);
      throw fail(502, 'connect_terminal_location_invalid');
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
    if (link.livemode !== false || link.account !== accountId || url.protocol !== 'https:' || url.username || url.password ||
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
    const metadata = owner.app_metadata || {};
    if ((metadata.stripe_connect_test_account_id || metadata.stripe_connect_test_creation) && boundCountry(owner) !== country) {
      throw fail(409, 'connect_country_mismatch');
    }
    if (country === 'FR') throw fail(503, 'connect_country_requires_supported_onboarding');
    if (!(env.STRIPE_CONNECT_TEST_COUNTRIES ?? 'ES').split(',').map((value) => value.trim()).includes(country)) {
      throw fail(503, 'connect_country_not_approved');
    }
    if (metadata.stripe_connect_test_account_id) return retrieve(owner, metadata.stripe_connect_test_account_id, country);
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
      const matches = [];
      for await (const account of stripe().v2.core.accounts.list({ limit: 100 })) {
        if (account.metadata?.supabase_owner_id === owner.id && account.metadata?.connect_test_creation_token === pending.token) {
          matches.push(account.id);
        }
      }
      if (matches.length > 1) throw fail(409, 'connect_creation_ambiguous');
      if (matches.length === 1) {
        const account = await retrieve(owner, matches[0], country);
        await save(owner.id, { stripe_connect_test_account_id: account.id, stripe_connect_test_country: country, stripe_connect_test_creation: null });
        return account;
      }
      if (now() - pending.started >= RETRY_WINDOW || pending.started > now()) throw fail(409, 'connect_creation_recovery_required');
    }
    const idempotencyKey = `connect-test-v1-${crypto.createHash('sha256').update(owner.id).digest('hex')}-${pending.token}`;
    const account = checkAccount(await stripe().v2.core.accounts.create({ contact_email: pending.email, display_name: pending.name,
      identity: { country }, dashboard: 'full', defaults: { responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } },
      configuration: MERCHANT_RECIPIENT_CONFIG,
      metadata: { supabase_owner_id: owner.id, connect_test_creation_token: pending.token }, include: INCLUDE,
    }, { idempotencyKey }), owner, undefined, country);
    await save(owner.id, { stripe_connect_test_account_id: account.id, stripe_connect_test_country: country, stripe_connect_test_creation: null });
    return account;
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
      return res.status(trusted ? error.status : 502).json({ ok: false,
        code: trusted ? error.code : 'connect_upstream_unavailable', error: 'Stripe Connect test no disponible para esta solicitud.' });
    }
  };
  return {
    resolveConnectedAccount,
    resolveTerminalContext,
    ensureConnectedLocalPaymentMethods,
    ensurePlatformLocalPaymentMethods,
    boundCountry,
    status: handle(async (req, res) => {
      if (!enabled()) return res.json(summary(false));
      config();
      const actor = await freshActor(req);
      const owner = await ownerFor(actor);
      return withAccountLock(owner.id, async () => {
        const currentActor = await freshActor(req);
        const currentOwner = await ownerFor(currentActor);
        if (currentOwner.id !== owner.id) throw fail(403, 'connect_company_invalid');
        const accountId = currentOwner.app_metadata?.stripe_connect_test_account_id;
        return res.json(summary(true, accountId ? await retrieve(currentOwner, accountId) : null));
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
        return res.json({ ok: true, livemode: false, phase: 'onboarding_only', accountId: account.id, ...link });
      });
    }),
    return: handle(async (req, res) => {
      config();
      const state = readState(req.query?.state);
      return withAccountLock(state.owner, async () => {
        const owner = await stateOwner(state);
        await retrieve(owner, owner.app_metadata?.stripe_connect_test_account_id);
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