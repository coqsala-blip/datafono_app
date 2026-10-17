/** Catálogo de productos del comercio (precio con IVA incluido). */

export type CatalogProduct = {
  id: string;
  name: string;
  price: number;
  photoUri?: string;
  createdAt: string;
};

export type CatalogCartLine = {
  productId: string;
  name: string;
  unitPrice: number;
  quantity: number;
};

export type InvoiceLine = {
  id: string;
  description: string;
  price: string;
  quantity?: number;
};

export const cartLineTotal = (line: CatalogCartLine): number =>
  Math.round(line.unitPrice * line.quantity * 100) / 100;

export const cartTotal = (lines: readonly CatalogCartLine[]): number =>
  Math.round(lines.reduce((sum, line) => sum + cartLineTotal(line), 0) * 100) / 100;

export const cartToInvoiceItems = (lines: readonly CatalogCartLine[]): InvoiceLine[] =>
  lines.map((line) => ({
    id: `${line.productId}-${line.quantity}-${line.unitPrice}`,
    description: line.name,
    price: cartLineTotal(line).toFixed(2),
    quantity: line.quantity,
  }));

export const addOrIncrementCartLine = (
  lines: readonly CatalogCartLine[],
  product: CatalogProduct,
  quantity: number,
): CatalogCartLine[] => {
  if (quantity < 1) return [...lines];
  const existing = lines.find((line) => line.productId === product.id && line.unitPrice === product.price);
  if (!existing) {
    return [...lines, {
      productId: product.id,
      name: product.name,
      unitPrice: product.price,
      quantity,
    }];
  }
  return lines.map((line) =>
    line.productId === product.id && line.unitPrice === product.price
      ? { ...line, quantity: line.quantity + quantity }
      : line,
  );
};

export const formatInvoiceItemLabel = (item: { description: string; quantity?: number }): string => {
  const quantity = item.quantity && item.quantity > 1 ? item.quantity : 0;
  return quantity ? `${quantity} × ${item.description}` : item.description;
};
