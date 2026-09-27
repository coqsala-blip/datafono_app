// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");
const globals = require("globals");

module.exports = defineConfig([
  expoConfig,
  {
    // El backend (server/) se ejecuta en Node, no en React Native: sin sus globals el
    // lint marca falsos positivos de 'Buffer' y `npm run lint` falla.
    files: ["server/**/*.js"],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: "commonjs",
    },
  },
  {
    ignores: ["dist/*"],
  }
]);
