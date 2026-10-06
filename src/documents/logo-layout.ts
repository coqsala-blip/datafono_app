export const LOGO_POSITIONS = ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'] as const;
export const LOGO_SIZES = ['small', 'medium', 'large'] as const;

export type LogoPosition = typeof LOGO_POSITIONS[number];
export type LogoSize = typeof LOGO_SIZES[number];
export type LogoOffset = { x: number; y: number };
export type LogoSettings = { logoPosition?: LogoPosition; logoSize?: LogoSize; logoOffsetA4?: LogoOffset; logoOffsetTicket?: LogoOffset };

const clamp = (value: number, maximum = 1) => Math.min(maximum, Math.max(0, value));
const normalizeOffset = (value: unknown): LogoOffset | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const offset = value as Record<string, unknown>;
  if (typeof offset.x !== 'number' || typeof offset.y !== 'number' || !Number.isFinite(offset.x) || !Number.isFinite(offset.y)) return undefined;
  return { x: clamp(offset.x), y: clamp(offset.y) };
};

export const normalizeLogoSettings = (settings?: unknown): LogoSettings & { logoPosition: LogoPosition; logoSize: LogoSize } => {
  const value = settings && typeof settings === 'object' ? settings as Record<string, unknown> : {};
  const logoOffsetA4 = normalizeOffset(value.logoOffsetA4);
  const logoOffsetTicket = normalizeOffset(value.logoOffsetTicket);
  return {
    logoPosition: LOGO_POSITIONS.includes(value.logoPosition as LogoPosition) ? value.logoPosition as LogoPosition : 'top-center',
    logoSize: LOGO_SIZES.includes(value.logoSize as LogoSize) ? value.logoSize as LogoSize : 'medium',
    ...(logoOffsetA4 ? { logoOffsetA4 } : {}),
    ...(logoOffsetTicket ? { logoOffsetTicket } : {}),
  };
};

export const getLogoLayout = (settings: unknown, isA4: boolean) => {
  const normalized = normalizeLogoSettings(settings);
  const width = { small: 55, medium: 85, large: isA4 ? 160 : 120 }[normalized.logoSize];
  const alignment = normalized.logoPosition.endsWith('-left') ? 'left' : normalized.logoPosition.endsWith('-right') ? 'right' : 'center';
  return { ...normalized, placement: normalized.logoPosition.startsWith('bottom-') ? 'bottom' : 'top', alignment, width, maxHeight: width } as const;
};

const escapeAttribute = (value: string): string => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]!);

export const renderDocumentLogo = (dataURL: unknown, settings: unknown, isA4: boolean): { topHtml: string; bottomHtml: string } => {
  if (typeof dataURL !== 'string' || !/^data:image\/(?:png|jpe?g|webp|gif|bmp|avif|heic|heif);base64,[A-Za-z0-9+/]+={0,2}$/i.test(dataURL)) {
    return { topHtml: '', bottomHtml: '' };
  }
  const layout = getLogoLayout(settings, isA4);
  const margin = layout.placement === 'top' ? 'margin-bottom: 15px; padding-top: 10px;' : 'margin-top: 15px;';
  const html = `<div class="document-logo" style="text-align: ${layout.alignment}; ${margin} break-inside: avoid;"><img alt="" src="${escapeAttribute(dataURL)}" style="width: ${layout.width}px; max-width: 100%; height: auto; max-height: ${layout.maxHeight}px; object-fit: contain;" /></div>`;
  return { topHtml: layout.placement === 'top' ? html : '', bottomHtml: layout.placement === 'bottom' ? html : '' };
};

export const ISSUER_FORMATS = {
  a4: { width: 600, height: 1000, textWidth: 240, nameSize: 16, nameLineHeight: 20, detailSize: 11, detailLineHeight: 14 },
  ticket: { width: 280, height: 440, textWidth: 180, nameSize: 13, nameLineHeight: 16, detailSize: 9, detailLineHeight: 12 },
} as const;

export type DocumentIssuer = LogoSettings & { name: string; nif?: string; address?: string; logoUri?: string };

const wrapIssuerText = (text: string, width: number, fontSize: number): string[] => {
  const capacity = Math.max(1, Math.floor(width / (fontSize * 0.61)));
  return text.split(/\r?\n/).flatMap(paragraph => {
    const characters = Array.from(paragraph);
    return Array.from({ length: Math.max(1, Math.ceil(characters.length / capacity)) }, (_, index) => characters.slice(index * capacity, (index + 1) * capacity).join(''));
  });
};

export const getIssuerLayout = (issuer: DocumentIssuer, isA4: boolean, hasLogo = Boolean(issuer.logoUri)) => {
  const format = ISSUER_FORMATS[isA4 ? 'a4' : 'ticket'];
  const logo = getLogoLayout(issuer, isA4);
  const offset = logo[isA4 ? 'logoOffsetA4' : 'logoOffsetTicket'] ?? {
    x: logo.alignment === 'left' ? 0 : logo.alignment === 'right' ? 1 : 0.5,
    y: logo.placement === 'bottom' ? 1 : 0,
  };
  const nameLines = wrapIssuerText(issuer.name, format.textWidth, format.nameSize);
  const detailLines = [issuer.nif ? `NIF: ${issuer.nif}` : '', issuer.address ?? ''].flatMap(text => wrapIssuerText(text, format.textWidth, format.detailSize));
  const logoHeight = hasLogo ? logo.width + 8 : 0;
  const height = logoHeight + nameLines.length * format.nameLineHeight + detailLines.length * format.detailLineHeight;
  const width = Math.max(format.textWidth, hasLogo ? logo.width : 0);
  const availableX = Math.max(0, format.width - width);
  const availableY = Math.max(0, format.height - height);
  return { ...format, pageWidth: format.width, pageHeight: format.height, width, height, logoWidth: hasLogo ? logo.width : 0, logoHeight, nameLines, detailLines, offset, availableX, availableY, left: offset.x * availableX, top: offset.y * availableY };
};

export const offsetFromIssuerDrag = (left: number, top: number, pageWidth: number, pageHeight: number, blockWidth: number, blockHeight: number): LogoOffset => ({
  x: pageWidth > blockWidth ? clamp(left / (pageWidth - blockWidth)) : 0,
  y: pageHeight > blockHeight ? clamp(top / (pageHeight - blockHeight)) : 0,
});

export const renderIssuerBlock = (issuer: DocumentIssuer, dataURL: unknown, isA4: boolean): { topHtml: string; bottomHtml: string } => {
  const legacyLogo = renderDocumentLogo(dataURL, issuer, isA4);
  const layout = getIssuerLayout(issuer, isA4, Boolean(legacyLogo.topHtml || legacyLogo.bottomHtml));
  const image = layout.logoWidth ? `<div class="document-logo" style="height: ${layout.logoHeight}px;"><img alt="" src="${escapeAttribute(dataURL as string)}" style="width: ${layout.logoWidth}px; height: ${layout.logoWidth}px; object-fit: contain;" /></div>` : '';
  const lines = (values: string[], size: number, lineHeight: number, bold: boolean) => `<div style="font-family: 'Courier New', Courier, monospace; font-size: ${size}px; line-height: ${lineHeight}px; font-weight: ${bold ? 'bold' : 'normal'}; letter-spacing: 0; white-space: pre-wrap; overflow-wrap: anywhere;">${values.map(text => `<div style="min-height: ${lineHeight}px;">${escapeAttribute(text)}</div>`).join('')}</div>`;
  return {
    topHtml: `<div class="issuer-space" style="padding-top: ${layout.top}px;"><div class="issuer-block" style="width: ${layout.width}px; max-width: 100%; margin-left: ${layout.left}px; text-align: center; break-inside: avoid;">${image}${lines(layout.nameLines, layout.nameSize, layout.nameLineHeight, true)}${lines(layout.detailLines, layout.detailSize, layout.detailLineHeight, false)}</div></div>`,
    bottomHtml: '',
  };
};