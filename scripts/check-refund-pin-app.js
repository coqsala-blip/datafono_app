const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.dirname(require.resolve('../package.json'));
const source = fs.readFileSync(path.join(root, 'src/app/index.tsx'), 'utf8');
const ast = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const nodes = [];
const visit = node => { nodes.push(node); ts.forEachChild(node, visit); };
visit(ast);
const declaration = name => nodes.find(node => ts.isVariableDeclaration(node) && node.name.getText(ast) === name);
const compile = code => ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
let checks = 0;
const equal = (actual, expected) => {
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)));
  checks += 1;
};
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const fixture = (overrides = {}) => ({
  id: 'doc-a', ticketCode: 'TK-A', type: 'COBRO', documentType: 'TICKET DE VENTA',
  amount: 20, subtotal: 16.53, iva: 3.47, ivaRateApplied: 21, method: 'Efectivo',
  createdAt: '2026-10-05T10:00:00Z', issuer: { name: 'Company', nif: 'NIF', address: 'Address' },
  publicUrl: 'https://api.test/d/original', ...overrides,
});
const revision = (amount = 15, overrides = {}) => fixture({
  amount, originalAmount: 20, documentType: 'COMPRA/DEVOLUCIONES', subtotal: 12.4, iva: 2.6,
  refundHistory: [{ amount: 20 - amount, date: '2026-10-05T11:00:00Z' }],
  publicUrl: 'https://api.test/d/refund', ...overrides,
});
const functions = ['requestCompanyPin', 'syncCompanyPin', 'saveCompanyPin', 'handleSetupOwnerPin',
  'handleChangeOwnerPin', 'applyRefundToTicket', 'confirmRefundPin', 'mergeCloudTransactions', 'syncHistoryFromCloud'];
const createContext = (overrides = {}) => {
  const context = vm.createContext({
    console: { warn() {} }, alerts: [], requests: [], publications: [],
    Alert: { alert: (...args) => context.alerts.push(args) },
    configuredDocumentApiUrl: 'https://api.test', DOCUMENT_API_URL_CANDIDATES: ['https://api.test'],
    accessToken: 'old-token', isLoaded: true, storageScope: 'owner:account',
    storageScopeRef: { current: 'owner:account' }, loadedScopeRef: { current: 'owner:account' },
    cacheGenerationRef: { current: 1 }, companyPinBusyRef: { current: false }, refundBusyRef: { current: false },
    syncCompanyPinRef: { current: () => context.syncCompanyPin() },
    userRole: 'principal', ownerPin: '', companyPinConfigured: null,
    ownerPinInput: '', ownerPinSetupNew: '', ownerPinSetupConfirm: '',
    ownerPinChangeCurrent: '', ownerPinChangeNew: '', ownerPinChangeConfirm: '',
    pinModalVisible: false, pendingRefund: null, transactions: [fixture()], selectedTicket: fixture(),
    expenses: [], issuer: {}, syncHistoryLoading: false, syncHistoryError: '', syncHistoryMessage: '',
    formatCurrency: amount => String(amount), tr: key => key,
    ensureFreshAccessToken: async () => 'fresh-token', uploadExpensesToCloud: async () => {},
    registerTransactionDocument: async ticket => {
      context.publications.push(JSON.parse(JSON.stringify(ticket)));
      return { ...ticket, publicUrl: 'https://api.test/d/published' };
    },
    fetchWithTimeout: async (url, options) => {
      context.requests.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
      return { ok: true, json: async () => url.endsWith('/status') ? { configured: false }
        : url.endsWith('/refund') ? { ok: true, document: revision() } : { ok: true } };
    },
    ...overrides,
  });
  for (const node of nodes.filter(candidate => ts.isCallExpression(candidate) && /^set[A-Z]/.test(candidate.expression.getText(ast)))) {
    const name = node.expression.getText(ast);
    const state = name.slice(3, 4).toLowerCase() + name.slice(4);
    context[name] = value => { context[state] = typeof value === 'function' ? value(context[state]) : value; };
  }
  for (const name of functions) {
    assert.ok(declaration(name), `Missing real app function ${name}`);
    vm.runInContext(compile(`${name} = ${declaration(name).initializer.getText(ast)};`), context);
  }
  return context;
};
const mockResponse = (context, result, ok = true) => {
  context.fetchWithTimeout = async (url, options) => {
    context.requests.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    return { ok, json: async () => result };
  };
};
const setup = context => { context.ownerPinSetupNew = '1234'; context.ownerPinSetupConfirm = '1234'; };
const change = context => {
  context.ownerPinChangeCurrent = '6789'; context.ownerPinChangeNew = '123456'; context.ownerPinChangeConfirm = '123456';
};

async function checkPin() {
  const effect = nodes.find(node => ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
    && node.arguments[0].getText(ast).includes('syncCompanyPinRef.current'));
  assert.ok(effect);
  for (const dependency of ['isLoaded', 'accessToken', 'ownerPin', 'userRole', 'storageScope']) equal(effect.arguments[1].getText(ast).includes(dependency), true);
  const triggered = createContext();
  let completion;
  triggered.syncCompanyPinRef.current = () => { completion = triggered.syncCompanyPin(); return completion; };
  vm.runInContext(compile(`(${effect.arguments[0].getText(ast)})();`), triggered);
  await completion;
  equal(triggered.companyPinConfigured, false);
  equal(triggered.requests.length, 1);

  for (const configured of [false, true]) {
    const context = createContext({ ownerPin: '4567' });
    context.fetchWithTimeout = async (url, options) => {
      context.requests.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
      return { ok: true, json: async () => ({ configured }) };
    };
    await context.syncCompanyPin();
    equal(context.companyPinConfigured, true);
    equal(context.ownerPin, '4567');
    equal(context.requests.length, configured ? 1 : 2);
    equal(context.requests[0].url, 'https://api.test/api/company/pin/status');
    equal(context.requests[0].options.headers.Authorization, 'Bearer fresh-token');
    if (!configured) {
      equal(context.requests[1].body, { pin: '4567' });
      equal(context.requests[1].options.method, 'POST');
    }
    equal(context.companyPinBusyRef.current, false);
  }
  for (const overrides of [{ isLoaded: false }, { accessToken: null }, { userRole: 'empleado' },
    { storageScope: null }, { loadedScopeRef: { current: 'other' } }, { companyPinBusyRef: { current: true } }]) {
    const context = createContext({ ownerPin: '4567', ...overrides });
    await context.syncCompanyPin();
    equal(context.requests, []);
  }
  const invalidLegacy = createContext({ ownerPin: 'abcd' });
  await invalidLegacy.syncCompanyPin();
  equal(invalidLegacy.requests.length, 1);
  equal(invalidLegacy.companyPinConfigured, false);
  for (const result of [{}, { configured: 'false' }]) {
    const context = createContext({ ownerPin: '4567' });
    mockResponse(context, result);
    await context.syncCompanyPin();
    equal(context.requests.length, 1);
    equal(context.companyPinConfigured, null);
  }
  const migrateFailure = createContext({ ownerPin: '4567' });
  migrateFailure.fetchWithTimeout = async url => ({ ok: url.endsWith('/status'), json: async () => ({ configured: false, error: 'offline' }) });
  await migrateFailure.syncCompanyPin();
  equal(migrateFailure.companyPinConfigured, false);
  equal(migrateFailure.ownerPin, '4567');

  const saved = createContext();
  setup(saved);
  await saved.handleSetupOwnerPin();
  equal(saved.ownerPin, '1234');
  equal(saved.companyPinConfigured, true);
  equal(saved.ownerPinSetupNew, '');
  equal(saved.requests.map(request => request.body), [null, { pin: '1234' }]);
  const alreadyConfigured = createContext();
  setup(alreadyConfigured);
  mockResponse(alreadyConfigured, { configured: true });
  await alreadyConfigured.handleSetupOwnerPin();
  equal(alreadyConfigured.ownerPin, '');
  equal(alreadyConfigured.companyPinConfigured, true);
  equal(alreadyConfigured.requests.length, 1);
  equal(alreadyConfigured.ownerPinSetupNew, '1234');

  const updated = createContext({ ownerPin: '' });
  change(updated);
  await updated.handleChangeOwnerPin();
  equal(updated.ownerPin, '123456');
  equal(updated.requests[0].body, { pin: '123456', currentPin: '6789' });
  equal(updated.ownerPinChangeCurrent, '');
  for (const operation of ['setup', 'change']) {
    const failed = createContext({ ownerPin: '9999' });
    if (operation === 'setup') setup(failed); else change(failed);
    mockResponse(failed, { error: 'Incorrect PIN' }, false);
    await failed[operation === 'setup' ? 'handleSetupOwnerPin' : 'handleChangeOwnerPin']();
    equal(failed.ownerPin, '9999');
    equal(failed.companyPinConfigured, null);
    equal(operation === 'setup' ? failed.ownerPinSetupNew : failed.ownerPinChangeNew, operation === 'setup' ? '1234' : '123456');
    equal(failed.companyPinBusyRef.current, false);
    equal(failed.alerts.length, 1);
  }
  for (const pin of ['123', '1234567', 'abcd', '12.4', '']) {
    const context = createContext();
    context.ownerPinSetupNew = pin; context.ownerPinSetupConfirm = pin;
    await context.handleSetupOwnerPin();
    equal(context.requests, []);
    change(context); context.ownerPinChangeNew = pin; context.ownerPinChangeConfirm = pin;
    await context.handleChangeOwnerPin();
    equal(context.requests, []);
  }
  const mismatch = createContext();
  setup(mismatch); mismatch.ownerPinSetupConfirm = '9999';
  await mismatch.handleSetupOwnerPin();
  change(mismatch); mismatch.ownerPinChangeConfirm = '9999';
  await mismatch.handleChangeOwnerPin();
  equal(mismatch.requests, []);
  const employee = createContext({ userRole: 'empleado' });
  setup(employee); change(employee);
  await employee.handleSetupOwnerPin(); await employee.handleChangeOwnerPin();
  equal(employee.requests, []);

  for (const operation of ['migration', 'setup', 'change']) {
    const context = createContext({ ownerPin: '4567' });
    const token = deferred();
    context.ensureFreshAccessToken = () => token.promise;
    setup(context); change(context);
    const action = operation === 'migration' ? context.syncCompanyPin() : operation === 'setup' ? context.handleSetupOwnerPin() : context.handleChangeOwnerPin();
    context.cacheGenerationRef.current += 1;
    token.resolve('stale-token');
    await action;
    equal(context.requests, []);
    equal(context.ownerPin, '4567');
    equal(context.alerts, []);
  }
  for (const stage of ['status', 'post']) {
    const context = createContext({ ownerPin: '4567' });
    const result = deferred();
    const started = deferred();
    context.fetchWithTimeout = async (url, options) => {
      context.requests.push({ url, options });
      if ((stage === 'status') === url.endsWith('/status')) {
        started.resolve();
        return { ok: true, json: () => result.promise };
      }
      return { ok: true, json: async () => ({ configured: false }) };
    };
    const action = context.syncCompanyPin();
    await started.promise;
    context.cacheGenerationRef.current += 1;
    context.companyPinConfigured = null;
    result.resolve({ configured: false });
    await action;
    equal(context.requests.length, stage === 'status' ? 1 : 2);
    equal(context.companyPinConfigured, null);
  }
  const busy = createContext();
  const token = deferred();
  busy.ensureFreshAccessToken = () => token.promise;
  setup(busy);
  const first = busy.handleSetupOwnerPin();
  await busy.handleSetupOwnerPin(); await busy.syncCompanyPin();
  token.resolve('fresh-token'); await first;
  equal(busy.requests.length, 2);
  const pinChoice = nodes.find(node => ts.isConditionalExpression(node) && node.condition.getText(ast) === '!(companyPinConfigured === true || ownerPin)');
  assert.ok(pinChoice);
  for (const [configured, local, create] of [[true, '', false], [false, '', true], [null, '1234', false]]) {
    equal(vm.runInNewContext(pinChoice.condition.getText(ast), { companyPinConfigured: configured, ownerPin: local }), create);
  }
}

async function checkRefund() {
  const publicationEffect = nodes.find(node => ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
    && node.arguments[0].getText(ast).includes('transactionsNeedingPublication'));
  const publicationContext = createContext();
  const freshSale = fixture({ id: 'new-sale', publicUrl: undefined });
  publicationContext.transactionsRef = { current: [freshSale, revision(15, { publicUrl: undefined })] };
  publicationContext.registerTransactionDocumentRef = { current: async ticket => {
    publicationContext.publications.push(JSON.parse(JSON.stringify(ticket)));
    return { ...ticket, publicUrl: 'https://api.test/d/published' };
  } };
  vm.runInContext(compile(`(${publicationEffect.arguments[0].getText(ast)})();`), publicationContext);
  equal(publicationContext.publications, [freshSale]);
  for (const role of ['principal', 'empleado']) {
    const context = createContext({ userRole: role, ownerPin: '9999', ownerPinInput: '1234', pinModalVisible: true,
      pendingRefund: { ticket: fixture(), amount: 5 } });
    if (role === 'empleado') await context.confirmRefundPin(); else equal(await context.applyRefundToTicket(fixture(), 5), true);
    equal(context.requests.length, 1);
    equal(context.requests[0].url, 'https://api.test/api/documents/refund');
    equal(context.requests[0].body, role === 'empleado' ? { documentId: 'doc-a', amount: 5, pin: '1234' } : { documentId: 'doc-a', amount: 5 });
    equal(context.requests[0].options.headers.Authorization, 'Bearer fresh-token');
    equal(context.transactions[0], revision());
    equal(context.selectedTicket, revision());
    equal(context.publications, []);
    if (role === 'empleado') {
      equal(context.pinModalVisible, false); equal(context.pendingRefund, null); equal(context.ownerPinInput, '');
    }
  }
  const noPin = createContext({ userRole: 'empleado', ownerPin: '' });
  equal(await noPin.applyRefundToTicket(fixture(), 5), false);
  equal(noPin.requests, []); equal(noPin.pinModalVisible, true); equal(noPin.pendingRefund.amount, 5);
  for (const pin of ['123', '1234567', 'abcd', '']) {
    noPin.ownerPinInput = pin;
    await noPin.confirmRefundPin();
    equal(noPin.requests, []); equal(noPin.pinModalVisible, true);
  }
  for (const amount of [0, -1, NaN, Infinity, 21]) {
    const context = createContext();
    equal(await context.applyRefundToTicket(fixture(), amount), false);
    equal(context.requests, []); equal(context.publications, []);
  }
  for (const ticket of [fixture({ type: 'DEVOLUCIÓN' }), fixture({ isRefunded: true }), fixture({ amount: 0 })]) {
    const context = createContext();
    equal(await context.applyRefundToTicket(ticket, 5), false); equal(context.requests, []);
  }
  for (const role of ['principal', 'empleado']) {
    const context = createContext({ userRole: role });
    const ticket = fixture({ publicUrl: undefined, originalAmount: 20 });
    const snapshot = JSON.stringify(ticket);
    equal(await context.applyRefundToTicket(ticket, 5, '1234'), true);
    equal(context.publications, [JSON.parse(snapshot)]);
    equal(context.requests.length, 1);
    equal(JSON.stringify(ticket), snapshot);
  }
  const unpublished = createContext();
  unpublished.registerTransactionDocument = async ticket => ticket;
  equal(await unpublished.applyRefundToTicket(fixture({ publicUrl: undefined }), 5), false);
  equal(unpublished.requests, []); equal(unpublished.transactions, [fixture()]);
  for (const ticket of [revision(15, { publicUrl: undefined }),
    fixture({ publicUrl: undefined, documentType: 'COMPRA/DEVOLUCIONES' })]) {
    const employee = createContext({ userRole: 'empleado' });
    equal(await employee.applyRefundToTicket(ticket, 5, '1234'), true);
    equal(employee.requests.length, 1); equal(employee.publications, []);
    equal(employee.requests[0].body, { documentId: ticket.id, amount: 5, pin: '1234' });
    equal(employee.transactions, [revision()]);
  }
  for (const role of ['principal', 'empleado']) {
    for (const error of ['PIN incorrecto', 'Documento no encontrado.', 'El importe supera el saldo disponible.']) {
      const context = createContext({ userRole: role });
      const ticket = revision(15, { publicUrl: undefined });
      mockResponse(context, { ok: false, error }, false);
      equal(await context.applyRefundToTicket(ticket, 5, '1234'), false);
      equal(context.requests.length, 1);
      equal(context.publications, []);
      equal(context.transactions, [fixture()]);
      equal(context.alerts.at(-1)[1], error);
    }
  }
  for (const overrides of [{ isLoaded: false }, { storageScope: null }, { loadedScopeRef: { current: 'other' } },
    { storageScopeRef: { current: 'other' } }, { accessToken: null }, { configuredDocumentApiUrl: undefined },
    { ensureFreshAccessToken: async () => null }]) {
    const context = createContext(overrides);
    equal(await context.applyRefundToTicket(fixture(), 5), false);
    equal(context.requests, []); equal(context.transactions, [fixture()]);
  }
  for (const failure of ['http', 'offline', 'bad-json', 'missing', 'wrong-id', 'no-url', 'invalid-amount']) {
    const context = createContext({ userRole: 'empleado', ownerPinInput: '1234', pinModalVisible: true, pendingRefund: { ticket: fixture(), amount: 5 } });
    const before = JSON.stringify(context.transactions);
    if (failure === 'offline') context.fetchWithTimeout = async () => { throw new Error('Offline'); };
    else if (failure === 'bad-json') context.fetchWithTimeout = async () => ({ ok: true, json: async () => { throw new Error('JSON'); } });
    else mockResponse(context, failure === 'http' ? { error: 'PIN incorrecto' }
      : { ok: true, document: failure === 'missing' ? undefined : revision(15, failure === 'wrong-id' ? { id: 'other' }
        : failure === 'no-url' ? { publicUrl: undefined } : failure === 'invalid-amount' ? { amount: '15' } : {}) }, failure !== 'http');
    await context.confirmRefundPin();
    equal(JSON.stringify(context.transactions), before);
    equal(context.selectedTicket, fixture()); equal(context.pinModalVisible, true);
    equal(context.pendingRefund.amount, 5); equal(context.ownerPinInput, '1234');
    equal(context.refundBusyRef.current, false); equal(context.alerts.length, 1);
    mockResponse(context, { ok: true, document: revision() });
    await context.confirmRefundPin();
    equal(context.pinModalVisible, false); equal(context.transactions[0], revision());
  }
  for (const stage of ['token', 'publication', 'response']) {
    const context = createContext({ userRole: 'empleado', ownerPinInput: '1234', pinModalVisible: true,
      pendingRefund: { ticket: fixture({ publicUrl: stage === 'publication' ? undefined : fixture().publicUrl }), amount: 5 } });
    const delayed = deferred();
    const started = deferred();
    if (stage === 'token') context.ensureFreshAccessToken = () => { started.resolve(); return delayed.promise; };
    if (stage === 'publication') context.registerTransactionDocument = () => { started.resolve(); return delayed.promise; };
    if (stage === 'response') context.fetchWithTimeout = async () => { started.resolve(); return { ok: true, json: () => delayed.promise }; };
    const action = context.confirmRefundPin();
    await started.promise;
    context.cacheGenerationRef.current += 1;
    context.transactions = []; context.selectedTicket = null; context.pendingRefund = null; context.pinModalVisible = false;
    context.refundBusyRef.current = true;
    delayed.resolve(stage === 'token' ? 'token' : stage === 'publication' ? fixture() : { ok: true, document: revision() });
    await action;
    equal(context.transactions, []); equal(context.selectedTicket, null); equal(context.alerts, []);
    equal(context.refundBusyRef.current, true);
    equal(context.requests, []);
  }
  const context = createContext({ userRole: 'empleado', ownerPinInput: '1234', pinModalVisible: true, pendingRefund: { ticket: fixture(), amount: 5 } });
  const delayed = deferred();
  const started = deferred();
  context.fetchWithTimeout = async (url, options) => {
    context.requests.push({ url, body: JSON.parse(options.body) }); started.resolve();
    return { ok: true, json: () => delayed.promise };
  };
  const first = context.confirmRefundPin();
  await started.promise;
  context.ownerPinInput = '7777'; context.pendingRefund = { ticket: fixture(), amount: 10 };
  await context.confirmRefundPin();
  equal(context.requests.length, 1); equal(context.requests[0].body.pin, '1234'); equal(context.requests[0].body.amount, 5);
  delayed.resolve({ ok: true, document: revision() }); await first;
  equal(context.refundBusyRef.current, false);
}

async function checkMerge() {
  const context = createContext();
  const original = fixture();
  const refunded = revision();
  const newest = revision(10, { refundHistory: [...refunded.refundHistory, { amount: 5, date: '2026-10-05T12:00:00Z' }] });
  const unsynced = fixture({ id: 'local', ticketCode: 'LOCAL', publicUrl: undefined });
  const another = fixture({ id: 'other', ticketCode: 'OTHER' });
  equal(context.mergeCloudTransactions([original, unsynced], [newest, refunded, original, another, another,
    fixture({ id: 'local', ticketCode: 'LOCAL', amount: 2 })]), [another, newest, unsynced]);
  equal(context.mergeCloudTransactions([newest], [original, refunded]), [newest]);
  equal(context.mergeCloudTransactions([original], [fixture({ id: 'duplicate-id', ticketCode: 'TK-A' })]), [original]);
  equal(context.mergeCloudTransactions([], [refunded, newest, original]), [newest]);
  mockResponse(context, { ok: true, documents: [newest, refunded, another], expenses: [] });
  await context.syncHistoryFromCloud();
  equal(context.transactions, [another, newest]); equal(context.selectedTicket, newest);
  equal(context.syncHistoryLoading, false); equal(context.syncHistoryError, '');
  context.transactions = [unsynced]; context.selectedTicket = unsynced;
  mockResponse(context, { ok: true, documents: [fixture({ id: 'local', ticketCode: 'LOCAL' })], expenses: [] });
  await context.syncHistoryFromCloud();
  equal(context.transactions, [unsynced]); equal(context.selectedTicket, unsynced);
  const delayed = deferred();
  const started = deferred();
  context.transactions = [original]; context.selectedTicket = original;
  context.fetchWithTimeout = async () => { started.resolve(); return { ok: true, json: () => delayed.promise }; };
  const sync = context.syncHistoryFromCloud();
  await started.promise;
  context.transactions = [newest]; context.selectedTicket = newest;
  delayed.resolve({ ok: true, documents: [refunded], expenses: [] }); await sync;
  equal(context.transactions, [newest]); equal(context.selectedTicket, newest);
}

async function main() {
  await checkPin();
  await checkRefund();
  await checkMerge();
  console.log(`Refund/PIN app: ${checks} real AST/VM checks passed (migration, API setup/change, employee authorization, authoritative refunds, retries, generation/busy guards and cloud revisions).`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });