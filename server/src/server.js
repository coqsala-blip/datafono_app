if (process.env.CONNECT_TEST_ENV_ISOLATED !== 'true') require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const QRCode = require('qrcode');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const createStripeConnect = require('./stripe-connect');

const app = express();
const PORT = process.env.PORT || 4000;
const PUBLIC_API_URL = (process.env.PUBLIC_API_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const NODE_ENV = process.env.NODE_ENV || 'development';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_MAIN_SUBSCRIPTION_PRICE_ID = process.env.STRIPE_MAIN_SUBSCRIPTION_PRICE_ID;
const STRIPE_ADDITIONAL_USER_PRICE_ID = process.env.STRIPE_ADDITIONAL_USER_PRICE_ID;
const stripe = STRIPE_SECRET_KEY ? Stripe(STRIPE_SECRET_KEY) : null;
const stripeCurrency = 'eur';

// Métodos de pago del cobro online (solo cobros puntuales, en EUR).
// Por defecto se usan MÉTODOS DINÁMICOS (equivalente a 'auto'): no se envía payment_method_types
// al Checkout y es Stripe quien muestra los métodos ACTIVADOS en Settings > Payment methods del
// Dashboard (Bizum en España, MB WAY en Portugal, Bancontact en Bélgica, EPS en Austria, iDEAL en
// Países Bajos, Wero paneuropeo...). Es el modo recomendado por Stripe y el que garantiza que lo
// activado en el Dashboard salga siempre, sin listas en el código.
// Si prefieres limitarlo a mano, define STRIPE_PAYMENT_METHOD_TYPES con tu lista, p. ej.
// 'card,bizum': en ese caso los métodos no activados se retiran solos con reintentos acotados.
// Referencia: https://docs.stripe.com/payments/payment-methods/dynamic-payment-methods
// Dias de margen desde que la suscripcion entra en impago antes de bloquear la app. Durante ese
// plazo el usuario ve un aviso rojo; al cumplirse, la app queda bloqueada hasta que pague.
const SUBSCRIPTION_LOCK_DAYS = 3;
const SUBSCRIPTION_PAST_DUE_STATES = new Set(['past_due', 'unpaid']);

const EUR_LOCAL_PAYMENT_METHODS = ['bizum', 'mb_way', 'bancontact', 'eps', 'ideal', 'wero'];
const stripePaymentMethodTypesSetting = String(process.env.STRIPE_PAYMENT_METHOD_TYPES || 'auto').trim().toLowerCase();
const stripeDynamicPaymentMethods = stripePaymentMethodTypesSetting === '' || stripePaymentMethodTypesSetting === 'auto';
const stripePaymentMethodTypes = stripeDynamicPaymentMethods
  ? []
  : stripePaymentMethodTypesSetting.split(',').map((method) => method.trim()).filter(Boolean);

// Bizum: solo cobros puntuales en EUR, entre 0,50 € y 5.000 €. No admite suscripciones.
const BIZUM_MIN_AMOUNT_CENTS = 50;
const BIZUM_MAX_AMOUNT_CENTS = 500000;

const resolveCheckoutPaymentMethodTypes = (amountCents) => {
  if (stripeDynamicPaymentMethods) return null;
  const eligible = stripePaymentMethodTypes.filter((method) => (
    method !== 'bizum' || (amountCents >= BIZUM_MIN_AMOUNT_CENTS && amountCents <= BIZUM_MAX_AMOUNT_CENTS)
  ));
  return eligible.length > 0 ? eligible : ['card'];
};

// Comprueba si el mensaje de error menciona a un método local europeo (por palabra completa,
// evitando falsos positivos de subcadenas como 'steps' conteniendo 'eps').
const messageMentionsLocalMethod = (method, message) => {
  const pattern = method.includes('_') ? method.replace(/_/g, '[_ ]') : method;
  return new RegExp(`\\b${pattern}\\b`).test(message);
};

// Detecta el error de Stripe cuando se pide un método local que no está activado en el Dashboard.
const isLocalPaymentMethodUnavailableError = (error) => {
  const message = String(error?.message || '').toLowerCase();
  if (EUR_LOCAL_PAYMENT_METHODS.some((method) => messageMentionsLocalMethod(method, message))) return true;
  return ['not activated', 'no está activado', 'not enabled', 'not supported', 'invalid payment method'].some((text) => message.includes(text));
};

// Configuración de métodos de pago de la cuenta (misma fuente que el diagnóstico), cacheada 10
// minutos para no ralentizar cada cobro: indica qué métodos están realmente disponibles en Stripe.
let cachedPaymentMethodConfiguration = null;
let cachedPaymentMethodConfigurationAt = 0;
const PAYMENT_METHOD_CONFIGURATION_TTL_MS = 10 * 60 * 1000;

// Lee la configuración de métodos de pago de la cuenta. Si hay varias (p. ej. una personalizada
// creada desde el Dashboard), usa SIEMPRE la por defecto, que es la que aplica el Checkout.
// OJO: en la API de Stripe el campo se llama 'is_default' (no 'default'): al buscarlo mal se
// cogia la primera configuracion de la lista, que puede NO ser la que aplica el Checkout; en ese
// caso activar un metodo (Bizum) no surtia ningun efecto en el cobro.
const readDefaultPaymentMethodConfiguration = async () => {
  const configurations = await requireStripe().paymentMethodConfigurations.list({ limit: 10 });
  const items = Array.isArray(configurations?.data) ? configurations.data : [];
  return items.find((item) => item?.is_default === true)
    || items.find((item) => item?.active !== false)
    || items[0]
    || null;
};

const getPaymentMethodConfiguration = async () => {
  const now = Date.now();
  if (cachedPaymentMethodConfiguration && now - cachedPaymentMethodConfigurationAt < PAYMENT_METHOD_CONFIGURATION_TTL_MS) {
    return cachedPaymentMethodConfiguration;
  }
  try {
    cachedPaymentMethodConfiguration = await readDefaultPaymentMethodConfiguration();
    cachedPaymentMethodConfigurationAt = now;
  } catch (error) {
    // Sin configuración no se prefiltra: la lista pedida pasa tal cual y filtran los reintentos.
    console.warn('No se pudo leer la configuración de métodos de pago de Stripe:', error.message);
  }
  return cachedPaymentMethodConfiguration;
};

// Deja en la lista los métodos que Stripe no marca explícitamente como no disponibles; la tarjeta
// siempre se mantiene. Regla conservadora: si la configuración no menciona a un método, se conserva
// y será el reintento acotado quien lo retire si Stripe lo rechaza.
const filterAvailablePaymentMethods = async (paymentMethodTypes) => {
  if (!Array.isArray(paymentMethodTypes)) return paymentMethodTypes;
  const configuration = await getPaymentMethodConfiguration();
  if (!configuration) return paymentMethodTypes;
  const available = paymentMethodTypes.filter((method) => (
    method === 'card' || configuration[method]?.available !== false
  ));
  return available.length > 0 ? available : ['card'];
};

// Crea la sesión de Checkout. Primero se filtran los métodos no disponibles según la cuenta; si aun
// así Stripe rechaza un método local, se retira y se reintenta (con límite y garantizando progreso)
// para que el cobro nunca se rompa. Avisando por log.
// options.stripeAccount: cobro directo en cuenta Connect (Stripe-Account). No usa la PMC de plataforma.
const createCheckoutSessionWithLocalMethodsFallback = async (params, requestedPaymentMethodTypes, options = {}) => {
  const stripeClient = options.stripeClient || requireStripe();
  const requestOptions = options.stripeAccount ? { stripeAccount: options.stripeAccount } : {};
  // En cobros directos Stripe resuelve los métodos de la cuenta conectada; no prefiltrar con la plataforma.
  let currentTypes = options.stripeAccount
    ? (Array.isArray(requestedPaymentMethodTypes) ? [...requestedPaymentMethodTypes] : requestedPaymentMethodTypes)
    : await filterAvailablePaymentMethods(
      Array.isArray(requestedPaymentMethodTypes) ? [...requestedPaymentMethodTypes] : requestedPaymentMethodTypes,
    );
  let removalsLeft = EUR_LOCAL_PAYMENT_METHODS.length;

  for (;;) {
    try {
      const session = await stripeClient.checkout.sessions.create(
        Array.isArray(currentTypes) ? { ...params, payment_method_types: currentTypes } : params,
        requestOptions,
      );
      // Con métodos dinámicos (currentTypes null) se devuelve la lista que Stripe resuelve para la
      // sesión, para poder mostrar al vendedor qué métodos ofrecerá este cobro concreto.
      const resolvedTypes = Array.isArray(currentTypes)
        ? currentTypes
        : (Array.isArray(session?.payment_method_types) && session.payment_method_types.length > 0
          ? session.payment_method_types
          : null);
      return { session, paymentMethodTypes: resolvedTypes };
    } catch (error) {
      const requestedLocal = Array.isArray(currentTypes) && currentTypes.some((method) => EUR_LOCAL_PAYMENT_METHODS.includes(method));
      if (!requestedLocal || removalsLeft <= 0 || !isLocalPaymentMethodUnavailableError(error)) {
        throw error;
      }
      removalsLeft -= 1;

      // Retirar el método mencionado en el error SI está en la lista actual; si no, el último
      // local de la lista. Siempre se retira uno, para que el reintento progrese siempre.
      const lower = String(error?.message || '').toLowerCase();
      const mentioned = EUR_LOCAL_PAYMENT_METHODS.find((method) => currentTypes.includes(method) && messageMentionsLocalMethod(method, lower));
      const toRemove = mentioned || [...currentTypes].reverse().find((method) => EUR_LOCAL_PAYMENT_METHODS.includes(method));
      currentTypes = currentTypes.filter((method) => method !== toRemove);
      if (currentTypes.length === 0) currentTypes = ['card'];
      console.warn(`Método ${toRemove} no disponible en tu cuenta de Stripe. Se reintenta con:`, currentTypes.join(', '), '- Actívalo en Settings > Payment methods del Dashboard.');
    }
  }
};

// Datos de la cuenta de Stripe + enlaces directos al Dashboard (test o live según la clave
// configurada). Sirve para que el comercio configure desde la app DÓNDE recibe sus cobros:
// cuenta bancaria y titular, calendario de pagos y estado de la cuenta.
const buildStripeAccountSnapshot = async (stripeClient) => {
  const account = await stripeClient.accounts.retrieve();
  const secretKey = String(process.env.STRIPE_SECRET_KEY || '');
  const livemode = typeof account?.livemode === 'boolean' ? account.livemode : secretKey.startsWith('sk_live');
  const base = livemode ? 'https://dashboard.stripe.com' : 'https://dashboard.stripe.com/test';

  // Leer la cuenta bancaria de abono solo es posible con claves de plataforma (Connect). Con la
  // clave estándar de la propia cuenta Stripe no lo permite: se informa como "no legible" en vez de
  // decir que no hay ninguna, y el comercio la configura en el Dashboard que se abre desde la app.
  let bankAccounts = [];
  let bankAccountsReadable = true;
  let bankAccountsNote = null;
  try {
    const list = await stripeClient.accounts.listExternalAccounts(account.id, { object: 'bank_account', limit: 10 });
    bankAccounts = (Array.isArray(list?.data) ? list.data : []).map((bank) => ({
      id: bank.id,
      bankName: bank.bank_name || null,
      last4: bank.last4 || null,
      country: bank.country || null,
      currency: bank.currency || null,
      status: bank.status || null,
    }));
  } catch (error) {
    bankAccountsReadable = false;
    bankAccountsNote = error.message;
    console.warn('No se pudieron leer las cuentas bancarias de Stripe:', error.message);
  }

  return {
    livemode,
    accountId: account?.id || null,
    country: account?.country || null,
    businessType: account?.business_type || null,
    businessName: account?.business_profile?.name || account?.settings?.dashboard?.display_name || null,
    defaultCurrency: account?.default_currency || null,
    chargesEnabled: typeof account?.charges_enabled === 'boolean' ? account.charges_enabled : null,
    payoutsEnabled: typeof account?.payouts_enabled === 'boolean' ? account.payouts_enabled : null,
    detailsSubmitted: typeof account?.details_submitted === 'boolean' ? account.details_submitted : null,
    payoutSchedule: account?.settings?.payouts?.schedule || null,
    requirementsDue: Array.isArray(account?.requirements?.currently_due) ? account.requirements.currently_due : [],
    disabledReason: account?.requirements?.disabled_reason || null,
    bankAccounts,
    bankAccountsReadable,
    bankAccountsNote,
    dashboardUrls: {
      account: `${base}/settings/account`,
      payouts: `${base}/settings/payouts`,
      paymentMethods: `${base}/settings/payment_methods`,
      balances: `${base}/balance`,
      overview: `${base}/dashboard`,
    },
  };
};

try {
  const publicApiUrl = new URL(PUBLIC_API_URL);
  if (NODE_ENV === 'production' && publicApiUrl.protocol !== 'https:') {
    throw new Error('PUBLIC_API_URL debe usar HTTPS en producción.');
  }
} catch (error) {
  throw new Error(`PUBLIC_API_URL no es válida: ${error.message}`);
}

const supabaseAuthOptions = {
  auth: { persistSession: false, autoRefreshToken: false },
};
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  supabaseAuthOptions,
);
const supabaseAuth = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  supabaseAuthOptions,
);

const requireStripe = () => {
  if (!stripe) {
    throw new Error('STRIPE_SECRET_KEY no está configurada en el backend.');
  }
  return stripe;
};

const updateUserMetadata = async (userId, metadata) => {
  const { data } = await supabase.auth.admin.getUserById(userId);
  const currentMetadata = data?.user?.user_metadata || {};
  return supabase.auth.admin.updateUserById(userId, {
    user_metadata: {
      ...currentMetadata,
      ...metadata,
    },
  });
};

const updateUserAppMetadata = async (userId, metadata) => {
  const { data } = await supabase.auth.admin.getUserById(userId);
  const currentMetadata = data?.user?.app_metadata || {};
  return supabase.auth.admin.updateUserById(userId, {
    app_metadata: {
      ...currentMetadata,
      ...metadata,
    },
  });
};

const hashEmployeeAccessCode = (code, salt) => crypto.scryptSync(code, salt, 64).toString('hex');

// Los códigos nuevos se guardan en NFKC y mayúsculas. Para los ya guardados se prueba también el
// texto tal cual y en minúsculas (el teclado puede haber cambiado las mayúsculas al escribirlo).
const normalizeEmployeeAccessCode = (code) => (typeof code === 'string' ? code.normalize('NFKC').trim().toUpperCase() : '');
const employeeAccessCodeCandidates = (code) => {
  const raw = typeof code === 'string' ? code.trim() : '';
  const normalized = normalizeEmployeeAccessCode(code);
  return [...new Set([raw, normalized, normalized.toLowerCase()].filter(Boolean))];
};
const employeeAccessCodeMatches = (metadata, candidates) => {
  if (!metadata || metadata.role === 'empleado') return false;
  const { employee_access_code_salt: salt, employee_access_code_hash: storedHash } = metadata;
  if (typeof salt !== 'string' || typeof storedHash !== 'string' || !salt || !storedHash) return false;
  const stored = Buffer.from(storedHash, 'hex');
  return candidates.some((candidate) => {
    const candidateHash = Buffer.from(hashEmployeeAccessCode(candidate, salt), 'hex');
    return candidateHash.length === stored.length && crypto.timingSafeEqual(candidateHash, stored);
  });
};

const isPrincipal = (user) => user.app_metadata?.role !== 'empleado';

// Plazas de empleado (usuarios adicionales) contratadas. La fuente de verdad es el item de la
// suscripcion con el precio STRIPE_ADDITIONAL_USER_PRICE_ID, no la copia en la metadata.
// Devuelve el objeto latest_invoice si viene expandido, o null si Stripe devuelve solo el id.
const latestInvoiceObject = (subscription) => (
  subscription?.latest_invoice && typeof subscription.latest_invoice === 'object'
    ? subscription.latest_invoice
    : null
);

const readSubscriptionSeats = (subscription) => {
  const item = (subscription?.items?.data || []).find((entry) => entry?.price?.id === STRIPE_ADDITIONAL_USER_PRICE_ID);
  return item ? Math.max(0, Math.floor(Number(item.quantity) || 0)) : 0;
};

// Importe mensual (IVA incluido) del plan con esas plazas, igual que calcula el Checkout.
const monthlyAmountCentsForSeats = (seats) => 1089 + (Math.max(0, Math.min(50, Math.floor(Number(seats) || 0))) * 303);

// Stripe NO guarda los metodos de pago de redireccion (Bizum, iDEAL, MB WAY, Payconiq...) como
// metodo reutilizable. Si el plan se contrato con uno de ellos, el cliente se queda sin tarjeta y el
// prorrateo de las plazas no se puede cobrar: Stripe devuelve este error concreto.
// Indica si el cliente de Stripe tiene ya una tarjeta guardada. Los metodos de redireccion (Bizum,
// iDEAL, MB WAY...) NO se guardan, asi que un plan contratado con ellos se queda sin nada con que
// cobrar las renovaciones y los pro-rrateos.
const customerHasReusableCard = async (stripeClient, customerId) => {
  if (!customerId) return false;
  try {
    const methods = await stripeClient.paymentMethods.list({
      customer: typeof customerId === 'string' ? customerId : customerId.id,
      type: 'card',
      limit: 1,
    });
    if (methods?.data?.length) return true;
  } catch (error) {
    // Si la API falla no se bloquea el alta: el propio cobro dira si falta la tarjeta.
    console.warn('No se pudieron listar las tarjetas del cliente:', error.message);
    return true;
  }
  return false;
};
const errorNeedsPaymentMethod = (error) => {
  const message = String(error?.message || '').toLowerCase();
  return /no attached payment source|no default payment method/.test(message);
};

// Localiza la suscripcion del usuario: primero el id guardado en su metadata y, si falta, el
// cliente de Stripe o la sesion de Checkout pendiente (cuentas antiguas sin id guardado).
const resolveUserSubscription = async (stripeClient, userId) => {
  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error || !data?.user) throw new Error('No se encontró la cuenta para consultar su suscripción.');
  const user = data.user;
  const expand = ['items.data.price', 'latest_invoice'];

  const storedId = user.user_metadata?.stripe_subscription_id;
  if (storedId) {
    try {
      const subscription = await stripeClient.subscriptions.retrieve(storedId, { expand });
      return { user, subscription, subscriptionId: storedId };
    } catch (retrieveError) {
      console.warn('No se pudo leer la suscripción guardada en la cuenta:', retrieveError.message);
    }
  }

  const customerId = user.user_metadata?.stripe_customer_id;
  if (customerId) {
    const list = await stripeClient.subscriptions.list({ customer: customerId, status: 'all', limit: 20 });
    const preferred = list.data.find((entry) => ['active', 'trialing', 'past_due'].includes(entry.status)) || list.data[0];
    if (preferred) {
      const subscription = await stripeClient.subscriptions.retrieve(preferred.id, { expand });
      return { user, subscription, subscriptionId: preferred.id };
    }
  }

  const checkoutSessionId = user.user_metadata?.stripe_checkout_session_id;
  if (checkoutSessionId) {
    const session = await stripeClient.checkout.sessions.retrieve(checkoutSessionId);
    const fromSession = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
    if (fromSession) {
      const subscription = await stripeClient.subscriptions.retrieve(fromSession, { expand });
      return { user, subscription, subscriptionId: fromSession };
    }
  }

  return { user, subscription: null, subscriptionId: null };
};

const findPrincipalByEmployeeAccessCode = async (accessCode, companyEmail) => {
  const candidates = employeeAccessCodeCandidates(accessCode);
  let page = 1;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;

    const users = data?.users || [];
    for (const user of users) {
      if ((!companyEmail || user.email?.toLowerCase() === companyEmail) && employeeAccessCodeMatches(user.app_metadata, candidates)) return user;
    }

    if (users.length < 1000) return null;
    page += 1;
  }
};

const normalizeStripePaymentStatus = (session) => {
  if (session.payment_status === 'paid') return 'SUCCEEDED';
  if (session.status === 'expired') return 'EXPIRED';
  // Pago rechazado (p. ej. Bizum con el banco declinando, o tarjeta denegada): Checkout queda
  // completo pero sin cobrar y con error en el PaymentIntent. Hay que mostrarlo, no esperar.
  const paymentIntent = session.payment_intent && typeof session.payment_intent === 'object'
    ? session.payment_intent
    : null;
  if (
    session.status === 'complete' &&
    session.payment_status === 'unpaid' &&
    (paymentIntent?.last_payment_error || paymentIntent?.status === 'requires_payment_method')
  ) {
    return 'FAILED';
  }
  if (session.status === 'complete') return 'PROCESSING';
  return 'PENDING';
};

// Método usado en el intento de pago (card, bizum...). Null si aún no hay intento.
const resolveOnlinePaymentUsedMethod = (session) => {
  const paymentIntent = session.payment_intent && typeof session.payment_intent === 'object'
    ? session.payment_intent
    : null;
  const methodObject = paymentIntent?.payment_method && typeof paymentIntent.payment_method === 'object'
    ? paymentIntent.payment_method
    : null;
  if (typeof methodObject?.type === 'string' && methodObject.type) return methodObject.type;
  const errorMethod = paymentIntent?.last_payment_error?.payment_method;
  const errorMethodObject = errorMethod && typeof errorMethod === 'object' ? errorMethod : null;
  if (typeof errorMethodObject?.type === 'string' && errorMethodObject.type) return errorMethodObject.type;
  return null;
};

app.set('trust proxy', 1);
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!STRIPE_WEBHOOK_SECRET && NODE_ENV === 'production') {
    console.error('Webhook Stripe rechazado: STRIPE_WEBHOOK_SECRET no está configurado.');
    return res.status(500).json({ ok: false, error: 'STRIPE_WEBHOOK_SECRET no está configurado en el backend.' });
  }

  let event;
  try {
    const stripeClient = requireStripe();
    const signature = req.headers['stripe-signature'];
    if (STRIPE_WEBHOOK_SECRET) {
      event = stripeClient.webhooks.constructEvent(req.body, signature, STRIPE_WEBHOOK_SECRET);
    } else {
      console.warn('Webhook Stripe recibido sin verificar firma (solo permitido en desarrollo).');
      event = JSON.parse(req.body.toString('utf8'));
    }
  } catch (error) {
    console.error('Webhook Stripe no válido:', error.message);
    return res.status(400).json({ ok: false, error: 'Webhook Stripe no válido.' });
  }

  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data.object;
    const userId = session.metadata?.supabase_user_id;
    if (userId && session.mode === 'subscription') {
      await updateUserMetadata(userId, {
        subscription_provider: 'stripe',
        stripe_customer_id: session.customer || null,
        stripe_subscription_id: session.subscription || null,
        stripe_subscription_status: 'active',
        stripe_subscription_updated_at: new Date().toISOString(),
      }).catch((error) => console.error('Error guardando estado de suscripción Stripe:', error.message));
    }
  }

  return res.status(200).json({ received: true });
});

app.get('/api/stripe/webhook', (req, res) => {
  res.status(200).json({ ok: true, service: 'Stripe webhook' });
});

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

if (NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.path === '/health' || req.secure) {
      return next();
    }

    return res.redirect(`https://${req.get('host')}${req.originalUrl}`);
  });
}

app.get('/health', (req, res) => {
  // RENDER_GIT_COMMIT lo inyecta Render automaticamente en cada despliegue: permite verificar
  // desde fuera que el backend servido corresponde exactamente al commit desplegado.
  res.json({ ok: true, service: 'TPV & GESTOR backend', commit: process.env.RENDER_GIT_COMMIT || null });
});

// Diagnóstico de la conexión con Supabase. NUNCA devuelve la clave: solo su tipo (prefijo) y si
// realmente tiene acceso a las tablas. Sirve para distinguir "la clave de Render es de otro tipo"
// de "faltan permisos en el SQL" sin tener que adivinar.
app.get('/api/supabase-diagnostico', async (req, res) => {
  const url = String(process.env.SUPABASE_URL || '');
  const key = String(process.env.SUPABASE_SECRET_KEY || '');
  const projectRef = (url.match(/\/\/([^.]+)\.supabase\./) || [])[1] || null;

  // Clasifica la clave por prefijo. Las claves nuevas de Supabase (sb_secret_/sb_publishable_)
  // no son JWT, así que no se puede leer el 'role' de dentro: solo el prefijo.
  let keyKind = 'ausente';
  if (key.startsWith('sb_secret_')) keyKind = 'sb_secret_ (clave secreta: la que da permisos)';
  else if (key.startsWith('sb_publishable_')) keyKind = 'sb_publishable_ (CLAVE PÚBLICA: NO da permisos)';
  else if (key.startsWith('eyJ')) keyKind = 'JWT (revisar que el rol sea service_role)';
  else if (key) keyKind = 'formato desconocido';

  const probe = async (table) => {
    const { error } = await supabase.from(table).select('*').limit(1);
    return error ? `ERROR: ${error.message || error}` : 'OK';
  };

  res.json({
    ok: true,
    proyecto: projectRef,
    urlConfigurada: url || null,
    tipoDeClave: keyKind,
    longitudClave: key.length,
    acceso: { documents: await probe('documents'), expenses: await probe('expenses') },
  });
});

const getBearerToken = (req) => {
  const authorization = req.headers.authorization || '';
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : null;
};

// --- SESIÓN ÚNICA POR CUENTA ---
// Cada cuenta (principal o empleado) solo puede operar desde un terminal: app_metadata guarda el
// dispositivo (active_device_id) y la sesión de Supabase (active_session_id) autorizados. Solo el
// servidor escribe app_metadata; el cliente no puede modificarla.
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const DEVICE_CONFLICT_MESSAGE = 'La sesión ya está abierta en otro dispositivo. Cierra la sesión allí o pulsa "Abrir en este dispositivo" para trasladarla (la sesión anterior se cerrará).';

const normalizeDeviceId = (value) => {
  const deviceId = typeof value === 'string' ? value.trim() : '';
  return DEVICE_ID_PATTERN.test(deviceId) ? deviceId : '';
};

const deviceConflict = (res) => res.status(409).json({ ok: false, code: 'device_conflict', error: DEVICE_CONFLICT_MESSAGE });

// Lee session_id del JWT. SOLO se llama después de que Supabase haya validado el token con getUser.
const readVerifiedSessionId = (verifiedToken) => {
  try {
    const payload = JSON.parse(Buffer.from(String(verifiedToken).split('.')[1] || '', 'base64url').toString('utf8'));
    return typeof payload?.session_id === 'string' && payload.session_id ? payload.session_id : null;
  } catch {
    return null;
  }
};

// Valida el token contra Supabase (firma, caducidad, sesión no revocada) y devuelve el usuario
// leído de la base de datos de Auth (app_metadata actual, no las claims del token).
const verifyAccessToken = async (token) => {
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  const sessionId = readVerifiedSessionId(token);
  return sessionId ? { user: data.user, sessionId } : null;
};

const sessionBindingState = (user, sessionId) => {
  const activeSession = user?.app_metadata?.active_session_id;
  if (typeof activeSession !== 'string' || !activeSession) return 'unbound';
  return activeSession === sessionId ? 'ok' : 'conflict';
};

// Serializa login/registro/traslado por cuenta dentro de ESTE proceso. No protege entre varias
// instancias del backend (hoy solo hay una).
const accountLocks = new Map();
const withAccountLock = async (key, task) => {
  const previous = accountLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  accountLocks.set(key, tail);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (accountLocks.get(key) === tail) accountLocks.delete(key);
  }
};

const fetchAuthoritativeUser = async (userId) => {
  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error || !data?.user) return null;
  return data.user;
};

// Solo verifica el token. Únicamente /api/auth/me la usa directamente, porque es quien decide el
// enlace o el traslado explícito de la sesión.
const requireVerifiedToken = async (req, res, next) => {
  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'Se requiere autenticación.' });
  }

  const verified = await verifyAccessToken(token);
  if (!verified) {
    return res.status(401).json({ ok: false, error: 'La sesión no es válida o ha caducado.' });
  }

  req.user = verified.user;
  req.authSessionId = verified.sessionId;
  req.authToken = token;
  return next();
};

const requireAuth = (req, res, next) => requireVerifiedToken(req, res, () => {
  const state = sessionBindingState(req.user, req.authSessionId);
  if (state === 'conflict') return deviceConflict(res);
  if (state === 'unbound') {
    // Sesiones anteriores a este control: /api/auth/me las enlaza al arrancar la app.
    return res.status(409).json({ ok: false, code: 'session_unbound', error: 'Vuelve a abrir la app para verificar la sesión en este dispositivo.' });
  }
  return next();
});

const stripeConnect = createStripeConnect({ env: process.env, fetchAuthoritativeUser, updateUserAppMetadata, withAccountLock });
app.get('/api/stripe/connect/status', requireAuth, stripeConnect.status);
app.post('/api/stripe/connect/onboarding', requireAuth, stripeConnect.onboarding);
app.get('/api/stripe/connect/return', stripeConnect.return);
app.get('/api/stripe/connect/refresh', stripeConnect.refresh);

const connectChargeError = (error) => {
  if (!error?.status || !/^connect_[a-z_]+$/.test(error.code || '')) return null;
  const messages = {
    connect_not_connected: 'Completa el alta de Stripe Connect antes de cobrar.',
    connect_charges_not_enabled: 'Tu cuenta Connect aún no puede cobrar. Completa la verificación en Stripe.',
    connect_test_disabled: 'Stripe Connect test no está habilitado.',
    connect_test_key_invalid: 'Stripe Connect test no está configurado correctamente.',
    connect_state_secret_missing: 'Stripe Connect test no está configurado correctamente.',
    connect_public_origin_invalid: 'Stripe Connect test no está configurado correctamente.',
    connect_country_config_invalid: 'Stripe Connect test no está configurado correctamente.',
    connect_session_invalid: 'La sesión no es válida o ha caducado.',
    connect_principal_required: 'No tienes permiso para operar con la cuenta Connect de la empresa.',
    connect_company_invalid: 'No se pudo resolver la empresa de la cuenta Connect.',
    connect_account_binding_invalid: 'La cuenta Connect vinculada no es válida.',
    connect_country_mismatch: 'El país de la cuenta Connect no coincide.',
    connect_terminal_location_invalid: 'No se pudo preparar la ubicación de Stripe Terminal para la cuenta Connect.',
  };
  return {
    status: error.status,
    body: { ok: false, code: error.code, error: messages[error.code] || 'Stripe Connect no disponible para esta solicitud.' },
  };
};

app.get('/api/billing/status', requireAuth, async (req, res) => {
  let accountOwner = req.user;
  const ownerId = req.user.app_metadata?.company_owner_id;
  if (ownerId) {
    const { data, error } = await supabase.auth.admin.getUserById(ownerId);
    if (error || !data.user) {
      return res.status(404).json({ ok: false, error: 'No se encontró la cuenta principal asociada.' });
    }
    accountOwner = data.user;
  }

  let status = accountOwner.user_metadata?.stripe_subscription_status || 'missing';
  // Plazas de empleado: se leen de Stripe y, si no se pudiera, queda la metadata como respaldo.
  let additionalUsers = Math.max(0, Math.floor(Number(accountOwner.user_metadata?.stripe_subscription_additional_users) || 0));
  let subscriptionId = accountOwner.user_metadata?.stripe_subscription_id || null;
  const checkoutSessionId = accountOwner.user_metadata?.stripe_checkout_session_id || null;
  // Momento en que la suscripcion entro en impago. Se guarda en la metadata del usuario la PRIMERA
  // vez que se detecta, para que el plazo de cortesia se cuente igual aunque la app se cierre, se le
  // borren los datos o se cambie de movil. Se limpia en cuanto la suscripcion vuelve a estar al dia.
  let pastDueSince = accountOwner.user_metadata?.stripe_past_due_since || null;
  // Enlace a la factura vencida, para poder pagarla desde el aviso de la propia app.
  let pastDueInvoiceUrl = accountOwner.user_metadata?.stripe_past_due_invoice_url || null;

  try {
    if (stripe && subscriptionId) {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['items.data.price', 'latest_invoice'] });
      status = subscription.status || status;
      additionalUsers = readSubscriptionSeats(subscription);
      const currentInvoice = latestInvoiceObject(subscription);
      if (currentInvoice?.hosted_invoice_url) pastDueInvoiceUrl = currentInvoice.hosted_invoice_url;
      await updateUserMetadata(accountOwner.id, {
        stripe_subscription_status: status,
        stripe_past_due_invoice_url: pastDueInvoiceUrl,
        stripe_subscription_updated_at: new Date().toISOString(),
      });
    } else if (stripe && checkoutSessionId) {
      const session = await stripe.checkout.sessions.retrieve(checkoutSessionId);
      if (session.subscription) {
        subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
        const subscription = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['items.data.price', 'latest_invoice'] });
        status = subscription.status || status;
        additionalUsers = readSubscriptionSeats(subscription);
        const currentInvoice = latestInvoiceObject(subscription);
        if (currentInvoice?.hosted_invoice_url) pastDueInvoiceUrl = currentInvoice.hosted_invoice_url;
        await updateUserMetadata(accountOwner.id, {
          subscription_provider: 'stripe',
          stripe_customer_id: session.customer || null,
          stripe_subscription_id: subscriptionId,
          stripe_subscription_status: status,
          stripe_past_due_invoice_url: pastDueInvoiceUrl,
          stripe_subscription_updated_at: new Date().toISOString(),
        });
      } else {
        status = session.status || status;
      }
    }
  } catch (error) {
    console.error('Error consultando suscripción Stripe:', error.message);
  }

  const activeStatuses = new Set(['active', 'trialing']);

  // Estado de impago y dias de margen que quedan antes de bloquear la app. Al entrar en impago se
  // guarda la fecha de forma permanente; al ponerse al dia se limpia, de modo que un impago futuro
  // vuelva a contar los 3 dias completos desde el principio.
  const isPastDue = SUBSCRIPTION_PAST_DUE_STATES.has(status);
  if (isPastDue && !pastDueSince) {
    pastDueSince = new Date().toISOString();
    await updateUserMetadata(accountOwner.id, { stripe_past_due_since: pastDueSince });
  } else if (!isPastDue && pastDueSince) {
    pastDueSince = null;
    await updateUserMetadata(accountOwner.id, { stripe_past_due_since: null });
  }
  const daysPastDue = isPastDue && pastDueSince
    ? Math.max(0, Math.floor((Date.now() - new Date(pastDueSince).getTime()) / 86400000))
    : 0;
  const daysUntilLock = isPastDue ? Math.max(0, SUBSCRIPTION_LOCK_DAYS - daysPastDue) : null;

  return res.json({
    ok: true,
    provider: 'stripe',
    active: activeStatuses.has(status),
    status,
    subscriptionId,
    additionalUsers,
    totalMonthlyCents: monthlyAmountCentsForSeats(additionalUsers),
    pastDue: isPastDue,
    pastDueSince,
    daysPastDue,
    daysUntilLock,
    locked: isPastDue && daysPastDue >= SUBSCRIPTION_LOCK_DAYS,
    lockAfterDays: SUBSCRIPTION_LOCK_DAYS,
    pastDueInvoiceUrl,
  });
});

// Cobra la factura VENCIDA de la suscripcion con la tarjeta que el usuario acaba de guardar.
// Se usa cuando la app lleva el aviso de impago: sin esto, el usuario tendria que entrar al panel de
// Stripe a mano. La factura se recupera del propio campo latest_invoice de la suscripcion, nunca de
// un dato del cliente.
app.post('/api/billing/resolve-invoice', requireAuth, async (req, res) => {
  // Lo puede cobrar cualquier usuario de la cuenta, no solo el principal: si la app esta
  // bloqueada por impago, cualquiera que entre debe poder pagar la factura pendiente. La
  // suscripcion que se cobra es siempre la del titular (resolveUserSubscription de mas abajo).

  try {
    const stripeClient = requireStripe();
    const resolved = await resolveUserSubscription(stripeClient, req.user.id);
    const subscription = resolved.subscription;
    // Los cambios de estado se guardan en la metadata del TITULAR: si los guardasemos en la del
    // empleado que paga, el aviso de impago seguiria activo en la cuenta y la app no se desbloquearia.
    const ownerUserId = resolved.user?.id || req.user.id;
    if (!subscription) {
      return res.status(409).json({ ok: false, error: 'Todavía no hay una suscripción activa.' });
    }

    const updated = await stripeClient.subscriptions.retrieve(resolved.subscriptionId, {
      expand: ['latest_invoice', 'latest_invoice.payment_intent', 'default_payment_method'],
    });
    const invoice = updated.latest_invoice && typeof updated.latest_invoice === 'object'
      ? updated.latest_invoice
      : null;

    if (!invoice || invoice.status === 'paid' || invoice.status === 'void') {
      await updateUserMetadata(ownerUserId, { stripe_subscription_status: updated.status || 'active' });
      return res.json({ ok: true, alreadyPaid: true, status: updated.status || 'active' });
    }

    // Sin tarjeta guardada no hay nada con que cobrar: se pide una antes de reintentar.
    const defaultMethod = updated.default_payment_method && typeof updated.default_payment_method === 'object'
      ? updated.default_payment_method
      : null;
    if (!defaultMethod) {
      return res.status(402).json({
        ok: false,
        needsPaymentMethod: true,
        error: 'No hay ninguna tarjeta guardada en Stripe. Guarda una tarjeta para poder pagar la factura pendiente.',
      });
    }

    const paid = await stripeClient.invoices.pay(invoice.id, {
      payment_method: defaultMethod.id,
    });
    const subscriptionAfter = await stripeClient.subscriptions.retrieve(resolved.subscriptionId);

    await updateUserMetadata(ownerUserId, {
      stripe_subscription_status: subscriptionAfter.status || 'active',
      stripe_past_due_since: null,
      stripe_subscription_updated_at: new Date().toISOString(),
    });

    return res.json({
      ok: true,
      alreadyPaid: false,
      status: subscriptionAfter.status || 'active',
      amountPaidCents: Number(paid.amount_paid) || Number(paid.total) || 0,
    });
  } catch (error) {
    const needsPaymentMethod = errorNeedsPaymentMethod(error);
    console.error('Error cobrando la factura pendiente:', error.message);
    return res.status(needsPaymentMethod ? 402 : 502).json({
      ok: false,
      needsPaymentMethod,
      error: needsPaymentMethod
        ? 'No hay ninguna tarjeta guardada en Stripe. Guarda una tarjeta para poder pagar la factura pendiente.'
        : `Stripe no pudo cobrar la factura pendiente: ${error.message}`,
    });
  }
});

// Cierra en Supabase una sesión recién creada que no se va a usar (best effort).
const revokeSession = async (accessToken) => {
  try {
    await supabase.auth.admin.signOut(accessToken, 'local');
  } catch (error) {
    console.warn('No se pudo revocar la sesión:', error.message);
  }
};

const employeeLoginAttempts = new Map();

app.post('/api/auth/employee-login', async (req, res) => {
  const companyEmail = typeof req.body?.companyEmail === 'string' ? req.body.companyEmail.trim().toLowerCase() : '';
  const fullName = typeof req.body?.fullName === 'string' ? req.body.fullName.trim().slice(0, 120) : '';
  const deviceId = normalizeDeviceId(req.body?.deviceId);
  const accessCode = req.body?.employeeAccessCode;
  if (!deviceId) return res.status(400).json({ ok: false, code: 'device_required', error: 'Reinicia la app para identificar este dispositivo.' });
  if (!/^[^\s@]+@[^\s@]+$/.test(companyEmail) || !fullName || normalizeEmployeeAccessCode(accessCode).length < 8) {
    return res.status(400).json({ ok: false, error: 'Indica tu nombre completo, el correo del usuario principal y su código de acceso.' });
  }
  const now = Date.now();
  for (const [key, attempt] of employeeLoginAttempts) {
    if (attempt.until <= now) employeeLoginAttempts.delete(key);
  }
  const attemptKey = req.ip || req.socket?.remoteAddress || 'unknown';
  const attempt = employeeLoginAttempts.get(attemptKey) || { count: 0, until: now + 15 * 60 * 1000 };
  if (attempt.count >= 10) return res.status(429).json({ ok: false, error: 'Demasiados intentos. Vuelve a intentarlo en 15 minutos.' });
  attempt.count += 1;
  employeeLoginAttempts.set(attemptKey, attempt);
  try {
    const principal = await findPrincipalByEmployeeAccessCode(accessCode, companyEmail);
    if (!principal) return res.status(401).json({ ok: false, error: 'El correo de la empresa o el código no son correctos.' });
    return await withAccountLock(principal.id, async () => {
      const owner = await fetchAuthoritativeUser(principal.id);
      if (!owner || owner.email?.toLowerCase() !== companyEmail || !employeeAccessCodeMatches(owner.app_metadata, employeeAccessCodeCandidates(accessCode))) {
        return res.status(401).json({ ok: false, error: 'El correo de la empresa o el código no son correctos.' });
      }
      const identity = crypto.createHash('sha256').update(`${owner.id}:${deviceId}`).digest('hex');
      const email = `${identity}@employees.tpv.invalid`;
      let employee = null;
      let occupiedSeats = 0;
      for (let page = 1; ; page += 1) {
        const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) throw error;
        const users = data?.users || [];
        employee ||= users.find((user) => user.email === email);
        occupiedSeats += users.filter((user) => user.app_metadata?.company_owner_id === owner.id &&
          Boolean(user.app_metadata?.active_session_id || user.app_metadata?.active_device_id)).length;
        if (users.length < 1000) break;
      }
      if (employee && (employee.app_metadata?.role !== 'empleado' || employee.app_metadata?.company_owner_id !== owner.id)) {
        return res.status(403).json({ ok: false, error: 'No se pudo verificar la vinculación con la empresa.' });
      }
      let seats = Math.max(0, Math.floor(Number(owner.user_metadata?.stripe_subscription_additional_users) || 0));
      if (stripe) {
        const resolved = await resolveUserSubscription(stripe, owner.id);
        seats = resolved.subscription ? readSubscriptionSeats(resolved.subscription) : 0;
      }
      const alreadyActive = Boolean(employee?.app_metadata?.active_session_id || employee?.app_metadata?.active_device_id);
      if (seats === 0 || (!alreadyActive && occupiedSeats >= seats)) {
        return res.status(403).json({ ok: false, error: 'No hay plazas adicionales disponibles. El usuario principal debe ampliar las plazas o cerrar otra sesión adicional.' });
      }
      const password = crypto.randomBytes(32).toString('hex');
      const attributes = {
        password,
        user_metadata: { full_name: fullName, company_name: owner.user_metadata?.company_name || '' },
        app_metadata: { role: 'empleado', company_owner_id: owner.id, active_device_id: deviceId },
      };
      const saved = employee
        ? await supabase.auth.admin.updateUserById(employee.id, attributes)
        : await supabase.auth.admin.createUser({ ...attributes, email, email_confirm: true });
      if (saved.error || !saved.data?.user) throw saved.error || new Error('No se pudo crear el acceso adicional.');
      const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });
      if (error || !data?.session?.access_token) throw error || new Error('No se pudo iniciar la sesión.');
      const verified = await verifyAccessToken(data.session.access_token);
      if (!verified || verified.user.id !== saved.data.user.id) {
        await revokeSession(data.session.access_token);
        throw new Error('No se pudo verificar la sesión adicional.');
      }
      const linked = await updateUserAppMetadata(saved.data.user.id, { active_session_id: verified.sessionId });
      if (linked.error || !linked.data?.user) {
        await revokeSession(data.session.access_token);
        throw linked.error || new Error('No se pudo guardar la sesión adicional.');
      }
      employeeLoginAttempts.delete(attemptKey);
      return res.json({ ok: true, user: linked.data.user, session: data.session });
    });
  } catch {
    return res.status(500).json({ ok: false, error: 'No se pudo iniciar el acceso adicional. Inténtalo de nuevo.' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  const { email, password, fullName, companyName, role, employeeAccessCode } = req.body || {};
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const requestedRole = role === 'empleado' ? 'empleado' : 'principal';
  const normalizedFullName = typeof fullName === 'string' ? fullName.trim().slice(0, 120) : '';
  const normalizedCompanyName = typeof companyName === 'string' ? companyName.trim().slice(0, 160) : '';
  const deviceId = normalizeDeviceId(req.body?.deviceId);

  if (!normalizedEmail || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ ok: false, error: 'Indica un email válido y una contraseña de al menos 8 caracteres.' });
  }
  if (!deviceId) {
    return res.status(400).json({ ok: false, code: 'device_required', error: 'Falta el identificador de este dispositivo. Reinicia la app e inténtalo de nuevo.' });
  }
  if (!normalizedFullName) {
    return res.status(400).json({ ok: false, error: 'Indica tu nombre completo.' });
  }
  if (requestedRole === 'principal' && !normalizedCompanyName) {
    return res.status(400).json({ ok: false, error: 'Indica el nombre de la empresa.' });
  }

  let principal = null;
  if (requestedRole === 'empleado') {
    if (normalizeEmployeeAccessCode(employeeAccessCode).length < 8) {
      return res.status(400).json({ ok: false, error: 'Introduce el código de acceso que te ha dado el principal.' });
    }
    try {
      principal = await findPrincipalByEmployeeAccessCode(employeeAccessCode);
    } catch (error) {
      console.error('Error buscando el código de empleado:', error.message);
      return res.status(500).json({ ok: false, error: 'No se pudo validar el código de empleado.' });
    }
    if (!principal) {
      return res.status(400).json({ ok: false, error: 'El código de empleado no es válido.' });
    }
  }

  const registerAccount = async () => {
    // Bajo el bloqueo del principal se vuelve a comprobar el código: si otro alta lo acaba de
    // consumir, este registro no debe usarlo.
    let owner = null;
    if (principal) {
      owner = await fetchAuthoritativeUser(principal.id);
      if (!owner || !employeeAccessCodeMatches(owner.app_metadata, employeeAccessCodeCandidates(employeeAccessCode))) {
        return res.status(400).json({ ok: false, error: 'El código de empleado no es válido.' });
      }
    }
    // El empleado hereda la empresa del principal: no se le pide.
    const resolvedCompanyName = owner
      ? String(owner.user_metadata?.company_name || '').trim()
      : normalizedCompanyName;

    const { data, error } = await supabaseAuth.auth.signUp({
      email: normalizedEmail,
      password,
      options: {
        data: {
          full_name: normalizedFullName,
          company_name: resolvedCompanyName,
        },
      },
    });

    if (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }

    // Email ya registrado: Supabase devuelve un usuario ofuscado sin identidades (o uno real ya
    // configurado). Nunca se toca esa cuenta ni se consume el código; respuesta neutra.
    const identities = data?.user?.identities;
    const created = data?.user && Array.isArray(identities) && identities.length > 0
      ? await fetchAuthoritativeUser(data.user.id)
      : null;
    if (!created || created.app_metadata?.role) {
      return res.status(201).json({ ok: true, user: null, session: null, requiresEmailConfirmation: true });
    }

    let sessionId = null;
    if (data.session?.access_token) {
      const verified = await verifyAccessToken(data.session.access_token);
      if (!verified || verified.user.id !== created.id) {
        await supabase.auth.admin.deleteUser(created.id).catch(() => undefined);
        return res.status(502).json({ ok: false, error: 'No se pudo verificar la sesión de la cuenta nueva.' });
      }
      sessionId = verified.sessionId;
    }

    const { data: updatedUser, error: metadataError } = await updateUserAppMetadata(created.id, {
      role: requestedRole,
      ...(owner ? { company_owner_id: owner.id } : {}),
      active_device_id: deviceId,
      // Sin sesión (email por confirmar) se enlaza al iniciar sesión desde este mismo dispositivo.
      ...(sessionId ? { active_session_id: sessionId } : {}),
    });
    if (metadataError || !updatedUser?.user) {
      console.error('Error asignando el rol de la cuenta:', metadataError?.message);
      // Sin rol la cuenta se trataría como principal: se elimina la cuenta recién creada.
      await supabase.auth.admin.deleteUser(created.id).catch(() => undefined);
      return res.status(500).json({ ok: false, error: 'No se pudo asignar el acceso de la cuenta.' });
    }

    if (owner) {
      const { error: codeError } = await updateUserAppMetadata(owner.id, {
        employee_access_code_salt: null,
        employee_access_code_hash: null,
      });
      if (codeError) console.error('Error invalidando el código de empleado:', codeError.message);
    }

    return res.status(201).json({
      ok: true,
      user: updatedUser.user,
      session: data.session,
      requiresEmailConfirmation: !data.session,
    });
  };

  return principal ? withAccountLock(principal.id, registerAccount) : registerAccount();
});

app.post('/api/auth/employee-access-code', requireAuth, async (req, res) => {
  if (!isPrincipal(req.user)) {
    return res.status(403).json({ ok: false, error: 'Solo el usuario principal puede crear códigos de empleado.' });
  }

  const accessCode = normalizeEmployeeAccessCode(req.body?.accessCode) || crypto.randomBytes(8).toString('hex').toUpperCase();
  if (accessCode.length < 8) {
    return res.status(400).json({ ok: false, error: 'El código debe tener al menos 8 caracteres.' });
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const { error } = await updateUserAppMetadata(req.user.id, {
    employee_access_code_salt: salt,
    employee_access_code_hash: hashEmployeeAccessCode(accessCode, salt),
  });
  if (error) {
    console.error('Error guardando el código de empleado:', error.message);
    return res.status(500).json({ ok: false, error: 'No se pudo guardar el código de empleado.' });
  }

  return res.json({ ok: true, accessCode, companyEmail: req.user.email });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  // Sesión única: cada cuenta solo puede estar abierta en un dispositivo a la vez.
  const deviceId = normalizeDeviceId(req.body?.deviceId);
  const force = req.body?.force === true;

  if (!normalizedEmail || typeof password !== 'string' || password.length === 0) {
    return res.status(400).json({ ok: false, error: 'Indica email y contraseña.' });
  }
  if (!deviceId) {
    return res.status(400).json({ ok: false, code: 'device_required', error: 'Falta el identificador de este dispositivo. Reinicia la app e inténtalo de nuevo.' });
  }

  const { data, error } = await supabaseAuth.auth.signInWithPassword({
    email: normalizedEmail,
    password,
  });

  if (error || !data?.user || !data?.session?.access_token) {
    return res.status(401).json({ ok: false, error: 'Email o contraseña incorrectos.' });
  }

  const verified = await verifyAccessToken(data.session.access_token);
  if (!verified || verified.user.id !== data.user.id) {
    return res.status(401).json({ ok: false, error: 'La sesión no es válida o ha caducado.' });
  }

  return withAccountLock(data.user.id, async () => {
    const fresh = await fetchAuthoritativeUser(data.user.id);
    if (!fresh) {
      await revokeSession(data.session.access_token);
      return res.status(500).json({ ok: false, error: 'No se pudo leer la cuenta.' });
    }
    const metadata = fresh.app_metadata || {};
    const activeDevice = typeof metadata.active_device_id === 'string' && metadata.active_device_id ? metadata.active_device_id : null;
    const activeSession = typeof metadata.active_session_id === 'string' && metadata.active_session_id ? metadata.active_session_id : null;
    const occupiedElsewhere = Boolean(activeDevice || activeSession) && activeDevice !== deviceId;

    // Abierta en otro dispositivo: se bloquea salvo traslado explícito; la sesión nueva se descarta.
    if (occupiedElsewhere && !force) {
      await revokeSession(data.session.access_token);
      return deviceConflict(res);
    }

    const { data: updatedUser, error: metaError } = await updateUserAppMetadata(fresh.id, {
      active_device_id: deviceId,
      active_session_id: verified.sessionId,
    });
    if (metaError || !updatedUser?.user) {
      console.error('Error registrando el dispositivo activo:', metaError?.message);
      await revokeSession(data.session.access_token);
      return res.status(500).json({ ok: false, error: 'No se pudo registrar el dispositivo.' });
    }

    return res.json({ ok: true, user: updatedUser.user, session: data.session });
  });
});

// Renueva la sesión del móvil con el refresh token guardado. Los access tokens de Supabase caducan
// en ~1 hora: sin este refresco la app seguiría publicando documentos con un token caducado y los
// tickets quedarían en la nube sin dueño (imposibles de recuperar con "Sincronizar historial").
app.post('/api/auth/refresh', async (req, res) => {
  const refreshToken = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken.trim() : '';
  if (!refreshToken) {
    return res.status(400).json({ ok: false, error: 'Falta el refresh token de la sesión.' });
  }

  const { data, error } = await supabaseAuth.auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data?.session?.access_token) {
    return res.status(401).json({ ok: false, error: 'La sesión ha caducado. Vuelve a iniciar sesión.' });
  }

  const verified = await verifyAccessToken(data.session.access_token);
  if (!verified) {
    return res.status(401).json({ ok: false, error: 'La sesión ha caducado. Vuelve a iniciar sesión.' });
  }
  // Una sesión trasladada a otro dispositivo no se puede renovar (los marcadores no se tocan).
  if (sessionBindingState(verified.user, verified.sessionId) === 'conflict') {
    return deviceConflict(res);
  }

  return res.json({ ok: true, user: verified.user, session: data.session });
});

// Única ruta que puede enlazar o trasladar la sesión. Usa solo la verificación del token (no
// requireAuth) para que una sesión antigua o de otro dispositivo pueda pedir el traslado explícito.
app.get('/api/auth/me', requireVerifiedToken, async (req, res) => {
  const deviceId = normalizeDeviceId(req.headers['x-device-id']);
  const force = String(req.headers['x-device-force'] || '') === '1';

  return withAccountLock(req.user.id, async () => {
    const fresh = await fetchAuthoritativeUser(req.user.id);
    if (!fresh) {
      return res.status(401).json({ ok: false, error: 'La sesión no es válida o ha caducado.' });
    }
    const metadata = fresh.app_metadata || {};
    const activeDevice = typeof metadata.active_device_id === 'string' && metadata.active_device_id ? metadata.active_device_id : null;
    const activeSession = typeof metadata.active_session_id === 'string' && metadata.active_session_id ? metadata.active_session_id : null;

    if (activeSession === req.authSessionId && (!deviceId || !activeDevice || activeDevice === deviceId)) {
      return res.json({ ok: true, user: fresh });
    }

    if (!deviceId) {
      if (activeSession || activeDevice) return deviceConflict(res);
      return res.status(400).json({ ok: false, code: 'device_required', error: 'Falta el identificador de este dispositivo.' });
    }

    // Sesión antigua sin enlazar desde su propio dispositivo: se enlaza. Cualquier otro caso es un
    // conflicto que solo se resuelve con traslado explícito.
    const occupied = Boolean(activeSession) || (Boolean(activeDevice) && activeDevice !== deviceId);
    if (occupied && !force) return deviceConflict(res);

    const { data: updatedUser, error: metaError } = await updateUserAppMetadata(fresh.id, {
      active_device_id: deviceId,
      active_session_id: req.authSessionId,
    });
    if (metaError || !updatedUser?.user) {
      console.error('Error enlazando la sesión al dispositivo:', metaError?.message);
      return res.status(500).json({ ok: false, error: 'No se pudo trasladar la sesión a este dispositivo.' });
    }
    return res.json({ ok: true, user: updatedUser.user, transferred: occupied });
  });
});

// Cierre de sesión: libera el dispositivo solo si esta sesión es la activa, y revoca la sesión.
app.post('/api/auth/logout', requireVerifiedToken, async (req, res) => {
  await withAccountLock(req.user.id, async () => {
    const fresh = await fetchAuthoritativeUser(req.user.id);
    if (fresh && sessionBindingState(fresh, req.authSessionId) === 'ok') {
      const { error } = await updateUserAppMetadata(fresh.id, { active_device_id: null, active_session_id: null });
      if (error) console.error('Error liberando el dispositivo activo:', error.message);
    }
  });
  await revokeSession(req.authToken);
  return res.json({ ok: true });
});

app.post('/api/stripe/terminal/connection-token', requireAuth, async (req, res) => {
  let connected = null;
  try {
    connected = await stripeConnect.resolveTerminalContext(req);
  } catch (error) {
    const mapped = connectChargeError(error);
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error('Error resolviendo cuenta Connect para Terminal:', error.message);
    return res.status(502).json({ ok: false, code: 'connect_upstream_unavailable', error: 'No se pudo preparar Stripe Terminal Connect.' });
  }

  try {
    const stripeClient = connected?.stripe || requireStripe();
    const requestOptions = connected ? { stripeAccount: connected.accountId } : {};
    const token = await stripeClient.terminal.connectionTokens.create({}, requestOptions);
    return res.status(201).json({
      ok: true,
      secret: token.secret,
      accountId: connected?.accountId || null,
      locationId: connected?.locationId || null,
      chargeMode: connected ? 'direct' : 'platform',
    });
  } catch (error) {
    console.error('Error creando token Stripe Terminal:', error.message);
    return res.status(502).json({ ok: false, error: `Stripe Terminal: ${error.message}` });
  }
});

app.post('/api/stripe/payment-intent', requireAuth, async (req, res) => {
  const amountNumber = typeof req.body?.amount === 'string'
    ? Number(req.body.amount.replace(',', '.'))
    : Number(req.body?.amount);
  const amount = Math.round(amountNumber * 100);
  const orderId = typeof req.body?.orderId === 'string' ? req.body.orderId.trim() : '';

  if (!Number.isFinite(amountNumber) || !Number.isInteger(amount) || amount < 50 || amount > 99999999) {
    return res.status(400).json({ ok: false, error: 'Importe no válido. Usa al menos 0,50 €.' });
  }

  let connected = null;
  try {
    connected = await stripeConnect.resolveTerminalContext(req);
  } catch (error) {
    const mapped = connectChargeError(error);
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error('Error resolviendo cuenta Connect para PaymentIntent:', error.message);
    return res.status(502).json({ ok: false, code: 'connect_upstream_unavailable', error: 'No se pudo preparar el cobro Terminal Connect.' });
  }

  try {
    const ownerId = connected?.ownerId || req.user.app_metadata?.company_owner_id || req.user.id;
    const stripeClient = connected?.stripe || requireStripe();
    const requestOptions = connected ? { stripeAccount: connected.accountId } : {};
    const paymentIntent = await stripeClient.paymentIntents.create({
      amount,
      currency: stripeCurrency,
      payment_method_types: ['card_present'],
      capture_method: 'automatic',
      metadata: {
        supabase_user_id: ownerId,
        operator_user_id: req.user.id,
        order_id: orderId,
        ...(connected ? {
          stripe_connect_account_id: connected.accountId,
          charge_mode: 'direct',
        } : { charge_mode: 'platform' }),
      },
    }, requestOptions);
    return res.status(201).json({
      ok: true,
      paymentIntentId: paymentIntent.id,
      clientSecret: paymentIntent.client_secret,
      accountId: connected?.accountId || null,
      locationId: connected?.locationId || null,
      chargeMode: connected ? 'direct' : 'platform',
    });
  } catch (error) {
    console.error('Error creando PaymentIntent Stripe Terminal:', error.message);
    return res.status(502).json({ ok: false, error: `Stripe Terminal: ${error.message}` });
  }
});

app.post('/api/stripe/payment', requireAuth, async (req, res) => {
  const amountNumber = typeof req.body?.amount === 'string'
    ? Number(req.body.amount.replace(',', '.'))
    : Number(req.body?.amount);
  const amount = Math.round(amountNumber * 100);
  const orderId = typeof req.body?.orderId === 'string' ? req.body.orderId.trim() : '';

  if (!Number.isFinite(amountNumber) || !Number.isInteger(amount) || amount < 50 || amount > 99999999) {
    return res.status(400).json({ ok: false, error: 'Importe no válido. Usa al menos 0,50 €.' });
  }
  if (!orderId) {
    return res.status(400).json({ ok: false, error: 'Falta el identificador de la operación.' });
  }

  let connected = null;
  try {
    // Connect activo: cobro directo en la cuenta del comercio. Sin fallback a la plataforma.
    connected = await stripeConnect.resolveConnectedAccount(req, { requireCharges: true });
  } catch (error) {
    const mapped = connectChargeError(error);
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error('Error resolviendo cuenta Connect para cobro:', error.message);
    return res.status(502).json({ ok: false, code: 'connect_upstream_unavailable', error: 'No se pudo preparar el cobro Connect.' });
  }

  try {
    // Métodos dinámicos (Bizum incluido): no se pasa payment_method_types salvo que se configure
    // una lista explícita en STRIPE_PAYMENT_METHOD_TYPES.
    const ownerId = connected?.ownerId || req.user.app_metadata?.company_owner_id || req.user.id;
    const requestedPaymentMethodTypes = resolveCheckoutPaymentMethodTypes(amount);
    const checkoutSessionParams = {
      mode: 'payment',
      ...(requestedPaymentMethodTypes ? { payment_method_types: requestedPaymentMethodTypes } : {}),
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: stripeCurrency,
            unit_amount: amount,
            product_data: {
              name: `TPV - ${orderId}`,
            },
          },
        },
      ],
      metadata: {
        supabase_user_id: ownerId,
        operator_user_id: req.user.id,
        order_id: orderId,
        ...(connected ? {
          stripe_connect_account_id: connected.accountId,
          charge_mode: 'direct',
        } : { charge_mode: 'platform' }),
      },
      payment_intent_data: {
        metadata: {
          supabase_user_id: ownerId,
          operator_user_id: req.user.id,
          order_id: orderId,
          ...(connected ? {
            stripe_connect_account_id: connected.accountId,
            charge_mode: 'direct',
          } : { charge_mode: 'platform' }),
        },
      },
      success_url: `${PUBLIC_API_URL}/stripe/complete?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_API_URL}/stripe/cancel?orderId=${encodeURIComponent(orderId)}`,
    };
    const { session, paymentMethodTypes } = await createCheckoutSessionWithLocalMethodsFallback(
      checkoutSessionParams,
      requestedPaymentMethodTypes,
      connected ? { stripeClient: connected.stripe, stripeAccount: connected.accountId } : {},
    );

    const redirectUrl = session.url;
    const qrDataUrl = redirectUrl
      ? await QRCode.toDataURL(redirectUrl, { width: 420, margin: 2 })
      : null;

    return res.status(201).json({
      ok: true,
      paymentId: session.id,
      redirectUrl,
      checkoutUrl: redirectUrl,
      qrDataUrl,
      paymentMethods: paymentMethodTypes || 'auto',
      amount,
      accountId: connected?.accountId || null,
      chargeMode: connected ? 'direct' : 'platform',
      paymentIntentId: typeof session.payment_intent === 'string'
        ? session.payment_intent
        : (session.payment_intent?.id || null),
    });
  } catch (error) {
    console.error('Error creando pago Stripe:', error.message);
    return res.status(502).json({ ok: false, error: `Stripe: ${error.message}` });
  }
});

app.get('/api/stripe/payment/:paymentId', requireAuth, async (req, res) => {
  try {
    // Se expande payment_intent + payment_method para detectar rechazos (p. ej. Bizum
    // declinado por el banco) y saber con qué método pagó el cliente.
    let connected = null;
    try {
      // Sin exigir chargesEnabled: se puede consultar un cobro ya creado aunque falten requisitos.
      connected = await stripeConnect.resolveConnectedAccount(req, { requireCharges: false });
    } catch (error) {
      if (error?.code === 'connect_not_connected') {
        connected = null;
      } else {
        const mapped = connectChargeError(error);
        if (mapped) return res.status(mapped.status).json(mapped.body);
        console.error('Error resolviendo cuenta Connect para consulta:', error.message);
        return res.status(502).json({ ok: false, error: 'No se pudo consultar el estado del pago Stripe.' });
      }
    }

    const retrieveOptions = {
      expand: ['payment_intent.payment_method', 'payment_intent.last_payment_error.payment_method'],
    };
    const session = connected
      ? await connected.stripe.checkout.sessions.retrieve(req.params.paymentId, retrieveOptions, {
        stripeAccount: connected.accountId,
      })
      : await requireStripe().checkout.sessions.retrieve(req.params.paymentId, retrieveOptions);
    const ownerId = connected?.ownerId || req.user.app_metadata?.company_owner_id || req.user.id;
    const paymentUserId = session.metadata?.supabase_user_id;
    const paymentUser = paymentUserId && paymentUserId !== ownerId ? await fetchAuthoritativeUser(paymentUserId) : null;
    if (paymentUserId !== ownerId && paymentUser?.app_metadata?.company_owner_id !== ownerId) {
      return res.status(403).json({ ok: false, error: 'Este pago no pertenece a tu empresa.' });
    }
    // Cobro directo: la cuenta de la sesión debe coincidir con la vinculada al comercio.
    if (connected && session.metadata?.stripe_connect_account_id
      && session.metadata.stripe_connect_account_id !== connected.accountId) {
      return res.status(403).json({ ok: false, error: 'Este pago no pertenece a tu empresa.' });
    }
    return res.json({
      ok: true,
      paymentId: session.id,
      status: normalizeStripePaymentStatus(session),
      checkoutStatus: session.status,
      paymentStatus: session.payment_status,
      usedMethod: resolveOnlinePaymentUsedMethod(session),
      amount: session.amount_total,
      currency: session.currency,
      accountId: connected?.accountId || session.metadata?.stripe_connect_account_id || null,
      chargeMode: session.metadata?.charge_mode || (connected ? 'direct' : 'platform'),
      paymentIntentId: typeof session.payment_intent === 'string'
        ? session.payment_intent
        : (session.payment_intent?.id || null),
    });
  } catch (error) {
    console.error('Error consultando pago Stripe:', error.message);
    return res.status(502).json({ ok: false, error: 'No se pudo consultar el estado del pago Stripe.' });
  }
});

// Diagnóstico: indica qué métodos saldrán en el Checkout y el estado de Bizum en la cuenta.
// Admite ?probe=1: crea una sesión de Checkout real de 1,00 € (se caduca al momento, no cobra nada)
// y devuelve los métodos que Stripe resuelve de verdad para esta cuenta.
app.get('/api/stripe/payment-methods', requireAuth, async (req, res) => {
  const warnings = [];
  const bizum = { capability: null, enabledInDashboard: null, available: null };
  const methods = {};
  const accountInfo = { country: null, chargesEnabled: null, payoutsEnabled: null, detailsSubmitted: null, disabledReason: null, defaultCurrency: null };
  let livemode = null;
  let accountCountry = null;
  let effectiveCheckoutMethods = null;
  let probe = null;

  try {
    const stripeClient = requireStripe();

    try {
      const account = await stripeClient.accounts.retrieve();
      bizum.capability = account?.capabilities?.bizum_payments || null;
      livemode = account?.livemode ?? null;
      accountCountry = account?.country || null;
      accountInfo.country = account?.country || null;
      accountInfo.chargesEnabled = account?.charges_enabled ?? null;
      accountInfo.payoutsEnabled = account?.payouts_enabled ?? null;
      accountInfo.detailsSubmitted = account?.details_submitted ?? null;
      accountInfo.disabledReason = account?.requirements?.disabled_reason || null;
      accountInfo.defaultCurrency = account?.default_currency || null;
    } catch (error) {
      warnings.push(`No se pudieron leer las capacidades de la cuenta: ${error.message}`);
    }

    let configuration = null;
    try {
      configuration = await readDefaultPaymentMethodConfiguration();
      livemode = livemode ?? configuration?.livemode ?? null;
      for (const method of ['card', ...EUR_LOCAL_PAYMENT_METHODS]) {
        const entry = configuration?.[method];
        methods[method] = {
          present: Boolean(entry),
          available: typeof entry?.available === 'boolean' ? entry.available : null,
          preference: entry?.display_preference?.value || null,
        };
      }
      if (configuration?.bizum) {
        bizum.available = configuration.bizum.available === true;
        bizum.enabledInDashboard = configuration.bizum.display_preference?.value || null;
      }
    } catch (error) {
      warnings.push(`No se pudo leer la configuración de métodos de pago: ${error.message}`);
    }

    // Lista efectiva que se pedirá en el Checkout (misma regla que el cobro real).
    if (stripeDynamicPaymentMethods) {
      effectiveCheckoutMethods = 'dinámicos';
    } else {
      const effective = stripePaymentMethodTypes.filter((method) => method === 'card' || configuration?.[method]?.available !== false);
      effectiveCheckoutMethods = effective.length > 0 ? effective : ['card'];
    }

    // Sondeo opcional: comprobar con Stripe qué métodos resolvería el Checkout de verdad.
    if (String(req.query?.probe || '') === '1') {
      try {
        const probeTypes = resolveCheckoutPaymentMethodTypes(100);
        const { session, paymentMethodTypes } = await createCheckoutSessionWithLocalMethodsFallback({
          mode: 'payment',
          ...(probeTypes ? { payment_method_types: probeTypes } : {}),
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: stripeCurrency,
                unit_amount: 100,
                product_data: { name: 'Comprobación de métodos de pago' },
              },
            },
          ],
          metadata: { supabase_user_id: req.user.id, diagnostic: 'payment-methods-probe' },
          success_url: `${PUBLIC_API_URL}/stripe/complete`,
          cancel_url: `${PUBLIC_API_URL}/stripe/cancel`,
        }, probeTypes);

        const sessionTypes = Array.isArray(session.payment_method_types) && session.payment_method_types.length > 0
          ? session.payment_method_types
          : null;

        probe = {
          requested: paymentMethodTypes || 'dinámicos',
          resolved: sessionTypes || paymentMethodTypes,
          resolvedFromSession: sessionTypes,
          configurationId: session.payment_method_configuration || null,
          amount: session.amount_total,
          currency: session.currency,
        };

        try {
          await stripeClient.checkout.sessions.expire(session.id);
        } catch (error) {
          warnings.push(`La sesión de comprobación no se pudo caducar: ${error.message}`);
        }
      } catch (error) {
        warnings.push(`No se pudo comprobar el Checkout real: ${error.message}`);
      }
    }

    return res.json({
      ok: true,
      checkoutMode: stripeDynamicPaymentMethods ? 'dynamic' : 'list',
      dynamicPaymentMethods: stripeDynamicPaymentMethods,
      envPaymentMethodTypes: process.env.STRIPE_PAYMENT_METHOD_TYPES ?? null,
      configuredSetting: stripeDynamicPaymentMethods ? 'auto' : stripePaymentMethodTypes.join(','),
      requestedForOnlinePayments: stripeDynamicPaymentMethods
        ? 'Dinámicos: Stripe muestra los métodos activados en el Dashboard'
        : stripePaymentMethodTypes,
      effectiveCheckoutMethods,
      methods,
      livemode,
      accountCountry,
      accountInfo,
      configurationId: configuration?.id || null,
      configurationName: configuration?.name || null,
      configurationIsDefault: configuration?.is_default === true,
      configurationActive: configuration?.active !== false,
      dashboardUrl: livemode === true
        ? 'https://dashboard.stripe.com/settings/payment_methods'
        : 'https://dashboard.stripe.com/test/settings/payment_methods',
      bizum,
      probe,
      warnings,
    });
  } catch (error) {
    return res.status(502).json({ ok: false, error: `Stripe: ${error.message}` });
  }
});

// Configuración de la cuenta de Stripe: país, estado de cobros/pagos y cuenta bancaria, junto con
// los enlaces directos al Dashboard (test o live) donde el comercio configura DÓNDE recibe el
// dinero. Se usa desde Config -> "Configurar tu cuenta de Stripe".
app.get('/api/stripe/account', requireAuth, async (req, res) => {
  try {
    const stripeClient = requireStripe();
    const snapshot = await buildStripeAccountSnapshot(stripeClient);
    return res.json({ ok: true, ...snapshot });
  } catch (error) {
    console.error('Error consultando la cuenta de Stripe:', error.message);
    return res.status(502).json({ ok: false, error: `Stripe: ${error.message}` });
  }
});

// Activa Bizum en la configuración de métodos de pago por defecto de la cuenta. Endpoint de API y
// soporte: la app ya no lo llama desde Config (sus botones de Bizum se retiraron), porque con
// métodos dinámicos basta con activar Bizum en Stripe (Settings -> Payment methods). Usa la misma
// clave de Stripe del backend y devuelve el resultado real de la API. Nota: solo funciona si la
// cuenta ya puede usar Bizum (ubicación de negocio en España y capacidad verificada); si no, se
// devuelve el motivo exacto.
app.post('/api/stripe/enable-bizum', requireAuth, async (req, res) => {
  try {
    const stripeClient = requireStripe();

    let account = null;
    try {
      account = await stripeClient.accounts.retrieve();
    } catch (error) {
      console.warn('No se pudieron leer los datos de la cuenta de Stripe:', error.message);
    }

    const configuration = await readDefaultPaymentMethodConfiguration();
    if (!configuration?.id) {
      return res.status(409).json({
        ok: false,
        error: 'No se encontró la configuración de métodos de pago por defecto en tu cuenta de Stripe.',
        accountCountry: account?.country || null,
        dashboardUrl: account?.livemode === true
          ? 'https://dashboard.stripe.com/settings/payment_methods'
          : 'https://dashboard.stripe.com/test/settings/payment_methods',
      });
    }

    const capability = String(account?.capabilities?.bizum_payments || '').toLowerCase() || null;
    const before = {
      available: typeof configuration?.bizum?.available === 'boolean' ? configuration.bizum.available : null,
      preference: configuration?.bizum?.display_preference?.value || null,
    };

    try {
      const updated = await stripeClient.paymentMethodConfigurations.update(configuration.id, {
        bizum: { display_preference: { preference: 'on' } },
      });

      // Invalidar la caché para que el siguiente cobro y el diagnóstico lean el estado nuevo.
      cachedPaymentMethodConfiguration = null;
      cachedPaymentMethodConfigurationAt = 0;

      return res.json({
        ok: true,
        activated: true,
        configurationId: configuration.id,
        configurationName: configuration.name || null,
        before,
        after: {
          available: typeof updated?.bizum?.available === 'boolean' ? updated.bizum.available : null,
          preference: updated?.bizum?.display_preference?.value || null,
        },
        accountCountry: account?.country || null,
        capability,
      });
    } catch (error) {
      const raw = String(error?.message || 'error desconocido de Stripe');
      const lower = raw.toLowerCase();
      let hint = '';
      if (lower.includes('not activated') || lower.includes('not enabled') || lower.includes('not available') || lower.includes('unsupported')) {
        hint = ' Stripe todavía no permite Bizum en esta cuenta: hay que activar la capacidad de Bizum (Dashboard → Settings → Payment methods → Bizum → "Turn on"). Si la opción no aparece o queda en revisión, escribe a soporte de Stripe pidiendo activar la capacidad "bizum_payments".';
      }
      if (account?.country && account.country !== 'ES') {
        hint += ` Además, tu cuenta está dada de alta en "${account.country}" y Bizum solo admite negocios con ubicación en España.`;
      }
      if (!account) {
        hint += ' No se pudieron leer los datos de la cuenta de Stripe para dar más detalle.';
      }
      return res.status(502).json({
        ok: false,
        activated: false,
        error: `Stripe no permitió activar Bizum: ${raw}.${hint}`,
        configurationId: configuration.id,
        before,
        accountCountry: account?.country || null,
        capability,
        dashboardUrl: account?.livemode === true
          ? 'https://dashboard.stripe.com/settings/payment_methods'
          : 'https://dashboard.stripe.com/test/settings/payment_methods',
      });
    }
  } catch (error) {
    return res.status(502).json({ ok: false, error: `Stripe: ${error.message}` });
  }
});

app.get('/stripe/complete', (req, res) => {
  const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id : '';
  const deepLink = `tpvapp://pago-completado${sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ''}`;

  res.type('html').send(`<!doctype html>
<html lang="es">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pago recibido</title>
  <style>body{font-family:system-ui,-apple-system,sans-serif;background:#f1f5f9;color:#0f172a;margin:0;padding:40px 24px;text-align:center}h1{font-size:22px}p{color:#475569;font-size:14px;line-height:20px}a{display:inline-block;margin-top:20px;padding:14px 22px;background:#0f766e;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:bold}</style>
  <script>window.location.replace(${JSON.stringify(deepLink)});</script>
  </head>
  <body>
    <h1>Pago recibido</h1>
    <p>Gracias. Volviendo a la aplicación para mostrar tu ticket...</p>
    <a href="${deepLink}">Volver a la aplicación</a>
  </body>
</html>`);
});

app.get('/stripe/cancel', (req, res) => {
  res.type('html').send('<h1>Pago cancelado</h1><p>Puedes volver a la aplicación e intentarlo de nuevo.</p>');
});

app.post('/api/billing/checkout', requireAuth, async (req, res) => {
  if (!isPrincipal(req.user)) {
    return res.status(403).json({ ok: false, error: 'Solo el usuario principal puede gestionar la suscripción.' });
  }
  const additionalUsers = Math.max(0, Math.min(50, Math.floor(Number(req.body?.additionalUsers) || 0)));
  const amount = 1089 + (additionalUsers * 303);
  const orderId = `subscription-${req.user.id}-${Date.now()}`;

  if (!STRIPE_MAIN_SUBSCRIPTION_PRICE_ID) {
    return res.status(500).json({ ok: false, error: 'STRIPE_MAIN_SUBSCRIPTION_PRICE_ID no está configurado en el backend.' });
  }

  if (additionalUsers > 0 && !STRIPE_ADDITIONAL_USER_PRICE_ID) {
    return res.status(500).json({ ok: false, error: 'STRIPE_ADDITIONAL_USER_PRICE_ID no está configurado en el backend.' });
  }

  const lineItems = [
    {
      price: STRIPE_MAIN_SUBSCRIPTION_PRICE_ID,
      quantity: 1,
    },
  ];

  if (additionalUsers > 0) {
    lineItems.push({
      price: STRIPE_ADDITIONAL_USER_PRICE_ID,
      quantity: additionalUsers,
    });
  }

  try {
    // Si ya hay una suscripcion activa no se crea otra: el cambio de plazas se hace con
    // POST /api/billing/seats, que actualiza la suscripcion existente con prorrateo.
    try {
      const existing = await resolveUserSubscription(requireStripe(), req.user.id);
      if (existing.subscription && ['active', 'trialing', 'past_due'].includes(existing.subscription.status)) {
        return res.status(409).json({
          ok: false,
          alreadySubscribed: true,
          error: 'Ya tienes una suscripción activa. Cambia las plazas de empleado desde Config y el importe se ajusta con prorrateo.',
        });
      }
    } catch (existingError) {
      console.warn('No se pudo comprobar si ya había suscripción:', existingError.message);
    }

    const session = await requireStripe().checkout.sessions.create({
      mode: 'subscription',
      customer_email: req.user.email,
      line_items: lineItems,
      // La suscripcion se contrata SOLO con tarjeta bancaria. Bizum, iDEAL, MB WAY... son metodos de
      // redireccion de un solo uso que NO admiten suscripciones: el primer cobro entraria bien, pero la
      // renovacion del mes siguiente fallaria al no quedar nada guardado con que cobrar. Stripe guarda
      // la tarjeta automaticamente, de modo que las renovaciones y las plazas de empleado se cobran de
      // esa misma tarjeta sin que el usuario tenga que hacer nada.
      payment_method_types: ['card'],
      metadata: {
        supabase_user_id: req.user.id,
        additional_users: String(additionalUsers),
        total_monthly_cents: String(amount),
      },
      subscription_data: {
        metadata: {
          supabase_user_id: req.user.id,
          additional_users: String(additionalUsers),
          total_monthly_cents: String(amount),
        },
      },
      success_url: `${PUBLIC_API_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_API_URL}/billing/cancelled?orderId=${encodeURIComponent(orderId)}`,
    });

    await updateUserMetadata(req.user.id, {
      subscription_provider: 'stripe',
      stripe_checkout_session_id: session.id,
      stripe_subscription_status: 'checkout_created',
      stripe_subscription_additional_users: String(additionalUsers),
      stripe_subscription_amount_cents: String(amount),
    });

    return res.status(201).json({
      ok: true,
      checkoutSessionId: session.id,
      checkoutUrl: session.url,
      redirectUrl: session.url,
      amount,
      additionalUsers,
    });
  } catch (error) {
    console.error('Error creando suscripción Stripe:', error.message);
    return res.status(502).json({ ok: false, error: `Stripe: ${error.message}` });
  }
});

// Ajusta las plazas de empleado (usuarios adicionales) de la suscripcion ya activa. Cobra el
// prorrateo en el acto (proration_behavior: 'always_invoice') y, si el cobro falla, Stripe no
// aplica el cambio (payment_behavior: 'error_if_incomplete') para no dejar la cuenta en impago.
app.post('/api/billing/seats', requireAuth, async (req, res) => {
  if (!isPrincipal(req.user)) {
    return res.status(403).json({ ok: false, error: 'Solo el usuario principal puede gestionar la suscripción.' });
  }
  if (!STRIPE_ADDITIONAL_USER_PRICE_ID) {
    return res.status(500).json({ ok: false, error: 'STRIPE_ADDITIONAL_USER_PRICE_ID no está configurado en el backend.' });
  }
  const requestedSeats = Math.max(0, Math.min(50, Math.floor(Number(req.body?.additionalUsers) || 0)));
  let subscriptionId = null;

  try {
    const stripeClient = requireStripe();
    const resolved = await resolveUserSubscription(stripeClient, req.user.id);
    subscriptionId = resolved.subscriptionId;
    const subscription = resolved.subscription;

    if (!subscription || !subscriptionId) {
      return res.status(409).json({
        ok: false,
        needsCheckout: true,
        error: 'Todavía no hay una suscripción activa: contrátala y las plazas de empleado se incluyen en el plan.',
      });
    }
    if (['canceled', 'unpaid', 'incomplete_expired'].includes(subscription.status)) {
      return res.status(409).json({
        ok: false,
        error: `La suscripción está en estado "${subscription.status}": reactívala antes de cambiar las plazas.`,
        additionalUsers: readSubscriptionSeats(subscription),
      });
    }

    const currentSeats = readSubscriptionSeats(subscription);
    if (currentSeats === requestedSeats) {
      // Sin cambios reales no se llama a Stripe: evita facturas de 0 € al repetir el mismo número.
      return res.json({
        ok: true,
        changed: false,
        additionalUsers: currentSeats,
        totalMonthlyCents: monthlyAmountCentsForSeats(currentSeats),
        status: subscription.status || null,
        invoiceAmountCents: 0,
      });
    }

    // Si el plan se contracted con Bizum/iDEAL/MB WAY no hay ninguna tarjeta guardada. Se comprueba
    // ANTES de tocar la suscripcion para devolver needsPaymentMethod y que la app mande al usuario
    // directamente a la pagina de tarjeta, en vez de depender del error que Stripe decida devolver.
    const customerId = typeof subscription.customer === 'string'
      ? subscription.customer
      : subscription.customer?.id || null;
    if (!(await customerHasReusableCard(stripeClient, customerId))) {
      return res.status(402).json({
        ok: false,
        needsPaymentMethod: true,
        additionalUsers: currentSeats,
        error: 'No hay ninguna tarjeta guardada en Stripe.',
      });
    }

    const additionalItem = (subscription.items?.data || [])
      .find((entry) => entry.price?.id === STRIPE_ADDITIONAL_USER_PRICE_ID) || null;
    // Stripe exige una operación distinta según el caso: actualizar, añadir o quitar el item.
    const itemUpdate = requestedSeats === 0
      ? { id: additionalItem.id, deleted: true }
      : additionalItem
        ? { id: additionalItem.id, quantity: requestedSeats }
        : { price: STRIPE_ADDITIONAL_USER_PRICE_ID, quantity: requestedSeats };

    const updated = await stripeClient.subscriptions.update(subscriptionId, {
      items: [itemUpdate],
      proration_behavior: 'always_invoice',
      payment_behavior: 'error_if_incomplete',
      expand: ['latest_invoice'],
      metadata: {
        additional_users: String(requestedSeats),
        total_monthly_cents: String(monthlyAmountCentsForSeats(requestedSeats)),
      },
    });

    const seats = readSubscriptionSeats(updated);
    const amount = monthlyAmountCentsForSeats(seats);
    const invoice = updated.latest_invoice && typeof updated.latest_invoice === 'object' ? updated.latest_invoice : null;
    const invoiceAmountCents = invoice ? Number(invoice.total) || 0 : 0;

    await updateUserMetadata(req.user.id, {
      subscription_provider: 'stripe',
      stripe_subscription_id: subscriptionId,
      stripe_subscription_status: updated.status || 'active',
      stripe_subscription_additional_users: String(seats),
      stripe_subscription_amount_cents: String(amount),
      stripe_subscription_updated_at: new Date().toISOString(),
    });

    return res.json({
      ok: true,
      changed: true,
      additionalUsers: seats,
      totalMonthlyCents: amount,
      status: updated.status || null,
      invoiceId: invoice?.id || null,
      invoiceAmountCents,
      invoiceUrl: invoice?.hosted_invoice_url || null,
    });
  } catch (error) {
    const code = String(error?.code || '');
    const message = String(error?.message || 'error desconocido de Stripe');
    const paymentFailed = [
      'card_declined', 'expired_card', 'insufficient_funds', 'authentication_required',
      'invoice_payment_failed', 'payment_intent_authentication_failure',
    ].includes(code) || /payment|invoice/i.test(message);
    // Caso mas frecuente: el plan se contrato con Bizum/iDEAL/MB WAY (metodos de redireccion), que
    // NO se guardan en Stripe. Sin tarjeta reusable no hay con que cobrar el prorrateo, asi que se
    // responde con needsPaymentMethod para que la app ofrezca guardar una tarjeta y reintentar.
    const needsPaymentMethod = errorNeedsPaymentMethod(error);
    console.error('Error ajustando las plazas de empleado:', message);

    // Se releen las plazas reales para que la app no se quede con un numero que Stripe no aplico.
    let seatsAfterFailure = null;
    if (subscriptionId) {
      try {
        const current = await requireStripe().subscriptions.retrieve(subscriptionId, { expand: ['items.data.price'] });
        seatsAfterFailure = readSubscriptionSeats(current);
      } catch (readError) {
        console.warn('No se pudieron releer las plazas tras el fallo:', readError.message);
      }
    }

    return res.status(paymentFailed || needsPaymentMethod ? 402 : 502).json({
      ok: false,
      needsPaymentMethod,
      additionalUsers: seatsAfterFailure,
      error: needsPaymentMethod
        ? 'No hay ninguna tarjeta guardada en Stripe. Guarda una tarjeta para poder cobrar las plazas de empleado.'
        : (paymentFailed
          ? `Stripe no pudo cobrar el ajuste de plazas: ${message}. No se ha aplicado el cambio; revisa el método de pago y vuelve a intentarlo.`
          : `Stripe: ${message}`),
    });
  }
});

// Crea una sesion de Checkout en modo 'setup' para GUARDAR UN METODO DE PAGO REUTILIZABLE (tarjeta)
// en el cliente de Stripe. Necesario cuando el plan se contrato con Bizum, iDEAL, MB WAY... porque
// esos metodos de redireccion no se guardan y el prorrateo de las plazas no tendria con que cobrar.
app.post('/api/billing/payment-method-setup', requireAuth, async (req, res) => {
  // Cualquier usuario de la cuenta puede guardar la tarjeta que se usara para las renovaciones y
  // los prorrateos. La sesion se crea sobre el cliente de Stripe del titular.

  try {
    const stripeClient = requireStripe();
    const resolved = await resolveUserSubscription(stripeClient, req.user.id);
    // Los cambios de estado se guardan en la metadata del TITULAR: si se guardaran en la del
    // empleado, el aviso de impago seguiria activo y la app no se desbloquearia.
    const ownerUserId = resolved.user?.id || req.user.id;
    if (!resolved.subscription) {
      return res.status(409).json({ ok: false, error: 'Todavía no hay una suscripción activa: contrátala primero.' });
    }

    const subscription = resolved.subscription;
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
    if (!customerId) {
      return res.status(409).json({ ok: false, error: 'No se encontró tu ficha de cliente en Stripe.' });
    }

    const session = await stripeClient.checkout.sessions.create({
      mode: 'setup',
      customer: customerId,
      // Solo tarjeta: es el metodo que Stripe puede reutilizar para las renovaciones y los prorrateos.
      payment_method_types: ['card'],
      success_url: `${PUBLIC_API_URL}/billing/payment-method?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_API_URL}/billing/payment-method-cancelled`,
      metadata: { supabase_user_id: req.user.id },
    });

    await updateUserMetadata(ownerUserId, {
      stripe_payment_method_setup_at: new Date().toISOString(),
      // Se guarda el identificador de la sesion para poder reutilizar despues la tarjeta que el
      // usuario guarde y cobrar con ella la factura vencida (POST /api/billing/resolve-invoice).
      stripe_payment_method_setup_session: session.id,
    });

    return res.status(201).json({ ok: true, url: session.url, checkoutUrl: session.url });
  } catch (error) {
    console.error('Error creando la sesión para guardar el método de pago:', error.message);
    return res.status(502).json({ ok: false, error: `Stripe: ${error.message}` });
  }
});

app.get('/billing/success', (req, res) => {
  res.type('html').send('<h1>Pago recibido</h1><p>Puedes volver a la aplicación. Comprobaremos tu suscripción automáticamente.</p>');
});

app.get('/billing/cancelled', (req, res) => {
  res.type('html').send('<h1>Pago cancelado</h1><p>Puedes cerrar esta página y volver a la aplicación.</p>');
});

app.get('/billing/payment-method', async (req, res) => {
  let deepLink = 'tpvapp://pago-completado?flow=payment-method-setup&result=error';

  try {
    const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id : '';
    if (!sessionId) throw new Error('Falta la sesión de Stripe.');

    const stripeClient = requireStripe();
    const session = await stripeClient.checkout.sessions.retrieve(sessionId, { expand: ['setup_intent'] });
    if (session.mode !== 'setup' || session.status !== 'complete') {
      throw new Error('Stripe no confirmó que se guardara la tarjeta.');
    }

    const setupIntent = session.setup_intent && typeof session.setup_intent === 'object'
      ? session.setup_intent
      : await stripeClient.setupIntents.retrieve(String(session.setup_intent || ''));
    if (setupIntent.status !== 'succeeded') {
      throw new Error('Stripe aún no confirmó la tarjeta.');
    }

    const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
    const paymentMethodId = typeof setupIntent.payment_method === 'string'
      ? setupIntent.payment_method
      : setupIntent.payment_method?.id;
    if (!customerId || !paymentMethodId) {
      throw new Error('Stripe no devolvió el cliente o la tarjeta guardada.');
    }

    // Setup Checkout adjunta la tarjeta, pero no necesariamente la convierte en método
    // predeterminado para las facturas que cobra el cambio de plazas.
    await stripeClient.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    const subscriptions = await stripeClient.subscriptions.list({
      customer: customerId,
      status: 'all',
      limit: 100,
    });
    const billableStatuses = new Set(['active', 'trialing', 'past_due', 'unpaid']);
    await Promise.all(subscriptions.data
      .filter((subscription) => billableStatuses.has(subscription.status))
      .map((subscription) => stripeClient.subscriptions.update(subscription.id, {
        default_payment_method: paymentMethodId,
      })));

    deepLink = 'tpvapp://pago-completado?flow=payment-method-setup&result=success';
  } catch (error) {
    console.error('Error confirmando la tarjeta de Stripe:', error.message);
  }

  res.type('html').send(`<!doctype html>
<html lang="es">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Tarjeta guardada</title>
  <script>window.location.replace(${JSON.stringify(deepLink)});</script>
  </head>
  <body><h1>Tarjeta procesada</h1><p>Volviendo a la aplicación para continuar.</p><a href="${deepLink}">Volver a la aplicación</a></body>
</html>`);
});

app.get('/billing/payment-method-cancelled', (req, res) => {
  res.type('html').send('<h1>No se guardó la tarjeta</h1><p>Puedes cerrar esta página. Para añadir empleados necesitarás una tarjeta guardada en Stripe.</p>');
});

const companyHistoryUserIds = async (req, res) => {
  const ownerId = req.user.app_metadata?.company_owner_id || req.user.id;
  const userIds = new Set([ownerId]);
  try {
    for (let page = 1; ; page += 1) {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) throw error;
      if (!Array.isArray(data?.users)) throw new Error('Respuesta de usuarios no valida.');
      for (const user of data.users) {
        if (user.app_metadata?.company_owner_id === ownerId) userIds.add(user.id);
      }
      if (data.users.length < 1000) break;
    }
    return [...userIds];
  } catch (error) {
    console.error('Error resolviendo usuarios del historial de empresa:', error.message);
    res.status(500).json({ ok: false, error: 'No se pudo recuperar el historial de la empresa.' });
    return null;
  }
};

const refundPinAttempts = new Map();
const REFUND_PIN_TTL_MS = 15 * 60 * 1000;
const validRefundPin = (pin) => typeof pin === 'string' && /^\d{4,8}$/.test(pin);
const hasRefundPin = (metadata) => (
  typeof metadata?.company_refund_pin_salt === 'string'
  && /^[a-f0-9]{32}$/.test(metadata.company_refund_pin_salt)
  && typeof metadata.company_refund_pin_hash === 'string'
  && /^[a-f0-9]{128}$/.test(metadata.company_refund_pin_hash)
);
const deriveRefundPin = (pin, salt) => new Promise((resolve, reject) => {
  crypto.scrypt(pin, salt, 64, (error, hash) => error ? reject(error) : resolve(hash));
});
const verifyRefundPin = async (owner, actorId, pin, res) => {
  const now = Date.now();
  for (const [key, attempt] of refundPinAttempts) {
    if (attempt.expiresAt <= now) refundPinAttempts.delete(key);
  }
  const key = JSON.stringify([owner.id, actorId]);
  const attempt = refundPinAttempts.get(key);
  if (attempt?.count >= 5) {
    res.status(429).json({ ok: false, code: 'pin_attempts_exceeded', retryAfterSeconds: Math.ceil((attempt.expiresAt - now) / 1000), error: 'Demasiados intentos de PIN.' });
    return false;
  }
  const metadata = owner.app_metadata;
  const candidate = await deriveRefundPin(validRefundPin(pin) ? pin : '', metadata.company_refund_pin_salt);
  const matches = crypto.timingSafeEqual(candidate, Buffer.from(metadata.company_refund_pin_hash, 'hex'));
  if (!matches || !validRefundPin(pin)) {
    refundPinAttempts.set(key, { count: (attempt?.count || 0) + 1, expiresAt: attempt?.expiresAt || now + REFUND_PIN_TTL_MS });
    res.status(403).json({ ok: false, code: 'invalid_pin', error: 'PIN incorrecto.' });
    return false;
  }
  refundPinAttempts.delete(key);
  return true;
};
const isRefundPrincipal = (user) => {
  const role = user?.app_metadata?.role;
  const ownerId = user?.app_metadata?.company_owner_id;
  return Boolean(user) && (role === 'principal' || role === undefined)
    && (!ownerId || ownerId === user.id);
};
const refundAccountOwner = async (req, res) => {
  const actor = await fetchAuthoritativeUser(req.user.id);
  const role = isRefundPrincipal(actor) ? 'principal' : actor?.app_metadata?.role;
  const ownerId = actor?.app_metadata?.company_owner_id;
  if (!actor || !['principal', 'empleado'].includes(role)
    || (role === 'principal' && ownerId && ownerId !== actor.id)
    || (role === 'empleado' && (typeof ownerId !== 'string' || !ownerId || ownerId === actor.id))) {
    res.status(403).json({ ok: false, error: 'Cuenta sin rol o empresa valida.' });
    return null;
  }
  const owner = role === 'principal' ? actor : await fetchAuthoritativeUser(ownerId);
  if (!isRefundPrincipal(owner)) {
    res.status(403).json({ ok: false, error: 'La empresa no tiene un principal valido.' });
    return null;
  }
  req.user = actor;
  return owner;
};

app.get('/api/company/pin/status', requireAuth, async (req, res) => {
  try {
    const owner = await refundAccountOwner(req, res);
    if (!owner) return;
    return res.json({ configured: hasRefundPin(owner.app_metadata) });
  } catch {
    return res.status(500).json({ ok: false, error: 'No se pudo consultar el PIN.' });
  }
});

app.post('/api/company/pin', requireAuth, async (req, res) => {
  try {
    const owner = await refundAccountOwner(req, res);
    if (!owner) return;
    if (req.user.id !== owner.id) return res.status(403).json({ ok: false, error: 'Solo el principal puede configurar el PIN.' });
    const { pin, currentPin } = req.body || {};
    if (!validRefundPin(pin)) return res.status(400).json({ ok: false, error: 'El PIN debe contener de 4 a 8 digitos.' });
    return await withAccountLock(owner.id, async () => {
      const freshOwner = await refundAccountOwner(req, res);
      if (!freshOwner) return;
      if (freshOwner.id !== owner.id || req.user.id !== freshOwner.id) return res.status(403).json({ ok: false, error: 'La cuenta ha cambiado.' });
      const metadata = freshOwner.app_metadata || {};
      if (hasRefundPin(metadata)) {
        if (!await verifyRefundPin(freshOwner, req.user.id, currentPin, res)) return;
      } else if (metadata.company_refund_pin_salt !== undefined || metadata.company_refund_pin_hash !== undefined) {
        return res.status(409).json({ ok: false, error: 'La configuracion del PIN requiere revision.' });
      }
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = (await deriveRefundPin(pin, salt)).toString('hex');
      const { error } = await supabase.auth.admin.updateUserById(freshOwner.id, {
        app_metadata: { ...metadata, company_refund_pin_salt: salt, company_refund_pin_hash: hash },
      });
      if (error) return res.status(500).json({ ok: false, error: 'No se pudo guardar el PIN.' });
      return res.json({ ok: true, configured: true });
    });
  } catch {
    return res.status(500).json({ ok: false, error: 'No se pudo guardar el PIN.' });
  }
});

const refundMoneyCents = (amount) => {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return null;
  const cents = Math.round(amount * 100);
  return Number.isSafeInteger(cents) && Math.abs(amount * 100 - cents) < 0.000001 ? cents : null;
};

const validStripePaymentIntentId = (value) => typeof value === 'string' && /^pi_[A-Za-z0-9]+$/.test(value);
const validStripeAccountId = (value) => typeof value === 'string' && /^acct_[A-Za-z0-9]+$/.test(value);

// Reembolso de dinero en Stripe cuando el ticket guarda un PaymentIntent. Sin PI: solo documental.
const createStripeMoneyRefund = async (document, requestedCents, historyLength) => {
  if (!validStripePaymentIntentId(document.stripePaymentIntentId)) {
    return { stripeRefundId: null, stripeRefundStatus: null };
  }
  const direct = document.chargeMode === 'direct' && validStripeAccountId(document.stripeAccountId);
  let stripeClient;
  let requestOptions = {};
  if (direct) {
    // Misma clave Connect que creó el cobro directo.
    const connected = process.env.STRIPE_CONNECT_TEST_ENABLED === 'true'
      && /^sk_test_[A-Za-z0-9]+$/.test(process.env.STRIPE_CONNECT_TEST_SECRET_KEY || '')
      ? require('stripe')(process.env.STRIPE_CONNECT_TEST_SECRET_KEY)
      : null;
    if (!connected) throw Object.assign(new Error('connect_refund_client_unavailable'), { status: 503, code: 'connect_refund_client_unavailable' });
    stripeClient = connected;
    requestOptions = { stripeAccount: document.stripeAccountId };
  } else {
    stripeClient = requireStripe();
  }
  const refund = await stripeClient.refunds.create({
    payment_intent: document.stripePaymentIntentId,
    amount: requestedCents,
    reason: 'requested_by_customer',
    metadata: {
      document_id: String(document.id || ''),
      ticket_code: String(document.ticketCode || ''),
      charge_mode: String(document.chargeMode || 'platform'),
    },
  }, {
    ...requestOptions,
    idempotencyKey: `doc-refund-${document.id}-${historyLength}-${requestedCents}`,
  });
  return {
    stripeRefundId: typeof refund?.id === 'string' ? refund.id : null,
    stripeRefundStatus: typeof refund?.status === 'string' ? refund.status : null,
  };
};

app.post('/api/documents/refund', requireAuth, async (req, res) => {
  try {
    const { documentId, amount, pin } = req.body || {};
    const requestedCents = refundMoneyCents(amount);
    if (typeof documentId !== 'string' || !documentId.trim() || requestedCents === null || requestedCents <= 0) {
      return res.status(400).json({ ok: false, error: 'Se requiere documentId e importe positivo con hasta dos decimales.' });
    }
    const owner = await refundAccountOwner(req, res);
    if (!owner) return;
    return await withAccountLock(owner.id, async () => {
      const freshOwner = await refundAccountOwner(req, res);
      if (!freshOwner) return;
      if (freshOwner.id !== owner.id) return res.status(403).json({ ok: false, error: 'La cuenta ha cambiado.' });
      if (req.user.app_metadata.role === 'empleado') {
        if (!hasRefundPin(freshOwner.app_metadata)) return res.status(409).json({ ok: false, code: 'pin_not_configured', error: 'El principal debe configurar el PIN.' });
        if (!await verifyRefundPin(freshOwner, req.user.id, pin, res)) return;
      }
      const userIds = await companyHistoryUserIds(req, res);
      if (!userIds) return;
      const { data, error } = await supabase.from('documents')
        .select('document_data,created_at')
        .in('user_id', userIds)
        .eq('document_data->>id', documentId)
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) return res.status(500).json({ ok: false, error: 'No se pudo leer el documento.' });
      const document = data?.[0]?.document_data;
      if (!document) return res.status(404).json({ ok: false, error: 'Documento no encontrado.' });
      if (document.type !== 'COBRO') return res.status(409).json({ ok: false, error: 'Solo se pueden devolver cobros originales.' });
      const history = document.refundHistory ?? [];
      const balanceCents = refundMoneyCents(document.amount);
      if (!Array.isArray(history) || history.some((entry) => refundMoneyCents(entry?.amount) === null || entry.amount <= 0)) {
        return res.status(409).json({ ok: false, error: 'Historial de devoluciones inconsistente.' });
      }
      const refundedCents = history.reduce((total, entry) => total + refundMoneyCents(entry.amount), 0);
      const originalCents = document.originalAmount === undefined
        ? balanceCents + refundedCents : refundMoneyCents(document.originalAmount);
      const rate = document.ivaRateApplied ?? 0;
      if (balanceCents === null || originalCents === null || !Number.isSafeInteger(originalCents)
        || !Number.isSafeInteger(refundedCents) || originalCents - refundedCents !== balanceCents
        || typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) {
        return res.status(409).json({ ok: false, error: 'Saldo del documento inconsistente.' });
      }
      if (document.isRefunded || balanceCents <= 0 || requestedCents > balanceCents) {
        return res.status(409).json({ ok: false, error: 'El importe supera el saldo disponible.' });
      }

      let moneyRefund = { stripeRefundId: null, stripeRefundStatus: null };
      try {
        moneyRefund = await createStripeMoneyRefund(document, requestedCents, history.length);
      } catch (stripeError) {
        if (stripeError?.code === 'connect_refund_client_unavailable') {
          return res.status(503).json({ ok: false, code: stripeError.code, error: 'No se pudo conectar con Stripe Connect para reembolsar.' });
        }
        console.error('Error reembolsando en Stripe:', stripeError.message);
        return res.status(502).json({
          ok: false,
          code: 'stripe_refund_failed',
          error: 'Stripe no pudo reembolsar el cobro. No se ha modificado el ticket.',
        });
      }

      const remaining = (balanceCents - requestedCents) / 100;
      const subtotal = remaining / (1 + rate / 100);
      const historyEntry = {
        amount: requestedCents / 100,
        date: new Date().toISOString(),
        ...(moneyRefund.stripeRefundId ? {
          stripeRefundId: moneyRefund.stripeRefundId,
          stripeRefundStatus: moneyRefund.stripeRefundStatus,
        } : {}),
      };
      const updated = {
        ...document, documentType: 'COMPRA/DEVOLUCIONES', amount: remaining,
        originalAmount: originalCents / 100, subtotal, iva: remaining - subtotal,
        isRefunded: remaining === 0,
        refundHistory: [...history, historyEntry],
      };
      delete updated.publicUrl;
      const token = crypto.randomBytes(24).toString('hex');
      const { error: insertError } = await supabase.from('documents').insert({
        user_id: freshOwner.id, ticket_code: updated.ticketCode, document_type: updated.documentType,
        amount: updated.amount, original_amount: updated.originalAmount,
        document_data: updated, public_token: token,
      });
      if (insertError) {
        console.error('Devolución Stripe OK pero fallo al guardar documento:', insertError.message, moneyRefund.stripeRefundId);
        return res.status(500).json({
          ok: false,
          error: 'El reembolso de Stripe se emitió pero no se pudo guardar el ticket. Contacta soporte.',
          stripeRefundId: moneyRefund.stripeRefundId,
        });
      }
      return res.json({ ok: true, document: { ...updated, publicUrl: `${PUBLIC_API_URL}/documents/${token}` } });
    });
  } catch {
    return res.status(500).json({ ok: false, error: 'No se pudo registrar la devolucion.' });
  }
});

const isRefundDocument = (document) => (
  ['DEVOLUCION', 'DEVOLUCIÓN'].includes(document.type) || document.documentType === 'COMPRA/DEVOLUCIONES'
  || document.documentType === 'TICKET DE DEVOLUCIÓN' || Boolean(document.isRefunded)
  || (Array.isArray(document.refundHistory) && document.refundHistory.length > 0)
);

app.post('/api/documents', requireAuth, async (req, res) => {
  const {
    id, ticketCode, documentType, amount, originalAmount, relatedTicketCode, refundHistory, isRefunded,
    createdAt, issuer, client, items, subtotal, iva, ivaRateApplied, type,
    stripePaymentIntentId, stripeAccountId, chargeMode, stripeCheckoutSessionId,
  } = req.body;

  if (req.user.app_metadata?.role === 'empleado' && isRefundDocument(req.body)) {
    return res.status(403).json({ ok: false, error: 'Las devoluciones requieren el endpoint autorizado de devolucion.' });
  }

  if (!id || !ticketCode || !documentType || !Number.isFinite(Number(amount))) {
    return res.status(400).json({ ok: false, error: 'Faltan datos obligatorios del documento.' });
  }

  const token = crypto.randomBytes(24).toString('hex');
  const document = {
    id,
    ticketCode,
    documentType,
    amount: Number(amount),
    originalAmount: originalAmount !== undefined ? Number(originalAmount) : Number(amount),
    relatedTicketCode,
    refundHistory: Array.isArray(refundHistory) ? refundHistory : [],
    isRefunded: Boolean(isRefunded),
    createdAt,
    issuer,
    client,
    items,
    subtotal,
    iva,
    ivaRateApplied,
    type,
    ...(validStripePaymentIntentId(stripePaymentIntentId) ? { stripePaymentIntentId } : {}),
    ...(validStripeAccountId(stripeAccountId) ? { stripeAccountId } : {}),
    ...(chargeMode === 'direct' || chargeMode === 'platform' ? { chargeMode } : {}),
    ...(typeof stripeCheckoutSessionId === 'string' && /^cs_[A-Za-z0-9_]+$/.test(stripeCheckoutSessionId)
      ? { stripeCheckoutSessionId } : {}),
  };

  const ownerId = req.user.app_metadata?.company_owner_id || req.user.id;
  return withAccountLock(ownerId, async () => {
    if (req.user.app_metadata?.role === 'empleado') {
      const userIds = await companyHistoryUserIds(req, res);
      if (!userIds) return;
      const { data, error } = await supabase.from('documents')
        .select('document_data')
        .in('user_id', userIds)
        .eq('document_data->>id', id)
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) return res.status(500).json({ ok: false, error: 'No se pudo verificar el documento.' });
      if (data?.[0]?.document_data && isRefundDocument(data[0].document_data)) {
        return res.status(403).json({ ok: false, error: 'Un empleado no puede reemplazar un documento con devoluciones.' });
      }
    }
    const insertPayload = {
      user_id: ownerId,
      ticket_code: ticketCode,
      document_type: documentType,
      amount: document.amount,
      original_amount: document.originalAmount,
      document_data: document,
      public_token: token,
    };
    const { error } = await supabase.from('documents').insert(insertPayload);

    if (error) {
      console.error('Error guardando documento en Supabase:', error.message);
      return res.status(500).json({ ok: false, error: `Supabase: ${error.message}` });
    }

    return res.status(201).json({
      ok: true,
      token,
      publicUrl: `${PUBLIC_API_URL}/documents/${token}`,
    });
  });
});

// Lista los documentos publicados por el usuario autenticado, para recuperar el historial
// al borrar la app, cambiar de móvil o reinstalar.
app.get('/api/documents', requireAuth, async (req, res) => {
  const userIds = await companyHistoryUserIds(req, res);
  if (!userIds) return;
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
  const since = req.query.since ? new Date(req.query.since) : null;

  const query = supabase
    .from('documents')
    .select('ticket_code,document_type,amount,original_amount,document_data,public_token,created_at')
    .in('user_id', userIds)
    .order('created_at', { ascending: false })
    .limit(limit);

  const { data, error } = await (since
    ? query.gte('created_at', since.toISOString())
    : query);

  if (error) {
    console.error('Error listando documentos:', error.message);
    return res.status(500).json({ ok: false, error: `Supabase: ${error.message}` });
  }

  res.json({
    ok: true,
    documents: (data || []).map((row) => ({
      ...(row.document_data || {}),
      publicUrl: row.public_token ? `${PUBLIC_API_URL}/documents/${row.public_token}` : undefined,
      createdAt: row.created_at || row.document_data?.createdAt,
    })),
  });
});

// Sincroniza gastos puntuales desde la app. Recibe un array de gastos con id cliente y
// actualiza o inserta (upsert) con based_on: 'client' para que cada móvil mantenga su propia
// copia y nunca pierda la nube al reinstalar.
app.post('/api/expenses/sync', requireAuth, async (req, res) => {
  const expenses = Array.isArray(req.body?.expenses) ? req.body.expenses : [];
  if (expenses.length === 0) {
    return res.status(400).json({ ok: false, error: 'No se recibieron gastos para sincronizar.' });
  }

  const rows = expenses.map((gasto) => ({
    user_id: req.user.app_metadata?.company_owner_id || req.user.id,
    local_id: gasto.id,
    based_on: 'client',
    description: gasto.description || '',
    amount: Number(gasto.amount) || 0,
    date: gasto.date || null,
    category: gasto.category || 'Otros',
    synced_at: new Date().toISOString(),
  }));

  const { error } = await supabase.from('expenses').upsert(rows, {
    onConflict: ['user_id', 'local_id', 'based_on'],
  });

  if (error) {
    console.error('Error sincronizando gastos:', error.message);
    return res.status(500).json({ ok: false, error: `Supabase: ${error.message}` });
  }
  res.json({ ok: true, count: rows.length });
});

// Lista los gastos sincronizados del usuario autenticado.
app.get('/api/expenses', requireAuth, async (req, res) => {
  const userIds = await companyHistoryUserIds(req, res);
  if (!userIds) return;
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
  const { data, error } = await supabase
    .from('expenses')
    .select('local_id,description,amount,date,category,based_on,synced_at')
    .in('user_id', userIds)
    .order('date', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('Error listando gastos:', error.message);
    return res.status(500).json({ ok: false, error: `Supabase: ${error.message}` });
  }
  res.json({ ok: true, expenses: data || [] });
});

// Recupera todo el historial (documentos + gastos) en un solo llamado, para restaurar la app
// tras borrar datos o instalarla en otro móvil.
app.get('/api/documents/sync-all', requireAuth, async (req, res) => {
  const userIds = await companyHistoryUserIds(req, res);
  if (!userIds) return;
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));

  const documentsPromise = supabase
    .from('documents')
    .select('ticket_code,document_type,amount,original_amount,document_data,public_token,created_at')
    .in('user_id', userIds)
    .order('created_at', { ascending: false })
    .limit(limit);

  const expensesPromise = supabase
    .from('expenses')
    .select('local_id,description,amount,date,category,based_on,synced_at')
    .in('user_id', userIds)
    .order('date', { ascending: false })
    .limit(limit);

  const [documentsResult, expensesResult] = await Promise.allSettled([
    documentsPromise,
    expensesPromise,
  ]);

  const documentsError = documentsResult.status === 'rejected'
    ? documentsResult.reason
    : documentsResult.value.error;
  const expensesError = expensesResult.status === 'rejected'
    ? expensesResult.reason
    : expensesResult.value.error;

  if (documentsError || expensesError) {
    // Nunca se oculta el fallo de la nube: si falta la columna user_id o los permisos de la tabla
    // de gastos, la app debe avisar del motivo en vez de decir que "no hay historial guardado".
    const details = [];
    if (documentsError) details.push(`documentos: ${documentsError.message || documentsError}`);
    if (expensesError) details.push(`gastos: ${expensesError.message || expensesError}`);
    console.error('Error en sync-all:', details.join(' | '));
    return res.status(500).json({
      ok: false,
      error: `No se pudo recuperar el historial (${details.join('; ')}).`,
    });
  }

  const documents = (documentsResult.value.data || []).map((row) => ({
    ...(row.document_data || {}),
    publicUrl: row.public_token ? `${PUBLIC_API_URL}/documents/${row.public_token}` : undefined,
    createdAt: row.created_at || row.document_data?.createdAt,
  }));

  const expenses = expensesResult.value.data || [];

  res.json({ ok: true, documents, expenses });
});


const escapeHtml = (value = '') => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const formatMoney = (value) => Number(value || 0).toFixed(2);

app.get('/documents/:token', async (req, res) => {
  const { data, error } = await supabase
    .from('documents')
    .select('document_data')
    .eq('public_token', req.params.token)
    .maybeSingle();
  const document = data?.document_data;

  if (error || !document) {
    if (error) console.error('Error consultando documento en Supabase:', error.message);
    return res.status(404).send('<h1>Documento no encontrado</h1><p>El enlace no es válido o ha caducado.</p>');
  }

  const publicUrl = `${PUBLIC_API_URL}/documents/${req.params.token}`;
  const qrDataUrl = await QRCode.toDataURL(publicUrl, {
    width: 420,
    margin: 2,
    errorCorrectionLevel: 'M',
  });
  const itemsHtml = Array.isArray(document.items)
    ? document.items.map((item) => `<li>${escapeHtml(item.description)}: ${escapeHtml(item.price)} €</li>`).join('')
    : '';
  const logoHtml = typeof document.issuer?.logoUri === 'string' && document.issuer.logoUri.startsWith('data:image/')
    ? `<div class="logo"><img src="${document.issuer.logoUri}" alt="Logotipo de la empresa"></div>`
    : '';

  const totalRefunded = document.refundHistory.reduce((sum, refund) => sum + Number(refund.amount || 0), 0);
  const refundHistoryHtml = document.refundHistory.length > 0
    ? '<div class="section"><strong>COMPRA/DEVOLUCIONES</strong><br>Importe original: ' + formatMoney(document.originalAmount) + ' €<br>Total devuelto: -' + formatMoney(totalRefunded) + ' €<br>' + document.refundHistory.map((refund) => 'Devolución: -' + formatMoney(refund.amount) + ' € (' + escapeHtml(refund.date) + ')').join('<br>') + '<br><strong>Saldo restante: ' + formatMoney(document.amount) + ' €</strong></div>'
    : '';

  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.type('html').send(`<!doctype html>
<html lang="es">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(document.documentType)} ${escapeHtml(document.ticketCode)}</title>
  <style>body{font-family:'Courier New',monospace;background:#fff;color:#000;margin:0;padding:20px;display:flex;justify-content:center}.document{width:100%;max-width:420px;padding:18px;box-sizing:border-box}.logo{text-align:center;margin-bottom:10px}.logo img{width:85px;height:85px;object-fit:contain}.center{text-align:center}.title{font-size:18px;font-weight:bold;margin-bottom:5px}.subtitle{font-size:12px;margin-bottom:4px;color:#334155}.divider{border-top:1px dashed #000;margin:14px 0}.section{margin-top:12px;border-top:1px dashed #000;padding-top:10px}.row{display:flex;justify-content:space-between;font-size:13px;margin:7px 0}.total{display:flex;justify-content:space-between;font-size:17px;font-weight:bold;margin-top:10px;border-top:1px dashed #000;padding-top:8px}.qr{text-align:center;margin:0 0 18px;padding:0 2mm 2mm}.qr img{width:35mm;height:35mm}.muted{color:#64748b;font-size:11px}</style></head>
  <body><main class="document">${logoHtml}<div class="center title">${escapeHtml(document.issuer?.name || '')}</div><div class="center subtitle">NIF: ${escapeHtml(document.issuer?.nif || '')}</div><div class="center subtitle">${escapeHtml(document.issuer?.address || '')}</div><div class="divider"></div><div class="center title">${escapeHtml(document.documentType)}</div><div class="subtitle">Nº de serie: <strong>${escapeHtml(document.ticketCode)}</strong></div><div class="subtitle">Fecha: ${escapeHtml(document.createdAt || '')}</div>${document.client ? `<div class="section"><strong>DATOS DEL CLIENTE:</strong><br>${escapeHtml(document.client.name)}<br>NIF/CIF: ${escapeHtml(document.client.nif)}<br>${escapeHtml(document.client.address)}</div>` : ''}${itemsHtml ? `<div class="section"><strong>PRODUCTOS / SERVICIOS:</strong><ul>${itemsHtml}</ul></div>` : ''}${refundHistoryHtml}<div class="divider"></div><div class="row"><span>Base imponible actual</span><span>${formatMoney(document.subtotal)} €</span></div><div class="row"><span>IVA (${escapeHtml(document.ivaRateApplied)}%)</span><span>${formatMoney(document.iva)} €</span></div><div class="total"><span>TOTAL ORIGINAL</span><span>${formatMoney(document.originalAmount)} €</span></div><div class="row"><span>Saldo tras devoluciones</span><span>${formatMoney(document.amount)} €</span></div><div class="qr"><img src="${qrDataUrl}" alt="QR del documento"><div>Nº de serie: <strong>${escapeHtml(document.ticketCode)}</strong></div></div></main></body></html>`);
});

app.get('/api/documents/:token', async (req, res) => {
  const { data, error } = await supabase
    .from('documents')
    .select('document_data')
    .eq('public_token', req.params.token)
    .maybeSingle();
  if (error || !data?.document_data) {
    return res.status(404).json({ ok: false, error: 'Documento no encontrado.' });
  }
  res.json({ ok: true, document: data.document_data });
});

app.post('/api/companies', async (req, res) => {
  res.status(503).json({ ok: false, error: 'Usa /api/billing/checkout para crear suscripciones con Stripe.' });
});

app.post('/api/subscriptions/create', async (req, res) => {
  res.status(503).json({ ok: false, error: 'Usa /api/billing/checkout para crear suscripciones con Stripe.' });
});

// Endpoint heredado: el precio real de las plazas vive en la suscripcion de Stripe
// (POST /api/billing/seats). Se mantiene solo para responder 503 a clientes antiguos.
app.post('/api/companies/:companyId/users', async (req, res) => {
  res.status(503).json({ ok: false, error: 'Usa /api/billing/seats para cambiar las plazas de empleado.' });
});

app.listen(PORT, () => {
  console.log(`TPV & GESTOR backend running on http://localhost:${PORT}`);
});
