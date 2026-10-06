import * as FileSystemLegacy from 'expo-file-system/legacy';

let exportCounter = 0;

const truncatePart = (value: string, byteLimit: number): string => {
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    const size = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes + size > byteLimit) break;
    result += character;
    bytes += size;
  }
  return result.replace(/_+$/g, '');
};

export const buildPdfFilename = (parts: readonly string[]): string => {
  const sanitized = parts.map(part => part.normalize('NFC')
    .replace(/\.pdf$/i, '')
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .trim().replace(/\s+/g, '_').replace(/^_+|_+$/g, ''))
    .filter(Boolean);
  const selected: string[] = [];
  let remaining = 176;
  for (let index = sanitized.length - 1; index >= 0; index -= 1) {
    const part = truncatePart(sanitized[index], Math.max(0, remaining - (index > 0 ? 33 : 0)));
    if (!part) continue;
    selected.unshift(part);
    remaining -= encodeURIComponent(part).replace(/%[A-F0-9]{2}/gi, 'x').length + 1;
  }
  let basename = selected.join('_') || 'Document';
  if (/^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i.test(basename)) basename = `PDF_${basename}`;
  return `${basename}.pdf`;
};

export const buildReportPdfFilename = (title: string, start: Date, end: Date): string => {
  const localDay = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return buildPdfFilename([title, localDay(start), localDay(end)]);
};

export const copyPdfForExport = async (sourceUri: string, filename: string): Promise<string> => {
  const cacheDirectory = FileSystemLegacy.cacheDirectory;
  if (!cacheDirectory) throw new Error('PDF export cache directory is unavailable.');
  const directory = `${cacheDirectory.replace(/\/?$/, '/')}pdf-exports/${Date.now()}-${++exportCounter}/`;
  const destination = `${directory}${buildPdfFilename([filename])}`;
  await FileSystemLegacy.makeDirectoryAsync(directory, { intermediates: true });
  await FileSystemLegacy.copyAsync({ from: sourceUri, to: destination });
  return destination;
};