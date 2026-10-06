const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.dirname(require.resolve('../package.json'));
const compile = code => ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const load = file => {
  const exports = {};
  vm.runInNewContext(compile(fs.readFileSync(path.join(root, file), 'utf8')), { exports, URL, Intl,
    require(name) {
      assert.ok(name.startsWith('./translations/'));
      return load(`src/${name.slice(2)}.ts`);
    },
  });
  return exports;
};
const helper = load('src/payments/connect-onboarding.ts');
const { connectTranslations } = load('src/translations/connect.ts');
const source = fs.readFileSync(path.join(root, 'src/app/index.tsx'), 'utf8');
const ast = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const nodes = [];
const visit = node => { nodes.push(node); ts.forEachChild(node, visit); };
visit(ast);
const declaration = name => nodes.find(node => ts.isVariableDeclaration(node) && node.name.getText(ast) === name);
const unmountEffect = nodes.find(node => ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' &&
  node.arguments[0].getText(ast).includes('stripeConnectBusyRef.current = null'));
let checks = 0;
const equal = (actual, expected) => {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)));
  checks += 1;
};
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const status = (patch = {}) => ({ ok: true, enabled: true, livemode: false, connected: false,
  accountId: null, chargesEnabled: false, payoutsEnabled: false, requirementsPending: false,
  phase: 'onboarding_only', ...patch });
const pending = status({ connected: true, accountId: 'acct_fixture', requirementsPending: true });
const ready = { ...pending, chargesEnabled: true, payoutsEnabled: true, requirementsPending: false };
const link = (patch = {}) => ({ ok: true, livemode: false, phase: 'onboarding_only', accountId: 'acct_fixture',
  url: 'https://onboarding.stripe.com/setup/sensitive-token', expiresAt: '2099-01-01T00:00:00Z', ...patch });
const contextFor = (overrides = {}) => {
  const context = vm.createContext({
    ...helper, URL, requests: [], browsers: [], mutations: [], tokenCalls: 0,
    userRole: 'principal', accessToken: 'old-token', configuredDocumentApiUrl: 'https://api.test',
    isLoaded: true, storageScope: 'owner:owner', storageScopeRef: { current: 'owner:owner' },
    loadedScopeRef: { current: 'owner:owner' }, cacheGenerationRef: { current: 1 },
    stripeConnectBusyRef: { current: null }, stripeAccountLoading: false, stripeMethodsInfo: '', stripeMethodsError: '',
    issuer: { country: 'ES' }, stripeCountryConfirmed: 'ES', stripeCountryModalVisible: false,
    stripeCountryScopeRef: { current: null },
    ensureFreshAccessToken: async () => `fresh-token-${++context.tokenCalls}`,
    WebBrowser: { openAuthSessionAsync: async (url, redirect) => {
      context.browsers.push({ url, redirect }); return { type: 'cancel' };
    } },
    Linking: { openURL() { throw new Error('Forbidden fallback'); } },
    fetchWithTimeout: async (url, options) => {
      context.requests.push({ url, options });
      return { ok: true, json: async () => options.method === 'POST' ? link() : pending };
    },
    ...overrides,
  });
  for (const name of ['stripeAccountLoading', 'stripeMethodsInfo', 'stripeMethodsError', 'stripeCountryConfirmed', 'stripeCountryModalVisible']) {
    context[`set${name[0].toUpperCase()}${name.slice(1)}`] = value => {
      context[name] = value; context.mutations.push([name, value]);
    };
  }
  vm.runInContext(compile(`openStripeAccountSettings = ${declaration('openStripeAccountSettings').initializer.getText(ast)};`), context);
  return context;
};
const respond = (context, initial = pending, after = pending, post = link(), httpOk = true) => {
  let reads = 0;
  context.fetchWithTimeout = async (url, options) => {
    context.requests.push({ url, options });
    return { ok: httpOk, json: async () => options.method === 'POST' ? post : reads++ === 0 ? initial : after };
  };
};

async function run() {
  equal(helper.CONNECT_EU_COUNTRIES.length, 27);
  equal(new Set(helper.CONNECT_EU_COUNTRIES).size, 27);
  for (const invalid of [undefined, null, 123, '', 'US', 'GB', 'NO', 'CH', 'EU']) equal(helper.normalizeConnectCountry(invalid), null);
  equal(helper.normalizeConnectCountry(' de '), 'DE');
  for (const country of helper.CONNECT_EU_COUNTRIES) {
    const context = contextFor({ issuer: { country: country.toLowerCase() }, stripeCountryConfirmed: country });
    await context.openStripeAccountSettings();
    equal(JSON.parse(context.requests[1].options.body), { country });
    for (const locale of Object.keys(connectTranslations)) {
      equal(helper.connectCountryLabel(country, locale), new Intl.DisplayNames([locale], { type: 'region' }).of(country));
    }
  }
  const fallback = {};
  vm.runInNewContext(compile(fs.readFileSync(path.join(root, 'src/payments/connect-onboarding.ts'), 'utf8')),
    { exports: fallback, URL, Intl: {} });
  equal(fallback.connectCountryLabel('DE', 'es'), 'DE');
  equal(helper.connectCountryLabel('DE', '!invalid'), 'DE');
  const captured = contextFor({ issuer: { country: 'DE' }, stripeCountryConfirmed: 'DE' });
  captured.ensureFreshAccessToken = async () => {
    captured.issuer.country = 'FR';
    captured.stripeCountryConfirmed = 'FR';
    return 'fresh-token';
  };
  await captured.openStripeAccountSettings();
  equal(JSON.parse(captured.requests[1].options.body), { country: 'DE' });
  for (const overrides of [{ stripeCountryConfirmed: null }, { issuer: { country: 'US' } },
    { issuer: { country: 'DE' }, stripeCountryConfirmed: 'ES' }]) {
    const context = contextFor(overrides);
    await context.openStripeAccountSettings();
    equal(context.requests, []);
    equal(context.stripeMethodsError, 'connect.chooseCountry');
  }
  for (const [code, key] of [['connect_country_requires_supported_onboarding', 'connect.countryRequiresSupport'],
    ['connect_country_not_approved', 'connect.countryNotApproved'], ['connect_country_mismatch', 'connect.countryMismatch'],
    ['unknown_secret', 'connect.failed']]) {
    const context = contextFor();
    context.fetchWithTimeout = async (url, options) => {
      context.requests.push({ url, options });
      return { ok: options.method !== 'POST', json: async () => options.method === 'POST' ? { code, error: 'secret' } : pending };
    };
    await context.openStripeAccountSettings();
    equal(context.stripeMethodsError, key);
    equal(context.browsers, []);
    equal(context.stripeAccountLoading, false);
  }
  for (const change of ['none', 'generation', 'scope', 'loaded', 'employee', 'busy', 'closed']) {
    const context = contextFor({ stripeCountryConfirmed: null, issuer: { country: 'ES', name: 'Original' } });
    context.setIssuer = update => { context.issuer = update(context.issuer); };
    for (const name of ['openStripeCountrySelector', 'selectStripeConnectCountry']) {
      vm.runInContext(compile(`${name} = ${declaration(name).initializer.getText(ast)};`), context);
    }
    context.openStripeCountrySelector();
    equal(context.stripeCountryModalVisible, true);
    if (change === 'generation') context.cacheGenerationRef.current += 1;
    if (change === 'scope') context.storageScopeRef.current = 'other:other';
    if (change === 'loaded') context.loadedScopeRef.current = 'other:other';
    if (change === 'employee') context.userRole = 'empleado';
    if (change === 'busy') context.stripeAccountLoading = true;
    if (change === 'closed') context.stripeCountryScopeRef.current = null;
    context.selectStripeConnectCountry('DE');
    equal(context.issuer, { country: change === 'none' ? 'DE' : 'ES', name: 'Original' });
    equal(context.stripeCountryConfirmed, change === 'none' ? 'DE' : null);
  }
  const selectionModal = nodes.find(node => ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'Modal' &&
    node.openingElement.attributes.properties.some(attr => ts.isJsxAttribute(attr) && attr.name.getText(ast) === 'visible' &&
      attr.initializer?.getText(ast) === '{stripeCountryModalVisible}'));
  assert.ok(selectionModal && selectionModal.getText(ast).includes('<ScrollView>') &&
    selectionModal.getText(ast).includes('CONNECT_EU_COUNTRIES.map') && selectionModal.getText(ast).includes('accessibilityRole="radio"'));
  checks += 1;
  equal(helper.parseConnectStatus(status()) !== null, true);
  equal(helper.connectStatusKey(status({ enabled: false })), 'connect.disabled');
  equal(helper.connectStatusKey(status()), 'connect.notConnected');
  equal(helper.connectStatusKey(pending), 'connect.pending');
  equal(helper.connectStatusKey(ready), 'connect.ready');
  for (const value of [null, [], {}, status({ ok: false }), status({ livemode: true }), status({ phase: 'payments' }),
    status({ enabled: 'true' }), status({ connected: true }), status({ accountId: 'acct_foreign' }),
    status({ chargesEnabled: true }), status({ payoutsEnabled: true }), status({ requirementsPending: true }),
    { ...pending, enabled: false }, { ...pending, accountId: 'not-account' }]) equal(helper.parseConnectStatus(value), null);
  for (const value of [link({ ok: false }), link({ livemode: true }), link({ phase: 'live' }),
    link({ accountId: 'bad' }), link({ expiresAt: null }), link({ expiresAt: 'bad' }), link({ expiresAt: 1 }),
    ...['http://onboarding.stripe.com/x', 'https://onboarding.stripe.com.evil.test/x', 'https://user:pass@connect.stripe.com/x',
      'https://connect.stripe.com:444/x', 'https://dashboard.stripe.com/test/dashboard', 'https://evil.accounts.stripe.com/x',
      'javascript:alert(1)', 'tpvapp://pago-completado', '//connect.stripe.com/x'].map(url => link({ url }))]) {
    equal(helper.parseConnectOnboardingUrl(value, null), null);
    const context = contextFor(); respond(context, pending, pending, value);
    await context.openStripeAccountSettings();
    equal(context.browsers, []);
    equal(context.stripeMethodsError, 'connect.failed');
  }
  equal(helper.parseConnectOnboardingUrl(link(), 'acct_foreign'), null);
  equal(helper.parseConnectOnboardingUrl(link({ expiresAt: 9999999999 }), null), link().url);
  equal(helper.parseConnectOnboardingUrl(link({
    url: 'https://accounts.stripe.com/r/acct_fixture#alu_test_token',
  }), null), 'https://accounts.stripe.com/r/acct_fixture#alu_test_token');
  equal(helper.parseConnectOnboardingUrl(link({ url: 'https://connect.stripe.com/x#token' }), null),
    'https://connect.stripe.com/x#token');
  for (const initial of [status({ enabled: false }), status({ livemode: true }), {}, { ...pending, chargesEnabled: 'yes' }]) {
    const context = contextFor(); respond(context, initial);
    await context.openStripeAccountSettings();
    equal(context.requests.length, 1);
    equal(context.browsers, []);
    equal(context.stripeMethodsInfo, initial.enabled === false ? 'connect.disabled' : '');
  }
  for (const overrides of [{ userRole: 'empleado' }, { userRole: 'admin' }, { accessToken: null },
    { configuredDocumentApiUrl: null }, { isLoaded: false }, { storageScope: null },
    { loadedScopeRef: { current: 'other' } }, { storageScopeRef: { current: 'other' } },
    { stripeConnectBusyRef: { current: 1 } }]) {
    const context = contextFor(overrides);
    await context.openStripeAccountSettings(); equal(context.requests, []); equal(context.browsers, []);
  }
  for (const outcome of ['cancel', 'dismiss', 'success', 'throw']) {
    for (const initial of [status(), pending, ready]) {
      for (const after of [pending, ready, status({ enabled: false }), {}]) {
        const context = contextFor(); respond(context, initial, after);
        context.WebBrowser.openAuthSessionAsync = async (url, redirect) => {
          context.browsers.push({ url, redirect });
          if (outcome === 'throw') throw new Error('https://secret.test/token');
          return { type: outcome, url: 'tpvapp://pago-completado?connect=return&success=true' };
        };
        await context.openStripeAccountSettings();
        equal(context.requests.map(request => request.options.method), ['GET', 'POST', 'GET']);
        equal(context.requests.map(request => request.options.headers.Authorization), ['Bearer fresh-token-1', 'Bearer fresh-token-2', 'Bearer fresh-token-3']);
        equal(JSON.parse(context.requests[1].options.body), { country: 'ES' });
        equal(context.browsers, [{ url: link().url, redirect: 'tpvapp://pago-completado' }]);
        equal(context.stripeMethodsInfo, helper.parseConnectStatus(after) ? helper.connectStatusKey(after) : '');
        equal(context.stripeMethodsError, outcome === 'throw' || !helper.parseConnectStatus(after) ? 'connect.failed' : '');
        equal(context.stripeAccountLoading, false);
        equal(context.stripeConnectBusyRef.current, null);
        equal(context.mutations.some(([, value]) => String(value).includes('https:') || String(value).includes('acct_')), false);
      }
    }
  }
  for (const stage of ['token', 'status-fetch', 'status-json', 'post-token', 'post-fetch', 'post-json', 'browser', 'return-token', 'return-json']) {
    for (const change of ['logout', 'switch', 'same-account', 'scope-only', 'unmount']) {
      const context = contextFor();
      const gate = deferred(); const started = deferred();
      let tokens = 0; let reads = 0;
      context.ensureFreshAccessToken = async () => {
        tokens += 1;
        if ((stage === 'token' && tokens === 1) || (stage === 'post-token' && tokens === 2) || (stage === 'return-token' && tokens === 3)) {
          started.resolve(); return gate.promise;
        }
        return 'fresh-token';
      };
      context.fetchWithTimeout = async (url, options) => {
        context.requests.push({ url, options });
        const post = options.method === 'POST'; if (!post) reads += 1;
        if ((stage === 'status-fetch' && reads === 1 && !post) || (stage === 'post-fetch' && post)) {
          started.resolve(); await gate.promise;
        }
        return { ok: true, json: async () => {
          if ((stage === 'status-json' && reads === 1 && !post) || (stage === 'post-json' && post) || (stage === 'return-json' && reads === 2)) {
            started.resolve(); await gate.promise;
          }
          return post ? link() : pending;
        } };
      };
      context.WebBrowser.openAuthSessionAsync = async () => {
        context.browsers.push('opened');
        if (stage === 'browser') { started.resolve(); await gate.promise; }
        return { type: 'success' };
      };
      const action = context.openStripeAccountSettings();
      await started.promise;
      if (change === 'unmount') vm.runInContext(compile(`(${unmountEffect.arguments[0].getText(ast)})()();`), context);
      else if (change === 'scope-only') context.storageScopeRef.current = 'other:other';
      else {
        context.cacheGenerationRef.current += 1;
        context.storageScopeRef.current = change === 'logout' ? null : change === 'switch' ? 'other:other' : 'owner:owner';
        context.stripeConnectBusyRef.current = context.cacheGenerationRef.current;
      }
      const mutations = context.mutations.length; const requests = context.requests.length; const browsers = context.browsers.length;
      gate.resolve('late-token'); await action;
      equal(context.mutations.length, mutations);
      equal(context.requests.length, requests);
      equal(context.browsers.length, browsers);
      equal(context.stripeConnectBusyRef.current, change === 'unmount' ? null : change === 'scope-only' ? 1 : 2);
    }
  }
  const busy = contextFor(); const gate = deferred(); const started = deferred();
  busy.WebBrowser.openAuthSessionAsync = async () => { started.resolve(); return gate.promise; };
  const first = busy.openStripeAccountSettings(); await started.promise;
  await busy.openStripeAccountSettings(); equal(busy.requests.length, 2);
  gate.resolve({ type: 'cancel' }); await first; equal(busy.requests.length, 3);
  await busy.openStripeAccountSettings(); equal(busy.requests.length, 6);
  for (const failure of ['token-null', 'token-throw', 'http', 'json', 'network', 'return-network', 'wrong-account']) {
    const context = contextFor();
    if (failure === 'token-null') context.ensureFreshAccessToken = async () => null;
    if (failure === 'token-throw') context.ensureFreshAccessToken = async () => { throw new Error('secret'); };
    if (failure === 'http') respond(context, { error: 'https://secret.test/token' }, pending, link(), false);
    if (failure === 'wrong-account') respond(context, pending, ready, link({ accountId: 'acct_other' }));
    if (['json', 'network', 'return-network'].includes(failure)) context.fetchWithTimeout = async (url, options) => {
      context.requests.push({ url, options });
      if (failure === 'network' || (failure === 'return-network' && context.requests.length === 3)) throw new Error('secret');
      return { ok: true, json: async () => {
        if (failure === 'json') throw new Error('secret');
        return options.method === 'POST' ? link() : pending;
      } };
    };
    await context.openStripeAccountSettings();
    equal(context.stripeMethodsError, 'connect.failed');
    equal(context.stripeAccountLoading, false);
    equal(context.stripeConnectBusyRef.current, null);
    if (failure !== 'return-network') equal(context.browsers, []);
    else equal(context.stripeMethodsInfo, '');
  }
  const reset = contextFor();
  for (const node of nodes.filter(candidate => ts.isCallExpression(candidate) && /^set[A-Z]/.test(candidate.expression.getText(ast)))) {
    reset[node.expression.getText(ast)] ??= () => {};
  }
  Object.assign(reset, { issuerLoadedScopeRef: {}, autoSyncDoneRef: {}, transactionsRef: {}, onlinePaymentRef: {},
    onlinePaymentConfirmedRef: {}, companyPinBusyRef: {}, refundBusyRef: {}, seatsSyncedRef: {}, initialIssuer: {} });
  vm.runInContext(compile(`resetAccountCache = ${declaration('resetAccountCache').initializer.getText(ast)};`), reset);
  reset.stripeMethodsInfo = 'connect.ready'; reset.stripeMethodsError = 'connect.failed'; reset.stripeAccountLoading = true;
  reset.stripeCountryModalVisible = true; reset.stripeCountryConfirmed = 'DE';
  reset.stripeCountryScopeRef.current = { scope: 'owner:owner', generation: 1 };
  reset.resetAccountCache();
  equal(reset.cacheGenerationRef.current, 2); equal(reset.stripeMethodsInfo, '');
  equal(reset.stripeMethodsError, ''); equal(reset.stripeAccountLoading, false);
  equal(reset.stripeCountryModalVisible, false); equal(reset.stripeCountryConfirmed, null);
  equal(reset.stripeCountryScopeRef.current.generation !== reset.cacheGenerationRef.current, true);
  const button = nodes.find(node => ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'Pressable' &&
    node.openingElement.attributes.properties.some(attr => ts.isJsxAttribute(attr) && attr.name.getText(ast) === 'onPress' &&
      attr.initializer?.getText(ast) === '{openStripeAccountSettings}'));
  assert.ok(button); checks += 1;
  const disabled = button.openingElement.attributes.properties.find(attr => attr.name?.getText(ast) === 'disabled').initializer.expression;
  for (const [loading, role, loaded, expected] of [[false, 'principal', true, false], [true, 'principal', true, true],
    [false, 'empleado', true, true], [false, 'principal', false, true]]) {
    equal(vm.runInNewContext(disabled.getText(ast), { stripeAccountLoading: loading, userRole: role, isLoaded: loaded,
      stripeCountryConfirmed: 'ES', issuer: { country: 'ES' }, normalizeConnectCountry: helper.normalizeConnectCountry }), expected);
  }
  equal(source.includes('/api/stripe/account'), false);
  equal(declaration('openStripeAccountSettings').initializer.getText(ast).includes('Linking.'), false);
  equal(declaration('openStripeAccountSettings').initializer.getText(ast).includes('dashboard.stripe.com'), false);
  const keys = Object.keys(connectTranslations.es).sort();
  const translation = load('src/i18n.ts');
  for (const [locale, dictionary] of Object.entries(connectTranslations)) {
    equal(Object.keys(dictionary).sort(), keys);
    equal(dictionary['connect.phase'].includes('TEST ONLY'), true);
    for (const key of keys) {
      equal(typeof dictionary[key] === 'string' && dictionary[key].length > 0, true);
      equal(translation.t(locale, key), dictionary[key]);
    }
    equal(['es', 'en', 'fr', 'de', 'it', 'pt', 'nl', 'pl'].includes(locale), true);
  }
  const callbackSource = fs.readFileSync(path.join(root, 'src/app/pago-completado.tsx'), 'utf8');
  const callbackAst = ts.createSourceFile('pago-completado.tsx', callbackSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const callbackNodes = [];
  const visitCallback = node => { callbackNodes.push(node); ts.forEachChild(node, visitCallback); };
  visitCallback(callbackAst);
  const callbackDeclaration = name => callbackNodes.find(node => ts.isVariableDeclaration(node) && node.name.getText(callbackAst) === name);
  const navigation = callbackNodes.find(node => ts.isCallExpression(node) && node.expression.getText(callbackAst) === 'useEffect' &&
    node.arguments[0].getText(callbackAst).includes('router.back'));
  const messages = callbackNodes.filter(node => ts.isJsxExpression(node) && node.expression?.getText(callbackAst).startsWith('isConnectOnboarding ? t('));
  equal(messages.length, 2);
  for (const locale of Object.keys(connectTranslations)) {
    for (const connect of ['return', undefined]) {
      for (const flow of ['payment-method-setup', undefined]) {
        for (const result of ['success', 'cancel']) {
          const context = vm.createContext({ connect, flow, result, locale, t: translation.t, navigation: [],
            router: { back: () => context.navigation.push('back'), replace: value => context.navigation.push(value) },
            setTimeout: callback => { callback(); return 1; }, clearTimeout() {},
          });
          for (const name of ['isConnectOnboarding', 'isPaymentMethodSetup', 'paymentMethodSaved']) {
            vm.runInContext(compile(`${name} = ${callbackDeclaration(name).initializer.getText(callbackAst)};`), context);
          }
          vm.runInContext(compile(`(${navigation.arguments[0].getText(callbackAst)})();`), context);
          equal(context.navigation, [connect === 'return' || flow === 'payment-method-setup' ? 'back' : '/']);
          const rendered = messages.map(node => vm.runInContext(node.expression.getText(callbackAst), context));
          if (connect === 'return') equal(rendered, [translation.t(locale, 'connect.returnTitle'), translation.t(locale, 'connect.returnBody')]);
          else equal(rendered[0], flow === 'payment-method-setup' ? result === 'success' ? 'Tarjeta guardada' : 'No se confirmó la tarjeta' : 'Pago recibido');
        }
      }
    }
  }
  console.log(`Connect onboarding app: ${checks} checks passed (real AST, mocked async lifecycle, no network).`);
}

run().catch(error => { console.error(error); process.exitCode = 1; });