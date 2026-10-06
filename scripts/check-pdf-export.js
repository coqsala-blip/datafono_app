const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve('.');
const files = new Map();
const directories = new Set();
let copyFailure = false;
const fileSystem = {
  cacheDirectory: 'file:///cache/',
  makeDirectoryAsync: async (uri, options) => {
    assert.equal(options.intermediates, true);
    assert.ok(!directories.has(uri), 'Export directory reused');
    directories.add(uri);
  },
  copyAsync: async ({ from, to }) => {
    if (copyFailure) throw new Error('Copy failed');
    assert.ok(files.has(from), 'Missing source');
    assert.ok(!files.has(to), 'Previous export overwritten');
    files.set(to, Buffer.from(files.get(from)));
  },
};
const cache = new Map();
const loadModule = filePath => {
  if (cache.has(filePath)) return cache.get(filePath);
  const module = { exports: {} };
  const compiled = ts.transpileModule(fs.readFileSync(filePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(compiled, {
    module, exports: module.exports, Intl,
    Date: filePath.endsWith('pdf-export.ts') ? class extends Date { static now() { return 123456789; } } : Date,
    require: name => {
      if (name === 'expo-file-system/legacy') return fileSystem;
      assert.ok(name.startsWith('.'), `Unexpected dependency: ${name}`);
      return loadModule(path.resolve(path.dirname(filePath), `${name}.ts`));
    },
  });
  cache.set(filePath, module.exports);
  return module.exports;
};
const { buildPdfFilename, buildReportPdfFilename, copyPdfForExport } = loadModule(path.join(root, 'src/documents/pdf-export.ts'));

const checkHelper = async () => {
  assert.equal(buildPdfFilename(['Facture', 'FAC-123']), 'Facture_FAC-123.pdf');
  assert.equal(buildPdfFilename(['De\u0301penses', 'REF-1']), 'D\u00e9penses_REF-1.pdf');
  assert.equal(buildPdfFilename(['  A  B  ', 'file.PDF']), 'A_B_file.pdf');
  for (const unsafe of ['../..\\:<a>?*|\"\u0000\u202e', '', 'CON', 'prn', 'AUX', 'NUL', 'COM1', 'LPT9', 'COM\u00b9', 'LPT\u00b2']) {
    const filename = buildPdfFilename([unsafe]);
    assert.match(filename, /^[\p{L}\p{N}_-]+\.pdf$/u);
    assert.ok(!/^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])\.pdf$/i.test(filename));
  }
  for (const title of ['Long '.repeat(100), '\u00c9'.repeat(300), '\u{10400}'.repeat(300)]) {
    const filename = buildPdfFilename([title, 'FAC-123456']);
    assert.ok(Buffer.byteLength(filename) <= 180);
    assert.ok(filename.endsWith('_FAC-123456.pdf'));
  }
  const originalTimezone = process.env.TZ;
  try {
    for (const timezone of ['Europe/Madrid', 'Pacific/Auckland', 'America/Los_Angeles']) {
      process.env.TZ = timezone;
      assert.equal(buildReportPdfFilename('Report', new Date(2026, 0, 2), new Date(2026, 1, 3)), 'Report_2026-01-02_2026-02-03.pdf');
    }
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
  const source = 'file:///print/random.pdf';
  const original = Buffer.from([37, 80, 68, 70, 0, 255, 10]);
  files.set(source, original);
  const exports = await Promise.all(Array.from({ length: 100 }, () => copyPdfForExport(source, 'Facture_FAC-123.pdf')));
  assert.equal(new Set(exports).size, 100);
  for (const uri of exports) {
    assert.ok(uri.endsWith('/Facture_FAC-123.pdf'));
    assert.deepEqual(files.get(uri), original);
  }
  assert.deepEqual(files.get(source), original);
  const unsafeUri = await copyPdfForExport(source, '../../CON?.PDF');
  assert.ok(unsafeUri.endsWith('/PDF_CON.pdf'));
  copyFailure = true;
  await assert.rejects(copyPdfForExport(source, 'Invoice.pdf'), /Copy failed/);
  copyFailure = false;
  fileSystem.cacheDirectory = null;
  await assert.rejects(copyPdfForExport(source, 'Invoice.pdf'), /PDF export cache directory is unavailable/);
  fileSystem.cacheDirectory = 'file:///cache/';
  assert.deepEqual(files.get(source), original);
};

const { APP_LOCALES, t } = loadModule(path.join(root, 'src/i18n.ts'));
const { buildEmailedReport } = loadModule(path.join(root, 'src/reports/emailed-report.ts'));
const { renderDocumentLogo, renderIssuerBlock } = loadModule(path.join(root, 'src/documents/logo-layout.ts'));
const source = fs.readFileSync(path.join(root, 'src/app/index.tsx'), 'utf8');
const syntax = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
assert.equal(syntax.parseDiagnostics.length, 0);
const variables = new Map();
const collect = node => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) variables.set(node.name.text, node.initializer);
  ts.forEachChild(node, collect);
};
collect(syntax);
const compile = expression => ts.transpileModule(`(() => { const selected = ${expression}; return selected; })();`, {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText;
const extract = (name, context) => {
  assert.ok(variables.has(name), `Missing function: ${name}`);
  return vm.runInNewContext(compile(variables.get(name).getText(syntax)), context);
};
const issuer = { name: 'Fixture business', nif: 'B123', address: 'Address', managerEmail: 'manager@example.com', logoUri: 'data:image/png;base64,AAAA' };
const makeTransaction = documentType => ({
  id: 'fixture', ticketCode: 'REF-123', documentType, type: 'COBRO', amount: 12.1, subtotal: 10, iva: 2.1, ivaRateApplied: 21,
  createdAt: new Date(2026, 0, 3, 12).toISOString(), issuer, publicUrl: 'https://example.com/documents/fixture',
  client: { name: 'Client', nif: 'C123', address: 'Client address' }, items: [{ id: 'item', description: 'Product', price: '10' }],
  originalAmount: 15, refundHistory: [{ amount: 2.9, date: '2026-01-02T12:00:00Z' }],
});
const expense = { expenseCode: 'EXP-456', imageUri: 'data:image/jpeg;base64,AAAA', provider: 'Supplier', amount: 3, createdAt: new Date(2026, 0, 3, 12).toISOString() };
let printCounter = 0;
const createHarness = (locale, mailAvailable = true) => {
  const printed = [];
  const mailed = [];
  const shared = [];
  const alerts = [];
  const context = {
    appLocale: locale, translateKey: t, Date,
    buildPdfFilename, buildReportPdfFilename, copyPdfForExport, buildEmailedReport, renderDocumentLogo, renderIssuerBlock,
    issuer, transactions: [makeTransaction('FACTURA')], expenses: [expense],
    startDateInput: '2026-01-02', endDateInput: '2026-02-03',
    transactionStartDateInput: '2026-01-02', transactionEndDateInput: '2026-02-03',
    expenseStartDateInput: '2026-01-02', expenseEndDateInput: '2026-02-03',
    presupuestoClient: { name: 'Client', nif: 'C123', address: 'Client address' },
    presupuestoClientEmail: ' client@example.com ', presupuestoItems: [{ id: 'item', description: 'Product', price: '10' }],
    presupuestoIvaInput: '21', presupuestoDocumentType: 'PRESUPUESTO',
    requireSubscription: () => true,
    registerTransactionDocument: async transaction => transaction,
    resetQuoteForm() {},
    setCashInvoiceDrafts() {}, setManagerModalVisible() {}, setTransactionReportModalVisible() {}, setExpenseReportModalVisible() {},
    tr: key => t(context.appLocale, key),
    getTransactionQrUrl: () => 'https://example.com/qr.png',
    convertImageToBase64: async uri => { context.appLocale = locale === 'es' ? 'en' : 'es'; return uri; },
    formatCurrency: amount => `${amount.toFixed(2)} EUR`, formatDate: value => value,
    Print: { printToFileAsync: async options => {
      const uri = `file:///print/raw-${++printCounter}.pdf`;
      files.set(uri, Buffer.concat([Buffer.from('%PDF\u0000'), Buffer.from(options.html), Buffer.from([255])]));
      printed.push({ uri, html: options.html });
      context.appLocale = locale === 'es' ? 'en' : 'es';
      return { uri };
    } },
    MailComposer: {
      MailComposerStatus: { SENT: 'sent', SAVED: 'saved' },
      isAvailableAsync: async () => mailAvailable,
      composeAsync: async options => { mailed.push(options); return { status: 'sent' }; },
    },
    Sharing: { shareAsync: async (uri, options) => {
      assert.equal(options.UTI, '.pdf');
      assert.equal(options.mimeType, 'application/pdf');
      shared.push(uri);
    } },
    Alert: { alert: (...args) => alerts.push(args) }, console: { log() {} },
  };
  for (const name of ['documentTypeLabel', 'parseDateInput', 'ensurePublishedTransaction', 'generatePdfFileUri', 'generateExpensePdfUri', 'generateAndSharePdf', 'generateAndShareExpensePdf', 'sendByEmail', 'sendPresupuestoByEmail', 'sendManagerReportByEmail', 'sendCombinedReportByEmail', 'sendExpenseSpecificReport']) {
    context[name] = extract(name, context);
  }
  return { context, printed, mailed, shared, alerts };
};
const assertExport = (harness, uri, filename) => {
  const original = harness.printed[0];
  assert.notEqual(uri, original.uri);
  assert.ok(uri.endsWith(`/${filename}`), uri);
  assert.deepEqual(files.get(uri), files.get(original.uri));
  assert.ok(files.has(original.uri));
};
const assertUnchangedHtml = async (harness, functionName, input) => {
  const expression = variables.get(functionName).getText(syntax)
    .replace(/    const filename = [^\n]+\n/, '')
    .replace('return copyPdfForExport(uri, filename);', 'return uri;');
  const originalHtml = harness.printed[0].html;
  const generateOriginal = vm.runInNewContext(compile(expression), harness.context);
  await generateOriginal(input);
  assert.equal(harness.printed[1].html, originalHtml);
};
const checkIntegration = async () => {
  let scenarios = 0;
  const types = ['TICKET DE VENTA', 'FACTURA SIMPLIFICADA', 'FACTURA COMPLETA', 'TICKET DE DEVOLUCI\u00d3N', 'COMPRA/DEVOLUCIONES', 'PRESUPUESTO', 'FACTURA'];
  for (const { code: locale } of APP_LOCALES) {
    for (const documentType of types) {
      for (const method of ['generateAndSharePdf', 'sendByEmail']) {
        const harness = createHarness(locale);
        const transaction = makeTransaction(documentType);
        const label = harness.context.documentTypeLabel(documentType);
        assert.notEqual(label, undefined);
        await harness.context[method](transaction);
        assert.equal(harness.alerts.length, 0);
        const uri = method === 'sendByEmail' ? harness.mailed[0].attachments[0] : harness.shared[0];
        assertExport(harness, uri, buildPdfFilename([label, transaction.ticketCode]));
        if (method === 'sendByEmail') {
          assert.equal(harness.mailed[0].recipients[0], issuer.managerEmail);
          assert.equal(harness.mailed[0].subject, `${documentType} - Ref: REF-123`);
          assert.equal(harness.mailed[0].body, `Adjunto documento ${documentType} con referencia REF-123 por un importe de 12.10 EUR.`);
        }
        await assertUnchangedHtml(harness, 'generatePdfFileUri', transaction);
        scenarios += 1;
      }
    }
    const harness = createHarness(locale);
    await harness.context.generateAndShareExpensePdf(expense);
    assert.equal(harness.alerts.length, 0);
    assertExport(harness, harness.shared[0], buildPdfFilename([t(locale, 'expense.detail'), expense.expenseCode]));
    await assertUnchangedHtml(harness, 'generateExpensePdfUri', expense);
    scenarios += 1;
    for (const documentType of ['PRESUPUESTO', 'FACTURA']) {
      const quote = createHarness(locale);
      quote.context.presupuestoDocumentType = documentType;
      const label = quote.context.documentTypeLabel(documentType);
      await quote.context.sendPresupuestoByEmail();
      assert.equal(quote.mailed.length, 1);
      assert.equal(quote.mailed[0].recipients[0], 'client@example.com');
      const code = quote.printed[0].html.match(/Ref: <b>([^<]+)<\/b>/)[1];
      assertExport(quote, quote.mailed[0].attachments[0], buildPdfFilename([label, code]));
      scenarios += 1;
    }
    for (const [kind, method] of [['manager', 'sendManagerReportByEmail'], ['combined', 'sendCombinedReportByEmail'], ['expenses', 'sendExpenseSpecificReport']]) {
      for (const mailAvailable of [true, false]) {
        const report = createHarness(locale, mailAvailable);
        await report.context[method]();
        assert.equal(report.alerts.length, 0, `${locale}/${kind}/${mailAvailable}: ${JSON.stringify(report.alerts)}`);
        const uri = mailAvailable ? report.mailed[0].attachments[0] : report.shared[0];
        assertExport(report, uri, buildReportPdfFilename(t(locale, `emailReport.${kind}.title`), new Date(2026, 0, 2), new Date(2026, 1, 3)));
        assert.ok(report.printed[0].html.includes(`<html lang="${locale}">`));
        if (mailAvailable) assert.equal(report.mailed[0].recipients[0], issuer.managerEmail);
        scenarios += 1;
      }
    }
  }
  for (const failure of ['copy', 'cache']) {
    for (const method of ['generateAndSharePdf', 'sendByEmail', 'sendPresupuestoByEmail', 'generateAndShareExpensePdf', 'sendManagerReportByEmail', 'sendCombinedReportByEmail', 'sendExpenseSpecificReport']) {
      const harness = createHarness('es');
      copyFailure = failure === 'copy';
      fileSystem.cacheDirectory = failure === 'cache' ? null : 'file:///cache/';
      await harness.context[method](method === 'generateAndShareExpensePdf' ? expense : makeTransaction('FACTURA'));
      assert.equal(harness.mailed.length + harness.shared.length, 0);
      assert.equal(harness.alerts.length, 1);
      assert.ok(files.has(harness.printed[0].uri));
      scenarios += 1;
    }
  }
  copyFailure = false;
  fileSystem.cacheDirectory = 'file:///cache/';
  return scenarios;
};

checkHelper().then(checkIntegration).then(scenarios => {
  console.log(`PDF export: safe Unicode names, 180-byte limit, 3 local timezones, preserved bytes, 100 concurrent copies at a fixed timestamp and propagated errors passed; ${scenarios} real export scenarios in 8 languages passed (documents, quotes, expenses, reports, Sharing/MailComposer, async locale changes, unchanged HTML and failed copies/cache).`);
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});