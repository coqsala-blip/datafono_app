const assert = require('assert');
const {
  addOrIncrementCartLine,
  cartToInvoiceItems,
  cartTotal,
  formatInvoiceItemLabel,
} = (() => {
  const fs = require('fs');
  const path = require('path');
  const ts = require('typescript');
  const vm = require('vm');
  const file = path.join(__dirname, '../src/products/catalog.ts');
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports });
  return module.exports;
})();

const product = { id: 'p1', name: 'Café', price: 1.5, createdAt: '2026-01-01' };
let cart = addOrIncrementCartLine([], product, 3);
assert.strictEqual(cartTotal(cart), 4.5);
cart = addOrIncrementCartLine(cart, product, 1);
assert.strictEqual(cartTotal(cart), 6);
const items = cartToInvoiceItems(cart);
assert.strictEqual(items[0].description, '4 × Café');
assert.strictEqual(items[0].quantity, undefined);
assert.strictEqual(formatInvoiceItemLabel(items[0]), '4 × Café');
assert.strictEqual(items[0].price, '6.00');
console.log('check-catalog: ok');
