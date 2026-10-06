const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.dirname(require.resolve('../package.json'));
const logoSource = fs.readFileSync(path.join(root, 'src/documents/logo-layout.ts'), 'utf8');
const logoExports = {};
vm.runInNewContext(ts.transpileModule(logoSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: logoExports });

const source = fs.readFileSync(path.join(root, 'src/app/index.tsx'), 'utf8');
const ast = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const nodes = [];
const visit = (node) => { nodes.push(node); ts.forEachChild(node, visit); };
visit(ast);
const declaration = (name) => nodes.find((node) => ts.isVariableDeclaration(node) && node.name.getText(ast) === name);
const effects = nodes.filter((node) => ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect');
const effectWith = (text) => effects.find((node) => node.arguments[0].getText(ast).includes(text));
const compile = (code) => ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
let checks = 0;
const equal = (actual, expected) => {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)));
  checks += 1;
};
const loadFunction = (context, name) => vm.runInContext(compile(`${name} = ${declaration(name).initializer.getText(ast)};`), context);
const loadEffect = (context, node, track = false) => {
  let callback = node.arguments[0].getText(ast);
  if (track) callback = callback.replace('(async () => {', 'pendingLoad = (async () => {');
  vm.runInContext(compile(`effect = ${callback}; cleanup = effect();`), context);
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const createContext = () => {
  const values = {};
  const reads = [];
  const writes = [];
  const store = new Map();
  const context = vm.createContext({
    console, values, reads, writes, store,
    storageScope: null, accessToken: null, isLoaded: false,
    storageScopeRef: { current: null }, loadedScopeRef: { current: null }, cacheGenerationRef: { current: 0 },
    issuerLoadedScopeRef: { current: null }, issuerWriteQueueRef: { current: Promise.resolve() }, issuerRef: { current: {} },
    normalizeLogoSettings: logoExports.normalizeLogoSettings,
    autoSyncDoneRef: { current: false }, transactionsRef: { current: [] }, onlinePaymentRef: { current: null },
    companyPinBusyRef: { current: false }, refundBusyRef: { current: false },
    onlinePaymentConfirmedRef: { current: false }, seatsSyncedRef: { current: 0 },
    transactions: [], cashInvoiceDrafts: [], expenses: [], issuer: {}, ownerPin: '', ownerRecoveryEmail: '', ownerRecoveryPhone: '',
    AsyncStorage: {
      async multiGet(keys) { reads.push(...keys); return keys.map((key) => [key, store.get(key) ?? null]); },
      async getItem(key) { reads.push(key); return store.get(key) ?? null; },
      async setItem(key, value) { writes.push([key, value]); store.set(key, value); },
      async removeItem(key) { writes.push([key, null]); store.delete(key); },
    },
    SecureStore: { async deleteItemAsync() {} },
    selectAuthRole() {}, setTokenExpiresAt() {},
  });
  for (const node of nodes.filter((candidate) => ts.isCallExpression(candidate) && /^set[A-Z]/.test(candidate.expression.getText(ast)))) {
    const name = node.expression.getText(ast);
    context[name] = (value) => { values[name] = value; };
  }
  context.setIsLoaded = (value) => { context.isLoaded = value; values.setIsLoaded = value; };
  context.setStorageScope = (value) => { context.storageScope = value; };
  context.setAccessToken = (value) => { context.accessToken = value; };
  context.setIssuer = (value) => {
    context.issuer = typeof value === 'function' ? value(context.issuer) : value;
    context.issuerRef.current = context.issuer;
    values.setIssuer = context.issuer;
  };
  for (const node of nodes.filter((candidate) => ts.isVariableDeclaration(candidate) && candidate.name.getText(ast).startsWith('STORAGE_KEY_'))) {
    context[node.name.getText(ast)] = vm.runInContext(node.initializer.getText(ast), context);
  }
  context.initialIssuer = vm.runInContext(compile(`(${declaration('initialIssuer').initializer.getText(ast)})`), context);
  for (const name of ['restoreIssuerSettings', 'storageScopeFromUser', 'accountStorageKey', 'writeIssuerSettings', 'resetAccountCache', 'activateAccountCache', 'clearStoredSession']) loadFunction(context, name);
  return context;
};

async function run() {
  const context = createContext();
  equal(context.initialIssuer.name, '');
  equal(context.initialIssuer.nif, '');
  equal(context.initialIssuer.address, '');
  equal(context.initialIssuer.managerEmail, '');
  equal(context.initialIssuer.accountHolder, '');
  equal(context.initialIssuer.iban, '');
  equal(context.initialIssuer.bankName, '');
  equal(context.initialIssuer.country, 'ES');
  const owner = { id: 'owner-a' };
  const employee = { id: 'employee-a', app_metadata: { company_owner_id: 'owner-a', role: 'empleado' } };
  const companyB = { id: 'owner-b' };
  equal(context.storageScopeFromUser(undefined), null);
  equal(context.storageScopeFromUser({ app_metadata: { company_owner_id: 'owner-a' } }), null);
  equal(context.storageScopeFromUser(owner), 'owner-a:owner-a');
  equal(context.storageScopeFromUser(employee), 'owner-a:employee-a');
  equal(context.storageScopeFromUser({ id: 'a:b', app_metadata: { company_owner_id: 'c:d' } }), 'c%3Ad:a%3Ab');
  const load = effectWith('AsyncStorage.multiGet');
  const refundedCache = createContext();
  refundedCache.activateAccountCache(owner);
  refundedCache.accessToken = 'token-a';
  const cachedPartial = { id: 'partial', ticketCode: 'TK-PARTIAL', type: 'COBRO', amount: 70,
    originalAmount: 100, ivaRateApplied: 21, refundHistory: [{ amount: 30, date: '2026-10-05T10:00:00Z' }],
    publicUrl: 'https://api.test/documents/partial' };
  refundedCache.store.set(refundedCache.accountStorageKey(refundedCache.STORAGE_KEY_TRANSACTIONS, refundedCache.storageScope), JSON.stringify([cachedPartial]));
  loadEffect(refundedCache, load, true);
  await refundedCache.pendingLoad;
  equal(refundedCache.values.setTransactions[0].publicUrl, cachedPartial.publicUrl);
  equal(refundedCache.values.setTransactions[0].refundHistory, cachedPartial.refundHistory);
  const persistence = effects.filter((node) => /AsyncStorage\.setItem\(accountStorageKey\(|void writeIssuerSettings\(storageScope, issuer\)/.test(node.arguments[0].getText(ast)));
  equal(persistence.length, 7);
  loadEffect(context, load);
  equal(context.reads, []);
  context.activateAccountCache(owner);
  loadEffect(context, load);
  equal(context.reads, []);
  context.accessToken = 'token-a';
  context.store.set(context.STORAGE_KEY_EXPENSES, JSON.stringify([{ id: 'unattributed-legacy' }]));
  context.store.set(context.accountStorageKey(context.STORAGE_KEY_EXPENSES, context.storageScope), JSON.stringify([{ id: 'expense-a' }]));
  context.store.set(context.accountStorageKey(context.STORAGE_KEY_OWNER_PIN, context.storageScope), '1234');
  loadEffect(context, load, true);
  await context.pendingLoad;
  equal(context.values.setExpenses, [{ id: 'expense-a' }]);
  equal(context.values.setOwnerPin, '1234');
  equal(context.isLoaded, true);
  equal(context.reads.every((key) => key.endsWith(':account:owner-a:owner-a')), true);
  for (const effect of persistence) loadEffect(context, effect);
  await context.issuerWriteQueueRef.current;
  equal(context.writes.length, 7);
  equal(context.writes.every(([key]) => key.endsWith(':account:owner-a:owner-a')), true);
  for (const guard of ['not-loaded', 'no-scope', 'not-current', 'not-loaded-scope']) {
    const guarded = createContext();
    guarded.storageScope = 'owner-b:owner-b';
    guarded.storageScopeRef.current = guarded.storageScope;
    guarded.loadedScopeRef.current = guarded.storageScope;
    guarded.issuerLoadedScopeRef.current = guarded.storageScope;
    guarded.isLoaded = true;
    if (guard === 'not-loaded') guarded.isLoaded = false;
    if (guard === 'no-scope') guarded.storageScope = null;
    if (guard === 'not-current') guarded.storageScopeRef.current = 'owner-a:owner-a';
    if (guard === 'not-loaded-scope') guarded.loadedScopeRef.current = 'owner-a:owner-a';
    for (const effect of persistence) loadEffect(guarded, effect);
    equal(guarded.writes, []);
  }
  context.activateAccountCache(employee);
  equal(context.isLoaded, false);
  equal(context.values.setOwnerPin, '');
  equal(context.values.setCompanyPinConfigured, null);
  equal(context.companyPinBusyRef.current, false);
  equal(context.refundBusyRef.current, false);
  equal(nodes.some((node) => ts.isIdentifier(node) && node.text === 'setImageShareDocument'), false);
  equal(context.values.setExpenses, []);
  equal(context.autoSyncDoneRef.current, false);
  loadEffect(context, load, true);
  await context.pendingLoad;
  equal(context.values.setOwnerPin, '');
  equal(context.values.setExpenses, []);
  equal(context.reads.slice(-7).every((key) => key.endsWith(':account:owner-a:employee-a')), true);
  equal(context.store.has(context.STORAGE_KEY_EXPENSES), true);

  for (const cancel of ['cleanup', 'switch', 'logout', 'same-account-return']) {
    const delayed = createContext();
    delayed.activateAccountCache(owner);
    delayed.accessToken = 'token-a';
    const pending = deferred();
    const started = deferred();
    delayed.AsyncStorage.multiGet = (keys) => { delayed.reads.push(...keys); started.resolve(); return pending.promise; };
    loadEffect(delayed, load, true);
    await started.promise;
    if (cancel === 'cleanup') delayed.cleanup();
    if (cancel === 'switch') delayed.activateAccountCache(companyB);
    if (cancel === 'logout' || cancel === 'same-account-return') await delayed.clearStoredSession();
    if (cancel === 'same-account-return') delayed.activateAccountCache(owner);
    const snapshot = JSON.stringify(delayed.values);
    pending.resolve(delayed.reads.slice(-6).map((key) => [key, key.includes('expenses') ? '[{"id":"stale-a"}]' : null]));
    await delayed.pendingLoad;
    equal(JSON.stringify(delayed.values), snapshot);
    equal(delayed.isLoaded, false);
    equal(delayed.writes.filter(([key]) => key.includes('@tpv_issuer')), []);
  }

  const issuerPersistence = effectWith('void writeIssuerSettings(storageScope, issuer)');
  const savedBusiness = {
    name: 'Mi negocio', nif: 'B12345678', address: 'Mi direccion', managerEmail: 'real@example.com',
    accountHolder: 'Titular real', iban: 'ES-real', bankName: 'Mi banco', country: 'FR', additionalUsers: 3,
    logoUri: 'file:///saved-logo.png', logoPosition: 'bottom-right', logoSize: 'large',
    logoOffsetA4: { x: 0.3, y: 0.6 }, logoOffsetTicket: { x: 0.2, y: 0.5 },
  };
  const samples = {
    name: 'COMERCIO LOCAL AUTÓNOMO S.L.', nif: 'B98765432', address: 'Calle Mayor 45, Santander',
    managerEmail: 'gestor@tugestoria.com', accountHolder: 'Comercio Local Autónomo S.L.',
    iban: 'ES9121000418450200051332', bankName: 'Banco Santander',
  };
  equal(context.restoreIssuerSettings({}), { ...context.initialIssuer, logoPosition: 'top-center', logoSize: 'medium' });
  equal(context.restoreIssuerSettings(savedBusiness), savedBusiness);
  for (const [field, sample] of Object.entries(samples)) {
    equal(context.restoreIssuerSettings({ ...savedBusiness, [field]: sample }), { ...savedBusiness, [field]: '' });
    equal(context.restoreIssuerSettings({ ...savedBusiness, [field]: `${sample} ` })[field], `${sample} `);
    equal(context.restoreIssuerSettings({ ...savedBusiness, [field]: '' })[field], '');
  }
  const prepareIssuer = (stored = JSON.stringify(savedBusiness)) => {
    const fixture = createContext();
    fixture.console = { error() {} };
    fixture.activateAccountCache(owner);
    fixture.accessToken = 'token-a';
    fixture.store.set(fixture.accountStorageKey(fixture.STORAGE_KEY_ISSUER, fixture.storageScope), stored);
    fixture.store.set(fixture.STORAGE_KEY_ISSUER, JSON.stringify({ name: 'Global legacy must stay' }));
    return fixture;
  };
  for (const brokenKey of ['STORAGE_KEY_TRANSACTIONS', 'STORAGE_KEY_CASH_INVOICE_DRAFTS', 'STORAGE_KEY_EXPENSES']) {
    const fixture = prepareIssuer();
    const historical = { id: 'history', type: 'VENTA', issuer: { ...samples } };
    fixture.store.set(fixture.accountStorageKey(fixture.STORAGE_KEY_TRANSACTIONS, fixture.storageScope), JSON.stringify([historical]));
    fixture.store.set(fixture.accountStorageKey(fixture[brokenKey], fixture.storageScope), '{broken');
    loadEffect(fixture, load, true);
    await fixture.pendingLoad;
    equal(fixture.issuer, savedBusiness);
    equal(fixture.issuerLoadedScopeRef.current, fixture.storageScope);
    if (brokenKey !== 'STORAGE_KEY_TRANSACTIONS') equal(fixture.values.setTransactions[0].issuer, samples);
    fixture.setIssuer({ ...fixture.issuer, name: 'Editado' });
    loadEffect(fixture, issuerPersistence);
    await fixture.issuerWriteQueueRef.current;
    await fixture.clearStoredSession();
    fixture.activateAccountCache(owner);
    fixture.accessToken = 'token-new';
    loadEffect(fixture, load, true);
    await fixture.pendingLoad;
    equal(fixture.issuer, { ...savedBusiness, name: 'Editado' });
    equal(fixture.store.get(fixture.STORAGE_KEY_ISSUER), JSON.stringify({ name: 'Global legacy must stay' }));
  }
  for (const invalid of ['', '{broken', 'null', '[]', 'true', '"text"', '{"name":123}', '{"managerEmail":null}', '{"additionalUsers":"3"}']) {
    const fixture = prepareIssuer(invalid);
    const issuerKey = fixture.accountStorageKey(fixture.STORAGE_KEY_ISSUER, fixture.storageScope);
    loadEffect(fixture, load, true);
    await fixture.pendingLoad;
    equal(fixture.isLoaded, true);
    equal(fixture.issuerLoadedScopeRef.current, null);
    fixture.setIssuer({ ...savedBusiness });
    loadEffect(fixture, issuerPersistence);
    await fixture.clearStoredSession();
    equal(fixture.store.get(issuerKey), invalid);
    equal(fixture.writes.filter(([key]) => key === issuerKey), []);
  }
  for (const failure of ['issuer-read', 'multiGet']) {
    const fixture = prepareIssuer();
    const issuerKey = fixture.accountStorageKey(fixture.STORAGE_KEY_ISSUER, fixture.storageScope);
    if (failure === 'issuer-read') fixture.AsyncStorage.getItem = async () => { throw new Error('read failed'); };
    else fixture.AsyncStorage.multiGet = async () => { throw new Error('multiGet failed'); };
    loadEffect(fixture, load, true);
    await fixture.pendingLoad;
    equal(fixture.issuerLoadedScopeRef.current, null);
    loadEffect(fixture, issuerPersistence);
    await fixture.clearStoredSession();
    equal(fixture.store.get(issuerKey), JSON.stringify(savedBusiness));
    equal(fixture.writes.filter(([key]) => key === issuerKey), []);
  }
  const fresh = prepareIssuer();
  fresh.store.delete(fresh.accountStorageKey(fresh.STORAGE_KEY_ISSUER, fresh.storageScope));
  loadEffect(fresh, load, true);
  await fresh.pendingLoad;
  equal(fresh.issuer, fresh.initialIssuer);
  equal(fresh.issuerLoadedScopeRef.current, fresh.storageScope);
  fresh.setIssuer(savedBusiness);
  await fresh.clearStoredSession();
  fresh.activateAccountCache(owner);
  fresh.accessToken = 'token-new';
  loadEffect(fresh, load, true);
  await fresh.pendingLoad;
  equal(fresh.issuer, savedBusiness);

  const ordered = prepareIssuer();
  loadEffect(ordered, load, true);
  await ordered.pendingLoad;
  const firstWrite = deferred();
  const writeStarted = deferred();
  const originalWrite = ordered.AsyncStorage.setItem;
  let writeNumber = 0;
  ordered.AsyncStorage.setItem = async (key, value) => {
    writeNumber += 1;
    if (writeNumber === 1) { writeStarted.resolve(); await firstWrite.promise; }
    return originalWrite(key, value);
  };
  ordered.setIssuer({ ...savedBusiness, name: 'Primera edicion' });
  loadEffect(ordered, issuerPersistence);
  await writeStarted.promise;
  ordered.setIssuer({ ...savedBusiness, name: 'Ultima edicion' });
  const signOut = ordered.clearStoredSession();
  equal(ordered.storageScope, null);
  ordered.activateAccountCache(owner);
  ordered.accessToken = 'token-new';
  loadEffect(ordered, load, true);
  firstWrite.resolve();
  await signOut;
  await ordered.pendingLoad;
  equal(ordered.issuer, { ...savedBusiness, name: 'Ultima edicion' });
  equal(ordered.writes.filter(([key]) => key.includes('@tpv_issuer')).map(([, value]) => JSON.parse(value).name), ['Primera edicion', 'Ultima edicion']);

  const delayedIssuer = prepareIssuer();
  const issuerRead = deferred();
  const issuerReadStarted = deferred();
  delayedIssuer.AsyncStorage.getItem = () => { issuerReadStarted.resolve(); return issuerRead.promise; };
  loadEffect(delayedIssuer, load, true);
  await issuerReadStarted.promise;
  await delayedIssuer.clearStoredSession();
  delayedIssuer.activateAccountCache(owner);
  const beforeLateRead = JSON.stringify(delayedIssuer.values);
  issuerRead.resolve(JSON.stringify(savedBusiness));
  await delayedIssuer.pendingLoad;
  equal(JSON.stringify(delayedIssuer.values), beforeLateRead);
  equal(delayedIssuer.issuerLoadedScopeRef.current, null);

  const configEmail = nodes.find((node) => ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'TextInput' && node.getText(ast).includes("tr('config.managerEmail')"));
  equal(configEmail.getText(ast).includes('autoCapitalize="none"'), true);
  equal(configEmail.getText(ast).includes('autoCorrect={false}'), true);
  for (const key of ['businessName', 'taxId', 'address', 'managerEmail']) {
    equal(nodes.some((node) => ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'Text' && node.getText(ast).includes(`tr('config.${key}')`)), true);
  }

  const autoSync = effectWith('if (autoSyncDoneRef.current)');
  let syncCalls = 0;
  context.syncHistoryFromCloudRef = { current: async () => { syncCalls += 1; } };
  context.hasActiveSubscription = true;
  context.activateAccountCache(companyB);
  loadEffect(context, autoSync);
  equal(syncCalls, 0);
  loadEffect(context, load, true);
  await context.pendingLoad;
  loadEffect(context, autoSync);
  loadEffect(context, autoSync);
  equal(syncCalls, 1);
  equal(autoSync.arguments[1].getText(ast).includes('storageScope'), true);

  context.DOCUMENT_API_URL_CANDIDATES = ['https://example.test'];
  context.expenses = [{ id: 'expense-b' }];
  let requests = 0;
  const renewed = deferred();
  context.ensureFreshAccessToken = () => renewed.promise;
  context.fetchWithTimeout = async () => { requests += 1; return { ok: true }; };
  loadFunction(context, 'uploadExpensesToCloud');
  const upload = context.uploadExpensesToCloud(context.expenses);
  await context.clearStoredSession();
  renewed.resolve('token-a');
  await upload;
  equal(requests, 0);
  equal(context.storageScope, null);
  equal(context.loadedScopeRef.current, null);
  equal(context.transactionsRef.current, []);
  equal(context.values.setPendingInvoice, null);
  equal(context.values.setIssuer, context.initialIssuer);

  const history = createContext();
  history.activateAccountCache(owner);
  history.accessToken = 'token-a';
  history.isLoaded = true;
  history.loadedScopeRef.current = history.storageScope;
  history.syncHistoryLoading = false;
  history.DOCUMENT_API_URL_CANDIDATES = ['https://example.test'];
  history.tr = (key) => key;
  history.ensureFreshAccessToken = async () => 'token-a';
  history.uploadExpensesToCloud = async () => {};
  const downloaded = deferred();
  const requestStarted = deferred();
  history.fetchWithTimeout = async () => {
    requestStarted.resolve();
    return { ok: true, json: () => downloaded.promise };
  };
  loadFunction(history, 'syncHistoryFromCloud');
  const sync = history.syncHistoryFromCloud();
  await requestStarted.promise;
  history.activateAccountCache(companyB);
  const resetSnapshot = JSON.stringify(history.values);
  downloaded.resolve({ ok: true, documents: [{ id: 'doc-a', ticketCode: 'TK-A' }], expenses: [{ local_id: 'expense-a' }] });
  await sync;
  equal(JSON.stringify(history.values), resetSnapshot);
  equal(history.values.setTransactions, []);
  equal(history.values.setExpenses, []);

  const resumed = createContext();
  resumed.activateAccountCache(owner);
  resumed.accessToken = 'token-a';
  resumed.isLoaded = true;
  resumed.loadedScopeRef.current = resumed.storageScope;
  resumed.configuredDocumentApiUrl = 'https://example.test';
  const pendingPayment = deferred();
  resumed.AsyncStorage.getItem = (key) => { resumed.reads.push(key); return pendingPayment.promise; };
  const resume = effectWith('const resumePendingOnlinePayment');
  const resumeCallback = resume.arguments[0].getText(ast).replace('void resumePendingOnlinePayment();', 'pendingResume = resumePendingOnlinePayment();');
  vm.runInContext(compile(`effect = ${resumeCallback}; cleanup = effect();`), resumed);
  equal(resumed.reads, [resumed.accountStorageKey(resumed.STORAGE_KEY_PENDING_ONLINE_PAYMENT, resumed.storageScope)]);
  resumed.activateAccountCache(companyB);
  const paymentSnapshot = JSON.stringify(resumed.values);
  pendingPayment.resolve(JSON.stringify({ paymentId: 'payment-a', checkoutUrl: 'https://example.test/a', paymentAmount: 123 }));
  await resumed.pendingResume;
  equal(JSON.stringify(resumed.values), paymentSnapshot);
  equal(resumed.values.setPendingInvoice, null);
  equal(resumed.values.setOnlinePayment, null);

  const closing = createContext();
  closing.activateAccountCache(owner);
  closing.accessToken = 'token-a';
  closing.isLoaded = true;
  closing.loadedScopeRef.current = closing.storageScope;
  const secureDelete = deferred();
  closing.SecureStore.deleteItemAsync = () => secureDelete.promise;
  const closed = closing.clearStoredSession();
  equal(closing.storageScope, null);
  equal(closing.isLoaded, false);
  equal(closing.accessToken, null);
  equal(closing.values.setOwnerPin, '');
  secureDelete.resolve();
  await closed;

  const storageCalls = nodes.filter((node) => ts.isCallExpression(node) && /^AsyncStorage\.(getItem|setItem|removeItem)$/.test(node.expression.getText(ast)));
  for (const call of storageCalls.filter((node) => node.getText(ast).includes('STORAGE_KEY_'))) {
    equal(ts.isCallExpression(call.arguments[0]) && call.arguments[0].expression.getText(ast) === 'accountStorageKey', true);
  }
  equal(resume.arguments[1].getText(ast).includes('storageScope'), true);
  equal(resume.arguments[0].getText(ast).includes('if (!isCurrent()) return;'), true);
  const startup = effectWith('const bootDeviceId');
  equal(startup.arguments[0].getText(ast).includes('activateAccountCacheRef.current(result.user)'), true);
  equal(declaration('submitAuth').initializer.getText(ast).includes('if (!storageScopeFromUser(result.user))'), true);
  equal(declaration('refreshUserSession').initializer.getText(ast).includes('if (!authLoading) setAccessToken(renewedToken)'), true);
  equal(source.includes('authLoading || (accessToken && (!isLoaded || !storageScope'), true);
  const periodic = effectWith('const refreshHistory');
  let intervalCallback;
  let foregroundCallback;
  let periodicSyncCalls = 0;
  let cleared = false;
  let removed = false;
  const periodicContext = createContext();
  periodicContext.activateAccountCache(owner);
  periodicContext.accessToken = 'token-a';
  periodicContext.isLoaded = true;
  periodicContext.hasActiveSubscription = true;
  periodicContext.AppState = {
    currentState: 'active',
    addEventListener: (event, callback) => { equal(event, 'change'); foregroundCallback = callback; return { remove: () => { removed = true; } }; },
  };
  periodicContext.syncHistoryFromCloudRef = { current: options => { equal(options, { silent: true }); periodicSyncCalls += 1; } };
  periodicContext.setInterval = (callback, milliseconds) => { equal(milliseconds, 60000); intervalCallback = callback; return 'interval'; };
  periodicContext.clearInterval = id => { equal(id, 'interval'); cleared = true; };
  loadEffect(periodicContext, periodic);
  intervalCallback();
  equal(periodicSyncCalls, 1);
  periodicContext.AppState.currentState = 'background';
  intervalCallback();
  equal(periodicSyncCalls, 1);
  periodicContext.AppState.currentState = 'active';
  foregroundCallback('active');
  equal(periodicSyncCalls, 2);
  periodicContext.cleanup();
  equal(cleared && removed, true);
  console.log(`Account cache: ${checks} checks passed (real AST/VM, account/company isolation, PIN, delayed loads, persistence, logout and sync guards).`);
}

run().catch((error) => { console.error(error); process.exitCode = 1; });