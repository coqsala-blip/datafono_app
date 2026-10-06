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
  const source = fs.readFileSync(filePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    require: (name) => loadModule(path.resolve(path.dirname(filePath), `${name}.ts`)),
    Intl,
  }, { filename: filePath });
  return module.exports;
};

const { settingsReportsTranslations } = loadModule(path.join(root, 'src/translations/settings-reports.ts'));
const { t, APP_LOCALES } = loadModule(path.join(root, 'src/i18n.ts'));
const keys = Object.keys(settingsReportsTranslations.es).sort();
const placeholders = (value) => Array.from(value.matchAll(/\{\w+\}/g), (match) => match[0]).sort();
for (const { code } of APP_LOCALES) {
  const dictionary = settingsReportsTranslations[code];
  assert.deepEqual(Object.keys(dictionary).sort(), keys, `Missing keys: ${code}`);
  for (const key of keys) {
    assert.ok(dictionary[key].trim(), `Empty translation: ${code}/${key}`);
    assert.deepEqual(placeholders(dictionary[key]), placeholders(settingsReportsTranslations.es[key]));
    assert.equal(t(code, key), dictionary[key], `Fallback used: ${code}/${key}`);
  }
}
assert.equal(t('fr', 'config.noLogo'), 'Aucun logo configuré');
assert.equal(t('en', 'reports.day'), 'Day');

const source = fs.readFileSync(path.join(root, 'src/app/index.tsx'), 'utf8');
const start = source.indexOf("{activeTab === 'stats'");
const end = source.indexOf('{/* MODAL: ESCANEAR', start);
assert.ok(start >= 0 && end > start);
const slice = source.slice(start, end);
const syntax = ts.createSourceFile('screen.tsx', slice, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const inspect = (node) => {
  if (ts.isJsxText(node)) assert.ok(!/[A-Za-zÀ-ž]/.test(node.text), `Untranslated JSX: ${node.text.trim()}`);
  if (ts.isJsxAttribute(node) && ['placeholder', 'accessibilityLabel'].includes(node.name.getText(syntax))) {
    assert.ok(!node.initializer || !ts.isStringLiteral(node.initializer), 'Untranslated field or accessibility label');
  }
  ts.forEachChild(node, inspect);
};
inspect(syntax);
console.log(`${keys.length} keys validated in ${APP_LOCALES.length} languages; settings/report labels localized.`);