const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const createConnect = require('../server/src/stripe-connect');
const root = path.dirname(require.resolve('../package.json'));

let checks = 0;
const equal = (actual, expected) => { assert.deepStrictEqual(actual, expected); checks += 1; };
const clone = (value) => JSON.parse(JSON.stringify(value));
const fixture = (patch = {}) => {
  const state = { now: 100000000, users: new Map(), accounts: new Map(), creates: [], retrieves: [], links: [], factories: 0, writes: 0 };
  const user = (id, role = 'principal', owner) => ({ id, email: `${id}@example.test`, email_confirmed_at: '2026-01-01',
    app_metadata: { role, active_session_id: `session-${id}`, active_device_id: `device-${id}`, ...(owner ? { company_owner_id: owner } : {}) },
    user_metadata: { full_name: `Name ${id}`, company_owner_id: 'foreign', role: 'principal' } });
  state.users.set('owner', user('owner'));
  state.users.set('other', user('other'));
  state.users.set('employee', user('employee', 'empleado', 'owner'));
  const env = { STRIPE_CONNECT_TEST_ENABLED: 'true', STRIPE_CONNECT_TEST_SECRET_KEY: 'sk_test_fixture',
    STRIPE_CONNECT_STATE_SECRET: 'fixture-state-secret-with-at-least-32-bytes', PUBLIC_API_URL: 'https://api.example.test', ...patch };
  const client = { v2: { core: { accounts: {
    async create(params, options) {
      state.creates.push(clone({ params, options }));
      if (state.tokenRequired) throw Object.assign(new Error('sensitive upstream details'), { code: 'account_token_required' });
      if (state.failCreate) throw new Error('sensitive credentials');
      const account = { id: 'acct_fixture', livemode: false, identity: params.identity, dashboard: params.dashboard, defaults: params.defaults,
        metadata: params.metadata, configuration: { merchant: { capabilities: { card_payments: { status: 'inactive' },
          stripe_balance: { payouts: { status: 'pending' } } } } }, requirements: { entries: [{ awaiting_action_from: 'user' }] } };
      Object.assign(account, state.accountPatch);
      state.accounts.set(account.id, clone(account));
      if (state.lostResponse) { state.lostResponse = false; throw new Error('response lost'); }
      return clone(account);
    },
    async retrieve(id, params) { state.retrieves.push({ id, params }); if (state.failRetrieve) throw new Error('secret'); return clone(state.accounts.get(id)); },
    async *list(params) { equal(params, { limit: 100 }); for (const account of state.accounts.values()) yield clone(account); },
  }, accountLinks: { async create(params) {
    state.links.push(clone(params));
    if (state.failLink) throw new Error('secret link credentials');
    if (state.beforeLink) state.beforeLink();
    return { account: params.account, livemode: false, url: state.linkUrl || 'https://onboarding.stripe.com/setup/test',
      expires_at: '2026-10-05T10:00:00Z', ...state.linkPatch };
  } } } },
  terminal: {
    locations: {
      async retrieve(id, _params, options) {
        state.locationRetrieves = state.locationRetrieves || [];
        state.locationRetrieves.push({ id, options: options ? clone(options) : undefined });
        if (state.failLocationRetrieve) throw new Error('missing location');
        return { id };
      },
      async create(params, options) {
        state.locationCreates = state.locationCreates || [];
        state.locationCreates.push({ params: clone(params), options: options ? clone(options) : undefined });
        if (state.failLocationCreate) throw new Error('invalid address');
        const id = options?.stripeAccount ? 'tml_connected' : 'tml_platform';
        return { id };
      },
      async list(_params, options) {
        state.locationLists = state.locationLists || [];
        state.locationLists.push({ options: options ? clone(options) : undefined });
        return { data: [] };
      },
    },
  },
  paymentMethodConfigurations: {
    async list(_params, options) {
      state.pmcLists = state.pmcLists || [];
      state.pmcLists.push({ options: clone(options) });
      return { data: [{ id: 'pmc_fixture', is_default: true, active: true }] };
    },
    async update(id, params, options) {
      state.pmcUpdates = state.pmcUpdates || [];
      state.pmcUpdates.push({ id, params: clone(params), options: clone(options) });
      return { id, ...params };
    },
  },
  accounts: {
    async update(id, params) {
      state.accountUpdates = state.accountUpdates || [];
      state.accountUpdates.push({ id, params: clone(params) });
      return { id, ...params };
    },
  },
  };
  const locks = new Map();
  const deps = { env, now: () => state.now, stripeFactory(key) { equal(key, 'sk_test_fixture'); state.factories += 1; return client; },
    async fetchAuthoritativeUser(id) { return state.users.has(id) ? clone(state.users.get(id)) : null; },
    async updateUserAppMetadata(id, metadata) {
      state.writes += 1;
      if (state.failSave || (state.failBinding && metadata.stripe_connect_test_account_id)) return { error: true };
      Object.assign(state.users.get(id).app_metadata, clone(metadata));
      return { data: { user: clone(state.users.get(id)) } };
    },
    async withAccountLock(id, task) {
      const prior = locks.get(id) || Promise.resolve();
      const next = prior.then(task);
      locks.set(id, next.catch(() => undefined));
      return next;
    },
  };
  let handlers = createConnect(deps);
  const call = async (handler, options = {}) => {
    const id = options.id || 'owner';
    const req = { user: clone(state.users.get(id) || { id }), authSessionId: options.session || `session-${id}`,
      body: options.body || { country: 'ES' }, query: options.query || {} };
    const res = { statusCode: 200, headers: {}, set(key, value) { this.headers[key] = value; },
      status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; },
      redirect(url) { this.statusCode = 302; this.url = url; return this; } };
    await handlers[handler](req, res);
    return res;
  };
  const resolveConnectedAccount = (options = {}) => {
    const id = options.id || 'owner';
    return handlers.resolveConnectedAccount({
      user: clone(state.users.get(id) || { id }),
      authSessionId: options.session || `session-${id}`,
    }, options);
  };
  const resolveTerminalContext = (options = {}) => {
    const id = options.id || 'owner';
    return handlers.resolveTerminalContext({
      user: clone(state.users.get(id) || { id }),
      authSessionId: options.session || `session-${id}`,
    });
  };
  return {
    state, env, call, resolveConnectedAccount, resolveTerminalContext,
    ensureConnectedLocalPaymentMethods: (...args) => handlers.ensureConnectedLocalPaymentMethods(...args),
    restart() { handlers = createConnect(deps); },
    callbackState() {
      return new URL(state.links.at(-1).use_case.account_onboarding.return_url).searchParams.get('state');
    },
  };
};

const checkWiring = async () => {
  const routes = new Map();
  const app = { set() {}, use() {}, listen() {} };
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    app[method] = (route, ...handlers) => routes.set(`${method.toUpperCase()} ${route}`, handlers);
  }
  const express = () => app;
  express.json = express.raw = express.urlencoded = () => () => undefined;
  const owner = { id: 'owner', app_metadata: { role: 'principal', active_session_id: 'session-owner', active_device_id: 'device-owner' } };
  const client = { auth: { async getUser() { return { data: { user: clone(owner) } }; },
    admin: { async getUserById() { return { data: { user: clone(owner) } }; } } } };
  const modules = { dotenv: { config() {} }, express, crypto, qrcode: {},
    stripe: () => { throw new Error('Stripe must not initialize when disabled'); },
    '@supabase/supabase-js': { createClient: () => client }, './stripe-connect': createConnect };
  const source = fs.readFileSync(path.join(root, 'server/src/server.js'), 'utf8');
  vm.runInNewContext(source, { require(name) { assert.ok(name in modules); return modules[name]; },
    process: { env: { NODE_ENV: 'test', PUBLIC_API_URL: 'https://api.example.test',
      SUPABASE_URL: 'https://supabase.example.test', SUPABASE_SECRET_KEY: 'fixture' } },
    console: { log() {}, warn() {}, error() {} }, Buffer, URL, setTimeout, clearTimeout }, { filename: 'server.js' });
  equal(routes.get('GET /api/stripe/connect/status').length, 2);
  equal(routes.get('POST /api/stripe/connect/onboarding').length, 2);
  equal(routes.get('GET /api/stripe/connect/return').length, 1);
  equal(routes.get('GET /api/stripe/connect/refresh').length, 1);
  for (const route of ['GET /api/stripe/connect/status', 'POST /api/stripe/connect/onboarding']) {
    for (const session of [null, 'stale', 'session-owner']) {
      const headers = session ? { authorization: `Bearer header.${Buffer.from(JSON.stringify({ session_id: session })).toString('base64url')}.sig` } : {};
      const req = { headers, body: { country: 'ES' }, query: {} };
      const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
      const handlers = routes.get(route);
      await handlers[0](req, res, () => handlers[1](req, res));
      equal(res.statusCode, session === null ? 401 : session === 'stale' ? 409 : route.startsWith('GET') ? 200 : 503);
    }
  }
};

const checkSdk = (creation, retrieval, link) => {
  const file = path.join(root, 'scripts/connect-sdk-contract.ts').replace(/\\/g, '/');
  const source = `import type { V2 as Accounts } from '../server/node_modules/stripe/cjs/resources/V2/Core/Accounts';
import type { V2 as Links } from '../server/node_modules/stripe/cjs/resources/V2/Core/AccountLinks';
const creation: Accounts.Core.AccountCreateParams = ${JSON.stringify(creation)};
const retrieval: Accounts.Core.AccountRetrieveParams = ${JSON.stringify(retrieval)};
const link: Links.Core.AccountLinkCreateParams = ${JSON.stringify(link)};
const candidates: Accounts.Core.AccountCreateParams[] = ${JSON.stringify(
    'AT BE BG HR CY CZ DK EE FI DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE'.split(' ')
      .map(country => ({ ...creation, identity: { country } })))};
void candidates;
void creation; void retrieval; void link;`;
  const options = { noEmit: true, skipLibCheck: true, strict: true, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10 };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version, ...args) => name === file
    ? ts.createSourceFile(name, source, version, true) : original(name, version, ...args);
  const program = ts.createProgram([file], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  equal(diagnostics.map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')), []);
};

const main = async () => {
  await checkWiring();
  const countries = 'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE'.split(' ');
  for (const country of countries) {
    const candidate = fixture({ STRIPE_CONNECT_TEST_COUNTRIES: countries.join(',') });
    const result = await candidate.call('onboarding', { body: { country } });
    equal(result.statusCode, country === 'FR' ? 503 : 200);
    if (country === 'FR') {
      equal(result.body.code, 'connect_country_requires_supported_onboarding');
      equal(candidate.state.writes, 0);
      equal(candidate.state.creates.length, 0);
      equal(candidate.state.factories, 0);
    } else {
      equal(candidate.state.creates[0].params.identity.country, country);
      equal(candidate.state.users.get('owner').app_metadata.stripe_connect_test_country, country);
      equal((await candidate.call('refresh', { query: { state: candidate.callbackState() } })).statusCode, 302);
      equal((await candidate.call('return', { query: { state: candidate.callbackState() } })).statusCode, 302);
    }
  }
  const unapproved = fixture();
  equal((await unapproved.call('onboarding', { body: { country: 'DE' } })).body.code, 'connect_country_not_approved');
  equal(unapproved.state.writes, 0);
  const tokenRequired = fixture();
  tokenRequired.state.tokenRequired = true;
  equal((await tokenRequired.call('onboarding')).body.code, 'connect_country_requires_supported_onboarding');
  equal(tokenRequired.state.users.get('owner').app_metadata.stripe_connect_test_account_id, undefined);
  equal(tokenRequired.state.links.length, 0);
  const pendingRace = fixture({ STRIPE_CONNECT_TEST_COUNTRIES: 'ES,DE' });
  pendingRace.state.lostResponse = true;
  const pendingRaceResults = await Promise.all(['DE', 'ES'].map(country => pendingRace.call('onboarding', { body: { country } })));
  equal(pendingRaceResults.map(result => result.statusCode), [502, 409]);
  equal(pendingRace.state.creates.length, 1);
  equal(pendingRace.state.users.get('owner').app_metadata.stripe_connect_test_creation.country, 'DE');
  pendingRace.restart();
  equal((await pendingRace.call('onboarding', { body: { country: 'DE' } })).statusCode, 200);
  equal(pendingRace.state.creates.length, 1);
  for (const value of [null, '', 'US', 'es']) {
    const corrupt = fixture();
    await corrupt.call('onboarding');
    corrupt.state.users.get('owner').app_metadata.stripe_connect_test_country = value;
    const writes = corrupt.state.writes;
    equal((await corrupt.call('onboarding')).body.code, 'connect_country_mismatch');
    equal((await corrupt.call('status')).body.code, 'connect_country_mismatch');
    equal(corrupt.state.writes, writes);
  }
  for (const config of ['', 'ES,US', 'es', 'ES,']) {
    equal((await fixture({ STRIPE_CONNECT_TEST_COUNTRIES: config }).call('status')).body.code, 'connect_country_config_invalid');
  }
  const race = fixture({ STRIPE_CONNECT_TEST_COUNTRIES: 'ES,DE' });
  const raceResults = await Promise.all(['DE', 'ES'].map(country => race.call('onboarding', { body: { country } })));
  equal(raceResults.map(result => result.statusCode), [200, 409]);
  equal(race.state.creates.length, 1);
  const pendingCountry = fixture({ STRIPE_CONNECT_TEST_COUNTRIES: 'ES,DE' });
  pendingCountry.state.failCreate = true;
  equal((await pendingCountry.call('onboarding', { body: { country: 'DE' } })).statusCode, 502);
  const pendingWrites = pendingCountry.state.writes;
  equal((await pendingCountry.call('onboarding')).body.code, 'connect_country_mismatch');
  equal(pendingCountry.state.writes, pendingWrites);
  pendingCountry.state.failCreate = false;
  pendingCountry.state.accountPatch = { identity: { country: 'ES' } };
  equal((await pendingCountry.call('onboarding', { body: { country: 'DE' } })).body.code, 'connect_country_mismatch');
  equal(pendingCountry.state.writes, pendingWrites);
  const disabled = fixture({ STRIPE_CONNECT_TEST_ENABLED: 'false', STRIPE_SECRET_KEY: 'sk_live_unused' });
  equal((await disabled.call('status', { id: 'employee' })).body, { ok: true, enabled: false, livemode: false,
    connected: false, accountId: null, chargesEnabled: false, payoutsEnabled: false, requirementsPending: false,
    directCharges: false, phase: 'onboarding_only' });
  equal((await disabled.call('onboarding')).statusCode, 503);
  equal(disabled.state.factories, 0);
  for (const patch of [{ STRIPE_CONNECT_TEST_SECRET_KEY: undefined, STRIPE_SECRET_KEY: 'sk_test_fixture' },
    { STRIPE_CONNECT_TEST_SECRET_KEY: 'sk_live_fixture' }, { STRIPE_CONNECT_STATE_SECRET: 'short' },
    { PUBLIC_API_URL: 'http://api.example.test' }, { PUBLIC_API_URL: 'https://user:pass@api.example.test' }, { PUBLIC_API_URL: undefined }]) {
    const test = fixture(patch);
    equal((await test.call('status')).statusCode, 503);
    equal(test.state.factories, 0);
  }
  const test = fixture();
  equal((await test.call('status')).body.connected, false);
  equal(test.state.factories, 0);
  equal((await test.call('onboarding', { id: 'employee' })).statusCode, 403);
  for (const country of [undefined, null, 'US', 'GB', 'NO', 'CH', 'es', ' ES ', '', {}, 123]) {
    const writes = test.state.writes;
    equal((await test.call('onboarding', { body: { country } })).statusCode, 400);
    equal(test.state.writes, writes);
  }
  const results = await Promise.all(Array.from({ length: 12 }, () => test.call('onboarding', { body: {
    country: 'ES', ownerId: 'other', accountId: 'acct_attacker', email: 'attacker@example.test', full_name: 'attacker', role: 'principal' } })));
  equal(results.every((result) => result.statusCode === 200), true);
  equal(test.state.creates.length, 1);
  const payload = test.state.creates[0].params;
  equal(payload.contact_email, 'owner@example.test');
  equal(payload.display_name, 'Name owner');
  equal(payload.configuration, { customer: {}, merchant: { capabilities: { card_payments: { requested: true } } } });
  equal(payload.identity, { country: 'ES' });
  equal(payload.dashboard, 'full');
  equal(payload.defaults, { responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } });
  equal(Object.keys(test.state.creates[0].options), ['idempotencyKey']);
  equal(test.state.users.get('employee').app_metadata.stripe_connect_test_account_id, undefined);
  equal((await test.call('status', { id: 'employee' })).body, (await test.call('status')).body);
  equal((await test.call('status')).body.requirementsPending, true);
  const account = test.state.accounts.get('acct_fixture');
  account.configuration.merchant.capabilities.card_payments.status = 'active';
  account.configuration.merchant.capabilities.stripe_balance.payouts.status = 'active';
  account.requirements.entries = [];
  equal((await test.call('status')).body.chargesEnabled, true);
  equal((await test.call('status')).body.payoutsEnabled, true);
  equal((await test.call('status')).body.requirementsPending, false);
  delete account.configuration;
  equal((await test.call('status')).body.chargesEnabled, false);
  equal((await test.call('status')).body.requirementsPending, true);
  for (const patch of [{ livemode: true }, { metadata: { supabase_owner_id: 'other' } }, { dashboard: 'express' },
    { defaults: null }, { defaults: { responsibilities: { fees_collector: 'application', losses_collector: 'stripe' } } }]) {
    const original = clone(account);
    Object.assign(account, patch);
    equal((await test.call('status')).statusCode, 409);
    Object.assign(account, original);
  }
  equal(test.state.retrieves.every((entry) => entry.params.include.includes('defaults')), true);
  checkSdk(payload, test.state.retrieves[0].params, test.state.links[0]);
  const legacy = fixture();
  delete legacy.state.users.get('owner').app_metadata.role;
  equal((await legacy.call('onboarding')).statusCode, 200);
  for (const patch of [{ role: undefined, company_owner_id: 'other' }, { role: 'principal', company_owner_id: 'other' }, { role: 'admin' }]) {
    const invalid = fixture();
    Object.assign(invalid.state.users.get('owner').app_metadata, patch);
    equal((await invalid.call('onboarding')).statusCode, 403);
    equal(invalid.state.creates.length, 0);
  }
  const lost = fixture();
  lost.state.lostResponse = true;
  equal((await lost.call('onboarding')).statusCode, 502);
  equal(Boolean(lost.state.users.get('owner').app_metadata.stripe_connect_test_creation.token), true);
  lost.state.now += 25 * 60 * 60 * 1000;
  lost.restart();
  equal((await lost.call('onboarding')).statusCode, 200);
  equal(lost.state.creates.length, 1);
  for (const lostResponse of [false, true]) {
    const legacyPending = fixture({ STRIPE_CONNECT_TEST_COUNTRIES: 'ES,DE' });
    legacyPending.state.failCreate = !lostResponse;
    legacyPending.state.lostResponse = lostResponse;
    await legacyPending.call('onboarding');
    delete legacyPending.state.users.get('owner').app_metadata.stripe_connect_test_creation.country;
    equal((await legacyPending.call('onboarding', { body: { country: 'DE' } })).body.code, 'connect_country_mismatch');
    legacyPending.state.failCreate = false;
    equal((await legacyPending.call('onboarding')).statusCode, 200);
    equal(legacyPending.state.users.get('owner').app_metadata.stripe_connect_test_country, 'ES');
  }
  for (const operation of ['onboarding', 'status', 'return', 'refresh']) {
    const mismatch = fixture();
    await mismatch.call('onboarding');
    const signed = mismatch.callbackState();
    mismatch.state.accounts.get('acct_fixture').identity.country = 'DE';
    const writes = mismatch.state.writes;
    equal((await mismatch.call(operation, { query: { state: signed } })).body.code, 'connect_country_mismatch');
    equal(mismatch.state.writes, writes);
  }
  const failed = fixture();
  failed.state.failCreate = true;
  equal((await failed.call('onboarding')).statusCode, 502);
  const firstKey = failed.state.creates[0].options.idempotencyKey;
  failed.state.failCreate = false;
  equal((await failed.call('onboarding')).statusCode, 200);
  equal(failed.state.creates[1].options.idempotencyKey, firstKey);
  const expiredCreation = fixture();
  expiredCreation.state.failCreate = true;
  await expiredCreation.call('onboarding');
  expiredCreation.state.now += 25 * 60 * 60 * 1000;
  equal((await expiredCreation.call('onboarding')).body.code, 'connect_creation_recovery_required');
  equal(expiredCreation.state.creates.length, 1);
  const storage = fixture();
  storage.state.failSave = true;
  equal((await storage.call('onboarding')).statusCode, 503);
  equal(storage.state.creates.length, 0);
  const binding = fixture();
  binding.state.failBinding = true;
  equal((await binding.call('onboarding')).statusCode, 503);
  binding.state.failBinding = false;
  equal((await binding.call('onboarding')).statusCode, 200);
  equal(binding.state.creates.length, 1);
  const callbacks = fixture();
  await callbacks.call('onboarding');
  let state = callbacks.callbackState();
  equal((await callbacks.call('return', { query: { state: `${state}tamper` } })).statusCode, 400);
  callbacks.restart();
  equal((await callbacks.call('refresh', { query: { state, accountId: 'acct_attacker' } })).statusCode, 302);
  equal((await callbacks.call('return', { query: { state } })).statusCode, 400);
  state = callbacks.callbackState();
  equal((await callbacks.call('return', { query: { state } })).url, 'tpvapp://pago-completado?connect=return');
  equal((await callbacks.call('return', { query: { state } })).statusCode, 400);
  for (const kind of ['expiry', 'session', 'device', 'nonce', 'role', 'country']) {
    await callbacks.call('onboarding');
    const signed = callbacks.callbackState();
    const metadata = callbacks.state.users.get('owner').app_metadata;
    const original = clone(metadata);
    if (kind === 'expiry') callbacks.state.now += 30 * 60 * 1000;
    if (kind === 'session') metadata.active_session_id = 'new-session';
    if (kind === 'device') metadata.active_device_id = 'new-device';
    if (kind === 'nonce') metadata.stripe_connect_test_state_nonce = 'new-nonce';
    if (kind === 'role') metadata.role = 'empleado';
    if (kind === 'country') metadata.stripe_connect_test_country = 'DE';
    equal((await callbacks.call('return', { query: { state: signed } })).statusCode, 400);
    equal((await callbacks.call('refresh', { query: { state: signed } })).statusCode, 400);
    callbacks.state.users.get('owner').app_metadata = original;
  }
  {
    const fx = fixture({ STRIPE_CONNECT_TEST_COUNTRIES: 'ES' });
    fx.state.linkUrl = 'https://accounts.stripe.com/r/acct_fixture#alu_test_token';
    const onboard = await fx.call('onboarding');
    equal(onboard.statusCode, 200);
    equal(onboard.body.url, 'https://accounts.stripe.com/r/acct_fixture#alu_test_token');
  }
  for (const url of ['http://onboarding.stripe.com/x', 'https://onboarding.stripe.com.attacker.test',
    'https://user:pass@connect.stripe.com/x', 'https://stripe.com/x', 'https://evil.stripe.com/x',
    'https://evil.accounts.stripe.com/x', 'https://connect.stripe.com:444/x']) {
    const unsafe = fixture();
    unsafe.state.linkUrl = url;
    equal((await unsafe.call('onboarding')).statusCode, 502);
  }
  const live = fixture();
  live.state.accountPatch = { livemode: true };
  equal((await live.call('onboarding')).statusCode, 409);
  equal(live.state.links.length, 0);
  equal(live.state.users.get('owner').app_metadata.stripe_connect_test_account_id, undefined);
  equal((await fixture().call('onboarding', { session: 'stale' })).statusCode, 401);
  for (const operation of ['return', 'refresh']) {
    equal((await fixture().call(operation)).statusCode, 400);
    equal((await disabled.call(operation)).statusCode, 503);
  }
  const staleDuringLink = fixture();
  staleDuringLink.state.beforeLink = () => { staleDuringLink.state.users.get('owner').app_metadata.active_session_id = 'transferred'; };
  const staleResult = await staleDuringLink.call('onboarding');
  equal(staleResult.statusCode, 400);
  equal(staleResult.body.url, undefined);
  for (const field of ['active_device_id', 'active_session_id']) {
    const missing = fixture();
    delete missing.state.users.get('owner').app_metadata[field];
    equal((await missing.call('onboarding')).statusCode, field === 'active_session_id' ? 401 : 409);
    equal(missing.state.creates.length, 0);
  }
  const profile = fixture();
  delete profile.state.users.get('owner').email_confirmed_at;
  equal((await profile.call('onboarding')).body.code, 'connect_owner_profile_required');
  equal(profile.state.creates.length, 0);
  for (const linkPatch of [{ livemode: true }, { account: 'acct_foreign' }]) {
    const link = fixture();
    link.state.linkPatch = linkPatch;
    equal((await link.call('onboarding')).statusCode, 502);
  }
  const upstream = fixture();
  upstream.state.failLink = true;
  const sanitized = await upstream.call('onboarding');
  equal(sanitized.body.code, 'connect_upstream_unavailable');
  equal(JSON.stringify(sanitized.body).includes('credentials'), false);
  equal(sanitized.headers['Cache-Control'], 'no-store');
  equal(sanitized.headers['Referrer-Policy'], 'no-referrer');
  const badEmployee = fixture();
  badEmployee.state.users.get('employee').app_metadata.company_owner_id = 'missing';
  equal((await badEmployee.call('status', { id: 'employee' })).statusCode, 403);
  const requirements = fixture();
  await requirements.call('onboarding');
  const requirementsAccount = requirements.state.accounts.get('acct_fixture');
  requirementsAccount.configuration.merchant.capabilities.card_payments.status = 'active';
  requirementsAccount.configuration.merchant.capabilities.stripe_balance.payouts.status = 'active';
  requirementsAccount.requirements = { entries: [], summary: { minimum_deadline: { status: 'eventually_due' } } };
  equal((await requirements.call('status')).body.requirementsPending, true);
  delete requirementsAccount.requirements;
  equal((await requirements.call('status')).body.requirementsPending, true);

  // Cobros directos: resolveConnectedAccount exige cuenta + chargesEnabled; sin fallback a plataforma.
  equal(await fixture({ STRIPE_CONNECT_TEST_ENABLED: 'false' }).resolveConnectedAccount({ requireCharges: true }), null);
  const chargeReady = fixture();
  await chargeReady.call('onboarding');
  try {
    await chargeReady.resolveConnectedAccount({ requireCharges: true });
    assert.fail('expected connect_charges_not_enabled');
  } catch (error) {
    equal(error.code, 'connect_charges_not_enabled');
    equal(error.status, 409);
  }
  const chargeAccount = chargeReady.state.accounts.get('acct_fixture');
  chargeAccount.configuration.merchant.capabilities.card_payments.status = 'active';
  const resolved = await chargeReady.resolveConnectedAccount({ requireCharges: true });
  equal(resolved.accountId, 'acct_fixture');
  equal(resolved.ownerId, 'owner');
  equal(resolved.status.directCharges, true);
  equal(resolved.status.chargesEnabled, true);
  const employeeResolved = await chargeReady.resolveConnectedAccount({ id: 'employee', requireCharges: true });
  equal(employeeResolved.accountId, 'acct_fixture');
  equal(employeeResolved.ownerId, 'owner');
  const noAccount = fixture();
  try {
    await noAccount.resolveConnectedAccount({ requireCharges: true });
    assert.fail('expected connect_not_connected');
  } catch (error) {
    equal(error.code, 'connect_not_connected');
  }
  // Status con Connect activo marca directCharges.
  equal((await chargeReady.call('status')).body.directCharges, true);

  // Terminal Connect: ubicación en plataforma + mode destination (on_behalf_of).
  equal(await fixture({ STRIPE_CONNECT_TEST_ENABLED: 'false' }).resolveTerminalContext(), null);
  const terminal = fixture();
  await terminal.call('onboarding');
  terminal.state.accounts.get('acct_fixture').configuration.merchant.capabilities.card_payments.status = 'active';
  const terminalCtx = await terminal.resolveTerminalContext();
  equal(terminalCtx.locationId, 'tml_platform');
  equal(terminalCtx.accountId, 'acct_fixture');
  equal(terminalCtx.terminalMode, 'destination');
  equal(terminal.state.locationCreates.length, 1);
  equal(terminal.state.locationCreates[0].options, undefined);
  equal(terminal.state.locationCreates[0].params.address, {
    line1: 'Calle Provisional 1', city: 'Madrid', postal_code: '28001', country: 'ES',
  });
  equal(terminal.state.users.get('owner').app_metadata.stripe_connect_test_platform_terminal_location_id, 'tml_platform');
  const terminalReuse = await terminal.resolveTerminalContext();
  equal(terminalReuse.locationId, 'tml_platform');
  equal(terminal.state.locationCreates.length, 1);
  equal(terminal.state.locationRetrieves.length, 1);
  const terminalFail = fixture();
  await terminalFail.call('onboarding');
  terminalFail.state.accounts.get('acct_fixture').configuration.merchant.capabilities.card_payments.status = 'active';
  terminalFail.state.failLocationCreate = true;
  try {
    await terminalFail.resolveTerminalContext();
    assert.fail('expected connect_terminal_location_invalid');
  } catch (error) {
    equal(error.code, 'connect_terminal_location_invalid');
  }

  // Métodos locales (Bizum): capacidad + PMC de la cuenta Connect.
  const pmc = fixture();
  await pmc.call('onboarding');
  await pmc.ensureConnectedLocalPaymentMethods('acct_fixture', 'ES');
  equal(pmc.state.accountUpdates[0].params.capabilities.bizum_payments, { requested: true });
  equal(pmc.state.pmcLists[0].options, { stripeAccount: 'acct_fixture' });
  equal(pmc.state.pmcUpdates[0].params.bizum, { display_preference: { preference: 'on' } });

  console.log(`Stripe Connect: ${checks} checks passed (mocked, no network).`);
};

main().catch((error) => { console.error(error); process.exitCode = 1; });