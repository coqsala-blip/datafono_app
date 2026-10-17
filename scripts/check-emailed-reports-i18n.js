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
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(compiled, {
    module, exports: module.exports, Intl, Date,
    require: (name) => {
      if (name === 'expo-file-system/legacy') return {};
      assert.ok(name.startsWith('.'), `Unexpected runtime dependency: ${name}`);
      return loadModule(path.resolve(path.dirname(filePath), `${name}.ts`));
    },
  }, { filename: filePath });
  return module.exports;
};

const { emailedReportsTranslations } = loadModule(path.join(root, 'src/translations/emailed-reports.ts'));
const { APP_LOCALES, t, formatCurrencyForLocale } = loadModule(path.join(root, 'src/i18n.ts'));
const { buildEmailedReport, resolveReportTaxLine } = loadModule(path.join(root, 'src/reports/emailed-report.ts'));
const { buildReportPdfFilename } = loadModule(path.join(root, 'src/documents/pdf-export.ts'));
const keys = Object.keys(emailedReportsTranslations.es).sort();
const placeholders = (value) => Array.from(value.matchAll(/\{\w+\}/g), match => match[0]).sort();
const input = {
  issuer: { name: 'Atelier <Nord> & "Co" \'Élodie\' {range}', nif: 'ID<&>' },
  range: { start: new Date(2026, 0, 2), end: new Date(2026, 1, 3) },
  transactions: [
    { ticketCode: 'SALE<&>', createdAt: '2026-01-02T12:00:00Z', type: 'COBRO', client: { name: 'Zoë <Client> & "A"' }, amount: 71.23, originalAmount: 123.45, subtotal: 58.87, iva: 12.36, ivaRateApplied: 21 },
    { ticketCode: 'REFUND', createdAt: '2026-02-03T12:00:00Z', type: 'DEVOLUCIÓN', amount: 19.87, originalAmount: 999, subtotal: 16.42, iva: 3.45, ivaRateApplied: 21 },
    { ticketCode: 'SALE2', createdAt: '2026-01-03T12:00:00Z', type: 'COBRO', amount: 8.76, subtotal: 7.24, iva: 1.52, ivaRateApplied: 10 },
  ],
  expenses: [{ expenseCode: 'EXP<&>', createdAt: '2026-01-04T12:00:00Z', provider: 'Müller <Supply> & \'Sons\'', amount: 45.67 }],
  totals: { income: 132.21, refunds: 72.09, expenses: 45.67, netIncome: 60.12, netBalance: 14.45 },
};
const before = JSON.stringify(input);
const expectedTitles = {
  en: ['COMBINED RECEIPTS, INVOICES AND EXPENSES REPORT', 'BILLING AND EXPENSES REPORT FOR YOUR ACCOUNTANT', 'EXPENSES AND BILLING REPORT'],
  fr: ['RAPPORT CONSOLIDÉ DES TICKETS, FACTURES ET DÉPENSES', 'RAPPORT DE FACTURATION ET DE DÉPENSES POUR VOTRE COMPTABLE', 'RAPPORT DE DÉPENSES ET DE FACTURATION'],
};
for (const { code: locale } of APP_LOCALES) {
  const dictionary = emailedReportsTranslations[locale];
  assert.deepEqual(Object.keys(dictionary).sort(), keys, `Missing keys: ${locale}`);
  for (const key of keys) {
    assert.ok(dictionary[key].trim(), `Empty translation: ${locale}/${key}`);
    assert.deepEqual(placeholders(dictionary[key]), placeholders(emailedReportsTranslations.es[key]), `${locale}/${key}`);
    assert.equal(t(locale, key), dictionary[key], `Fallback used: ${locale}/${key}`);
  }
  const currency = amount => formatCurrencyForLocale(locale, amount);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'long' });
  for (const [index, kind] of ['combined', 'manager', 'expenses'].entries()) {
    const report = buildEmailedReport({ ...input, locale, kind });
    assert.ok(report.html.includes(`<html lang="${locale}">`));
    assert.ok(report.html.includes('Atelier &lt;Nord&gt; &amp; &quot;Co&quot; &#39;Élodie&#39; {range}'));
    assert.ok(report.html.includes('ID&lt;&amp;&gt;'));
    assert.ok(report.subject.endsWith(input.issuer.name));
    assert.ok(report.body.endsWith(input.issuer.name));
    for (const field of ['html', 'subject', 'body']) {
      assert.ok(report[field].includes(date.format(input.range.start)), `${locale}/${kind}/${field}: start date`);
      assert.ok(report[field].includes(date.format(input.range.end)), `${locale}/${kind}/${field}: end date`);
      assert.ok(!/\{(?:issuer|start|end|count)\}/.test(report[field]));
    }
    assert.equal((report.html.match(/<table>/g) || []).length, kind === 'expenses' ? 1 : 2);
    assert.equal((report.html.match(/<tr>/g) || []).length, kind === 'expenses' ? 2 : 6);
    assert.ok(report.html.includes('<td>EXP&lt;&amp;&gt;</td>'));
    assert.ok(report.html.includes('Müller &lt;Supply&gt; &amp; &#39;Sons&#39;'));
    assert.ok(report.html.includes(`<td>${currency(45.67)}</td>`));
    assert.ok(report.html.includes(`<strong>${t(locale, kind === 'expenses' ? 'emailReport.periodExpenses' : 'emailReport.expenseTotal')}:</strong> ${currency(input.totals.expenses)}`));
    assert.ok(report.html.includes(t(locale, 'legal.disclaimer')));
    if (kind !== 'expenses') {
      assert.ok(report.html.includes('Zoë &lt;Client&gt; &amp; &quot;A&quot;'));
      assert.ok(report.html.includes(`<td>${t(locale, 'emailReport.charge')}</td>`));
      assert.ok(report.html.includes(`<td>${t(locale, 'emailReport.refund')}</td>`));
      assert.ok(report.html.includes(`<th>${t(locale, 'ticket.taxBase')}</th>`));
      assert.ok(report.html.includes(`<th>${t(locale, 'emailReport.vatRate')}</th>`));
      assert.ok(report.html.includes(`<th>${t(locale, 'emailReport.vatAmount')}</th>`));
      assert.ok(report.html.includes('<td>21%</td>'));
      assert.ok(report.html.includes('<td>10%</td>'));
      const sale = resolveReportTaxLine(input.transactions[0], kind);
      const refund = resolveReportTaxLine(input.transactions[1], kind);
      const sale2 = resolveReportTaxLine(input.transactions[2], kind);
      assert.ok(report.html.includes(`<td>${currency(sale.total)}</td>`));
      assert.ok(report.html.includes(`<td>${currency(refund.total)}</td>`));
      assert.ok(report.html.includes(`<td>${currency(sale2.total)}</td>`));
      assert.ok(report.html.includes(`<td>${currency(sale.taxBase)}</td>`));
      assert.ok(report.html.includes(`<td>${currency(sale.vatAmount)}</td>`));
      assert.ok(report.html.includes(`<td>${t(locale, 'workflow.generalClient')}</td>`));
      const periodTaxBase = Math.round((sale.taxBase - refund.taxBase + sale2.taxBase) * 100) / 100;
      const periodVat = Math.round((sale.vatAmount - refund.vatAmount + sale2.vatAmount) * 100) / 100;
      for (const [key, amount] of [
        ['emailReport.income', 132.21],
        ['emailReport.refunds', 72.09],
        ['emailReport.taxBaseTotal', periodTaxBase],
        ['emailReport.vatTotal', periodVat],
        [kind === 'manager' ? 'emailReport.netBalance' : 'report.totalVat', 14.45],
      ]) {
        assert.ok(report.html.includes(`<strong>${t(locale, key)}:</strong> ${currency(amount)}`), `${locale}/${kind}/${key}`);
      }
      if (kind === 'manager') assert.ok(report.html.includes(`<strong>${t(locale, 'emailReport.netIncome')}:</strong> ${currency(60.12)}`));
    }
    assert.ok(report.html.includes(new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' }).format(new Date(input.expenses[0].createdAt))));
    for (const hour of [0, 13, 14, 23]) {
      const instant = new Date(2026, 0, 4, hour, 5);
      const formatter = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' });
      const parts = formatter.formatToParts(instant);
      assert.equal(Number(parts.find(part => part.type === 'hour').value), hour);
      assert.ok(!parts.some(part => part.type === 'dayPeriod'));
      const hourlyReport = buildEmailedReport({
        ...input, locale, kind,
        expenses: [{ ...input.expenses[0], createdAt: instant.toISOString() }],
      });
      assert.ok(hourlyReport.html.includes(formatter.format(instant)), `${locale}/${kind}: ${hour}:05 missing`);
    }
    if (expectedTitles[locale]) {
      assert.ok(report.html.includes(`<h1>${expectedTitles[locale][index]}</h1>`));
      assert.ok(report.html.includes(`<th>${locale === 'en' ? 'Supplier' : 'Fournisseur'}</th>`));
      assert.ok(report.html.includes(locale === 'en' ? 'January' : 'janvier'));
      assert.ok(report.subject.startsWith(locale === 'en' ? (kind === 'combined' ? 'Combined report' : kind === 'manager' ? 'Billing and expenses report' : 'Expense report') : (kind === 'combined' ? 'Rapport consolidé' : kind === 'manager' ? 'Rapport de facturation' : 'Rapport de dépenses')));
      assert.ok(report.body.startsWith(locale === 'en' ? 'Attached is' : 'Veuillez trouver ci-joint'));
      assert.ok(!/INFORME|Periodo:|Emisor:|Proveedor|Importe|COBRO|DEVOLUCIÓN|Atentamente|Adjunto|Sin transacciones|Sin gastos/.test(report.html + report.subject + report.body));
    }
    const empty = buildEmailedReport({ ...input, locale, kind, transactions: [], expenses: [] });
    assert.equal((empty.html.match(/<tr>/g) || []).length, kind === 'combined' ? 4 : kind === 'manager' ? 2 : 1);
    if (kind === 'combined') {
      assert.ok(empty.html.includes(`<td colspan="8">${t(locale, 'emailReport.noTransactions')}</td>`));
      assert.ok(empty.html.includes(`<td colspan="4">${t(locale, 'emailReport.noExpenses')}</td>`));
      for (const missing of ['transactions', 'expenses']) {
        const partial = buildEmailedReport({ ...input, locale, kind, [missing]: [] });
        assert.ok(partial.html.includes(t(locale, missing === 'transactions' ? 'emailReport.noTransactions' : 'emailReport.noExpenses')));
      }
    }
  }
}
assert.equal(JSON.stringify(input), before, 'Generator mutated report inputs');

const source = fs.readFileSync(path.join(root, 'src/app/index.tsx'), 'utf8');
const syntax = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
assert.equal(syntax.parseDiagnostics.length, 0, 'Invalid TSX syntax');
const variables = new Map();
const collect = node => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) variables.set(node.name.text, node.initializer);
  ts.forEachChild(node, collect);
};
collect(syntax);
const compileFunction = name => {
  assert.ok(variables.has(name), `Missing function: ${name}`);
  return ts.transpileModule(`const selected = ${variables.get(name).getText(syntax)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText + '\nselected;';
};
const parseDateInput = vm.runInNewContext(compileFunction('parseDateInput'), { Date });
const functions = {
  manager: compileFunction('sendManagerReportByEmail'),
  combined: compileFunction('sendCombinedReportByEmail'),
  expenses: compileFunction('sendExpenseSpecificReport'),
};
const checkSendFunctions = async () => {
  for (const { code: locale } of APP_LOCALES) {
    for (const kind of Object.keys(functions)) {
      for (const scenario of ['mail', 'share', 'error', 'empty', 'missing', 'invalid', 'reversed']) {
        const alerts = [];
        const generated = [];
        const printed = [];
        const mailed = [];
        const shared = [];
        const closed = [];
        const validStart = '02/01/2026';
        const validEnd = '2026-02-03';
        const startInput = scenario === 'missing' ? ' ' : scenario === 'invalid' ? 'not-a-date' : scenario === 'reversed' ? '04/02/2026' : validStart;
        const transactions = scenario === 'empty' ? [] : [
          { ...input.transactions[0], refundHistory: [{ amount: 52.22, date: '2026-01-05T12:00:00Z' }] },
          ...input.transactions.slice(1),
          { ...input.transactions[0], ticketCode: 'OUTSIDE', createdAt: '2025-12-31T12:00:00Z', amount: 5000 },
        ];
        const expenses = scenario === 'empty' ? [] : [
          ...input.expenses,
          { ...input.expenses[0], expenseCode: 'LASTDAY', createdAt: new Date(2026, 1, 3, 23, 59, 59, 999).toISOString(), amount: 2.34 },
          { ...input.expenses[0], expenseCode: 'OUTSIDE', createdAt: new Date(2026, 1, 4).toISOString(), amount: 5000 },
        ];
        const context = {
          buildReportPdfFilename,
          copyPdfForExport: async (uri, filename) => {
            assert.equal(uri, 'report.pdf');
            assert.equal(filename, buildReportPdfFilename(t(locale, `emailReport.${kind}.title`), parseDateInput(validStart), parseDateInput(validEnd)));
            return `file:///export/${filename}`;
          },
          appLocale: locale, translateKey: t, parseDateInput, Date, transactions, expenses, issuer: input.issuer,
          isSalesHistoryDocument: () => true,
          startDateInput: startInput, endDateInput: validEnd,
          transactionStartDateInput: startInput, transactionEndDateInput: validEnd,
          expenseStartDateInput: startInput, expenseEndDateInput: validEnd,
          requireSubscription: feature => {
            assert.equal(feature, t(locale, `emailReport.${kind}.feature`));
            return true;
          },
          Alert: { alert: (...args) => alerts.push(args) },
          buildEmailedReport: data => {
            const result = buildEmailedReport(data);
            generated.push({ data, result });
            return result;
          },
          Print: { printToFileAsync: async options => {
            printed.push(options);
            context.appLocale = locale === 'es' ? 'en' : 'es';
            if (scenario === 'error') throw new Error('Print failed');
            return { uri: 'report.pdf' };
          } },
          MailComposer: {
            isAvailableAsync: async () => scenario !== 'share',
            composeAsync: async options => mailed.push(options),
          },
          Sharing: { shareAsync: async (uri, options) => {
            assert.equal(options.UTI, '.pdf');
            assert.equal(options.mimeType, 'application/pdf');
            shared.push(uri);
          } },
          setManagerModalVisible: value => closed.push(value),
          setTransactionReportModalVisible: value => closed.push(value),
          setExpenseReportModalVisible: value => closed.push(value),
        };
        const send = vm.runInNewContext(functions[kind], context);
        await send();
        const tag = `${locale}/${kind}/${scenario}`;
        if (['empty', 'missing', 'invalid', 'reversed'].includes(scenario)) {
          assert.equal(generated.length, 0, tag);
          assert.equal(printed.length, 0, tag);
          assert.equal(alerts.length, 1, tag);
          const expected = scenario === 'empty'
            ? kind === 'expenses' ? ['report.expenses', 'report.noExpenses'] : ['emailReport.emptyTitle', `emailReport.${kind}.empty`]
            : kind !== 'manager' ? ['validation.error', 'validation.dates']
              : scenario === 'missing' ? ['emailReport.datesRequiredTitle', 'emailReport.datesRequired']
                : scenario === 'invalid' ? ['emailReport.invalidDateTitle', 'emailReport.invalidDate']
                  : ['emailReport.invalidRangeTitle', 'emailReport.invalidRange'];
          assert.deepEqual(alerts[0], expected.map(key => t(locale, key)), tag);
          continue;
        }
        assert.equal(generated.length, 1, tag);
        const { data, result } = generated[0];
        assert.equal(data.locale, locale, tag);
        assert.equal(data.kind, kind, tag);
        assert.equal(data.transactions.length, kind === 'expenses' ? 0 : 3, tag);
        assert.equal(data.expenses.length, 2, tag);
        assert.equal(data.range.start.getTime(), parseDateInput(validStart).getTime(), tag);
        assert.equal(data.range.end.getTime(), parseDateInput(validEnd).getTime(), tag);
        assert.ok(Math.abs(data.totals.expenses - 48.01) < 1e-9, tag);
        if (kind !== 'expenses') {
          assert.ok(Math.abs(data.totals.income - 132.21) < 1e-9, tag);
          assert.ok(Math.abs(data.totals.refunds - 72.09) < 1e-9, tag);
          assert.ok(Math.abs(data.totals.netIncome - 60.12) < 1e-9, tag);
          assert.ok(Math.abs(data.totals.netBalance - 12.11) < 1e-9, tag);
        }
        assert.equal(printed[0].html, result.html, tag);
        if (scenario === 'error') {
          assert.deepEqual(alerts[0], [t(locale, 'validation.error'), t(locale, `emailReport.${kind}.error`)], tag);
          assert.equal(mailed.length, 0, tag);
          assert.equal(closed.length, 0, tag);
        } else if (scenario === 'share') {
          assert.deepEqual(shared, [`file:///export/${buildReportPdfFilename(t(locale, `emailReport.${kind}.title`), data.range.start, data.range.end)}`], tag);
          assert.equal(mailed.length, 0, tag);
          assert.equal(closed.length, 0, tag);
        } else {
          assert.equal(mailed.length, 1, tag);
          assert.equal(mailed[0].subject, result.subject, tag);
          assert.equal(mailed[0].body, result.body, tag);
          assert.equal(mailed[0].attachments[0], `file:///export/${buildReportPdfFilename(t(locale, `emailReport.${kind}.title`), data.range.start, data.range.end)}`, tag);
          assert.equal(mailed[0].recipients[0], '', tag);
          assert.deepEqual(closed, [false], tag);
          assert.equal(alerts.length, 0, tag);
        }
      }
    }
  }
};
checkSendFunctions().then(() => {
  console.log(`${keys.length} email report keys validated in 8 languages; 3 report kinds, dates, money, refunds, empty tables and HTML escaping verified; 168 real send-function scenarios passed.`);
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});