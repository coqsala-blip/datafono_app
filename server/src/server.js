require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const QRCode = require('qrcode');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

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
// Por defecto tarjeta + métodos locales europeos: card, bizum (España), mb_way (Portugal),
// bancontact (Bélgica), eps (Austria), ideal (Países Bajos) y wero (paneuropeo, en preview).
// En el Checkout solo aparecen los que estén ACTIVADOS en Settings > Payment methods del
// Dashboard de Stripe; los no disponibles se retiran automáticamente con reintento.
// Con 'auto' se dejan como métodos dinámicos: Stripe mostraría todos los activados en el
// Dashboard. También puedes poner tu propia lista, p. ej. 'card,bizum'.
// Referencia: https://docs.stripe.com/payments/payment-methods/overview
const EUR_LOCAL_PAYMENT_METHODS = ['bizum', 'mb_way', 'bancontact', 'eps', 'ideal', 'wero'];
const stripePaymentMethodTypesSetting = String(process.env.STRIPE_PAYMENT_METHOD_TYPES || 'card,bizum,mb_way,bancontact,eps,ideal,wero').trim().toLowerCase();
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
const readDefaultPaymentMethodConfiguration = async () => {
  const configurations = await requireStripe().paymentMethodConfigurations.list({ limit: 10 });
  const items = Array.isArray(configurations?.data) ? configurations.data : [];
  return items.find((item) => item?.default === true) || items[0] || null;
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
const createCheckoutSessionWithLocalMethodsFallback = async (params, requestedPaymentMethodTypes) => {
  const stripeClient = requireStripe();
  let currentTypes = await filterAvailablePaymentMethods(
    Array.isArray(requestedPaymentMethodTypes) ? [...requestedPaymentMethodTypes] : requestedPaymentMethodTypes,
  );
  let removalsLeft = EUR_LOCAL_PAYMENT_METHODS.length;

  for (;;) {
    try {
      const session = await stripeClient.checkout.sessions.create(
        Array.isArray(currentTypes) ? { ...params, payment_method_types: currentTypes } : params,
      );
      return { session, paymentMethodTypes: currentTypes };
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

try {
  const publicApiUrl = new URL(PUBLIC_API_URL);
  if (NODE_ENV === 'production' && publicApiUrl.protocol !== 'https:') {
    throw new Error('PUBLIC_API_URL debe usar HTTPS en producción.');
  }
} catch (error) {
  throw new Error(`PUBLIC_API_URL no es válida: ${error.message}`);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

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

const isPrincipal = (user) => user.app_metadata?.role !== 'empleado';

const findPrincipalByEmployeeAccessCode = async (accessCode) => {
  let page = 1;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;

    const users = data?.users || [];
    for (const user of users) {
      const metadata = user.app_metadata || {};
      if (metadata.role === 'empleado' || !metadata.employee_access_code_salt || !metadata.employee_access_code_hash) continue;
      const candidateHash = hashEmployeeAccessCode(accessCode, metadata.employee_access_code_salt);
      if (crypto.timingSafeEqual(Buffer.from(candidateHash, 'hex'), Buffer.from(metadata.employee_access_code_hash, 'hex'))) {
        return user;
      }
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

const getBearerToken = (req) => {
  const authorization = req.headers.authorization || '';
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : null;
};

const requireAuth = async (req, res, next) => {
  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'Se requiere autenticación.' });
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    return res.status(401).json({ ok: false, error: 'La sesión no es válida o ha caducado.' });
  }

  req.user = data.user;
  return next();
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
  let subscriptionId = accountOwner.user_metadata?.stripe_subscription_id || null;
  const checkoutSessionId = accountOwner.user_metadata?.stripe_checkout_session_id || null;

  try {
    if (stripe && subscriptionId) {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      status = subscription.status || status;
      await updateUserMetadata(accountOwner.id, {
        stripe_subscription_status: status,
        stripe_subscription_updated_at: new Date().toISOString(),
      });
    } else if (stripe && checkoutSessionId) {
      const session = await stripe.checkout.sessions.retrieve(checkoutSessionId);
      if (session.subscription) {
        subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        status = subscription.status || status;
        await updateUserMetadata(accountOwner.id, {
          subscription_provider: 'stripe',
          stripe_customer_id: session.customer || null,
          stripe_subscription_id: subscriptionId,
          stripe_subscription_status: status,
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
  return res.json({
    ok: true,
    provider: 'stripe',
    active: activeStatuses.has(status),
    status,
    subscriptionId,
  });
});

app.post('/api/auth/register', async (req, res) => {
  const { email, password, fullName, companyName, role, employeeAccessCode } = req.body || {};
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const requestedRole = role === 'empleado' ? 'empleado' : 'principal';
  const normalizedAccessCode = typeof employeeAccessCode === 'string' ? employeeAccessCode.trim() : '';

  if (!normalizedEmail || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ ok: false, error: 'Indica un email válido y una contraseña de al menos 8 caracteres.' });
  }

  let principal = null;
  if (requestedRole === 'empleado') {
    if (normalizedAccessCode.length < 8) {
      return res.status(400).json({ ok: false, error: 'Introduce el código de acceso que te ha dado el principal.' });
    }
    try {
      principal = await findPrincipalByEmployeeAccessCode(normalizedAccessCode);
    } catch (error) {
      console.error('Error buscando el código de empleado:', error.message);
      return res.status(500).json({ ok: false, error: 'No se pudo validar el código de empleado.' });
    }
    if (!principal) {
      return res.status(400).json({ ok: false, error: 'El código de empleado no es válido.' });
    }
  }

  const { data, error } = await supabase.auth.signUp({
    email: normalizedEmail,
    password,
    options: {
      data: {
        full_name: typeof fullName === 'string' ? fullName.trim() : '',
        company_name: typeof companyName === 'string' ? companyName.trim() : '',
        role: requestedRole,
      },
    },
  });

  if (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }

  if (data.user) {
    const { data: updatedUser, error: metadataError } = await updateUserAppMetadata(data.user.id, {
      role: requestedRole,
      ...(principal ? { company_owner_id: principal.id } : {}),
    });
    if (metadataError) {
      console.error('Error asignando el rol de la cuenta:', metadataError.message);
      return res.status(500).json({ ok: false, error: 'No se pudo asignar el acceso de la cuenta.' });
    }
    data.user = updatedUser.user;

    if (principal) {
      const { error: codeError } = await updateUserAppMetadata(principal.id, {
        employee_access_code_salt: null,
        employee_access_code_hash: null,
      });
      if (codeError) console.error('Error invalidando el código de empleado:', codeError.message);
    }
  }

  return res.status(201).json({
    ok: true,
    user: data.user,
    session: data.session,
    requiresEmailConfirmation: !data.session,
  });
});

app.post('/api/auth/employee-access-code', requireAuth, async (req, res) => {
  if (!isPrincipal(req.user)) {
    return res.status(403).json({ ok: false, error: 'Solo el usuario principal puede crear códigos de empleado.' });
  }

  const accessCode = typeof req.body?.accessCode === 'string' ? req.body.accessCode.trim() : '';
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

  return res.json({ ok: true });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';

  if (!normalizedEmail || typeof password !== 'string' || password.length === 0) {
    return res.status(400).json({ ok: false, error: 'Indica email y contraseña.' });
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email: normalizedEmail,
    password,
  });

  if (error || !data.user || !data.session) {
    return res.status(401).json({ ok: false, error: 'Email o contraseña incorrectos.' });
  }

  return res.json({ ok: true, user: data.user, session: data.session });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ ok: true, user: req.user });
});

app.post('/api/stripe/terminal/connection-token', requireAuth, async (req, res) => {
  try {
    const token = await requireStripe().terminal.connectionTokens.create();
    return res.status(201).json({ ok: true, secret: token.secret });
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

  try {
    const paymentIntent = await requireStripe().paymentIntents.create({
      amount,
      currency: stripeCurrency,
      payment_method_types: ['card_present'],
      capture_method: 'automatic',
      metadata: {
        supabase_user_id: req.user.id,
        order_id: orderId,
      },
    });
    return res.status(201).json({ ok: true, paymentIntentId: paymentIntent.id, clientSecret: paymentIntent.client_secret });
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

  try {
    // Métodos dinámicos (Bizum incluido): no se pasa payment_method_types salvo que se configure
    // una lista explícita en STRIPE_PAYMENT_METHOD_TYPES.
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
        supabase_user_id: req.user.id,
        order_id: orderId,
      },
      payment_intent_data: {
        metadata: {
          supabase_user_id: req.user.id,
          order_id: orderId,
        },
      },
      success_url: `${PUBLIC_API_URL}/stripe/complete?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_API_URL}/stripe/cancel?orderId=${encodeURIComponent(orderId)}`,
    };
    const { session, paymentMethodTypes } = await createCheckoutSessionWithLocalMethodsFallback(
      checkoutSessionParams,
      requestedPaymentMethodTypes,
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
    const session = await requireStripe().checkout.sessions.retrieve(req.params.paymentId, {
      expand: ['payment_intent.payment_method', 'payment_intent.last_payment_error.payment_method'],
    });
    return res.json({
      ok: true,
      paymentId: session.id,
      status: normalizeStripePaymentStatus(session),
      checkoutStatus: session.status,
      paymentStatus: session.payment_status,
      usedMethod: resolveOnlinePaymentUsedMethod(session),
      amount: session.amount_total,
      currency: session.currency,
    });
  } catch (error) {
    console.error('Error consultando pago Stripe:', error.message);
    return res.status(502).json({ ok: false, error: 'No se pudo consultar el estado del pago Stripe.' });
  }
});

// Diagnóstico: indica si Bizum está disponible y activado en la cuenta de Stripe.
app.get('/api/stripe/payment-methods', requireAuth, async (req, res) => {
  const warnings = [];
  const bizum = { capability: null, enabledInDashboard: null, available: null };
  let livemode = null;
  let effectiveCheckoutMethods = null;

  try {
    const stripeClient = requireStripe();

    try {
      const account = await stripeClient.accounts.retrieve();
      bizum.capability = account?.capabilities?.bizum_payments || null;
      livemode = account?.livemode ?? null;
    } catch (error) {
      warnings.push(`No se pudieron leer las capacidades de la cuenta: ${error.message}`);
    }

    let configuration = null;
    try {
      configuration = await readDefaultPaymentMethodConfiguration();
      livemode = livemode ?? configuration?.livemode ?? null;
      if (configuration?.bizum) {
        bizum.available = configuration.bizum.available === true;
        bizum.enabledInDashboard = configuration.bizum.display_preference?.value || null;
      }
    } catch (error) {
      warnings.push(`No se pudo leer la configuración de métodos de pago: ${error.message}`);
    }

    // Lista efectiva que se pedirá en el Checkout tras el prefiltrado (misma regla que el cobro).
    if (!stripeDynamicPaymentMethods) {
      const effective = stripePaymentMethodTypes.filter((method) => method === 'card' || configuration?.[method]?.available !== false);
      effectiveCheckoutMethods = effective.length > 0 ? effective : ['card'];
    }

    return res.json({
      ok: true,
      dynamicPaymentMethods: stripeDynamicPaymentMethods,
      configuredSetting: stripeDynamicPaymentMethods ? 'auto' : stripePaymentMethodTypes.join(','),
      requestedForOnlinePayments: stripeDynamicPaymentMethods
        ? 'Dinámicos: Stripe muestra los métodos activados en el Dashboard'
        : stripePaymentMethodTypes,
      effectiveCheckoutMethods,
      livemode,
      bizum,
      warnings,
    });
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
    const session = await requireStripe().checkout.sessions.create({
      mode: 'subscription',
      customer_email: req.user.email,
      line_items: lineItems,
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

app.get('/billing/success', (req, res) => {
  res.type('html').send('<h1>Pago recibido</h1><p>Puedes volver a la aplicación. Comprobaremos tu suscripción automáticamente.</p>');
});

app.get('/billing/cancelled', (req, res) => {
  res.type('html').send('<h1>Pago cancelado</h1><p>Puedes cerrar esta página y volver a la aplicación.</p>');
});

app.post('/api/documents', async (req, res) => {
  const { id, ticketCode, documentType, amount, originalAmount, relatedTicketCode, refundHistory, isRefunded, createdAt, issuer, client, items, subtotal, iva, ivaRateApplied, type } = req.body;

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
  };

  const { error } = await supabase.from('documents').insert({
    ticket_code: ticketCode,
    document_type: documentType,
    amount: document.amount,
    original_amount: document.originalAmount,
    document_data: document,
    public_token: token,
  });

  if (error) {
    console.error('Error guardando documento en Supabase:', error.message);
    return res.status(500).json({ ok: false, error: `Supabase: ${error.message}` });
  }

  res.status(201).json({
    ok: true,
    token,
    publicUrl: `${PUBLIC_API_URL}/documents/${token}`,
  });
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

app.post('/api/companies/:companyId/users', async (req, res) => {
  try {
    const { totalUsers } = req.body;
    const extraUsers = Math.max(0, Number(totalUsers) - 1);
    const totalMonthly = 7 + (extraUsers * 2);

    res.json({ ok: true, totalMonthly, extraUsers });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`TPV & GESTOR backend running on http://localhost:${PORT}`);
});
