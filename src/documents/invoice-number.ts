/** Numeración correlativa de factura: 2026-000001 (año + secuencia). Códigos legacy TK-/FAC-/DEV- conviven sin entrar en la serie. */

export const INVOICE_NUMBER_PATTERN = /^(\d{4})-(\d+)$/;

export type InvoiceSequenceByYear = Record<string, number>;

export const parseInvoiceNumber = (code: string): { year: number; sequence: number } | null => {
  const match = String(code || '').trim().match(INVOICE_NUMBER_PATTERN);
  if (!match) return null;
  const year = Number(match[1]);
  const sequence = Number(match[2]);
  if (!Number.isFinite(year) || !Number.isFinite(sequence) || sequence < 1) return null;
  return { year, sequence };
};

export const formatInvoiceNumber = (year: number, sequence: number): string =>
  `${year}-${String(sequence).padStart(6, '0')}`;

export const maxInvoiceSequenceForYear = (codes: readonly string[], year: number): number => {
  let max = 0;
  for (const code of codes) {
    const parsed = parseInvoiceNumber(code);
    if (parsed && parsed.year === year) max = Math.max(max, parsed.sequence);
  }
  return max;
};

export const allocateNextInvoiceNumber = (options: {
  year: number;
  existingCodes: readonly string[];
  lastIssuedByYear: Readonly<InvoiceSequenceByYear>;
}): { ticketCode: string; lastIssuedByYear: InvoiceSequenceByYear } => {
  const key = String(options.year);
  const fromHistory = maxInvoiceSequenceForYear(options.existingCodes, options.year);
  const fromStored = options.lastIssuedByYear[key] ?? 0;
  const next = Math.max(fromHistory, fromStored) + 1;
  return {
    ticketCode: formatInvoiceNumber(options.year, next),
    lastIssuedByYear: { ...options.lastIssuedByYear, [key]: next },
  };
};

/** Título fiscal en documentos: el antiguo ticket de venta se muestra como factura simplificada. */
export const displayFiscalDocumentType = (documentType: string): string =>
  documentType === 'TICKET DE VENTA' ? 'FACTURA SIMPLIFICADA' : documentType;

export const resolveStoredDocumentType = <T extends string>(documentType: T): T | 'FACTURA SIMPLIFICADA' =>
  documentType === 'TICKET DE VENTA' ? 'FACTURA SIMPLIFICADA' : documentType;
