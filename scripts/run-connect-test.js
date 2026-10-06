const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const dotenv = require('../server/node_modules/dotenv');

const serverDir = path.resolve(__dirname, '../server');
const validate = (settings, currentDatabaseUrl) => {
  const required = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'STRIPE_CONNECT_TEST_SECRET_KEY', 'STRIPE_CONNECT_STATE_SECRET', 'PUBLIC_API_URL'];
  if (required.some(key => !settings[key]?.trim())) throw new Error('Faltan variables del entorno de pruebas.');
  if (settings.CONNECT_TEST_ISOLATED_DATA !== 'true') throw new Error('Confirma que Supabase contiene solo datos de prueba.');
  if (!/^sk_test_[A-Za-z0-9]+$/.test(settings.STRIPE_CONNECT_TEST_SECRET_KEY)) throw new Error('Se requiere una clave Stripe de pruebas.');
  if (Buffer.byteLength(settings.STRIPE_CONNECT_STATE_SECRET) < 32) throw new Error('El secreto de estado debe tener al menos 32 bytes.');
  let database;
  let publicUrl;
  try {
    database = new URL(settings.SUPABASE_URL);
    publicUrl = new URL(settings.PUBLIC_API_URL);
  } catch {
    throw new Error('Las URLs del entorno de pruebas no son validas.');
  }
  if (database.protocol !== 'https:' || database.username || database.password || database.search || database.hash) throw new Error('Supabase requiere un origen HTTPS seguro.');
  if (!currentDatabaseUrl) throw new Error('Falta la referencia a la base actual para comprobar aislamiento.');
  const currentHost = new URL(currentDatabaseUrl).hostname;
  if (database.hostname === currentHost) throw new Error('No se permite la base de datos de la aplicacion actual.');
  if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== '/') throw new Error('El retorno Connect requiere un origen HTTPS de pruebas.');
  const port = Number(settings.PORT || 4100);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Puerto de pruebas no valido.');
  return {
    CONNECT_TEST_ENV_ISOLATED: 'true',
    NODE_ENV: 'development', PORT: String(port), PUBLIC_API_URL: publicUrl.origin,
    SUPABASE_URL: database.origin, SUPABASE_SECRET_KEY: settings.SUPABASE_SECRET_KEY,
    STRIPE_CONNECT_TEST_ENABLED: 'true', STRIPE_CONNECT_TEST_COUNTRIES: settings.STRIPE_CONNECT_TEST_COUNTRIES || 'ES',
    STRIPE_CONNECT_TEST_SECRET_KEY: settings.STRIPE_CONNECT_TEST_SECRET_KEY,
    STRIPE_CONNECT_STATE_SECRET: settings.STRIPE_CONNECT_STATE_SECRET,
    STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', STRIPE_MAIN_SUBSCRIPTION_PRICE_ID: '', STRIPE_ADDITIONAL_USER_PRICE_ID: '',
    DOTENV_CONFIG_PATH: '',
  };
};

const main = () => {
  const configPath = path.join(serverDir, '.env.connect.test');
  if (!fs.existsSync(configPath)) throw new Error('Falta server/.env.connect.test. Completa la plantilla local sin compartir secretos.');
  const settings = dotenv.parse(fs.readFileSync(configPath));
  const normalPath = path.join(serverDir, '.env');
  const current = fs.existsSync(normalPath) ? dotenv.parse(fs.readFileSync(normalPath)) : {};
  const isolated = validate(settings, current.SUPABASE_URL);
  const systemEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => (
    /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|COMSPEC|PATHEXT)$/i.test(key)
  )));
  const child = spawn(process.execPath, [path.join(serverDir, 'src/server.js')], {
    cwd: serverDir, stdio: 'inherit', env: { ...systemEnv, ...isolated },
  });
  child.on('error', () => { console.error('No se pudo arrancar el servidor de pruebas.'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
};

module.exports = { validate };
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}