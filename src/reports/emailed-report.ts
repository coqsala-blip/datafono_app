import type { AppLocale } from '../i18n';
import { formatCurrencyForLocale, t } from '../i18n';

export type EmailedReportKind = 'combined' | 'manager' | 'expenses';

export type EmailedReportInput = {
  locale: AppLocale;
  kind: EmailedReportKind;
  issuer: { name: string; nif: string };
  range: { start: Date; end: Date };
  transactions: readonly {
    ticketCode: string;
    createdAt: string;
    type: 'COBRO' | 'DEVOLUCIÓN';
    client?: { name: string };
    amount: number;
    originalAmount?: number;
  }[];
  expenses: readonly { expenseCode: string; createdAt: string; provider: string; amount: number }[];
  totals: { income: number; refunds: number; expenses: number; netIncome: number; netBalance: number };
};

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]!);

export const buildEmailedReport = (input: EmailedReportInput): { html: string; subject: string; body: string } => {
  const { locale, kind, issuer, range, transactions, expenses, totals } = input;
  const translate = (key: string, values: Record<string, string | number> = {}) =>
    t(locale, key).replace(/\{(\w+)\}/g, (placeholder, name: string) => String(values[name] ?? placeholder));
  const text = (key: string, values: Record<string, string | number> = {}) => escapeHtml(translate(key, values));
  const currency = (amount: number) => escapeHtml(formatCurrencyForLocale(locale, amount));
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'long' });
  const timestamp = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' });
  const period = translate('report.range', { start: date.format(range.start), end: date.format(range.end) });
  const summaryLine = (key: string, value: string) => `<strong>${text(key)}:</strong> ${value}<br/>`;
  const summary = kind === 'expenses'
    ? summaryLine('emailReport.periodExpenses', currency(totals.expenses)) + summaryLine('emailReport.records', String(expenses.length))
    : summaryLine('emailReport.income', currency(totals.income))
      + summaryLine('emailReport.refunds', currency(totals.refunds))
      + summaryLine('emailReport.expenseTotal', currency(totals.expenses))
      + (kind === 'manager'
        ? summaryLine('emailReport.netIncome', currency(totals.netIncome)) + summaryLine('emailReport.netBalance', currency(totals.netBalance))
        : summaryLine('report.totalVat', currency(totals.netBalance)));
  const headers = (keys: string[]) => `<tr>${keys.map(key => `<th>${text(key)}</th>`).join('')}</tr>`;
  const transactionRows = transactions.map(transaction => `<tr>
    <td>${escapeHtml(transaction.ticketCode)}</td>
    <td>${escapeHtml(timestamp.format(new Date(transaction.createdAt)))}</td>
    <td>${text(transaction.type === 'COBRO' ? 'emailReport.charge' : 'emailReport.refund')}</td>
    <td>${escapeHtml(transaction.client?.name || translate('workflow.generalClient'))}</td>
    <td>${currency(kind === 'manager' && transaction.type === 'COBRO' ? (transaction.originalAmount ?? transaction.amount) : transaction.amount)}</td>
  </tr>`).join('');
  const expenseRows = expenses.map(expense => `<tr>
    <td>${escapeHtml(expense.expenseCode)}</td>
    <td>${escapeHtml(timestamp.format(new Date(expense.createdAt)))}</td>
    <td>${escapeHtml(expense.provider)}</td>
    <td>${currency(expense.amount)}</td>
  </tr>`).join('');
  const html = `
    <!DOCTYPE html>
    <html lang="${locale}">
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Helvetica, Arial, sans-serif; padding: 20px; color: #1e293b; }
          h1 { font-size: 20px; text-align: center; color: #0f172a; }
          h2 { font-size: 14px; border-bottom: 2px solid #cbd5e1; padding-bottom: 4px; margin-top: 20px; }
          .summary { background: #f8fafc; padding: 12px; border-radius: 6px; margin-bottom: 20px; }
          table { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 10px; }
          th, td { border: 1px solid #cbd5e1; padding: 6px 8px; text-align: left; }
          th { background: #e2e8f0; font-weight: bold; }
        </style>
      </head>
      <body>
        <h1>${escapeHtml(translate(`emailReport.${kind}.title`).toLocaleUpperCase(locale))}</h1>
        <p style="text-align: center; font-size: 12px; color: #64748b;">${text('emailReport.period', { range: period })}</p>
        ${kind === 'manager' ? `<p style="text-align: center; font-size: 10px; color: #64748b;">${text('emailReport.disclaimer')}</p>` : ''}
        <div class="summary">
          <strong>${text('emailReport.issuer')}:</strong> ${escapeHtml(issuer.name)} (${text('workflow.taxId')}: ${escapeHtml(issuer.nif)})<br/>
          ${summary}
        </div>
        ${kind === 'expenses' ? '' : `
          <h2>${escapeHtml(translate(kind === 'manager' ? 'emailReport.transactions' : 'report.documents', { count: transactions.length }).toLocaleUpperCase(locale))}</h2>
          <table>
            ${headers(['workflow.reference', 'workflow.date', 'workflow.type', 'workflow.client', 'workflow.amount'])}
            ${transactionRows || (kind === 'combined' ? `<tr><td colspan="5">${text('emailReport.noTransactions')}</td></tr>` : '')}
          </table>`}
        <h2>${escapeHtml(translate(kind === 'expenses' ? 'emailReport.expenseList' : 'emailReport.expenses', { count: expenses.length }).toLocaleUpperCase(locale))}</h2>
        <table>
          ${headers(['workflow.reference', 'workflow.date', 'workflow.provider', 'workflow.amount'])}
          ${expenseRows || (kind === 'combined' ? `<tr><td colspan="4">${text('emailReport.noExpenses')}</td></tr>` : '')}
        </table>
      </body>
    </html>
  `;
  const emailValues = { range: period, issuer: issuer.name };
  return {
    html,
    subject: translate(`emailReport.${kind}.subject`, emailValues),
    body: translate(`emailReport.${kind}.body`, emailValues),
  };
};