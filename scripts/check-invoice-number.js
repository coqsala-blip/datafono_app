const assert = require('assert');

const parseInvoiceNumber = (code) => {
  const match = String(code || '').trim().match(/^(\d{4})-(\d+)$/);
  if (!match) return null;
  const year = Number(match[1]);
  const sequence = Number(match[2]);
  if (!Number.isFinite(year) || !Number.isFinite(sequence) || sequence < 1) return null;
  return { year, sequence };
};

const formatInvoiceNumber = (year, sequence) => `${year}-${String(sequence).padStart(6, '0')}`;

const maxInvoiceSequenceForYear = (codes, year) => {
  let max = 0;
  for (const code of codes) {
    const parsed = parseInvoiceNumber(code);
    if (parsed && parsed.year === year) max = Math.max(max, parsed.sequence);
  }
  return max;
};

const allocateNextInvoiceNumber = ({ year, existingCodes, lastIssuedByYear }) => {
  const key = String(year);
  const next = Math.max(maxInvoiceSequenceForYear(existingCodes, year), lastIssuedByYear[key] ?? 0) + 1;
  return { ticketCode: formatInvoiceNumber(year, next), lastIssuedByYear: { ...lastIssuedByYear, [key]: next } };
};

assert.strictEqual(formatInvoiceNumber(2026, 1), '2026-000001');
assert.strictEqual(parseInvoiceNumber('TK-123150-RNSH'), null);
assert.strictEqual(maxInvoiceSequenceForYear(['TK-1', '2026-000003', '2026-000001'], 2026), 3);
const first = allocateNextInvoiceNumber({ year: 2026, existingCodes: ['TK-OLD'], lastIssuedByYear: {} });
assert.strictEqual(first.ticketCode, '2026-000001');
assert.strictEqual(
  allocateNextInvoiceNumber({ year: 2026, existingCodes: [first.ticketCode], lastIssuedByYear: first.lastIssuedByYear }).ticketCode,
  '2026-000002',
);
console.log('check-invoice-number: ok');
