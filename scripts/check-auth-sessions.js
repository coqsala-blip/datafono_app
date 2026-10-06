#!/usr/bin/env node
// Pruebas de sesión única, login/registro y formulario de acceso.
// Ejecuta los handlers REALES de server/src/server.js en una VM con dobles de Express/Supabase
// (sin red, sin cuentas reales) y los helpers reales de la app (src/auth/auth-session.ts).
const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.dirname(require.resolve('../package.json'));
let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks += 1; };
const eq = (actual, expected, message) => { assert.equal(actual, expected, message); checks += 1; };

// ---------------------------------------------------------------------------------------------
// Doble de Supabase Auth
// ---------------------------------------------------------------------------------------------
const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const clone = (value) => JSON.parse(JSON.stringify(value));

const createAuthDouble = () => {
  const state = {
    users: new Map(),
    tokens: new Map(), // access token -> { userId, sessionId }
    refreshTokens: new Map(), // refresh token -> { userId, sessionId }
    revokedSessions: new Set(),
    confirmationRequired: false,
    failNextAppMetadataUpdate: false,
    calls: [],
  };
  const issueSession = (userId, sessionId = crypto.randomUUID()) => {
    const accessToken = `${b64url({ alg: 'HS256' })}.${b64url({ sub: userId, session_id: sessionId })}.${crypto.randomBytes(12).toString('hex')}`;
    const refreshToken = crypto.randomBytes(16).toString('hex');
    state.tokens.set(accessToken, { userId, sessionId });
    state.refreshTokens.set(refreshToken, { userId, sessionId });
    return { access_token: accessToken, refresh_token: refreshToken, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600 };
  };
  const findByEmail = (email) => [...state.users.values()].find((user) => user.email === email);
  const mergeMetadata = (current, patch) => {
    const merged = { ...current };
    for (const [key, value] of Object.entries(patch || {})) {
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    return merged;
  };
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const auth = {
    async getUser(token) {
      await tick();
      const entry = state.tokens.get(token);
      const user = entry && state.users.get(entry.userId);
      if (!entry || !user || state.revokedSessions.has(entry.sessionId)) {
        return { data: { user: null }, error: { message: 'invalid JWT' } };
      }
      return { data: { user: clone(user) }, error: null };
    },
    async signInWithPassword({ email, password }) {
      await tick();
      const user = findByEmail(email);
      if (!user || user.password !== password) return { data: { user: null, session: null }, error: { message: 'Invalid login credentials' } };
      if (!user.confirmed) return { data: { user: null, session: null }, error: { message: 'Email not confirmed' } };
      // Usuario con app_metadata tal como venía en el token: el servidor no debe fiarse de él.
      return { data: { user: { ...clone(user), app_metadata: { stale: true } }, session: issueSession(user.id) }, error: null };
    },
    async signUp({ email, password, options }) {
      await tick();
      if (findByEmail(email)) {
        if (!state.confirmationRequired) return { data: { user: null, session: null }, error: { message: 'User already registered' } };
        return { data: { user: { id: crypto.randomUUID(), email, identities: [], app_metadata: {}, user_metadata: {} }, session: null }, error: null };
      }
      const id = crypto.randomUUID();
      const user = {
        id, email, password,
        confirmed: !state.confirmationRequired,
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: clone(options?.data || {}),
        identities: [{ id, provider: 'email' }],
      };
      state.users.set(id, user);
      return { data: { user: clone(user), session: user.confirmed ? issueSession(id) : null }, error: null };
    },
    async refreshSession({ refresh_token: refreshToken }) {
      await tick();
      const entry = state.refreshTokens.get(refreshToken);
      if (!entry || state.revokedSessions.has(entry.sessionId)) return { data: { session: null, user: null }, error: { message: 'Invalid Refresh Token' } };
      state.refreshTokens.delete(refreshToken);
      return { data: { user: { ...clone(state.users.get(entry.userId)), app_metadata: { stale: true } }, session: issueSession(entry.userId, entry.sessionId) }, error: null };
    },
    admin: {
      async createUser(attributes) {
        const result = await auth.signUp({ email: attributes.email, password: attributes.password, options: { data: attributes.user_metadata } });
        const user = state.users.get(result.data.user.id);
        user.confirmed = attributes.email_confirm === true;
        user.app_metadata = clone(attributes.app_metadata || {});
        return { data: { user: clone(user) }, error: null };
      },
      async getUserById(id) {
        await tick();
        const user = state.users.get(id);
        return user ? { data: { user: clone(user) }, error: null } : { data: { user: null }, error: { message: 'User not found' } };
      },
      async updateUserById(id, attributes) {
        await tick();
        const user = state.users.get(id);
        if (!user) return { data: { user: null }, error: { message: 'User not found' } };
        if (attributes.app_metadata && state.failNextAppMetadataUpdate) {
          state.failNextAppMetadataUpdate = false;
          return { data: { user: null }, error: { message: 'simulated failure' } };
        }
        if (attributes.app_metadata) user.app_metadata = mergeMetadata(user.app_metadata, attributes.app_metadata);
        if (attributes.user_metadata) user.user_metadata = mergeMetadata(user.user_metadata, attributes.user_metadata);
        if (attributes.password) user.password = attributes.password;
        return { data: { user: clone(user) }, error: null };
      },
      async listUsers({ page, perPage }) {
        await tick();
        const all = [...state.users.values()].map(clone);
        return { data: { users: all.slice((page - 1) * perPage, page * perPage) }, error: null };
      },
      async signOut(jwt) {
        await tick();
        const entry = state.tokens.get(jwt);
        if (entry) state.revokedSessions.add(entry.sessionId);
        state.calls.push(['signOut', entry?.sessionId]);
        return { data: null, error: null };
      },
      async deleteUser(id) {
        await tick();
        state.users.delete(id);
        state.calls.push(['deleteUser', id]);
        return { data: { user: null }, error: null };
      },
    },
  };
  const from = () => {
    const query = {
      insert: async (payload) => { state.calls.push(['insert', clone(payload)]); return { error: null }; },
      select: () => query, eq: () => query, order: () => query, limit: () => query, gte: () => query,
      then: (resolve) => resolve({ data: [], error: null }),
    };
    return query;
  };
  return { state, client: { auth, from }, issueSession };
};

// ---------------------------------------------------------------------------------------------
// Carga del servidor real con Express simulado
// ---------------------------------------------------------------------------------------------
const loadServer = () => {
  const double = createAuthDouble();
  const routes = new Map();
  const app = { set() {}, use() {}, listen() {} };
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    app[method] = (routePath, ...handlers) => { routes.set(`${method.toUpperCase()} ${routePath}`, handlers); };
  }
  const express = () => app;
  express.json = () => () => undefined;
  express.raw = () => () => undefined;
  express.urlencoded = () => () => undefined;
  const logs = [];
  const quietConsole = { log: (...a) => logs.push(a), warn: (...a) => logs.push(a), error: (...a) => logs.push(a), info() {} };
  const modules = {
    dotenv: { config() {} },
    express,
    crypto,
    qrcode: { toDataURL: async () => '' },
    stripe: () => ({}),
    '@supabase/supabase-js': { createClient: () => double.client },
  };
  const source = fs.readFileSync(path.join(root, 'server/src/server.js'), 'utf8');
  vm.runInNewContext(source, {
    require: (name) => {
      if (name === './stripe-connect') return require('../server/src/stripe-connect');
      if (!(name in modules)) throw new Error(`Módulo no simulado: ${name}`);
      return modules[name];
    },
    process: { env: { PUBLIC_API_URL: 'http://localhost:4000', NODE_ENV: 'test', SUPABASE_URL: 'http://supabase.test', SUPABASE_SECRET_KEY: 'test' } },
    console: quietConsole, Buffer, URL, setTimeout, clearTimeout, setImmediate,
  }, { filename: 'server.js' });

  const call = async (method, routePath, { body = {}, headers = {}, ip = 'test-ip' } = {}) => {
    const handlers = routes.get(`${method} ${routePath}`);
    if (!handlers) throw new Error(`Ruta no registrada: ${method} ${routePath}`);
    const lowerHeaders = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    const req = { method, path: routePath, body, headers: lowerHeaders, query: {}, params: {}, ip };
    let finish;
    const finished = new Promise((resolve) => { finish = resolve; });
    const res = {
      statusCode: 200, body: undefined,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = JSON.parse(JSON.stringify(payload)); finish(); return this; },
      send(payload) { this.body = payload; finish(); return this; },
      type() { return this; },
      redirect(target) { this.statusCode = 302; this.body = target; finish(); return this; },
    };
    const run = (index) => (index < handlers.length ? handlers[index](req, res, () => run(index + 1)) : undefined);
    await Promise.all([Promise.resolve(run(0)), finished]);
    return res;
  };
  return { ...double, routes, call, logs };
};

const bearer = (token, extra = {}) => ({ headers: { Authorization: `Bearer ${token}`, ...extra } });
const DEVICE_A = 'dev-aaaa-0001-phone';
const DEVICE_B = 'dev-bbbb-0002-phone';
const DEVICE_C = 'dev-cccc-0003-phone';
const PASSWORD = 'correct-horse-9';

const runServerTests = async () => {
  const server = loadServer();
  const { call, state } = server;
  const meta = (id) => state.users.get(id).app_metadata;
  const userByEmail = (email) => [...state.users.values()].find((user) => user.email === email);
  const protectedCall = (token, extra) => call('POST', '/api/auth/employee-access-code', { ...bearer(token, extra), body: { accessCode: 'zzzz-9999' } });

  // Rutas: requireAuth en operaciones, solo /me y /logout con verificación sin enlace.
  ok(server.routes.has('GET /api/auth/me') && server.routes.has('POST /api/auth/logout'), 'rutas de sesión registradas');

  // --- Validación de registro (sin crear cuentas) ---
  const base = { email: 'owner@example.test', password: PASSWORD, fullName: 'Ana Dueña', companyName: 'Bar Ana', role: 'principal', deviceId: DEVICE_A };
  for (const [patch, expectedCode] of [
    [{ deviceId: undefined }, 'device_required'], [{ deviceId: '' }, 'device_required'], [{ deviceId: 'x' }, 'device_required'],
    [{ deviceId: 'dev id with spaces' }, 'device_required'], [{ fullName: '   ' }], [{ companyName: '' }], [{ password: 'short' }], [{ email: '' }],
  ]) {
    const res = await call('POST', '/api/auth/register', { body: { ...base, ...patch } });
    eq(res.statusCode, 400, `registro inválido ${JSON.stringify(patch)}`);
    if (expectedCode) eq(res.body.code, expectedCode, 'código device_required');
  }
  eq(state.users.size, 0, 'ningún registro inválido crea cuenta');

  // --- Registro principal con sesión inmediata ---
  const ownerRes = await call('POST', '/api/auth/register', { body: base });
  eq(ownerRes.statusCode, 201, 'registro principal');
  const owner = userByEmail('owner@example.test');
  const ownerSession1 = ownerRes.body.session;
  const ownerSid1 = state.tokens.get(ownerSession1.access_token).sessionId;
  const simpleAccess = await call('POST', '/api/auth/employee-login', { body: {
    companyEmail: base.email, fullName: 'Luis Empleado', employeeAccessCode: 'zzzz-9999', deviceId: DEVICE_C,
  } });
  eq(simpleAccess.statusCode, 401, 'el acceso adicional exige un código válido de esa empresa');
  eq(meta(owner.id).role, 'principal', 'rol principal en app_metadata');
  eq(meta(owner.id).active_device_id, DEVICE_A, 'dispositivo del registro enlazado');
  eq(meta(owner.id).active_session_id, ownerSid1, 'sesión del registro enlazada');
  eq(owner.user_metadata.role, undefined, 'el rol no se guarda en user_metadata');
  eq(owner.user_metadata.company_name, 'Bar Ana', 'empresa del principal');
  eq(ownerRes.body.user.app_metadata.role, 'principal', 'respuesta con metadata actual');
  eq((await protectedCall(ownerSession1.access_token)).statusCode, 200, 'operación protegida con la sesión activa');
  state.users.get(owner.id).user_metadata.stripe_subscription_additional_users = '2';
  const simpleBody = { companyEmail: ' OWNER@EXAMPLE.TEST ', fullName: 'Luis Empleado', employeeAccessCode: ' zzzz-9999 ', deviceId: DEVICE_C };
  const beforeSimple = JSON.stringify(meta(owner.id));
  const simple = await call('POST', '/api/auth/employee-login', { body: simpleBody });
  eq(simple.statusCode, 200, 'adicional entra sin contraseña ni correo personal');
  const simpleUser = state.users.get(simple.body.user.id);
  eq(simpleUser.app_metadata.role, 'empleado', 'acceso simple solo empleado');
  eq(simpleUser.app_metadata.company_owner_id, owner.id, 'acceso simple pertenece a la empresa');
  eq(simpleUser.user_metadata.full_name, 'Luis Empleado', 'nombre conservado');
  eq(simpleUser.user_metadata.company_name, 'Bar Ana', 'empresa heredada');
  eq(JSON.stringify(meta(owner.id)), beforeSimple, 'entrada adicional no toca sesión ni código principal');
  eq((await protectedCall(ownerSession1.access_token)).statusCode, 200, 'principal sigue conectado');
  eq((await call('GET', '/api/auth/me', bearer(simple.body.session.access_token, { 'X-Device-Id': DEVICE_C }))).statusCode, 200, 'sesión adicional verificable');
  const again = await call('POST', '/api/auth/employee-login', { body: simpleBody });
  eq(again.statusCode, 200, 'el código se puede volver a usar');
  eq(again.body.user.id, simple.body.user.id, 'mismo dispositivo reutiliza cuenta adicional');
  eq((await call('GET', '/api/auth/me', bearer(simple.body.session.access_token))).statusCode, 409, 'sesión anterior adicional invalidada');
  eq((await call('POST', '/api/auth/refresh', { body: { refreshToken: again.body.session.refresh_token } })).statusCode, 200, 'sesión adicional renovable');
  const another = await call('POST', '/api/auth/employee-login', { body: { ...simpleBody, deviceId: 'dev-simple-other-01' } });
  eq(another.statusCode, 200, 'segundo adicional independiente');
  ok(another.body.user.id !== again.body.user.id, 'adicionales tienen cuentas independientes');
  eq((await call('POST', '/api/auth/employee-login', { body: { ...simpleBody, deviceId: 'dev-no-seat-0001' } })).statusCode, 403, 'no se exceden plazas contratadas');
  eq((await call('POST', '/api/auth/logout', bearer(another.body.session.access_token))).statusCode, 200, 'cerrar adicional libera plaza');
  eq((await call('POST', '/api/auth/employee-login', { body: { ...simpleBody, deviceId: 'dev-no-seat-0001' } })).statusCode, 200, 'plaza liberada disponible');
  eq((await call('POST', '/api/auth/employee-login', { body: { ...simpleBody, companyEmail: 'other@example.test' } })).statusCode, 401, 'código correcto no sirve para otra empresa');
  for (const patch of [{ fullName: '' }, { deviceId: '' }, { employeeAccessCode: 'short' }, { companyEmail: 'not-email' }]) {
    eq((await call('POST', '/api/auth/employee-login', { body: { ...simpleBody, ...patch } })).statusCode, 400, 'campos obligatorios adicional');
  }
  for (let attempt = 0; attempt < 9; attempt += 1) {
    eq((await call('POST', '/api/auth/employee-login', { body: { ...simpleBody, employeeAccessCode: 'WRONG-9999' } })).statusCode, 401, 'código erróneo rechazado');
  }
  eq((await call('POST', '/api/auth/employee-login', { body: simpleBody })).statusCode, 429, 'límite intentos protege código');
  const generated = await call('POST', '/api/auth/employee-access-code', { ...bearer(ownerSession1.access_token), body: {} });
  eq(generated.statusCode, 200, 'principal puede generar código sin escribirlo');
  ok(/^[A-F0-9]{16}$/.test(generated.body.accessCode), 'código generado aleatorio de 16 caracteres');
  eq(generated.body.companyEmail, base.email, 'principal recibe correo exacto de la empresa');
  const loginWithGenerated = await call('POST', '/api/auth/employee-login', { body: { ...simpleBody, employeeAccessCode: generated.body.accessCode } });
  eq(loginWithGenerated.statusCode, 429, 'rotación no elimina límite de intentos');
  const salt = state.users.get(owner.id).app_metadata.employee_access_code_salt;
  eq(state.users.get(owner.id).app_metadata.employee_access_code_hash, crypto.scryptSync(generated.body.accessCode, salt, 64).toString('hex'), 'código guardado como hash');
  eq((await call('POST', '/api/auth/employee-login', { ip: 'second-ip', body: { ...simpleBody, employeeAccessCode: generated.body.accessCode.toLowerCase() } })).statusCode, 200, 'código generado permite acceder sin distinguir mayúsculas');
  eq((await call('POST', '/api/auth/employee-login', { ip: 'second-ip', body: simpleBody })).statusCode, 401, 'código anterior deja de permitir nuevas entradas tras rotación');

  // --- Login: deviceId obligatorio, sin bypass ---
  for (const body of [{ email: base.email, password: PASSWORD }, { email: base.email, password: PASSWORD, force: true }, { email: base.email, password: PASSWORD, deviceId: '  ', force: true }]) {
    const res = await call('POST', '/api/auth/login', { body });
    eq(res.statusCode, 400, 'login sin deviceId rechazado');
    eq(res.body.code, 'device_required', 'login sin deviceId: device_required');
  }
  eq((await call('POST', '/api/auth/login', { body: { email: base.email, password: 'wrong-pass', deviceId: DEVICE_B } })).statusCode, 401, 'contraseña incorrecta');

  // --- Segundo móvil: 409 y su sesión nueva queda revocada ---
  const tokensBefore = new Set(state.tokens.keys());
  const second = await call('POST', '/api/auth/login', { body: { email: base.email, password: PASSWORD, deviceId: DEVICE_B } });
  eq(second.statusCode, 409, 'segundo dispositivo bloqueado');
  eq(second.body.code, 'device_conflict', 'código device_conflict');
  eq(second.body.session, undefined, 'sin sesión en el conflicto');
  const discarded = [...state.tokens.keys()].find((token) => !tokensBefore.has(token));
  ok(state.revokedSessions.has(state.tokens.get(discarded).sessionId), 'la sesión creada en el conflicto se revoca');
  eq(meta(owner.id).active_device_id, DEVICE_A, 'el conflicto no cambia el dispositivo');
  eq(meta(owner.id).active_session_id, ownerSid1, 'el conflicto no cambia la sesión');
  eq((await protectedCall(ownerSession1.access_token)).statusCode, 200, 'el primer móvil sigue operando');

  // --- Traslado explícito por login ---
  const forced = await call('POST', '/api/auth/login', { body: { email: base.email, password: PASSWORD, deviceId: DEVICE_B, force: true } });
  eq(forced.statusCode, 200, 'traslado con force');
  const ownerSessionB = forced.body.session;
  const sidB = state.tokens.get(ownerSessionB.access_token).sessionId;
  eq(meta(owner.id).active_device_id, DEVICE_B, 'dispositivo trasladado');
  eq(meta(owner.id).active_session_id, sidB, 'sesión trasladada');
  eq(forced.body.user.app_metadata.active_session_id, sidB, 'respuesta con metadata fresca (no la del token)');
  ok(!forced.body.user.app_metadata.stale, 'no se devuelve la metadata obsoleta del login');
  const oldOp = await protectedCall(ownerSession1.access_token);
  eq(oldOp.statusCode, 409, 'sesión antigua bloqueada en operaciones');
  eq(oldOp.body.code, 'device_conflict', 'sesión antigua: device_conflict');
  eq((await protectedCall(ownerSession1.access_token, { 'X-Device-Force': '1', 'X-Device-Id': DEVICE_A })).statusCode, 409, 'X-Device-Force no salta requireAuth');
  eq((await protectedCall(ownerSessionB.access_token)).statusCode, 200, 'sesión nueva opera');
  const publishOld = await call('POST', '/api/documents', { ...bearer(ownerSession1.access_token), body: { id: 't1', ticketCode: 'T-1', documentType: 'TICKET DE VENTA', amount: 1 } });
  eq(publishOld.statusCode, 409, 'sesión antigua no publica documentos a nombre de la cuenta');

  // --- /me: monitor sin force -> 409; token no verificado -> 401 ---
  const monitorOld = await call('GET', '/api/auth/me', bearer(ownerSession1.access_token, { 'X-Device-Id': DEVICE_A }));
  eq(monitorOld.statusCode, 409, '/me de la sesión movida: conflicto');
  eq(meta(owner.id).active_session_id, sidB, '/me sin force no reclama');
  const [, forgedPayload] = ownerSessionB.access_token.split('.');
  const forged = `${b64url({ alg: 'none' })}.${forgedPayload}.forged`;
  eq((await call('GET', '/api/auth/me', bearer(forged, { 'X-Device-Id': DEVICE_C, 'X-Device-Force': '1' }))).statusCode, 401, 'token falsificado con session_id válido: 401');
  eq((await protectedCall(forged)).statusCode, 401, 'token falsificado en operación: 401');
  eq((await call('GET', '/api/auth/me', {})).statusCode, 401, '/me sin token');
  eq(meta(owner.id).active_device_id, DEVICE_B, 'falsificación sin efecto');
  const monitorActive = await call('GET', '/api/auth/me', bearer(ownerSessionB.access_token, { 'X-Device-Id': DEVICE_B }));
  eq(monitorActive.statusCode, 200, '/me de la sesión activa');
  eq((await call('GET', '/api/auth/me', bearer(ownerSessionB.access_token))).statusCode, 200, '/me enlazado no necesita cabecera');
  eq((await call('GET', '/api/auth/me', bearer(ownerSessionB.access_token, { 'X-Device-Id': DEVICE_C }))).statusCode, 409, 'misma sesión desde otro dispositivo: conflicto');

  // --- /me con force explícito (arranque) traslada ---
  const meForce = await call('GET', '/api/auth/me', bearer(ownerSession1.access_token, { 'X-Device-Id': DEVICE_A, 'X-Device-Force': '1' }));
  eq(meForce.statusCode, 200, '/me force traslada');
  eq(meForce.body.transferred, true, '/me indica traslado');
  eq(meta(owner.id).active_session_id, ownerSid1, '/me force enlaza la sesión que lo pide');
  eq((await protectedCall(ownerSessionB.access_token)).statusCode, 409, 'tras el traslado, el otro queda bloqueado');
  eq((await protectedCall(ownerSession1.access_token)).statusCode, 200, 'la sesión trasladada opera');

  // --- Refresh ---
  const refreshMoved = await call('POST', '/api/auth/refresh', { body: { refreshToken: ownerSessionB.refresh_token } });
  eq(refreshMoved.statusCode, 409, 'refresh de sesión movida: 409');
  eq(refreshMoved.body.session, undefined, 'refresh movido sin sesión');
  eq(meta(owner.id).active_session_id, ownerSid1, 'refresh no toca los marcadores');
  eq(meta(owner.id).active_device_id, DEVICE_A, 'refresh no toca el dispositivo');
  const refreshActive = await call('POST', '/api/auth/refresh', { body: { refreshToken: ownerSession1.refresh_token } });
  eq(refreshActive.statusCode, 200, 'refresh de la sesión activa');
  ok(!refreshActive.body.user.app_metadata.stale, 'refresh devuelve metadata verificada');
  eq((await protectedCall(refreshActive.body.session.access_token)).statusCode, 200, 'token renovado opera');
  eq((await call('POST', '/api/auth/refresh', { body: { refreshToken: 'nope' } })).statusCode, 401, 'refresh inválido');
  eq((await call('POST', '/api/auth/refresh', { body: {} })).statusCode, 400, 'refresh vacío');

  // --- Login desde el mismo dispositivo sustituye la sesión anterior ---
  const sameDevice = await call('POST', '/api/auth/login', { body: { email: base.email, password: PASSWORD, deviceId: DEVICE_A } });
  eq(sameDevice.statusCode, 200, 'relogin en el mismo dispositivo');
  eq((await protectedCall(refreshActive.body.session.access_token)).statusCode, 409, 'la sesión previa del mismo dispositivo queda inválida');
  const ownerToken = sameDevice.body.session.access_token;

  // --- Logout libera solo la sesión activa ---
  await call('POST', '/api/auth/logout', bearer(ownerSessionB.access_token));
  eq(meta(owner.id).active_device_id, DEVICE_A, 'logout de una sesión movida no libera');
  const afterLogout = await call('POST', '/api/auth/logout', bearer(ownerToken));
  eq(afterLogout.statusCode, 200, 'logout');
  eq(meta(owner.id).active_device_id, undefined, 'logout libera el dispositivo');
  eq(meta(owner.id).active_session_id, undefined, 'logout libera la sesión');
  eq((await protectedCall(ownerToken)).statusCode, 401, 'la sesión cerrada queda revocada');
  const relogin = await call('POST', '/api/auth/login', { body: { email: base.email, password: PASSWORD, deviceId: DEVICE_C } });
  eq(relogin.statusCode, 200, 'tras cerrar sesión, otro móvil entra sin traslado');
  const ownerTokenC = relogin.body.session.access_token;

  // --- Cuentas antiguas (sin active_session_id) ---
  const legacyId = crypto.randomUUID();
  state.users.set(legacyId, { id: legacyId, email: 'legacy@example.test', password: PASSWORD, confirmed: true, app_metadata: { role: 'principal' }, user_metadata: {}, identities: [{ id: legacyId }] });
  const legacy1 = server.issueSession(legacyId);
  const legacy2 = server.issueSession(legacyId);
  const unbound = await protectedCall(legacy1.access_token);
  eq(unbound.statusCode, 409, 'sesión antigua sin enlazar no opera');
  eq(unbound.body.code, 'session_unbound', 'código session_unbound');
  eq((await call('GET', '/api/auth/me', bearer(legacy1.access_token))).statusCode, 400, '/me antiguo sin dispositivo: 400');
  eq(meta(legacyId).active_session_id, undefined, 'sin dispositivo no se enlaza');
  eq((await call('GET', '/api/auth/me', bearer(legacy1.access_token, { 'X-Device-Id': DEVICE_A }))).statusCode, 200, '/me antiguo enlaza su sesión');
  eq(meta(legacyId).active_device_id, DEVICE_A, 'migración: dispositivo');
  eq((await protectedCall(legacy1.access_token)).statusCode, 200, 'migrada opera');
  eq((await call('GET', '/api/auth/me', bearer(legacy2.access_token, { 'X-Device-Id': DEVICE_B }))).statusCode, 409, 'segundo móvil antiguo: conflicto');
  eq((await protectedCall(legacy2.access_token)).statusCode, 409, 'segundo móvil antiguo no opera');
  const legacyDeviceId = crypto.randomUUID();
  state.users.set(legacyDeviceId, { id: legacyDeviceId, email: 'legacy-device@example.test', password: PASSWORD, confirmed: true, app_metadata: { role: 'principal', active_device_id: DEVICE_A }, user_metadata: {}, identities: [{ id: legacyDeviceId }] });
  const legacyOther = server.issueSession(legacyDeviceId);
  eq((await call('GET', '/api/auth/me', bearer(legacyOther.access_token, { 'X-Device-Id': DEVICE_B }))).statusCode, 409, 'antiguo con otro dispositivo registrado: conflicto');
  eq((await call('GET', '/api/auth/me', bearer(legacyOther.access_token))).statusCode, 409, 'antiguo sin cabecera y dispositivo registrado: conflicto');
  const legacyOwn = server.issueSession(legacyDeviceId);
  eq((await call('GET', '/api/auth/me', bearer(legacyOwn.access_token, { 'X-Device-Id': DEVICE_A }))).statusCode, 200, 'antiguo desde su dispositivo: enlaza');

  // --- Logins simultáneos (bloqueo por cuenta) ---
  const raceId = crypto.randomUUID();
  state.users.set(raceId, { id: raceId, email: 'race@example.test', password: PASSWORD, confirmed: true, app_metadata: { role: 'principal' }, user_metadata: {}, identities: [{ id: raceId }] });
  const race = await Promise.all([DEVICE_B, DEVICE_C].map((deviceId) => call('POST', '/api/auth/login', { body: { email: 'race@example.test', password: PASSWORD, deviceId } })));
  eq(race.map((res) => res.statusCode).sort().join(','), '200,409', 'solo un login simultáneo gana');
  const winner = race.find((res) => res.statusCode === 200);
  eq(meta(raceId).active_session_id, state.tokens.get(winner.body.session.access_token).sessionId, 'gana la sesión que respondió 200');

  // --- Códigos de empleado ---
  eq((await call('POST', '/api/auth/employee-access-code', { ...bearer(ownerTokenC), body: { accessCode: '  abcd-1234 ' } })).statusCode, 200, 'principal crea código');
  const ownerMeta = meta(owner.id);
  eq(ownerMeta.employee_access_code_hash, crypto.scryptSync('ABCD-1234', ownerMeta.employee_access_code_salt, 64).toString('hex'), 'código guardado normalizado en mayúsculas');
  eq((await call('POST', '/api/auth/employee-access-code', { ...bearer(ownerTokenC), body: { accessCode: 'short' } })).statusCode, 400, 'código corto');

  const employeeBase = { email: 'emp1@example.test', password: PASSWORD, fullName: 'Eva Empleada', role: 'empleado', deviceId: DEVICE_B };
  const invalidCode = await call('POST', '/api/auth/register', { body: { ...employeeBase, employeeAccessCode: 'WRONG-0000' } });
  eq(invalidCode.statusCode, 400, 'código incorrecto');
  eq((await call('POST', '/api/auth/register', { body: { ...employeeBase, employeeAccessCode: '' } })).statusCode, 400, 'código vacío');
  eq((await call('POST', '/api/auth/register', { body: { ...employeeBase, fullName: '', employeeAccessCode: 'ABCD-1234' } })).statusCode, 400, 'empleado sin nombre');
  eq((await call('POST', '/api/auth/register', { body: { ...employeeBase, deviceId: '', employeeAccessCode: 'ABCD-1234' } })).statusCode, 400, 'empleado sin dispositivo');
  ok(!userByEmail('emp1@example.test'), 'los registros fallidos no crean empleado');
  ok(meta(owner.id).employee_access_code_hash, 'los fallos no consumen el código');

  // Duplicado (confirmación desactivada: error de Supabase) no consume el código.
  const duplicateOff = await call('POST', '/api/auth/register', { body: { ...employeeBase, email: 'owner@example.test', employeeAccessCode: 'abcd-1234' } });
  eq(duplicateOff.statusCode, 400, 'duplicado sin confirmación: error');
  ok(meta(owner.id).employee_access_code_hash, 'duplicado no consume el código');
  eq(meta(owner.id).role, 'principal', 'duplicado no cambia el rol del existente');

  // Duplicado (confirmación activada: usuario ofuscado sin identidades).
  state.confirmationRequired = true;
  const ownerBefore = JSON.stringify(state.users.get(owner.id));
  const duplicateOn = await call('POST', '/api/auth/register', { body: { ...employeeBase, email: 'owner@example.test', employeeAccessCode: 'ABCD-1234' } });
  eq(duplicateOn.statusCode, 201, 'duplicado ofuscado: respuesta neutra');
  eq(duplicateOn.body.user, null, 'duplicado ofuscado: sin usuario');
  eq(duplicateOn.body.requiresEmailConfirmation, true, 'duplicado ofuscado: neutro');
  eq(JSON.stringify(state.users.get(owner.id)), ownerBefore, 'la cuenta existente no se modifica');
  ok(meta(owner.id).employee_access_code_hash, 'duplicado ofuscado no consume el código');
  state.confirmationRequired = false;

  // Empleado correcto con el código escrito en minúsculas (el guardado está en mayúsculas).
  const employeeRes = await call('POST', '/api/auth/register', { body: { ...employeeBase, companyName: 'Empresa inventada', employeeAccessCode: ' abcd-1234 ' } });
  eq(employeeRes.statusCode, 201, 'alta de empleado');
  const employee = userByEmail('emp1@example.test');
  eq(meta(employee.id).role, 'empleado', 'rol empleado');
  eq(meta(employee.id).company_owner_id, owner.id, 'vinculado al principal');
  eq(employee.user_metadata.company_name, 'Bar Ana', 'empresa heredada del principal, no la enviada');
  eq(employee.user_metadata.role, undefined, 'rol fuera de user_metadata');
  eq(meta(employee.id).active_device_id, DEVICE_B, 'empleado enlazado a su dispositivo');
  eq(meta(employee.id).active_session_id, state.tokens.get(employeeRes.body.session.access_token).sessionId, 'empleado enlazado a su sesión');
  eq(meta(owner.id).employee_access_code_hash, undefined, 'código consumido');
  const employeeToken = employeeRes.body.session.access_token;
  eq((await call('POST', '/api/auth/employee-access-code', { ...bearer(employeeToken), body: { accessCode: 'EMPL-0001' } })).statusCode, 403, 'empleado no crea códigos');
  const reused = await call('POST', '/api/auth/register', { body: { ...employeeBase, email: 'emp2@example.test', employeeAccessCode: 'ABCD-1234' } });
  eq(reused.statusCode, 400, 'código ya usado (caducado) no vale');
  ok(!userByEmail('emp2@example.test'), 'código usado no crea cuenta');
  const empSecond = await call('POST', '/api/auth/login', { body: { email: 'emp1@example.test', password: PASSWORD, deviceId: DEVICE_C } });
  eq(empSecond.statusCode, 409, 'el empleado tampoco abre dos móviles');

  // Códigos antiguos guardados tal cual: minúsculas se recuperan, mayúsculas/minúsculas mezcladas no.
  const setLegacyCode = (code) => {
    const salt = crypto.randomBytes(16).toString('hex');
    state.users.get(owner.id).app_metadata.employee_access_code_salt = salt;
    state.users.get(owner.id).app_metadata.employee_access_code_hash = crypto.scryptSync(code, salt, 64).toString('hex');
  };
  setLegacyCode('legacy-lower-1');
  const legacyLower = await call('POST', '/api/auth/register', { body: { ...employeeBase, email: 'emp3@example.test', employeeAccessCode: 'LEGACY-LOWER-1' } });
  eq(legacyLower.statusCode, 201, 'código antiguo en minúsculas aceptado aunque el teclado ponga mayúsculas');
  setLegacyCode('MiXeD-Code-1');
  eq((await call('POST', '/api/auth/register', { body: { ...employeeBase, email: 'emp4@example.test', employeeAccessCode: 'MiXeD-Code-1' } })).statusCode, 201, 'código mezclado escrito exacto');
  setLegacyCode('MiXeD-Code-2');
  eq((await call('POST', '/api/auth/register', { body: { ...employeeBase, email: 'emp5@example.test', employeeAccessCode: 'MIXED-CODE-2' } })).statusCode, 400, 'código mezclado en mayúsculas: hay que regenerarlo');
  ok(meta(owner.id).employee_access_code_hash, 'el rechazo no consume el código mezclado');

  // Dos altas simultáneas con el mismo código: solo una.
  setLegacyCode('RACE-CODE-1');
  const raceRegs = await Promise.all(['emp6@example.test', 'emp7@example.test'].map((email) => call('POST', '/api/auth/register', { body: { ...employeeBase, email, employeeAccessCode: 'race-code-1' } })));
  eq(raceRegs.map((res) => res.statusCode).sort().join(','), '201,400', 'un código solo da una cuenta aunque haya altas simultáneas');

  // Fallo al asignar el rol: la cuenta nueva se elimina y el código sigue sin consumir.
  setLegacyCode('FAIL-CODE-1');
  state.failNextAppMetadataUpdate = true;
  const failed = await call('POST', '/api/auth/register', { body: { ...employeeBase, email: 'emp8@example.test', employeeAccessCode: 'FAIL-CODE-1' } });
  eq(failed.statusCode, 500, 'fallo de metadata');
  ok(!userByEmail('emp8@example.test'), 'cuenta sin rol eliminada');
  ok(meta(owner.id).employee_access_code_hash, 'código no consumido tras el fallo');

  // --- Registro sin sesión (confirmación de email) ---
  state.confirmationRequired = true;
  const unconfirmed = await call('POST', '/api/auth/register', { body: { ...base, email: 'new@example.test', deviceId: DEVICE_A } });
  eq(unconfirmed.statusCode, 201, 'registro pendiente de confirmar');
  eq(unconfirmed.body.requiresEmailConfirmation, true, 'requiere confirmación');
  const pending = userByEmail('new@example.test');
  eq(meta(pending.id).active_device_id, DEVICE_A, 'pendiente: dispositivo enlazado');
  eq(meta(pending.id).active_session_id, undefined, 'pendiente: sin sesión todavía');
  state.confirmationRequired = false;
  pending.confirmed = true;
  eq((await call('POST', '/api/auth/login', { body: { email: 'new@example.test', password: PASSWORD, deviceId: DEVICE_B } })).statusCode, 409, 'confirmado: otro dispositivo bloqueado');
  const pendingLogin = await call('POST', '/api/auth/login', { body: { email: 'new@example.test', password: PASSWORD, deviceId: DEVICE_A } });
  eq(pendingLogin.statusCode, 200, 'confirmado: su dispositivo entra');
  eq(meta(pending.id).active_session_id, state.tokens.get(pendingLogin.body.session.access_token).sessionId, 'sesión enlazada en el login');

  ok(!server.logs.some((entry) => String(entry.join(' ')).includes(PASSWORD)), 'los logs no contienen contraseñas');
  return server;
};

// ---------------------------------------------------------------------------------------------
// App: helpers reales, traducciones y estructura del formulario
// ---------------------------------------------------------------------------------------------
const cache = new Map();
const loadModule = (filePath, globals = {}) => {
  const key = `${filePath}|${Object.keys(globals).join(',')}`;
  if (cache.has(key)) return cache.get(key);
  const module = { exports: {} };
  cache.set(key, module.exports);
  const compiled = ts.transpileModule(fs.readFileSync(filePath, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  vm.runInNewContext(compiled, {
    module, exports: module.exports, Intl, ...globals,
    require: (name) => loadModule(path.resolve(path.dirname(filePath), `${name}.ts`), globals),
  }, { filename: filePath });
  return module.exports;
};

const runAppTests = async (server) => {
  const helperPath = path.join(root, 'src/auth/auth-session.ts');
  const helpers = loadModule(helperPath);
  const helpersWithCrypto = loadModule(helperPath, { crypto: { getRandomValues: (array) => crypto.getRandomValues(array) } });

  // Identificador de dispositivo
  const memoryStore = () => {
    const data = new Map();
    return { data, getItemAsync: async (key) => data.get(key) ?? null, setItemAsync: async (key, value) => { data.set(key, value); } };
  };
  const serverPattern = /^[A-Za-z0-9._:-]{8,128}$/;
  for (const lib of [helpers, helpersWithCrypto]) {
    const store = memoryStore();
    const first = await lib.getOrCreateDeviceId(store);
    ok(serverPattern.test(first), 'ID con formato aceptado por el servidor');
    eq(await lib.getOrCreateDeviceId(store), first, 'ID estable entre arranques');
    eq(lib.DEVICE_ID_KEY, 'tpv_device_id_v2', 'clave SecureStore nueva');
    ok(/^[A-Za-z0-9._-]+$/.test(lib.DEVICE_ID_KEY), 'clave válida para SecureStore');
    const ids = new Set(Array.from({ length: 2000 }, () => lib.generateDeviceId()));
    eq(ids.size, 2000, 'IDs únicos');
    const throwing = memoryStore();
    let reads = 0;
    throwing.getItemAsync = async (keyName) => { reads += 1; if (reads === 1) throw new Error('decrypt'); return throwing.data.get(keyName) ?? null; };
    ok(serverPattern.test(await lib.getOrCreateDeviceId(throwing)), 'valor ilegible: se genera otro');
    const corrupt = memoryStore();
    corrupt.data.set(lib.DEVICE_ID_KEY, 'bad id');
    const replaced = await lib.getOrCreateDeviceId(corrupt);
    ok(replaced !== 'bad id' && serverPattern.test(replaced), 'valor corrupto: se sustituye');
    const failing = memoryStore();
    failing.setItemAsync = async () => { throw new Error('no keystore'); };
    eq(await lib.getOrCreateDeviceId(failing), null, 'sin almacenamiento seguro: null (bloquea el acceso)');
    const volatile = memoryStore();
    volatile.setItemAsync = async () => undefined;
    eq(await lib.getOrCreateDeviceId(volatile), null, 'sin persistencia verificable: null');
  }

  // Validación y cuerpo de las peticiones
  const form = (patch) => ({ mode: 'register', role: 'principal', email: 'a@b.test', password: '12345678', fullName: 'Ana', companyName: 'Bar', employeeAccessCode: '', ...patch });
  const cases = [
    [form({ mode: 'login', password: '', fullName: '', companyName: '' }), 'auth.errorPassword'],
    [form({ mode: 'login', password: 'x', fullName: '', companyName: '' }), null],
    [form({ email: 'no-at' }), 'auth.errorEmail'],
    [form({ email: '  ' }), 'auth.errorEmail'],
    [form({ password: '1234567' }), 'auth.errorPasswordLength'],
    [form({ fullName: '  ' }), 'auth.errorFullName'],
    [form({ companyName: ' ' }), 'auth.errorCompanyName'],
    [form({}), null],
    [form({ role: 'empleado', companyName: '', employeeAccessCode: 'abc' }), 'auth.errorCode'],
    [form({ role: 'empleado', mode: 'login', password: '', companyName: '', employeeAccessCode: ' abcd-1234 ' }), null],
    [form({ role: 'empleado', fullName: '', employeeAccessCode: 'ABCD-1234' }), 'auth.errorFullName'],
  ];
  for (const [input, expected] of cases) eq(helpers.validateAuthForm(input), expected, `validación ${JSON.stringify(input)}`);

  const loginBody = helpers.buildAuthRequestBody(form({ mode: 'login', email: ' A@B.Test ' }), DEVICE_A, true);
  eq(JSON.stringify(loginBody), JSON.stringify({ email: 'a@b.test', password: '12345678', deviceId: DEVICE_A, force: true }), 'login envía deviceId y force');
  const principalBody = helpers.buildAuthRequestBody(form({}), DEVICE_A);
  eq(principalBody.companyName, 'Bar', 'principal envía empresa');
  ok(!('employeeAccessCode' in principalBody) && !('force' in principalBody), 'principal sin código ni force');
  eq(principalBody.deviceId, DEVICE_A, 'registro envía deviceId');
  const employeeBody = helpers.buildAuthRequestBody(form({ role: 'empleado', employeeAccessCode: ' ｚｚｚｚ-0001 ' }), DEVICE_B);
  eq(employeeBody.employeeAccessCode, 'zzzz-0001', 'código NFKC sin espacios');
  ok(!('companyName' in employeeBody), 'empleado no envía empresa');
  ok(!('password' in employeeBody) && !('email' in employeeBody), 'empleado sin contraseña ni email personal');
  eq(employeeBody.companyEmail, 'a@b.test', 'correo principal identifica empresa');

  eq(helpers.classifySessionCheck(200), 'ok', 'clasifica 200');
  eq(helpers.classifySessionCheck(409, 'device_conflict'), 'conflict', 'clasifica conflicto');
  eq(helpers.classifySessionCheck(409, 'other'), 'unknown', '409 sin código no expulsa');
  eq(helpers.classifySessionCheck(401), 'expired', 'clasifica 401');
  eq(helpers.classifySessionCheck(502), 'unknown', '502 no expulsa');

  // Integración: el cuerpo construido por la app lo acepta el servidor real.
  const appStore = memoryStore();
  const appDevice = await helpersWithCrypto.getOrCreateDeviceId(appStore);
  const appRegister = await server.call('POST', '/api/auth/register', { body: helpers.buildAuthRequestBody(form({ email: 'app@example.test' }), appDevice) });
  eq(appRegister.statusCode, 201, 'registro desde el cuerpo de la app');
  const appLogin = await server.call('POST', '/api/auth/login', { body: helpers.buildAuthRequestBody(form({ mode: 'login', email: 'app@example.test' }), await helpersWithCrypto.getOrCreateDeviceId(memoryStore())) });
  eq(appLogin.statusCode, 409, 'otro móvil (otro almacén) recibe conflicto');

  // Traducciones
  const { authTranslations } = loadModule(path.join(root, 'src/translations/auth.ts'));
  const { t, APP_LOCALES } = loadModule(path.join(root, 'src/i18n.ts'));
  const keys = Object.keys(authTranslations.es).sort();
  eq(APP_LOCALES.length, 8, '8 idiomas');
  for (const { code } of APP_LOCALES) {
    eq(JSON.stringify(Object.keys(authTranslations[code]).sort()), JSON.stringify(keys), `claves ${code}`);
    for (const key of keys) {
      ok(authTranslations[code][key].trim(), `${code} ${key} no vacío`);
      eq(t(code, key), authTranslations[code][key], `${code} ${key} resuelto por t()`);
    }
  }
  const validationKeys = new Set(cases.map(([, key]) => key).filter(Boolean));
  for (const key of validationKeys) ok(keys.includes(key), `clave de validación ${key} traducida`);

  // Estructura del formulario y del flujo en index.tsx (AST)
  const appSource = fs.readFileSync(path.join(root, 'src/app/index.tsx'), 'utf8');
  const usedKeys = new Set([...appSource.matchAll(/tr(?:Ref\.current)?\('(auth\.[A-Za-z]+)'\)/g)].map((match) => match[1]));
  for (const key of usedKeys) ok(keys.includes(key) || ['auth.signOut', 'auth.signOutTitle', 'auth.signOutMessage', 'auth.signOutConfirm', 'auth.signOutCancel', 'auth.signOutDone'].includes(key), `clave usada ${key} existe`);
  const sourceFile = ts.createSourceFile('index.tsx', appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const jsxById = new Map();
  const conditionsOf = (node) => {
    const conditions = [];
    for (let current = node.parent; current; current = current.parent) {
      if (ts.isConditionalExpression(current)) {
        const inWhenTrue = node.pos >= current.whenTrue.pos && node.end <= current.whenTrue.end;
        conditions.push(`${inWhenTrue ? '' : '!'}(${current.condition.getText()})`);
      }
      if (ts.isIfStatement(current)) conditions.push(current.expression.getText());
    }
    return conditions;
  };
  const visit = (node) => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const testId = node.attributes.properties.find((attr) => ts.isJsxAttribute(attr) && attr.name.getText() === 'testID');
      if (testId?.initializer && ts.isStringLiteral(testId.initializer)) {
        const attrs = Object.fromEntries(node.attributes.properties.filter(ts.isJsxAttribute).map((attr) => [attr.name.getText(), attr.initializer ? attr.initializer.getText() : 'true']));
        jsxById.set(testId.initializer.text, { tag: node.tagName.getText(), attrs, conditions: conditionsOf(node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const element = (id) => {
    const found = jsxById.get(id);
    ok(found, `existe ${id}`);
    return found;
  };
  const inside = (id, condition) => element(id).conditions.includes(condition);
  for (const id of ['auth-tab-login', 'auth-tab-register']) {
    eq(element(id).tag, 'Pressable', `${id} es botón`);
    ok(inside(id, '!accessToken'), `${id} en la pantalla de acceso`);
  }
  for (const id of ['auth-role-principal', 'auth-role-empleado']) ok(inside(id, '(authRegistrationRole === null)'), 'selector antes del formulario');
  ok(inside('auth-company-name', "(authRegistrationRole === 'principal' && authMode === 'register')"), 'empresa solo registro principal');
  ok(inside('auth-employee-code', "(authRegistrationRole === 'empleado')"), 'código solo para usuario adicional');
  ok(inside('auth-password', "(authRegistrationRole === 'principal')"), 'contraseña solo principal');
  ok(inside('auth-full-name', "(authRegistrationRole === 'empleado' || authMode === 'register')"), 'nombre adicional y registro principal');
  ok(appSource.includes("useState<UserRole | null>(null)"), 'inicio sin rol seleccionado');
  eq(element('auth-password').attrs.secureTextEntry, 'true', 'contraseña oculta');
  ok(!('secureTextEntry' in element('auth-employee-code').attrs), 'código de empleado visible para evitar errores');
  eq(element('auth-employee-code').attrs.autoCorrect, '{false}', 'código sin autocorrección');
  eq(element('auth-submit').attrs.disabled, '{!authReady}', 'enviar deshabilitado hasta tener dispositivo');
  ok(/const authReady = authRegistrationRole !== null && deviceIdStatus === 'ready' && !authSubmitting;/.test(appSource), 'authReady depende del rol y dispositivo');

  const fnBody = (name) => {
    let found = null;
    const find = (node) => {
      if (ts.isVariableDeclaration(node) && node.name.getText() === name && node.initializer) found = node.initializer.getText();
      if (!found) ts.forEachChild(node, find);
    };
    find(sourceFile);
    ok(found, `función ${name}`);
    return found;
  };
  const submit = fnBody('submitAuth');
  ok(submit.includes('validateAuthForm(form)') && submit.indexOf('validateAuthForm(form)') < submit.indexOf('fetchWithTimeout'), 'valida antes de enviar');
  ok(submit.includes('await resolveDeviceId()') && submit.indexOf('await resolveDeviceId()') < submit.indexOf('fetchWithTimeout'), 'obtiene el deviceId antes de enviar');
  ok(/if \(!currentDeviceId\) \{[\s\S]*?return;/.test(submit), 'sin deviceId no se envía');
  ok(submit.includes('buildAuthRequestBody(form, currentDeviceId, forceDevice)'), 'cuerpo con deviceId para login y registro');
  ok(!appSource.includes('@tpv_device_id_v1'), 'no se reutiliza el ID de AsyncStorage');
  ok(!/AsyncStorage\.[a-zA-Z]+\([^)]*device/i.test(appSource), 'deviceId fuera de AsyncStorage');
  ok(appSource.includes('AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY'), 'Keychain solo de este dispositivo');
  eq((appSource.match(/X-Device-Force/g) || []).length, 1, 'solo el arranque pide traslado explícito');
  const monitorStart = appSource.indexOf('const checkActiveSession = async');
  const monitor = appSource.slice(monitorStart, appSource.indexOf('}, [accessToken]);', monitorStart));
  ok(monitor.includes('SESSION_CHECK_INTERVAL_MS') && monitor.includes("AppState.addEventListener('change'"), 'monitor por intervalo y primer plano');
  ok(monitor.includes("outcome === 'conflict'") && monitor.includes('await clearStoredSessionRef.current()'), 'monitor cierra la sesión local en conflicto');
  ok(!monitor.includes('X-Device-Force'), 'monitor no reclama la sesión');
  ok(/const SESSION_CHECK_INTERVAL_MS = 30000;/.test(appSource), 'intervalo de 30 s');
  const refresh = fnBody('refreshUserSession');
  ok(refresh.includes("outcome === 'conflict'") && refresh.includes('clearStoredSession'), 'refresh con 409 cierra la sesión local');
  ok(fnBody('signOut').includes('/api/auth/logout'), 'cerrar sesión libera el dispositivo');
};

(async () => {
  const server = await runServerTests();
  await runAppTests(server);
  console.log(`check-auth-sessions: ${checks} comprobaciones OK`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
