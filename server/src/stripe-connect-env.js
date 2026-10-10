// Resuelve el modo Connect (test XOR live) sin mezclar claves.
// Fase 1 go-live: billing sk_live + Connect test. Fase 2: Connect live (y test apagado).

const TEST_KEY = /^sk_test_[A-Za-z0-9]+$/;
const LIVE_KEY = /^sk_live_[A-Za-z0-9]+$/;

function normalizeSecretKey(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/^['"]|['"]$/g, '');
}

function flagEnabled(raw) {
  return String(raw ?? '').trim().toLowerCase() === 'true';
}

function resolveConnectMode(env = process.env) {
  const liveOn = flagEnabled(env.STRIPE_CONNECT_LIVE_ENABLED);
  const testOn = flagEnabled(env.STRIPE_CONNECT_TEST_ENABLED);
  if (liveOn && testOn) {
    return { enabled: false, livemode: null, secretKey: null, countries: null, code: 'connect_mode_ambiguous' };
  }
  if (liveOn) {
    const secretKey = normalizeSecretKey(env.STRIPE_CONNECT_LIVE_SECRET_KEY);
    if (!LIVE_KEY.test(secretKey)) {
      return { enabled: false, livemode: true, secretKey: null, countries: null, code: 'connect_live_key_invalid' };
    }
    const countries = env.STRIPE_CONNECT_LIVE_COUNTRIES ?? env.STRIPE_CONNECT_TEST_COUNTRIES ?? 'ES';
    return { enabled: true, livemode: true, secretKey, countries, code: null };
  }
  if (testOn) {
    const secretKey = normalizeSecretKey(env.STRIPE_CONNECT_TEST_SECRET_KEY);
    if (!TEST_KEY.test(secretKey)) {
      return { enabled: false, livemode: false, secretKey: null, countries: null, code: 'connect_test_key_invalid' };
    }
    const countries = env.STRIPE_CONNECT_TEST_COUNTRIES ?? 'ES';
    return { enabled: true, livemode: false, secretKey, countries, code: null };
  }
  return { enabled: false, livemode: null, secretKey: null, countries: null, code: 'connect_disabled' };
}

function createConnectStripeClient(env = process.env, Stripe = require('stripe')) {
  const mode = resolveConnectMode(env);
  if (!mode.enabled || !mode.secretKey) return null;
  return Stripe(mode.secretKey);
}

/** Diagnóstico seguro (sin secretos) para /health y scripts. */
function classifySecretKey(raw) {
  if (raw == null || raw === '') {
    return { set: false, prefix: null, length: 0, issue: 'unset' };
  }
  if (typeof raw !== 'string') {
    return { set: true, prefix: null, length: 0, issue: 'not_string' };
  }
  const trimmed = raw.trim();
  const unquoted = trimmed.replace(/^['"]|['"]$/g, '');
  let prefix = 'other';
  if (unquoted.startsWith('sk_live_')) prefix = 'sk_live_';
  else if (unquoted.startsWith('sk_test_')) prefix = 'sk_test_';
  else if (unquoted.startsWith('pk_')) prefix = 'pk_';
  else if (unquoted.startsWith('rk_')) prefix = 'rk_';
  else if (unquoted.startsWith('whsec_')) prefix = 'whsec_';
  else if (unquoted.startsWith('price_')) prefix = 'price_';

  let issue = null;
  if (/^['"]/.test(trimmed)) issue = 'quoted_value';
  else if (trimmed !== raw) issue = 'leading_or_trailing_whitespace';
  else if (prefix === 'pk_') issue = 'publishable_key_use_sk_instead';
  else if (prefix === 'rk_') issue = 'restricted_key_not_supported';
  else if (prefix === 'sk_live_' || prefix === 'sk_test_') {
    if (!(LIVE_KEY.test(unquoted) || TEST_KEY.test(unquoted))) {
      issue = 'invalid_characters_or_format';
    }
  } else {
    issue = 'unexpected_prefix';
  }

  return {
    set: true,
    prefix,
    length: raw.length,
    issue,
    accepted: !issue && (LIVE_KEY.test(unquoted) || TEST_KEY.test(unquoted)),
  };
}

function buildStripeDiagnostics(env = process.env) {
  const billing = classifySecretKey(env.STRIPE_SECRET_KEY);
  const connectTestKey = classifySecretKey(env.STRIPE_CONNECT_TEST_SECRET_KEY);
  const connectLiveKey = classifySecretKey(env.STRIPE_CONNECT_LIVE_SECRET_KEY);
  const webhook = classifySecretKey(env.STRIPE_WEBHOOK_SECRET);
  // webhook usa whsec_; reutilizar classify solo para set/length/issue de prefijo
  const webhookRaw = typeof env.STRIPE_WEBHOOK_SECRET === 'string' ? env.STRIPE_WEBHOOK_SECRET : '';
  const webhookOk = /^whsec_[A-Za-z0-9]+$/.test(webhookRaw.trim().replace(/^['"]|['"]$/g, ''));
  const mainPrice = typeof env.STRIPE_MAIN_SUBSCRIPTION_PRICE_ID === 'string'
    && /^price_[A-Za-z0-9]+$/.test(env.STRIPE_MAIN_SUBSCRIPTION_PRICE_ID.trim());
  const addPrice = typeof env.STRIPE_ADDITIONAL_USER_PRICE_ID === 'string'
    && /^price_[A-Za-z0-9]+$/.test(env.STRIPE_ADDITIONAL_USER_PRICE_ID.trim());
  const connect = resolveConnectMode(env);
  const testEnabledRaw = env.STRIPE_CONNECT_TEST_ENABLED;
  const liveEnabledRaw = env.STRIPE_CONNECT_LIVE_ENABLED;
  return {
    billingKey: billing,
    webhookSecret: {
      set: webhookRaw.length > 0,
      prefix: webhook.prefix,
      length: webhookRaw.length,
      accepted: webhookOk,
      issue: webhookOk ? null : (webhookRaw ? (webhook.issue || 'invalid_format') : 'unset'),
    },
    mainPriceId: { set: !!env.STRIPE_MAIN_SUBSCRIPTION_PRICE_ID, accepted: mainPrice },
    additionalPriceId: { set: !!env.STRIPE_ADDITIONAL_USER_PRICE_ID, accepted: addPrice },
    connectTestEnabled: {
      set: testEnabledRaw != null && String(testEnabledRaw) !== '',
      rawLength: String(testEnabledRaw ?? '').length,
      isTrue: flagEnabled(testEnabledRaw),
    },
    connectLiveEnabled: {
      set: liveEnabledRaw != null && String(liveEnabledRaw) !== '',
      isTrue: flagEnabled(liveEnabledRaw),
    },
    connectTestKey,
    connectLiveKey,
    connectCode: connect.code,
    connectEnabled: connect.enabled,
    note: 'Sin secretos. Fase 1 objetivo: billing accepted sk_live_ + connect test enabled.',
  };
}

module.exports = {
  resolveConnectMode,
  createConnectStripeClient,
  TEST_KEY,
  LIVE_KEY,
  normalizeSecretKey,
  flagEnabled,
  classifySecretKey,
  buildStripeDiagnostics,
};
