// Resuelve el modo Connect (test XOR live) sin mezclar claves.
// Fase 1 go-live: billing sk_live + Connect test. Fase 2: Connect live (y test apagado).

const TEST_KEY = /^sk_test_[A-Za-z0-9]+$/;
const LIVE_KEY = /^sk_live_[A-Za-z0-9]+$/;

function resolveConnectMode(env = process.env) {
  const liveOn = env.STRIPE_CONNECT_LIVE_ENABLED === 'true';
  const testOn = env.STRIPE_CONNECT_TEST_ENABLED === 'true';
  if (liveOn && testOn) {
    return { enabled: false, livemode: null, secretKey: null, countries: null, code: 'connect_mode_ambiguous' };
  }
  if (liveOn) {
    const secretKey = env.STRIPE_CONNECT_LIVE_SECRET_KEY || '';
    if (!LIVE_KEY.test(secretKey)) {
      return { enabled: false, livemode: true, secretKey: null, countries: null, code: 'connect_live_key_invalid' };
    }
    const countries = env.STRIPE_CONNECT_LIVE_COUNTRIES ?? env.STRIPE_CONNECT_TEST_COUNTRIES ?? 'ES';
    return { enabled: true, livemode: true, secretKey, countries, code: null };
  }
  if (testOn) {
    const secretKey = env.STRIPE_CONNECT_TEST_SECRET_KEY || '';
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

module.exports = { resolveConnectMode, createConnectStripeClient, TEST_KEY, LIVE_KEY };
