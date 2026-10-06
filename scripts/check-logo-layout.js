const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve('.');
const cache = new Map();
const loadModule = (filePath) => {
  if (cache.has(filePath)) return cache.get(filePath);
  const module = { exports: {} };
  cache.set(filePath, module.exports);
  const compiled = ts.transpileModule(fs.readFileSync(filePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(compiled, {
    module, exports: module.exports, Intl,
    require: name => loadModule(path.resolve(path.dirname(filePath), `${name}.ts`)),
  }, { filename: filePath });
  return module.exports;
};

const logoModule = loadModule(path.join(root, 'src/documents/logo-layout.ts'));
const { LOGO_POSITIONS, LOGO_SIZES, normalizeLogoSettings, getLogoLayout, renderDocumentLogo, getIssuerLayout, renderIssuerBlock, offsetFromIssuerDrag } = logoModule;
const bitmap = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
let scenarios = 0;
for (const isA4 of [false, true]) {
  for (const logoPosition of LOGO_POSITIONS) {
    for (const logoSize of LOGO_SIZES) {
      const settings = Object.freeze({ logoPosition, logoSize });
      const layout = getLogoLayout(settings, isA4);
      const output = renderDocumentLogo(bitmap, settings, isA4);
      const html = output.topHtml + output.bottomHtml;
      assert.equal((html.match(/class="document-logo"/g) || []).length, 1);
      assert.equal((html.match(/<img /g) || []).length, 1);
      assert.equal(Boolean(output.topHtml), logoPosition.startsWith('top-'));
      assert.equal(Boolean(output.bottomHtml), logoPosition.startsWith('bottom-'));
      assert.ok(html.includes(`text-align: ${logoPosition.split('-')[1]};`));
      assert.equal(layout.width, { small: 55, medium: 85, large: isA4 ? 160 : 120 }[logoSize]);
      assert.ok(layout.width <= (isA4 ? 160 : 120));
      assert.ok(html.includes(`width: ${layout.width}px; max-width: 100%; height: auto; max-height: ${layout.maxHeight}px; object-fit: contain;`));
      assert.ok(!/position:|(?:^|[;\s])height: \d+px;/.test(html));
      scenarios += 1;
    }
  }
}
for (const settings of [undefined, null, {}, false, 'large', { logoPosition: 'sideways', logoSize: 'huge' }, { logoPosition: {}, logoSize: 85 }]) {
  assert.equal(JSON.stringify(normalizeLogoSettings(settings)), JSON.stringify({ logoPosition: 'top-center', logoSize: 'medium' }));
  assert.equal(renderDocumentLogo(bitmap, settings, false).topHtml, renderDocumentLogo(bitmap, {}, false).topHtml);
  scenarios += 1;
}
for (const uri of [undefined, null, '', 'file:///logo.png', 'https://example.com/logo.png', 'javascript:alert(1)', 'data:text/html;base64,AAAA', 'data:image/svg+xml;base64,AAAA', 'data:image/png;base64,', 'data:image/png;base64,AAAA" onerror="alert(1)', "data:image/png;base64,AAAA'><script>&</script>"]) {
  const output = renderDocumentLogo(uri, {}, true);
  assert.equal(output.topHtml + output.bottomHtml, '');
  scenarios += 1;
}
for (const mime of ['png', 'jpeg', 'webp', 'gif']) {
  const output = renderDocumentLogo(`data:image/${mime};base64,AAAA`, {}, true);
  assert.ok(output.topHtml.includes(`src="data:image/${mime};base64,AAAA"`));
  scenarios += 1;
}
const oldIssuer = Object.freeze({ name: 'Old business', logoUri: bitmap });
const transaction = Object.freeze({ issuer: Object.freeze({ ...oldIssuer }) });
const snapshot = JSON.stringify(transaction);
const newIssuer = { ...oldIssuer, logoPosition: 'bottom-right', logoSize: 'large' };
renderDocumentLogo(bitmap, transaction.issuer, false);
assert.equal(JSON.stringify(transaction), snapshot);
assert.ok(renderDocumentLogo(bitmap, transaction.issuer, false).topHtml.includes('width: 85px;'));
assert.ok(renderDocumentLogo(bitmap, newIssuer, false).bottomHtml);
scenarios += 1;
for (const isA4 of [false, true]) {
  for (const logoSize of LOGO_SIZES) {
    for (const x of [0, 0.37, 1]) {
      for (const y of [0, 0.61, 1]) {
        const key = isA4 ? 'logoOffsetA4' : 'logoOffsetTicket';
        const issuer = { name: 'Long business name '.repeat(4), nif: 'B123', address: 'Long address '.repeat(6), logoUri: bitmap, logoSize, [key]: { x, y } };
        const layout = getIssuerLayout(issuer, isA4);
        const html = renderIssuerBlock(issuer, bitmap, isA4).topHtml;
        assert.equal(layout.offset.x, x);
        assert.equal(layout.offset.y, y);
        assert.ok(layout.left + layout.width <= layout.pageWidth);
        assert.ok(layout.top + layout.height <= layout.pageHeight);
        assert.ok(html.includes(`padding-top: ${layout.top}px;`));
        assert.ok(html.includes(`margin-left: ${layout.left}px;`));
        assert.ok(!html.includes('position:'));
        assert.equal(renderIssuerBlock(issuer, bitmap, isA4).bottomHtml, '');
        assert.equal(JSON.stringify(offsetFromIssuerDrag(layout.left, layout.top, layout.pageWidth, layout.pageHeight, layout.width, layout.height)), JSON.stringify({ x, y }));
        scenarios += 1;
      }
    }
  }
}
assert.equal(JSON.stringify(normalizeLogoSettings({ logoOffsetA4: { x: -2, y: 5 }, logoOffsetTicket: { x: NaN, y: Infinity } })), JSON.stringify({ logoPosition: 'top-center', logoSize: 'medium', logoOffsetA4: { x: 0, y: 1 } }));
assert.equal(JSON.stringify(offsetFromIssuerDrag(10, 20, 200, 100, 300, 200)), JSON.stringify({ x: 0, y: 0 }));
assert.ok(renderIssuerBlock({ name: '<script>&"', address: '<img onerror=x>', logoOffsetA4: { x: 1, y: 1 } }, 'data:image/svg+xml;base64,AAAA', true).topHtml.includes('&lt;script&gt;&amp;&quot;'));
const { logoTranslations } = loadModule(path.join(root, 'src/translations/logo.ts'));
const { t, APP_LOCALES } = loadModule(path.join(root, 'src/i18n.ts'));
const keys = Object.keys(logoTranslations.es).sort();
for (const { code } of APP_LOCALES) {
  assert.deepEqual(Object.keys(logoTranslations[code]).sort(), keys);
  for (const key of keys) {
    assert.ok(logoTranslations[code][key].trim());
    assert.equal(t(code, key), logoTranslations[code][key]);
    assert.notEqual(t(code, key), key);
    assert.deepEqual(Array.from(t(code, key).matchAll(/\{\w+\}/g), match => match[0]), []);
  }
}
console.log(`${scenarios} logo scenarios passed (36 layout combinations, defaults, safe image attributes, old snapshots).`);
console.log(`${keys.length} logo keys validated in ${APP_LOCALES.length} languages (${keys.length * APP_LOCALES.length} translations).`);

const source = fs.readFileSync(path.join(root, 'src/app/index.tsx'), 'utf8');
const syntax = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
assert.equal(syntax.parseDiagnostics.length, 0);
const variables = new Map();
const effects = [];
let settingsChange;
let issuerRestore;
let issuerSnapshots = 0;
const collect = node => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) variables.set(node.name.text, node.initializer);
  if (ts.isCallExpression(node) && node.expression.getText(syntax) === 'useEffect') effects.push(node.arguments[0]);
  if (ts.isIfStatement(node) && node.expression.getText(syntax) === 'storedIssuer !== null' && node.thenStatement.getText(syntax).includes('restoreIssuerSettings')) issuerRestore = node;
  if (ts.isPropertyAssignment(node) && node.name.getText(syntax) === 'issuer' && ts.isObjectLiteralExpression(node.initializer) && node.initializer.properties.some(property => ts.isSpreadAssignment(property) && property.expression.getText(syntax) === 'issuer')) issuerSnapshots += 1;
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(syntax) === 'LogoSettings') {
    settingsChange = node.attributes.properties.find(attribute => attribute.name?.getText(syntax) === 'onChange').initializer.expression;
  }
  ts.forEachChild(node, collect);
};
collect(syntax);
assert.equal(issuerSnapshots, 4, 'New documents must retain their issuer snapshot');
const compile = expression => ts.transpileModule(`const selected = ${expression}; selected;`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;
const compileFunction = name => compile(variables.get(name).getText(syntax));
const persistence = effects.find(effect => effect.getText(syntax).includes('void writeIssuerSettings(storageScope, issuer)'));
assert.ok(persistence && settingsChange);
const publication = effects.find(effect => effect.getText(syntax).includes('transactionsNeedingPublication'));
assert.ok(!publication.getText(syntax).includes('issuer.logoUri'), 'Logo changes must not replace historical snapshots');
assert.ok(issuerRestore, 'Stored logo settings must normalize both format offsets');
let restored;
const initialIssuer = vm.runInNewContext(compileFunction('initialIssuer'));
const restoreIssuerSettings = vm.runInNewContext(compileFunction('restoreIssuerSettings'), { initialIssuer, normalizeLogoSettings });
vm.runInNewContext(compile(`() => { ${issuerRestore.getText(syntax)} }`), {
  storedIssuer: JSON.stringify({ name: 'Persisted business', managerEmail: 'kept@example.com', logoOffsetA4: { x: 0.37, y: 0.61 }, logoOffsetTicket: { x: -5, y: 2 } }),
  restoreIssuerSettings, setIssuer: value => { restored = value; },
})();
assert.equal(restored.managerEmail, 'kept@example.com');
assert.equal(JSON.stringify(restored.logoOffsetA4), JSON.stringify({ x: 0.37, y: 0.61 }));
assert.equal(JSON.stringify(restored.logoOffsetTicket), JSON.stringify({ x: 0, y: 1 }));

const createPdfHarness = () => {
  let html;
  let conversionFailure = false;
  let expectedA4 = false;
  const generate = vm.runInNewContext(compileFunction('generatePdfFileUri'), {
    buildPdfFilename: parts => `${parts.join('_')}.pdf`,
    documentTypeLabel: type => type,
    copyPdfForExport: async (uri, filename) => {
      assert.equal(uri, 'file:///fixture.pdf');
      assert.ok(filename.endsWith('_LOGO-001.pdf'));
      return 'file:///export/fixture.pdf';
    },
    renderDocumentLogo, renderIssuerBlock,
    getTransactionQrUrl: transaction => transaction.publicUrl ? 'https://example.com/qr.png' : null,
    convertImageToBase64: async uri => {
      if (conversionFailure) throw new Error('Unreadable image');
      return uri;
    },
    formatCurrency: amount => `${amount.toFixed(2)} EUR`,
    formatDate: date => date,
    Print: { printToFileAsync: async options => {
      html = options.html;
      assert.equal(options.width, expectedA4 ? 595.28 : undefined);
      assert.equal(options.height, expectedA4 ? 841.89 : undefined);
      if (expectedA4) assert.equal(JSON.stringify(options.margins), JSON.stringify({ top: 15, bottom: 15, left: 15, right: 15 }));
      return { uri: 'file:///fixture.pdf' };
    } },
    console: { log() {} },
  });
  return {
    async render(transaction, failConversion = false) {
      conversionFailure = failConversion;
      expectedA4 = ['FACTURA COMPLETA', 'FACTURA', 'PRESUPUESTO'].includes(transaction.documentType);
      assert.equal(await generate(transaction), 'file:///export/fixture.pdf');
      return html;
    },
  };
};

const documentTypes = ['TICKET DE VENTA', 'FACTURA SIMPLIFICADA', 'FACTURA COMPLETA', 'TICKET DE DEVOLUCIÓN', 'COMPRA/DEVOLUCIONES', 'PRESUPUESTO', 'FACTURA'];
const makeTransaction = (documentType, settings = {}) => ({
  id: 'fixture', ticketCode: 'LOGO-001', documentType, amount: 12.1, subtotal: 10, iva: 2.1, ivaRateApplied: 21,
  createdAt: '2026-10-04T12:00:00Z', publicUrl: 'https://example.com/documents/fixture',
  issuer: { name: 'Fixture business', nif: 'B12345678', address: 'Fixture address', logoUri: bitmap, ...settings },
  client: { name: 'Fixture client', nif: 'X12345', address: 'Client address' },
  items: [{ id: 'line', description: 'Fixture product', price: '10' }],
});

const buildLogoPdfFixtures = async (logoDataURL = bitmap) => {
  const harness = createPdfHarness();
  const fixtures = [];
  for (const documentType of documentTypes) {
    for (const logoPosition of LOGO_POSITIONS) {
      for (const logoSize of LOGO_SIZES) {
        const document = makeTransaction(documentType, { logoPosition, logoSize, logoUri: logoDataURL });
        fixtures.push({ documentType, logoPosition, logoSize, html: await harness.render(document) });
      }
    }
    for (const offset of [{ x: 0, y: 0 }, { x: 0.37, y: 0.61 }, { x: 1, y: 1 }]) {
      for (const logoSize of LOGO_SIZES) {
        const settings = { logoOffsetA4: offset, logoOffsetTicket: offset, logoSize };
        const document = makeTransaction(documentType, { ...settings, logoUri: logoDataURL });
        fixtures.push({ documentType, ...settings, html: await harness.render(document) });
      }
    }
  }
  return fixtures;
};
module.exports = { buildLogoPdfFixtures };

const checkLogoControls = () => {
  const componentSource = fs.readFileSync(path.join(root, 'src/components/logo-settings.tsx'), 'utf8');
  const compiled = ts.transpileModule(componentSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  let controlScenarios = 0;
  for (const { code } of APP_LOCALES) {
    for (const logoUri of [undefined, bitmap]) {
      const module = { exports: {} };
      const state = [];
      let cursor = 0;
      let currentIssuer = { ...oldIssuer, nif: 'B123456', address: 'Business address', logoUri };
      let saved = 0;
      const jsx = (type, props) => ({ type, props });
      const image = () => {};
      image.getSize = (uri, resolve) => resolve(300, 100);
      vm.runInNewContext(compiled, {
        module, exports: module.exports,
        require: name => {
          if (name === 'react') return {
            useState: initial => {
              const index = cursor++;
              if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
              return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
            },
            useRef: initial => {
              const index = cursor++;
              if (!(index in state)) state[index] = { current: initial };
              return state[index];
            },
          };
          if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
          if (name === '@expo/vector-icons') return { Ionicons: 'Ionicons' };
          if (name === 'react-native') return { Image: image, Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', View: 'View', Platform: { OS: 'android' }, PanResponder: { create: handlers => ({ panHandlers: handlers }) }, StyleSheet: { create: value => value } };
          if (name === '../documents/logo-layout') return logoModule;
          if (name === '../i18n') return { t };
          throw new Error(`Unexpected component dependency: ${name}`);
        },
      });
      const render = () => {
        cursor = 0;
        const tree = module.exports.LogoSettings({
          issuer: currentIssuer, locale: code, onChange: changes => { saved += 1; currentIssuer = { ...currentIssuer, ...changes }; },
        });
        const nodes = [];
        const visit = node => {
          if (Array.isArray(node)) return node.forEach(visit);
          if (!node || typeof node !== 'object' || !node.props) return;
          nodes.push(node);
          visit(node.props.children);
        };
        visit(tree);
        return nodes;
      };
      const findControl = (nodes, key) => nodes.find(node => node.type === 'Pressable' && node.props.accessibilityLabel === t(code, key));
      let nodes = render();
      assert.equal(nodes.filter(node => node.type === 'Pressable').length, 5);
      assert.ok(!findControl(nodes, 'logo.top-center'));
      assert.ok(findControl(nodes, 'logo.medium').props.accessibilityState.checked);
      for (const logoPosition of LOGO_POSITIONS) {
        for (const logoSize of LOGO_SIZES) {
          currentIssuer = { ...currentIssuer, logoPosition };
          findControl(nodes, `logo.${logoSize}`).props.onPress();
          nodes = render();
          for (const isA4 of [false, true]) {
            findControl(nodes, isA4 ? 'logo.invoice' : 'logo.ticket').props.onPress();
            nodes = render();
            const page = nodes.find(node => node.props.testID === 'issuer-page');
            const pageWidth = isA4 ? 274 : 198;
            page.props.onLayout({ nativeEvent: { layout: { width: pageWidth } } });
            nodes = render();
            assert.equal(currentIssuer.logoPosition, logoPosition);
            assert.equal(currentIssuer.logoSize, logoSize);
            assert.equal(currentIssuer.logoUri, logoUri);
            assert.ok(findControl(nodes, `logo.${logoSize}`).props.accessibilityState.checked);
            assert.ok(findControl(nodes, isA4 ? 'logo.invoice' : 'logo.ticket').props.accessibilityState.checked);
            const images = nodes.filter(node => node.type === image);
            assert.equal(images.length, logoUri ? 1 : 0);
            if (logoUri) {
              assert.equal(images[0].props.resizeMode, 'contain');
              assert.equal(images[0].props.style.width, images[0].props.style.height);
              assert.equal(images[0].props.source.uri, logoUri);
              const imageIndex = nodes.indexOf(images[0]);
              const issuerIndex = nodes.findIndex(node => node.type === 'Text' && node.props.children === currentIssuer.name);
              assert.ok(imageIndex < issuerIndex);
            }
            assert.ok(nodes.some(node => node.type === 'Text' && node.props.children === currentIssuer.name));
            assert.ok(nodes.some(node => node.type === 'Text' && node.props.children.includes?.(currentIssuer.address)));
            const getBlock = () => nodes.find(node => node.props.testID === 'issuer-drag-block');
            const layout = getIssuerLayout(currentIssuer, isA4);
            const scale = pageWidth / layout.pageWidth;
            const measuredWidth = layout.width * scale;
            const measuredHeight = layout.height * scale + 3;
            getBlock().props.onLayout({ nativeEvent: { layout: { width: measuredWidth, height: measuredHeight } } });
            nodes = render();
            const key = isA4 ? 'logoOffsetA4' : 'logoOffsetTicket';
            const otherKey = isA4 ? 'logoOffsetTicket' : 'logoOffsetA4';
            const otherBefore = JSON.stringify(currentIssuer[otherKey]);
            const handlers = getBlock().props;
            assert.ok(handlers.onStartShouldSetPanResponder());
            handlers.onPanResponderGrant();
            const beforeMove = saved;
            handlers.onPanResponderMove({}, { dx: 1e6, dy: 1e6 });
            nodes = render();
            assert.equal(saved, beforeMove, 'Movement must not persist every frame');
            assert.equal(getBlock().props.style.marginLeft, pageWidth - measuredWidth);
            handlers.onPanResponderRelease({}, { dx: 1e6, dy: 1e6 });
            nodes = render();
            assert.equal(JSON.stringify(currentIssuer[key]), JSON.stringify({ x: 1, y: 1 }));
            assert.equal(JSON.stringify(currentIssuer[otherKey]), otherBefore);
            handlers.onPanResponderGrant();
            handlers.onPanResponderRelease({}, { dx: -1e6, dy: -1e6 });
            nodes = render();
            assert.equal(JSON.stringify(currentIssuer[key]), JSON.stringify({ x: 0, y: 0 }));
            handlers.onPanResponderGrant();
            const availableX = pageWidth - measuredWidth;
            const availableY = layout.pageHeight * scale - measuredHeight;
            handlers.onPanResponderMove({}, { dx: availableX * 0.37, dy: availableY * 0.61 });
            nodes = render();
            handlers.onPanResponderTerminate();
            nodes = render();
            assert.ok(Math.abs(currentIssuer[key].x - 0.37) < 1e-10);
            assert.ok(Math.abs(currentIssuer[key].y - 0.61) < 1e-10);
            const html = renderIssuerBlock(currentIssuer, logoUri, isA4).topHtml;
            assert.ok(html.includes(`margin-left: ${getIssuerLayout(currentIssuer, isA4).left}px;`));
            controlScenarios += 1;
          }
        }
      }
      nodes = render();
      const retainedHandlers = nodes.find(node => node.props.testID === 'issuer-drag-block').props;
      retainedHandlers.onPanResponderGrant();
      retainedHandlers.onPanResponderMove({}, { dx: 20, dy: 30 });
      const savedBeforeFormat = saved;
      const a4BeforeFormat = JSON.stringify(currentIssuer.logoOffsetA4);
      findControl(nodes, 'logo.ticket').props.onPress();
      nodes = render();
      retainedHandlers.onPanResponderRelease({}, { dx: 40, dy: 50 });
      nodes = render();
      assert.equal(saved, savedBeforeFormat, 'A gesture from another format must not commit');
      assert.equal(JSON.stringify(currentIssuer.logoOffsetA4), a4BeforeFormat);
      currentIssuer = { ...currentIssuer, name: 'X'.repeat(3000), address: 'Address '.repeat(100), logoOffsetTicket: { x: 1, y: 1 } };
      nodes = render();
      const oversizedHandlers = nodes.find(node => node.props.testID === 'issuer-drag-block').props;
      oversizedHandlers.onPanResponderGrant();
      oversizedHandlers.onPanResponderRelease({}, { dx: 0, dy: 1e6 });
      nodes = render();
      assert.equal(currentIssuer.logoOffsetTicket.y, 0, 'An oversized block must grow in flow, not leave the page area');
      const text = nodes.filter(node => node.type === 'Text').map(node => typeof node.props.children === 'string' ? node.props.children : '').join('').replace(/\n/g, '');
      assert.ok(text.includes(currentIssuer.name), 'Long issuer names must not be truncated');
    }
  }
  console.log(`${controlScenarios} gesture scenarios passed in 8 languages, with/without logo, both formats, legacy positions/sizes; measured clamps, latest refs, release/termination persistence and contain frames verified.`);
};

const runIntegration = async () => {
  const fixtures = await buildLogoPdfFixtures();
  for (const fixture of fixtures) {
    const isA4 = ['FACTURA COMPLETA', 'FACTURA', 'PRESUPUESTO'].includes(fixture.documentType);
    const layout = getLogoLayout(fixture, isA4);
    const html = fixture.html;
    assert.equal((html.match(/class="document-logo"/g) || []).length, 1);
    const logoIndex = html.indexOf('class="document-logo"');
    assert.ok(logoIndex < html.indexOf('Fixture business'));
    assert.ok(html.indexOf('Fixture address') < html.indexOf('<div class="total-row">'));
    assert.ok(html.includes(`width: ${layout.width}px; height: ${layout.width}px; object-fit: contain;`));
    assert.ok(html.includes('class="issuer-space"'));
    assert.ok(!html.includes('position: absolute'));
    const issuerLayout = getIssuerLayout(makeTransaction(fixture.documentType, fixture).issuer, isA4);
    assert.ok(html.includes(`padding-top: ${issuerLayout.top}px;`));
    assert.ok(html.includes(`margin-left: ${issuerLayout.left}px;`));
  }
  let pdfScenarios = fixtures.length;
  const harness = createPdfHarness();
  let expenseHtml;
  const generateExpense = vm.runInNewContext(compileFunction('generateExpensePdfUri'), {
    buildPdfFilename: parts => `${parts.join('_')}.pdf`, tr: key => key,
    convertImageToBase64: async uri => uri,
    renderIssuerBlock,
    formatCurrency: amount => `${amount.toFixed(2)} EUR`, formatDate: date => date,
    Print: { printToFileAsync: async options => { expenseHtml = options.html; assert.equal(options.width, 595.28); assert.equal(options.height, 841.89); return { uri: 'file:///expense.pdf' }; } },
    copyPdfForExport: async uri => uri,
  });
  for (const offset of [{ x: 0, y: 0 }, { x: 0.37, y: 0.61 }, { x: 1, y: 1 }]) {
    const expense = { expenseCode: 'EXP-001', provider: 'Fixture supplier', createdAt: '2026-10-05', amount: 10, imageUri: bitmap, issuer: { ...makeTransaction('FACTURA').issuer, logoOffsetA4: offset } };
    const before = JSON.stringify(expense);
    assert.equal(await generateExpense(expense), 'file:///expense.pdf');
    assert.ok(expenseHtml.includes(`margin-left: ${getIssuerLayout(expense.issuer, true).left}px;`));
    assert.ok(expenseHtml.indexOf('class="issuer-block"') < expenseHtml.indexOf('COMPROBANTE DE GASTO'));
    assert.ok(expenseHtml.indexOf('Fixture address') < expenseHtml.indexOf('class="expense-img"'));
    assert.equal(JSON.stringify(expense), before);
    pdfScenarios += 1;
  }
  for (const documentType of documentTypes) {
    const document = makeTransaction(documentType);
    const before = JSON.stringify(document);
    const oldHtml = await harness.render(document);
    assert.ok(oldHtml.indexOf('class="document-logo"') < oldHtml.indexOf('Fixture business'));
    assert.ok(oldHtml.includes('width: 85px;'));
    assert.equal(JSON.stringify(document), before);
    for (const logoUri of [undefined, 'https://example.com/logo.png']) {
      const html = await harness.render({ ...document, issuer: { ...document.issuer, logoUri } });
      assert.ok(!html.includes('class="document-logo"'));
    }
    const failedHtml = await harness.render(document, true);
    assert.ok(!failedHtml.includes('class="document-logo"'));
    const noQrHtml = await harness.render({ ...document, publicUrl: undefined, issuer: { ...document.issuer, logoPosition: 'bottom-right' } });
    assert.ok(!noQrHtml.includes('<div class="qr-section">'));
    assert.ok(noQrHtml.indexOf('class="document-logo"') < noQrHtml.indexOf('<div class="total-row">'));
    pdfScenarios += 5;
  }
  let currentIssuer = { ...oldIssuer };
  const updateSettings = vm.runInNewContext(compile(settingsChange.getText(syntax)), {
    setIssuer: update => { currentIssuer = update(currentIssuer); },
  });
  updateSettings({ logoPosition: 'bottom-left' });
  updateSettings({ logoSize: 'large' });
  updateSettings({ logoOffsetA4: { x: 0.37, y: 0.61 } });
  updateSettings({ logoOffsetTicket: { x: 1, y: 1 } });
  assert.equal(currentIssuer.logoUri, bitmap);
  assert.equal(currentIssuer.logoPosition, 'bottom-left');
  assert.equal(currentIssuer.logoSize, 'large');
  assert.equal(JSON.stringify(currentIssuer.logoOffsetA4), JSON.stringify({ x: 0.37, y: 0.61 }));
  assert.equal(JSON.stringify(currentIssuer.logoOffsetTicket), JSON.stringify({ x: 1, y: 1 }));
  assert.equal(JSON.stringify(transaction), snapshot);
  let stored;
  const saveContext = vm.createContext({
    isLoaded: true, issuer: currentIssuer, STORAGE_KEY_ISSUER: '@tpv_issuer_v1',
    storageScope: 'owner:owner', storageScopeRef: { current: 'owner:owner' }, loadedScopeRef: { current: 'owner:owner' },
    issuerLoadedScopeRef: { current: 'owner:owner' }, issuerWriteQueueRef: { current: Promise.resolve() },
    accountStorageKey: (key, scope) => `${key}:account:${scope}`,
    AsyncStorage: { setItem: async (key, value) => { stored = { key, value }; } },
    console,
  });
  saveContext.writeIssuerSettings = vm.runInContext(compileFunction('writeIssuerSettings'), saveContext);
  const saveIssuer = vm.runInContext(compile(persistence.getText(syntax)), saveContext);
  saveIssuer();
  await saveContext.issuerWriteQueueRef.current;
  assert.equal(stored.key, '@tpv_issuer_v1:account:owner:owner');
  assert.equal(stored.value, JSON.stringify(currentIssuer));
  const historical = Object.freeze({ ...makeTransaction('TICKET DE VENTA'), id: 'historical' });
  const unpublished = Object.freeze({ ...makeTransaction('FACTURA'), id: 'unpublished', publicUrl: undefined });
  let history = [historical, unpublished];
  const originalSnapshots = history.map(item => JSON.stringify(item.issuer));
  const publications = [];
  let publicationComplete;
  const publicationDone = new Promise(resolve => { publicationComplete = resolve; });
  const publishMissing = vm.runInNewContext(compile(publication.getText(syntax)), {
    isLoaded: true, accessToken: 'fixture-token', transactionsRef: { current: history }, issuer: currentIssuer,
    storageScope: 'owner:owner', storageScopeRef: { current: 'owner:owner' }, loadedScopeRef: { current: 'owner:owner' },
    cacheGenerationRef: { current: 0 },
    registerTransactionDocumentRef: { current: async document => { publications.push(document); return { ...document, publicUrl: 'https://example.com/published' }; } },
    setTransactions: update => { history = update(history); publicationComplete(); },
  });
  publishMissing();
  await publicationDone;
  assert.equal(publications.length, 1);
  assert.equal(publications[0], unpublished);
  assert.equal(history[0], historical);
  assert.equal(history[1].publicUrl, 'https://example.com/published');
  assert.deepEqual(history.map(item => JSON.stringify(item.issuer)), originalSnapshots);
  for (const name of ['pickLogoImage', 'captureLogoWithCamera']) {
    let options;
    const launch = async value => { options = value; return { canceled: true }; };
    const picker = vm.runInNewContext(compileFunction(name), {
      ImagePicker: {
        MediaTypeOptions: { Images: 'images' }, requestMediaLibraryPermissionsAsync: async () => ({ granted: true }),
        launchImageLibraryAsync: launch, launchCameraAsync: launch,
      },
      Camera: { requestCameraPermissionsAsync: async () => ({ granted: true }) },
    });
    await picker();
    assert.equal(options.allowsEditing, false);
    assert.equal(options.aspect, undefined);
  }
  const componentSource = fs.readFileSync(path.join(root, 'src/components/logo-settings.tsx'), 'utf8');
  const componentSyntax = ts.createSourceFile('logo-settings.tsx', componentSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.equal(componentSyntax.parseDiagnostics.length, 0);
  const inspect = node => {
    if (ts.isJsxText(node)) assert.ok(!/[A-Za-zÀ-ž]/.test(node.text), `Untranslated logo label: ${node.text}`);
    if (ts.isJsxAttribute(node) && ['accessibilityLabel', 'accessibilityHint'].includes(node.name.getText(componentSyntax))) {
      assert.ok(ts.isJsxExpression(node.initializer) && /^tr\(/.test(node.initializer.expression.getText(componentSyntax)));
    }
    ts.forEachChild(node, inspect);
  };
  inspect(componentSyntax);
  checkLogoControls();
  console.log(`${pdfScenarios} actual PDF template scenarios passed; 2 uncropped pickers, persisted settings and historical snapshots verified.`);
};

if (require.main === module) runIntegration().catch(error => { console.error(error); process.exitCode = 1; });