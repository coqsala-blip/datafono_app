const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { Buffer } = require('node:buffer');

const cache = new Map();
const copies = [];
const fileSystem = {
  cacheDirectory: 'file:///cache/',
  makeDirectoryAsync: async () => {},
  copyAsync: async options => copies.push(options),
};
const doubles = { 'expo-file-system/legacy': fileSystem };
let hooks;
let captureCalls = [];
let shared = [];
let released = [];
let available = true;
let captureFailure = false;
let frameAction = () => {};
let viewport = 390;
const jsx = (type, props, key) => ({ type, props: props || {}, key });
doubles['react/jsx-runtime'] = { jsx, jsxs: jsx };
doubles.react = {
  useRef: value => hooks.slot(() => ({ current: value })),
  useState: value => {
    const index = hooks.cursor;
    const current = hooks.slot(() => value);
    return [current, next => { hooks.values[index] = typeof next === 'function' ? next(hooks.values[index]) : next; }];
  },
  useEffect: callback => hooks.slot(() => { const cleanup = callback(); hooks.cleanups.push(cleanup); return true; }),
};
doubles['react-native'] = {
  Image: 'Image', Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', View: 'View',
  StyleSheet: { create: value => value }, PixelRatio: { get: () => 3 }, useWindowDimensions: () => ({ width: viewport }),
  Platform: { OS: 'android' },
};
doubles['react-native-safe-area-context'] = { SafeAreaView: 'SafeAreaView' };
doubles['@expo/vector-icons'] = { Ionicons: 'Ionicons' };
doubles['expo-sharing'] = {
  isAvailableAsync: async () => available,
  shareAsync: async (uri, options) => shared.push({ uri, options }),
};
doubles['react-native-view-shot'] = {
  captureRef: async (ref, options) => {
    assert.equal(ref.current, 'native-scroll');
    captureCalls.push(options);
    if (captureFailure) throw new Error('capture');
    return 'file:///shot.png';
  },
  releaseCapture: uri => released.push(uri),
};
const load = filename => {
  const absolute = path.resolve(filename);
  if (cache.has(absolute)) return cache.get(absolute);
  const module = { exports: {} };
  const compiled = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(compiled, {
    module, exports: module.exports, Intl,
    requestAnimationFrame: callback => { frameAction(); callback(); },
    require: name => {
      if (doubles[name]) return doubles[name];
      const target = path.resolve(path.dirname(absolute), name);
      return load(fs.existsSync(`${target}.ts`) ? `${target}.ts` : `${target}.tsx`);
    },
  }, { filename: absolute });
  cache.set(absolute, module.exports);
  return module.exports;
};
const helper = load('src/documents/image-export.ts');
const { DocumentImageShare, snapshotImageDocument } = load('src/components/document-image-share.tsx');
const { APP_LOCALES, t, formatCurrencyForLocale } = load('src/i18n.ts');
const { imageShareTranslations } = load('src/translations/image-share.ts');
const walk = node => {
  if (Array.isArray(node)) return node.flatMap(walk);
  if (!node || typeof node !== 'object') return [];
  return [node, ...walk(node.props?.children)];
};
const text = node => {
  if (Array.isArray(node)) return node.map(text).join(' ');
  if (node && typeof node === 'object') return text(node.props?.children);
  return typeof node === 'string' ? node : '';
};
const fixture = () => ({
  ticketCode: 'REF-123', type: 'COBRO', documentType: 'FACTURA COMPLETA', createdAt: '2026-10-04T21:34:00Z',
  subtotal: 10, iva: 2.1, ivaRateApplied: 21, amount: 12.1,
  issuer: { name: 'Issuer', nif: 'NIF-1', address: 'Issuer address', logoUri: 'file:///logo.png', logoPosition: 'bottom-right', logoSize: 'large' },
  client: { name: 'Client', nif: 'CLIENT-ID', address: 'Client address' },
  items: Array.from({ length: 12 }, (_, index) => ({ id: String(index), description: `Item-${index}`, price: '1,00' })),
  refundHistory: [{ amount: 1, date: '2026-10-04T21:34:00Z' }], originalAmount: 13.1, publicUrl: 'https://example.com/receipt',
});
const harness = (document = fixture(), locale = 'es', qrUri = 'https://example.com/qr') => {
  hooks = { cursor: 0, values: [], cleanups: [], slot(factory) {
    const index = this.cursor++;
    if (!(index in this.values)) this.values[index] = factory();
    return this.values[index];
  } };
  const ownHooks = hooks;
  let tree;
  let closed = false;
  const render = () => {
    hooks = ownHooks;
    hooks.cursor = 0;
    tree = DocumentImageShare({ document, locale, qrUri, onClose: () => { closed = true; } });
    walk(tree).find(node => node.type === 'ScrollView').props.ref.current = 'native-scroll';
    return tree;
  };
  const scroll = () => walk(tree).find(node => node.type === 'ScrollView');
  const button = key => walk(tree).find(node => node.type === 'Pressable' && text(node).trim() === t(locale, key));
  const measure = (height = 900) => {
    const width = scroll().props.style[1].width;
    scroll().props.onLayout({ nativeEvent: { layout: { width } } });
    scroll().props.onContentSizeChange(width, height);
    render();
  };
  const loadImages = () => {
    for (const image of walk(tree).filter(node => node.type === 'Image')) { image.props.onLoad(); image.props.onLoadEnd(); }
    render();
  };
  render();
  return { render, scroll, button, measure, loadImages, tree: () => tree, closed: () => closed, unmount: () => ownHooks.cleanups.forEach(cleanup => cleanup?.()) };
};

async function checkComponent() {
  const original = fixture();
  const snapshot = snapshotImageDocument(original);
  original.issuer.name = 'Changed';
  original.items[0].description = 'Changed';
  original.client.name = 'Changed';
  original.refundHistory[0].amount = 99;
  assert.equal(snapshot.issuer.name, 'Issuer');
  assert.equal(snapshot.items[0].description, 'Item-0');
  assert.equal(snapshot.client.name, 'Client');
  assert.equal(snapshot.refundHistory[0].amount, 1);
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.items[0]));
  let scenarios = 0;
  for (const { code: locale } of APP_LOCALES) {
    assert.deepEqual(Object.keys(imageShareTranslations[locale]), Object.keys(imageShareTranslations.es));
    for (const key of Object.keys(imageShareTranslations.es)) assert.notEqual(t(locale, key), key);
    for (const [documentType, labelKey] of Object.entries({
      'TICKET DE VENTA': 'document.sale', 'FACTURA SIMPLIFICADA': 'document.simplified', 'FACTURA COMPLETA': 'document.complete',
      'TICKET DE DEVOLUCIÓN': 'document.refund', 'COMPRA/DEVOLUCIONES': 'document.purchaseRefunds', 'PRESUPUESTO': 'document.quote', 'FACTURA': 'document.invoice',
    })) {
      const document = { ...fixture(), documentType };
      const before = JSON.stringify(document);
      const ui = harness(document, locale);
      assert.equal(ui.button('imageShare.action').props.disabled, true);
      await ui.button('imageShare.action').props.onPress();
      ui.measure();
      assert.equal(ui.button('imageShare.action').props.disabled, true);
      const images = walk(ui.tree()).filter(node => node.type === 'Image');
      images[0].props.onLoad();
      ui.render();
      assert.equal(ui.button('imageShare.action').props.disabled, true);
      images[0].props.onLoadEnd();
      ui.render();
      ui.loadImages();
      assert.equal(ui.button('imageShare.action').props.disabled, false);
      const content = ui.scroll();
      assert.equal(walk(content).filter(node => node.type === 'Pressable').length, 0);
      assert.equal(content.props.removeClippedSubviews, false);
      assert.ok(text(content).includes(t(locale, labelKey)));
      assert.ok(text(content).includes('Client address'));
      for (const item of document.items) assert.ok(text(content).includes(item.description));
      assert.ok(text(content).includes(formatCurrencyForLocale(locale, document.amount)));
      assert.ok(text(content).includes('21%'));
      const count = shared.length;
      await ui.button('imageShare.action').props.onPress();
      assert.equal(shared.length, count + 1);
      const output = shared.at(-1);
      assert.ok(output.uri.endsWith(helper.buildImageFilename([t(locale, labelKey), document.ticketCode])));
      assert.equal(output.options.mimeType, 'image/png');
      assert.equal(output.options.UTI, 'public.png');
      const capture = captureCalls.at(-1);
      assert.equal(capture.snapshotContentContainer, true);
      assert.equal(capture.format, 'png');
      assert.equal(capture.result, 'tmpfile');
      assert.ok(capture.width <= 1200 && capture.height <= 8192);
      assert.equal(released.at(-1), 'file:///shot.png');
      assert.equal(JSON.stringify(document), before);
      ui.unmount();
      scenarios += 1;
    }
  }
  const ui = harness();
  ui.measure();
  let logo = walk(ui.tree()).find(node => node.type === 'Image');
  logo.props.onError(); logo.props.onLoadEnd(); ui.render();
  assert.ok(text(ui.tree()).includes(t('es', 'imageShare.imageFailed')));
  assert.equal(ui.button('imageShare.action').props.disabled, true);
  ui.button('ticket.retry').props.onPress(); ui.render();
  logo.props.onLoad(); logo.props.onLoadEnd(); ui.render();
  assert.equal(ui.button('imageShare.action').props.disabled, true);
  ui.loadImages();
  assert.equal(ui.button('imageShare.action').props.disabled, false);
  ui.measure(30000);
  assert.ok(text(ui.tree()).includes(t('es', 'imageShare.tooLong')));
  assert.equal(ui.button('imageShare.action').props.disabled, true);
  assert.ok(text(ui.scroll()).includes('Item-11'));
  ui.measure();
  captureFailure = true;
  await ui.button('imageShare.action').props.onPress(); ui.render();
  assert.ok(text(ui.tree()).includes(t('es', 'imageShare.failed')));
  captureFailure = false;
  available = false;
  await ui.button('imageShare.action').props.onPress(); ui.render();
  assert.ok(text(ui.tree()).includes(t('es', 'imageShare.unavailable')));
  available = true;
  const count = captureCalls.length;
  frameAction = () => { ui.scroll().props.onContentSizeChange(366, 901); };
  await ui.button('imageShare.action').props.onPress();
  assert.equal(captureCalls.length, count);
  frameAction = () => {};
  ui.measure();
  ui.button('common.close').props.onPress();
  assert.equal(ui.closed(), true);
  await ui.button('imageShare.action').props.onPress();
  assert.equal(captureCalls.length, count);
  ui.unmount();
  const noImages = harness({ ...fixture(), issuer: { name: 'Issuer', nif: 'ID', address: 'Street' }, publicUrl: undefined }, 'en', null);
  noImages.measure();
  assert.equal(walk(noImages.tree()).filter(node => node.type === 'Image').length, 0);
  assert.equal(noImages.button('imageShare.action').props.disabled, false);
  noImages.unmount();
  const longDocument = { ...fixture(), items: Array.from({ length: 500 }, (_, index) => ({ id: String(index), description: `Long-row-${index}`, price: '1' })) };
  const longPreview = harness(longDocument);
  longPreview.measure(20000); longPreview.loadImages();
  assert.equal(longPreview.button('imageShare.action').props.disabled, true);
  for (const item of longDocument.items) assert.ok(text(longPreview.scroll()).includes(item.description));
  assert.ok(text(longPreview.tree()).includes(t('es', 'imageShare.tooLong')));
  longPreview.unmount();
  const unfinished = harness();
  unfinished.measure();
  for (const image of walk(unfinished.tree()).filter(node => node.type === 'Image')) image.props.onLoadEnd();
  unfinished.render();
  assert.equal(unfinished.button('imageShare.action').props.disabled, true);
  assert.ok(unfinished.button('ticket.retry'));
  unfinished.unmount();
  const refund = harness({ ...fixture(), type: 'DEVOLUCIÓN', originalAmount: 20, relatedTicketCode: 'ORIGINAL-1', amount: 5 });
  assert.ok(text(refund.scroll()).includes('ORIGINAL-1'));
  assert.ok(text(refund.scroll()).includes(formatCurrencyForLocale('es', 15)));
  refund.unmount();
  viewport = 1024;
  const wide = harness();
  assert.equal(wide.scroll().props.style[1].width, 600);
  wide.unmount();
  doubles['react-native'].Platform.OS = 'ios';
  const ios = harness();
  ios.measure(); ios.loadImages();
  await ios.button('imageShare.action').props.onPress();
  assert.equal(captureCalls.at(-1).width * 3, 1200);
  assert.equal(captureCalls.at(-1).height * 3, 1800);
  ios.unmount();
  doubles['react-native'].Platform.OS = 'android';
  viewport = 390;
  const source = fs.readFileSync('src/app/index.tsx', 'utf8');
  const syntax = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const modalNodes = [];
  const forbidden = new Set(['DocumentImageShare', 'ImageShareDocument', 'snapshotImageDocument', 'imageShareDocument', 'imageShareVisible', 'setImageShareDocument']);
  const visit = node => {
    if (ts.isIdentifier(node)) assert.ok(!forbidden.has(node.text), `Image sharing remnant: ${node.text}`);
    if (ts.isImportDeclaration(node)) assert.ok(!node.moduleSpecifier.text.includes('document-image-share'));
    if (ts.isCallExpression(node) && node.expression.getText(syntax) === 'tr') assert.notEqual(node.arguments[0]?.text, 'imageShare.action');
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(syntax) === 'Modal') {
      const visible = node.openingElement.attributes.properties.find(attribute => attribute.name?.getText(syntax) === 'visible');
      if (visible?.initializer?.expression?.getText(syntax) === 'selectedTicket !== null') modalNodes.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(syntax);
  assert.equal(modalNodes.length, 1);
  assert.ok(modalNodes[0].getText(syntax).includes('generateAndSharePdf(selectedTicket)'));
  assert.ok(modalNodes[0].getText(syntax).includes('sendByEmail(selectedTicket)'));
  const selectedTicket = fixture();
  const beforeAction = JSON.stringify(selectedTicket);
  const actions = [];
  const collectActions = node => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(syntax) === 'Pressable') {
      const handler = node.openingElement.attributes.properties.find(attribute => attribute.name?.getText(syntax) === 'onPress')?.initializer?.expression;
      if (handler && /^(\(\) => (generateAndSharePdf|sendByEmail)\(selectedTicket\))$/.test(handler.getText(syntax))) actions.push(handler);
    }
    ts.forEachChild(node, collectActions);
  };
  collectActions(modalNodes[0]);
  assert.equal(actions.length, 2);
  const calls = [];
  for (const action of actions) vm.runInNewContext(ts.transpileModule(`(${action.getText(syntax)})();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    selectedTicket,
    generateAndSharePdf: ticket => calls.push(['pdf', ticket]),
    sendByEmail: ticket => calls.push(['email', ticket]),
  });
  assert.deepEqual(calls, [['pdf', selectedTicket], ['email', selectedTicket]]);
  assert.equal(JSON.stringify(selectedTicket), beforeAction);
  console.log(`Image preview: ${scenarios} isolated component scenarios passed; app AST has no image sharing and real PDF/email handlers remain.`);
}

async function main() {
  for (const parts of [['Factura', 'REF-123'], ['Zażółć', '日本語'], ['../CON.png'], ['e\u0301'.repeat(200), 'REF-999']]) {
    const filename = helper.buildImageFilename(parts);
    assert.ok(filename.endsWith('.png'));
    assert.ok(!filename.includes('.pdf'));
    assert.ok(!filename.includes('/'));
    assert.ok(Buffer.byteLength(filename) <= 180);
    assert.equal(filename, filename.normalize('NFC'));
  }
  assert.ok(helper.getImageCaptureSize(320, 1200, 3));
  const androidSize = helper.getImageCaptureSize(320, 1200, 3, 'android');
  const iosSize = helper.getImageCaptureSize(320, 1200, 3, 'ios');
  assert.equal(androidSize.width, iosSize.width * 3);
  assert.equal(androidSize.height, iosSize.height * 3);
  for (const size of [[320, 30000, 3], [1200, 3000, 3], [0, 1, 1], [320, Infinity, 2]]) {
    assert.equal(helper.getImageCaptureSize(...size), null);
  }
  const results = await Promise.all(Array.from({ length: 100 }, () => helper.copyImageForExport('file:///raw.png', 'Factura_REF.png')));
  assert.equal(new Set(results).size, 100);
  assert.ok(results.every(uri => uri.endsWith('/Factura_REF.png')));
  assert.ok(copies.every(copy => copy.from === 'file:///raw.png'));
  fileSystem.cacheDirectory = null;
  await assert.rejects(helper.copyImageForExport('raw', 'name'));
  fileSystem.cacheDirectory = 'file:///cache/';
  console.log('Image export helpers: names, 100 unique copies and native bitmap limits passed.');
  await checkComponent();
}

main().catch(error => { console.error(error); process.exitCode = 1; });