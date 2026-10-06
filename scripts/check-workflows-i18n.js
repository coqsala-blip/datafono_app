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
    require: (name) => loadModule(path.resolve(path.dirname(filePath), `${name}.ts`)),
  }, { filename: filePath });
  return module.exports;
};

const { workflowTranslations } = loadModule(path.join(root, 'src/translations/workflows.ts'));
const { t, APP_LOCALES, formatCurrencyForLocale } = loadModule(path.join(root, 'src/i18n.ts'));
const keys = Object.keys(workflowTranslations.es).sort();
const placeholders = (value) => Array.from(value.matchAll(/\{\w+\}/g), (match) => match[0]).sort();
for (const { code } of APP_LOCALES) {
  const dictionary = workflowTranslations[code];
  assert.deepEqual(Object.keys(dictionary).sort(), keys, `Missing keys: ${code}`);
  for (const key of keys) {
    assert.ok(dictionary[key].trim(), `Empty translation: ${code}/${key}`);
    assert.deepEqual(placeholders(dictionary[key]), placeholders(workflowTranslations.es[key]), `${code}/${key}`);
    assert.equal(t(code, key), dictionary[key], `Fallback used: ${code}/${key}`);
    const rendered = dictionary[key].replace(/\{\w+\}/g, '123');
    assert.ok(!/\{\w+\}/.test(rendered));
  }
}
assert.equal(t('en', 'document.quote'), 'Quote');
assert.equal(t('pl', 'workflow.generalClient'), 'Klient ogólny');
assert.equal(t('fr', 'unknown.workflow.key'), 'unknown.workflow.key');

const source = fs.readFileSync(path.join(root, 'src/app/index.tsx'), 'utf8');
const syntax = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
assert.equal(syntax.parseDiagnostics.length, 0, 'Invalid TSX syntax');
const variables = new Map();
const collect = (node) => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) variables.set(node.name.text, node);
  ts.forEachChild(node, collect);
};
collect(syntax);
const checkTerminalMessages = (node) => {
  if (ts.isCallExpression(node) && node.expression.getText(syntax) === 'setTerminalMessage' && ts.isStringLiteral(node.arguments[0])) {
    for (const { code } of APP_LOCALES) {
      assert.notEqual(t(code, node.arguments[0].text), node.arguments[0].text, 'Untranslated terminal status');
    }
  }
  ts.forEachChild(node, checkTerminalMessages);
};
checkTerminalMessages(syntax);
const start = source.indexOf("{activeTab === 'gastos_facturacion' && (");
const end = source.indexOf("{activeTab === 'stats' && (", start);
assert.ok(start >= 0 && end > start, 'Missing main tab boundaries');
const history = variables.get('TransactionHistory');
assert.ok(history);
const requestedModals = new Set([
  'scannerModalVisible', 'nfcModalVisible', 'onlinePaymentModalVisible', 'clientModalVisible',
  'selectedTicket', 'selectedExpense', 'transactionReportModalVisible', 'periodDetails', 'expenseReportModalVisible',
]);
const foundModals = new Set();
const letters = /\p{L}/u;
const inspectDisplay = (expression) => {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    assert.ok(!letters.test(expression.text), `Untranslated expression: ${expression.text}`);
  } else if (ts.isConditionalExpression(expression)) {
    inspectDisplay(expression.whenTrue);
    inspectDisplay(expression.whenFalse);
  } else if (ts.isBinaryExpression(expression)) {
    if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      inspectDisplay(expression.right);
    } else if ([ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.PlusToken].includes(expression.operatorToken.kind)) {
      inspectDisplay(expression.left);
      inspectDisplay(expression.right);
    }
  } else if (ts.isTemplateExpression(expression)) {
    assert.ok(!letters.test(expression.head.text), 'Untranslated template');
    for (const span of expression.templateSpans) {
      assert.ok(!letters.test(span.literal.text), 'Untranslated template');
      inspectDisplay(span.expression);
    }
  } else if (ts.isPropertyAccessExpression(expression)) {
    assert.notEqual(expression.name.text, 'documentType', 'Raw internal document type rendered');
  }
};
const inspect = (node) => {
  if (ts.isJsxText(node)) assert.ok(!letters.test(node.text), `Untranslated JSX: ${node.text.trim()}`);
  if (ts.isJsxAttribute(node) && ['placeholder', 'accessibilityLabel'].includes(node.name.getText(syntax))) {
    assert.ok(!node.initializer || !ts.isStringLiteral(node.initializer), 'Untranslated field label');
    if (node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
      inspectDisplay(node.initializer.expression);
    }
  }
  if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
    inspectDisplay(node.expression);
  }
  if (ts.isCallExpression(node) && node.expression.getText(syntax) === 'tr') {
    for (const argument of node.arguments) {
      const checkKey = (keyNode) => {
        if (ts.isStringLiteral(keyNode)) {
          for (const { code } of APP_LOCALES) assert.notEqual(t(code, keyNode.text), keyNode.text, `Unknown key: ${keyNode.text}`);
        } else if (ts.isConditionalExpression(keyNode)) {
          checkKey(keyNode.whenTrue);
          checkKey(keyNode.whenFalse);
        }
      };
      checkKey(argument);
    }
  }
  ts.forEachChild(node, inspect);
};
const visit = (node) => {
  if (node.getStart(syntax) >= start && node.end <= end && ts.isJsxElement(node)) {
    inspect(node);
    return;
  }
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(syntax) === 'Modal') {
    const visible = node.openingElement.attributes.properties.find((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(syntax) === 'visible');
    const text = visible?.initializer?.getText(syntax) || '';
    for (const name of requestedModals) {
      if (new RegExp(`\\b${name}\\b`).test(text)) {
        foundModals.add(name);
        inspect(node);
        return;
      }
    }
  }
  ts.forEachChild(node, visit);
};
inspect(history.initializer);
visit(syntax);
assert.deepEqual([...foundModals].sort(), [...requestedModals].sort());

const expectedTypes = [
  'TICKET DE VENTA', 'FACTURA SIMPLIFICADA', 'FACTURA COMPLETA', 'TICKET DE DEVOLUCIÓN',
  'COMPRA/DEVOLUCIONES', 'PRESUPUESTO', 'FACTURA',
];
const documentType = syntax.statements.find((node) => ts.isTypeAliasDeclaration(node) && node.name.text === 'DocumentType');
assert.deepEqual(documentType.type.types.map((node) => node.literal.text), expectedTypes);
const label = variables.get('documentTypeLabel').initializer;
const compiledLabel = ts.transpileModule(`const label = ${label.getText(syntax)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText;
for (const { code } of APP_LOCALES) {
  const translateLabel = vm.runInNewContext(`${compiledLabel}\nlabel;`, { tr: (key) => t(code, key) });
  for (const [index, type] of expectedTypes.entries()) {
    const key = ['document.sale', 'document.simplified', 'document.complete', 'document.refund', 'document.purchaseRefunds', 'document.quote', 'document.invoice'][index];
    assert.equal(translateLabel(type), t(code, key));
  }
  for (const name of ['formatUiCurrency', 'formatUiDate']) {
    const compiled = ts.transpileModule(`const formatter = ${variables.get(name).initializer.getText(syntax)};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const formatter = vm.runInNewContext(`${compiled}\nformatter;`, { appLocale: code, formatCurrencyForLocale, Intl });
    assert.equal(formatter(name === 'formatUiCurrency' ? 1234.56 : '2026-10-04T12:00:00Z'), name === 'formatUiCurrency'
      ? formatCurrencyForLocale(code, 1234.56)
      : new Intl.DateTimeFormat(code, { dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' }).format(new Date('2026-10-04T12:00:00Z')));
  }
}
assert.ok(source.includes("startPayment('TICKET DE VENTA')"));
assert.ok(source.includes("setPresupuestoDocumentType('PRESUPUESTO')"));
assert.ok(source.includes("documentType: presupuestoDocumentType"));
console.log(`${keys.length} workflow keys validated in ${APP_LOCALES.length} languages; tabs, history and ${foundModals.size} modals localized; internal types preserved.`);