const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync('src/app/index.tsx', 'utf8');
const syntax = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
assert.equal(syntax.parseDiagnostics.length, 0);
const declarations = new Map();
const elements = [];
const effects = [];
const visit = node => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarations.set(node.name.text, node.initializer);
  if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) elements.push(node);
  if (ts.isCallExpression(node) && node.expression.getText(syntax) === 'useEffect') effects.push(node.arguments[0]);
  ts.forEachChild(node, visit);
};
visit(syntax);
const evaluate = (node, context) => vm.runInNewContext(ts.transpileModule(`(${node.getText(syntax)})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React },
}).outputText, context);
const attribute = (element, name) => element.attributes.properties.find(property => property.name?.getText(syntax) === name)?.initializer?.expression;
const inputs = elements.filter(element => element.tagName.getText(syntax) === 'TextInput' && attribute(element, 'onFocus')?.getText(syntax).includes('revealQuoteInput'));
assert.equal(inputs.length, 7);
const quoteScroll = elements.find(element => attribute(element, 'ref')?.getText(syntax) === 'quoteScrollRef');
assert.ok(quoteScroll);
assert.equal(attribute(quoteScroll, 'automaticallyAdjustKeyboardInsets').getText(syntax), 'false');
assert.ok(!declarations.get('revealQuoteInput').getText(syntax).includes('scrollResponderScrollNativeHandleToKeyboard'));
const keyboardEffect = effects.find(effect => effect.getText(syntax).includes("Keyboard.addListener('keyboardDidShow'"));
assert.ok(keyboardEffect);

const createHarness = () => {
  const frames = [];
  const measurements = [];
  const scrolls = [];
  const listeners = new Map();
  const alerts = [];
  const published = [];
  const mailed = [];
  let viewport = { y: 100, height: 400 };
  let dismissals = 0;
  const context = {
    useCallback: callback => callback,
    requestAnimationFrame: callback => frames.push(callback),
    Platform: { OS: 'android' }, activeTab: 'presupuesto',
    quoteInputRefs: { current: {} }, quoteFocusedInputRef: { current: null },
    quoteFocusGenerationRef: { current: 0 }, quoteScrollOffsetRef: { current: 0 },
    quoteKeyboardYRef: { current: null }, quoteNewLineRef: { current: null },
    quoteScrollRef: { current: {
      getNativeScrollRef: () => ({ measureInWindow: callback => measurements.push(() => callback(0, viewport.y, 320, viewport.height)) }),
      scrollTo: options => scrolls.push(options),
    } },
    setQuoteKeyboardHeight: value => { context.quoteKeyboardHeight = value; },
    Keyboard: {
      addListener: (name, callback) => { listeners.set(name, callback); return { remove: () => listeners.delete(name) }; },
      dismiss: () => { dismissals += 1; },
    },
    presupuestoClient: { name: ' Client ', nif: ' NIF ', address: ' Address ' },
    presupuestoClientEmail: ' client@example.com ', presupuestoIvaInput: '10',
    presupuestoItems: [{ id: 'old', description: ' Product ', price: '12' }],
    presupuestoDocumentType: 'PRESUPUESTO', cashInvoiceDrafts: [], transactions: [], selectedTicket: null,
    issuer: { name: 'Business' }, requireSubscription: () => true,
    registerTransactionDocument: async document => { published.push(document); return { ...document, publicUrl: 'https://example.com/doc' }; },
    generatePdfFileUri: async () => 'file:///quote.pdf',
    MailComposer: {
      MailComposerStatus: { SENT: 'sent', SAVED: 'saved', CANCELLED: 'cancelled', UNDETERMINED: 'undetermined' },
      isAvailableAsync: async () => true,
      composeAsync: async options => { mailed.push(options); return { status: context.mailStatus }; },
    },
    mailStatus: 'sent', tr: key => key, documentTypeLabel: type => type,
    formatCurrency: value => String(value), Alert: { alert: (...args) => alerts.push(args) },
  };
  for (const [setter, state] of [
    ['setPresupuestoClient', 'presupuestoClient'], ['setPresupuestoClientEmail', 'presupuestoClientEmail'],
    ['setPresupuestoItems', 'presupuestoItems'], ['setPresupuestoIvaInput', 'presupuestoIvaInput'],
    ['setCashInvoiceDrafts', 'cashInvoiceDrafts'], ['setTransactions', 'transactions'], ['setSelectedTicket', 'selectedTicket'],
  ]) context[setter] = value => { context[state] = typeof value === 'function' ? value(context[state]) : value; };
  for (const name of ['measureQuoteInput', 'scheduleQuoteReveal', 'revealQuoteInput', 'blurQuoteInput', 'resetQuoteForm', 'sendPresupuestoByEmail', 'markCashInvoiceAsPaid']) {
    assert.ok(declarations.has(name), name);
    context[name] = evaluate(declarations.get(name), context);
  }
  const cleanup = evaluate(keyboardEffect, context)();
  const flush = () => {
    while (frames.length || measurements.length) {
      while (frames.length) frames.shift()();
      while (measurements.length) measurements.shift()();
    }
  };
  const input = (key, y, height = 40) => {
    const component = {
      measureInWindow: callback => measurements.push(() => callback(0, y, 120, height)),
      focus: () => context.revealQuoteInput(key), blur: () => context.blurQuoteInput(key),
    };
    context.quoteInputRefs.current[key] = component;
    return component;
  };
  const event = (name, screenY = 500, height = 300) => listeners.get(name)({ endCoordinates: { screenY, height } });
  const jsx = (element, name, extra = {}) => evaluate(attribute(element, name), { ...context, ...extra });
  return { context, frames, measurements, scrolls, listeners, alerts, published, mailed, flush, input, event, jsx, cleanup,
    setViewport: value => { viewport = value; }, dismissals: () => dismissals };
};

let scenarios = 0;
const checkGeometry = () => {
  for (const offset of [0, 180, 600]) {
    for (const inputY of [100, 450, 460, 480, 620]) {
      const harness = createHarness();
      harness.context.quoteScrollOffsetRef.current = offset;
      harness.input('name', inputY);
      harness.context.revealQuoteInput('name');
      harness.event('keyboardDidShow');
      harness.flush();
      const overlap = inputY + 40 - 500;
      assert.equal(harness.context.quoteKeyboardHeight, 0, 'adjustResize must not add keyboard height');
      assert.equal(harness.scrolls.length, overlap > 0 ? 1 : 0);
      if (overlap > 0) assert.equal(harness.scrolls[0].y, offset + overlap + 16);
      scenarios += 1;
    }
  }
  const harness = createHarness();
  harness.setViewport({ y: 100, height: 700 });
  harness.input('name', 620);
  harness.context.revealQuoteInput('name');
  harness.event('keyboardDidShow');
  harness.flush();
  assert.equal(harness.context.quoteKeyboardHeight, 300, 'Only actual viewport overlap is padded');
  harness.setViewport({ y: 100, height: 400 });
  harness.jsx(quoteScroll, 'onLayout')();
  harness.flush();
  assert.equal(harness.context.quoteKeyboardHeight, 0);
  harness.scrolls.length = 0;
  harness.jsx(quoteScroll, 'onScroll')({ nativeEvent: { contentOffset: { y: 230 } } });
  harness.flush();
  assert.equal(harness.scrolls.length, 0, 'Manual scrolling does not trigger reveal');
  scenarios += 3;

  for (const cancel of ['hide', 'blur', 'reset', 'focus', 'drag', 'offset', 'replace', 'cleanup']) {
    const delayed = createHarness();
    delayed.input('name', 620);
    delayed.context.revealQuoteInput('name');
    delayed.event('keyboardDidShow');
    while (delayed.frames.length) delayed.frames.shift()();
    delayed.measurements.shift()();
    if (cancel === 'hide') delayed.event('keyboardDidHide');
    if (cancel === 'blur') delayed.context.blurQuoteInput('name');
    if (cancel === 'reset') delayed.context.resetQuoteForm();
    if (cancel === 'focus') { delayed.input('email', 200); delayed.context.revealQuoteInput('email'); }
    if (cancel === 'drag') delayed.jsx(quoteScroll, 'onScrollBeginDrag')();
    if (cancel === 'offset') delayed.jsx(quoteScroll, 'onScroll')({ nativeEvent: { contentOffset: { y: 70 } } });
    if (cancel === 'replace') delayed.input('name', 200);
    if (cancel === 'cleanup') delayed.cleanup();
    delayed.flush();
    assert.equal(delayed.scrolls.filter(scroll => scroll.animated).length, 0, `Late callback: ${cancel}`);
    scenarios += 1;
  }
  const changed = createHarness();
  changed.input('price-new', 460);
  changed.context.revealQuoteInput('price-new');
  changed.event('keyboardDidShow', 550);
  changed.flush();
  assert.equal(changed.scrolls.length, 0);
  changed.event('keyboardDidChangeFrame', 480);
  changed.flush();
  assert.equal(changed.scrolls[0].y, 36);
  scenarios += 1;
  changed.scrolls.length = 0;
  changed.event('keyboardDidHide');
  changed.event('keyboardDidChangeFrame', 800, 0);
  changed.flush();
  assert.equal(changed.context.quoteKeyboardYRef.current, null);
  assert.equal(changed.scrolls.length, 0, 'Hidden keyboard frame must not reveal');
  scenarios += 1;

  const row = createHarness();
  const addButton = elements.find(element => attribute(element, 'onPress')?.getText(syntax).includes('quoteNewLineRef.current = id'));
  assert.ok(addButton);
  row.jsx(addButton, 'onPress')();
  const newItem = row.context.presupuestoItems.at(-1);
  assert.equal(newItem.id, row.context.quoteNewLineRef.current);
  assert.equal(newItem.description, '');
  const description = inputs.find(element => attribute(element, 'placeholder').getText(syntax).includes('quote.description'));
  const newComponent = row.input(`description-${newItem.id}`, 620);
  row.jsx(description, 'ref', { item: newItem })(newComponent);
  row.event('keyboardDidShow');
  row.jsx(quoteScroll, 'onContentSizeChange')();
  row.flush();
  assert.equal(row.context.quoteNewLineRef.current, null);
  assert.equal(row.scrolls.length, 1);
  assert.equal(row.scrolls[0].y, 176);
  scenarios += 1;

  const ios = createHarness();
  ios.context.Platform.OS = 'ios';
  ios.setViewport({ y: 100, height: 700 });
  ios.input('iva', 620);
  ios.context.revealQuoteInput('iva');
  ios.event('keyboardDidShow');
  ios.flush();
  assert.equal(ios.context.quoteKeyboardHeight, 0, 'iOS avoiding view handles padding');
  assert.equal(ios.scrolls[0].y, 176);
  scenarios += 1;

  for (const element of inputs) {
    const fields = createHarness();
    const item = { id: 'new' };
    const ref = fields.jsx(element, 'ref', { item });
    const focus = fields.jsx(element, 'onFocus', { item });
    const blur = fields.jsx(element, 'onBlur', { item });
    if (attribute(element, 'placeholder').getText(syntax).includes('quote.description')) fields.context.quoteNewLineRef.current = 'new';
    let focused = 0;
    const component = { focus: () => { focused += 1; focus(); }, measureInWindow: callback => callback(0, 620, 100, 40) };
    ref(component);
    focus();
    fields.event('keyboardDidShow');
    fields.flush();
    assert.equal(fields.scrolls.at(-1).y, 176);
    if (focused) { assert.equal(focused, 1); assert.equal(fields.context.quoteNewLineRef.current, null); }
    blur();
    assert.equal(fields.context.quoteFocusedInputRef.current, null);
    ref(null);
    scenarios += 1;
  }
};

const assertReset = harness => {
  assert.equal(JSON.stringify(harness.context.presupuestoClient), JSON.stringify({ name: '', nif: '', address: '' }));
  assert.equal(harness.context.presupuestoClientEmail, '');
  assert.equal(JSON.stringify(harness.context.presupuestoItems), JSON.stringify([{ id: '1', description: '', price: '' }]));
  assert.equal(harness.context.presupuestoIvaInput, '21');
  assert.equal(harness.context.quoteFocusedInputRef.current, null);
  assert.equal(harness.context.quoteNewLineRef.current, null);
  assert.equal(harness.context.quoteKeyboardYRef.current, null);
  assert.equal(harness.context.quoteScrollOffsetRef.current, 0);
  assert.equal(harness.context.quoteKeyboardHeight, 0);
  assert.equal(Object.keys(harness.context.quoteInputRefs.current).length, 0);
  assert.equal(harness.dismissals(), 1);
  assert.equal(harness.scrolls.at(-1).y, 0);
  assert.equal(harness.scrolls.at(-1).animated, false);
};
const checkCompletion = async () => {
  const reset = createHarness();
  reset.input('email', 620);
  reset.context.quoteNewLineRef.current = 'pending';
  reset.context.quoteScrollOffsetRef.current = 180;
  reset.context.revealQuoteInput('email');
  reset.event('keyboardDidShow');
  reset.context.resetQuoteForm();
  reset.flush();
  assertReset(reset);
  assert.equal(reset.scrolls.length, 1, 'Reset cancels scheduled reveal');
  scenarios += 1;
  for (const type of ['PRESUPUESTO', 'FACTURA']) {
    for (const status of ['sent', 'saved', 'cancelled', 'undetermined']) {
      const harness = createHarness();
      harness.context.presupuestoDocumentType = type;
      harness.context.mailStatus = status;
      await harness.context.sendPresupuestoByEmail();
      assert.equal(harness.mailed.length, 1);
      assert.equal(harness.mailed[0].recipients[0], 'client@example.com');
      assert.equal(harness.published.length, 1);
      assert.equal(harness.context.cashInvoiceDrafts.length, type === 'FACTURA' ? 1 : 0);
      assert.equal(harness.alerts.length, 0, 'Opening composer must not claim delivery');
      if (status === 'sent' || status === 'saved') assertReset(harness);
      else { assert.equal(harness.context.presupuestoClientEmail, ' client@example.com '); assert.equal(harness.dismissals(), 0); }
      assert.equal(harness.context.presupuestoDocumentType, type);
      assert.equal(harness.published[0].client.name, 'Client');
      assert.equal(harness.published[0].items[0].description, 'Product');
      scenarios += 1;
    }
  }
  for (const failure of ['subscription', 'client', 'email', 'items', 'unavailable', 'publish', 'pdf', 'composer']) {
    const harness = createHarness();
    if (failure === 'subscription') harness.context.requireSubscription = () => false;
    if (failure === 'client') harness.context.presupuestoClient.name = '';
    if (failure === 'email') harness.context.presupuestoClientEmail = '';
    if (failure === 'items') harness.context.presupuestoItems = [];
    if (failure === 'unavailable') harness.context.MailComposer.isAvailableAsync = async () => false;
    const fail = async () => { throw new Error('fixture failure'); };
    if (failure === 'publish') harness.context.registerTransactionDocument = fail;
    if (failure === 'pdf') harness.context.generatePdfFileUri = fail;
    if (failure === 'composer') harness.context.MailComposer.composeAsync = fail;
    await harness.context.sendPresupuestoByEmail();
    assert.equal(harness.dismissals(), 0, failure);
    assert.equal(harness.context.presupuestoIvaInput, '10', failure);
    scenarios += 1;
  }
  const paid = createHarness();
  const draft = { id: 'draft', documentType: 'FACTURA', client: { name: 'Client' }, items: [{ description: 'Product', price: '12' }], publicUrl: 'old', amount: 13.2 };
  const other = { id: 'other' };
  paid.context.cashInvoiceDrafts = [draft, other];
  paid.context.transactions = [other];
  await paid.context.markCashInvoiceAsPaid(draft);
  assertReset(paid);
  assert.equal(paid.context.cashInvoiceDrafts.length, 1);
  assert.equal(paid.context.cashInvoiceDrafts[0], other);
  assert.equal(paid.context.transactions.length, 2);
  assert.equal(paid.context.transactions[1], other);
  assert.equal(paid.context.selectedTicket.method, 'Efectivo');
  assert.equal(paid.context.selectedTicket.items[0].description, 'Product');
  assert.equal(paid.alerts[0][1], 'cash.saved');
  scenarios += 1;
  const rejected = createHarness();
  rejected.context.registerTransactionDocument = async () => { throw new Error('publish failed'); };
  await assert.rejects(rejected.context.markCashInvoiceAsPaid(draft), /publish failed/);
  assert.equal(rejected.dismissals(), 0);
  scenarios += 1;
};

(async () => {
  checkGeometry();
  await checkCompletion();
  console.log(`Quote form: ${scenarios} real AST/VM scenarios passed.`);
})().catch(error => { console.error(error); process.exitCode = 1; });