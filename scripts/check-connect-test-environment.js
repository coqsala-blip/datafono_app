const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { validate } = require('./run-connect-test');

const sample = {
  SUPABASE_URL: 'https://isolated-example.supabase.co', SUPABASE_SECRET_KEY: 'test-fixture',
  STRIPE_CONNECT_TEST_SECRET_KEY: 'sk_test_fixture', STRIPE_CONNECT_STATE_SECRET: 'fixture-secret-at-least-32-bytes-long',
  PUBLIC_API_URL: 'https://isolated.example.test', CONNECT_TEST_ISOLATED_DATA: 'true',
};
const env = validate(sample, 'https://current-example.supabase.co');
assert.equal(env.STRIPE_SECRET_KEY, '');
assert.equal(env.STRIPE_MAIN_SUBSCRIPTION_PRICE_ID, '');
assert.equal(env.STRIPE_CONNECT_TEST_ENABLED, 'true');
assert.equal(env.PORT, '4100');
assert.throws(() => validate(sample));
const bootstrap = fs.readFileSync(path.join(__dirname, '../server/src/server.js'), 'utf8').split('\n')[0];
for (const [flag, expectedLoads] of [['true', 0], [undefined, 1]]) {
  let loads = 0;
  vm.runInNewContext(bootstrap, {
    process: { env: { CONNECT_TEST_ENV_ISOLATED: flag } },
    require: () => ({ config: () => { loads += 1; } }),
  });
  assert.equal(loads, expectedLoads);
}
for (const patch of [
  { STRIPE_CONNECT_TEST_SECRET_KEY: 'sk_live_fixture' }, { STRIPE_CONNECT_STATE_SECRET: 'short' },
  { SUPABASE_URL: 'https://current-example.supabase.co' },
  { PUBLIC_API_URL: 'http://localhost:4100' }, { PUBLIC_API_URL: 'https://example.test/path' },
  { PUBLIC_API_URL: 'https://user:password@example.test' }, { SUPABASE_SECRET_KEY: '' },
  { CONNECT_TEST_ISOLATED_DATA: 'false' }, { PORT: '0' },
]) assert.throws(() => validate({ ...sample, ...patch }, 'https://current-example.supabase.co'));
console.log('Connect test environment: isolated database, test key, safe callback and disabled existing Stripe payments verified.');