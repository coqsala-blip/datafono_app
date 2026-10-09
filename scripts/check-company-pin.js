#!/usr/bin/env node
const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.dirname(require.resolve('../package.json'));
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
let checks = 0;
const equal = (actual, expected, message) => {
  assert.deepStrictEqual(clone(actual), clone(expected), message);
  checks += 1;
};

const loadServer = () => {
  const state = { users: [], tokens: new Map(), documents: [], queries: [], logs: [], now: Date.now(), hashes: 0, comparisons: 0 };
  const client = {
    auth: {
      async getUser(token) {
        return { data: { user: clone(state.users.find((user) => user.id === state.tokens.get(token))) }, error: null };
      },
      admin: {
        async getUserById(id) {
          return { data: { user: clone(state.users.find((user) => user.id === id)) }, error: null };
        },
        async updateUserById(id, payload) {
          if (state.beforeMetadata) await state.beforeMetadata();
          if (state.failMetadata) return { data: null, error: { message: 'Sensitive upstream failure' } };
          const user = state.users.find((candidate) => candidate.id === id);
          Object.assign(user, clone(payload));
          return { data: { user: clone(user) }, error: null };
        },
        async listUsers({ page, perPage }) {
          if (state.failUsers) return { data: null, error: { message: 'Membership unavailable' } };
          return { data: { users: clone(state.users.slice((page - 1) * perPage, page * perPage)) }, error: null };
        },
      },
    },
    from(table) {
      assert.equal(table, 'documents');
      const record = { filters: [] };
      state.queries.push(record);
      const query = {
        select(columns) { record.columns = columns; return query; },
        in(column, values) { record.filters.push(['in', column, [...values]]); return query; },
        eq(column, value) { record.filters.push(['eq', column, value]); return query; },
        order(column, options) { record.order = [column, options]; return query; },
        limit(value) { record.limit = value; return query; },
        async insert(row) {
          if (state.beforeInsert) await state.beforeInsert();
          if (state.failInsert) return { error: { message: 'Sensitive upstream failure' } };
          state.documents.push({ created_at: new Date(state.now++).toISOString(), ...clone(row) });
          return { error: null };
        },
        then(resolve, reject) {
          if (state.failRead) return Promise.resolve({ data: null, error: { message: 'Sensitive upstream failure' } }).then(resolve, reject);
          let rows = state.documents.filter((row) => record.filters.every(([operator, column, value]) => {
            const actual = column === 'document_data->>id' ? row.document_data.id : row[column];
            return operator === 'in' ? value.includes(actual) : actual === value;
          }));
          if (record.order) {
            const [column, options] = record.order;
            rows = [...rows].sort((left, right) => String(left[column]).localeCompare(String(right[column])) * (options.ascending ? 1 : -1));
          }
          if (record.limit) rows = rows.slice(0, record.limit);
          return Promise.resolve({ data: clone(rows), error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  const routes = new Map();
  const app = { set() {}, use() {}, listen() {} };
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    app[method] = (route, ...handlers) => routes.set(`${method.toUpperCase()} ${route}`, handlers);
  }
  const express = () => app;
  express.json = express.raw = express.urlencoded = () => () => undefined;
  const modules = {
    dotenv: { config() {} }, express, crypto: {
      ...crypto,
      scrypt(...args) { state.hashes += 1; return crypto.scrypt(...args); },
      timingSafeEqual(...args) { state.comparisons += 1; return crypto.timingSafeEqual(...args); },
    }, qrcode: { toDataURL: async () => '' },
    stripe: () => { throw new Error('Stripe must not be called'); },
    '@supabase/supabase-js': { createClient: () => client },
  };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [state.now])); }
    static now() { return state.now; }
  }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'server/src/server.js'), 'utf8'), {
    require(name) {
      if (name === './stripe-connect') return require('../server/src/stripe-connect');
      if (name === './stripe-connect-env') return require('../server/src/stripe-connect-env');
      assert.ok(name in modules, `Unexpected module: ${name}`); return modules[name];
    },
    process: { env: { PUBLIC_API_URL: 'http://localhost:4000', NODE_ENV: 'test', SUPABASE_URL: 'http://supabase.test', SUPABASE_SECRET_KEY: 'test' } },
    console: Object.fromEntries(['log', 'warn', 'error', 'info'].map((method) => [method, (...args) => state.logs.push(args)])),
    Buffer, URL, Date: Clock, setTimeout, clearTimeout, setImmediate,
  }, { filename: 'server.js' });
  const call = async (method, route, { userId, body = {}, sessionId } = {}) => {
    const handlers = routes.get(`${method} ${route}`);
    assert.ok(handlers, `Route registered: ${route}`);
    const token = userId ? `header.${Buffer.from(JSON.stringify({ sub: userId, session_id: sessionId || `session-${userId}` })).toString('base64url')}.signature` : null;
    if (token) state.tokens.set(token, userId);
    const req = { method, path: route, body, query: {}, params: {}, headers: token ? { authorization: `Bearer ${token}` } : {} };
    const res = {
      statusCode: 200, body: null,
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = clone(value); return this; },
    };
    const run = async (index) => {
      let next;
      await handlers[index](req, res, () => { next = run(index + 1); return next; });
      if (next) await next;
    };
    await run(0);
    assert.notEqual(res.body, null, 'Handler completed');
    return res;
  };
  const user = (id, role, ownerId) => ({
    id, app_metadata: { active_session_id: `session-${id}`, role, ...(ownerId ? { company_owner_id: ownerId } : {}) },
    user_metadata: { role: 'principal', company_owner_id: 'owner-b', company_refund_pin: '9999' },
  });
  state.users = [user('owner-a', 'principal'), user('employee-a', 'empleado', 'owner-a'), user('owner-b', 'principal'), user('employee-b', 'empleado', 'owner-b')];
  return { state, call, user };
};

const main = async () => {
  const { state, call, user } = loadServer();
  const document = {
    id: 'sale', ticketCode: 'T-1', amount: 100, documentType: 'TICKET DE VENTA', type: 'COBRO',
    createdAt: '2026-10-01T10:00:00.000Z', ivaRateApplied: 21, subtotal: 100 / 1.21, iva: 100 - 100 / 1.21,
    issuer: { name: 'Company A', nif: 'fixture' }, client: { name: 'Client' }, items: [{ description: 'Item', amount: 100 }],
  };
  const legacy = loadServer();
  delete legacy.state.users[0].app_metadata.role;
  equal((await legacy.call('POST', '/api/company/pin', { userId: 'owner-a', body: { pin: '1234' } })).statusCode, 200, 'Legacy principal can configure PIN without explicit role');
  equal((await legacy.call('GET', '/api/company/pin/status', { userId: 'employee-a' })).body, { configured: true }, 'Employee resolves legacy principal PIN');
  equal((await legacy.call('POST', '/api/documents', { userId: 'employee-a', body: document })).statusCode, 201, 'Legacy company charge');
  equal((await legacy.call('POST', '/api/documents/refund', { userId: 'employee-a', body: { documentId: 'sale', amount: 10, pin: '1234' } })).body.document.amount, 90, 'Legacy company employee refund authorized');
  equal((await legacy.call('POST', '/api/company/pin', { userId: 'employee-a', body: { pin: '5678' } })).statusCode, 403, 'Legacy principal does not grant employee PIN setup');
  equal((await legacy.call('POST', '/api/documents/refund', { userId: 'owner-a', body: { documentId: 'sale', amount: 10 } })).statusCode, 200, 'Legacy principal can refund without employee PIN');
  const mixedRefunds = loadServer();
  await mixedRefunds.call('POST', '/api/company/pin', { userId: 'owner-a', body: { pin: '1234' } });
  await mixedRefunds.call('POST', '/api/documents', { userId: 'owner-a', body: document });
  const principalPartial = await mixedRefunds.call('POST', '/api/documents/refund', { userId: 'owner-a', body: { documentId: 'sale', amount: 30 } });
  equal(principalPartial.body.document.amount, 70, 'First partial refund from principal');
  equal((await mixedRefunds.call('POST', '/api/documents/refund', { userId: 'employee-a', body: { documentId: 'sale', amount: 71, pin: '1234' } })).statusCode, 409, 'Employee cannot exceed balance after principal refund');
  const employeePartial = await mixedRefunds.call('POST', '/api/documents/refund', { userId: 'employee-a', body: { documentId: 'sale', amount: 20, pin: '1234' } });
  equal(employeePartial.statusCode, 200, 'Employee can make second refund after principal');
  equal(employeePartial.body.document.amount, 50, 'Second refund uses authoritative remaining balance');
  equal(employeePartial.body.document.originalAmount, 100, 'Mixed refunds keep original sale amount');
  equal(employeePartial.body.document.refundHistory.map(entry => entry.amount), [30, 20], 'Mixed refunds retain both history entries');
  equal((await call('POST', '/api/documents', { userId: 'employee-a', body: document })).statusCode, 201, 'Employee can publish a charge');
  for (const fields of [
    { type: 'DEVOLUCION' }, { type: 'DEVOLUCIÓN' }, { documentType: 'COMPRA/DEVOLUCIONES' },
    { documentType: 'TICKET DE DEVOLUCIÓN' }, { refundHistory: [{ amount: 1, date: 'today' }] }, { isRefunded: true },
  ]) {
    const count = state.documents.length;
    equal((await call('POST', '/api/documents', { userId: 'employee-a', body: { ...document, ...fields } })).statusCode, 403, 'Employee cannot bypass refund authorization');
    equal(state.documents.length, count, 'Rejected publication performs no insert');
  }
  equal((await call('GET', '/api/company/pin/status', { userId: 'employee-a' })).body, { configured: false }, 'Only boolean status before setup');
  equal((await call('POST', '/api/company/pin', { userId: 'employee-a', body: { pin: '1234' } })).statusCode, 403, 'Employee cannot set PIN');
  equal((await call('POST', '/api/company/pin', { userId: 'owner-a', body: { pin: '1234' } })).body, { ok: true, configured: true }, 'Initial local PIN upload');
  const metadata = state.users[0].app_metadata;
  equal(metadata.company_refund_pin_hash, crypto.scryptSync('1234', metadata.company_refund_pin_salt, 64).toString('hex'), 'Real salted scrypt hash');
  equal((await call('GET', '/api/company/pin/status', { userId: 'employee-a' })).body, { configured: true }, 'Only boolean status after setup');
  equal((await call('POST', '/api/documents/refund', { userId: 'employee-a', body: { documentId: 'sale', amount: 10, pin: '0000' } })).statusCode, 403, 'Bad PIN cannot refund');
  const refund = await call('POST', '/api/documents/refund', { userId: 'employee-a', body: { documentId: 'sale', amount: 10, pin: '1234' } });
  equal(refund.statusCode, 200, 'Employee refund with principal PIN');
  equal(refund.body.document.amount, 90, 'Balance reduced');
  equal(refund.body.document.originalAmount, 100, 'Original amount retained');
  equal(refund.body.document.documentType, 'COMPRA/DEVOLUCIONES', 'Original charge revision');
  equal(state.queries.at(-2).filters, [['in', 'user_id', ['owner-a', 'employee-a']], ['eq', 'document_data->>id', 'sale']], 'Company and document filters enforced');
  equal((await call('POST', '/api/documents', { userId: 'employee-a', body: document })).statusCode, 403, 'Employee cannot reset refunded balance via clean publication');
  equal(refund.body.document.subtotal, 90 / 1.21, 'Subtotal recalculated from stored VAT rate');
  equal(refund.body.document.iva, 90 - 90 / 1.21, 'VAT recalculated');
  for (const field of ['id', 'ticketCode', 'type', 'issuer', 'client', 'items', 'createdAt', 'ivaRateApplied']) {
    equal(refund.body.document[field], document[field], `Preserved field ${field}`);
  }
  equal(refund.body.document.refundHistory.length, 1, 'Refund history appended');
  equal(refund.body.document.refundHistory[0].amount, 10, 'History uses authorized amount');
  equal(Number.isFinite(Date.parse(refund.body.document.refundHistory[0].date)), true, 'History contains server date');
  equal(state.documents.at(-1).user_id, 'owner-a', 'Refund revision owned by principal');
  equal(state.documents.at(-1).document_data.publicUrl, undefined, 'URL not stored in document data');
  equal(state.documents[0].document_data.amount, 100, 'Previous published snapshot unchanged');
  equal(state.documents.at(-1).public_token.length, 48, 'Random publication token');
  equal(state.documents[0].public_token !== state.documents.at(-1).public_token, true, 'New token for revision');
  equal(state.comparisons >= 2, true, 'Constant-time comparison used for PINs');
  equal((await call('GET', '/api/company/pin/status', { userId: 'owner-b' })).body, { configured: false }, 'Company B independent PIN');
  for (const fields of [{ pin: 1234 }, { pin: '123' }, { pin: '123456789' }, { pin: ' 1234' }, { pin: 'abcd' }, {}]) {
    equal((await call('POST', '/api/company/pin', { userId: 'owner-b', body: fields })).statusCode, 400, 'PIN format rejected');
  }
  const beforeChange = clone(metadata);
  for (const currentPin of [undefined, '0000', 1234]) {
    equal((await call('POST', '/api/company/pin', { userId: 'owner-a', body: { pin: '5678', currentPin } })).statusCode, 403, 'Change requires current PIN');
    equal(state.users[0].app_metadata, beforeChange, 'Failed change keeps metadata unchanged');
  }
  equal((await call('POST', '/api/company/pin', { userId: 'owner-a', body: { pin: '5678', currentPin: '1234', company_owner_id: 'owner-b' } })).statusCode, 200, 'Verified PIN rotation');
  const rotated = state.users[0].app_metadata;
  equal(rotated.company_refund_pin_salt !== metadata.company_refund_pin_salt, true, 'Rotation gets new salt');
  equal(rotated.company_refund_pin_hash, crypto.scryptSync('5678', rotated.company_refund_pin_salt, 64).toString('hex'), 'Rotated PIN hash');
  equal(rotated.active_session_id, 'session-owner-a', 'Other app metadata preserved');
  equal(rotated.role, 'principal', 'Role preserved');
  equal(state.users[1].app_metadata.company_refund_pin_hash, undefined, 'No PIN metadata on employee');
  equal((await call('POST', '/api/documents/refund', { userId: 'employee-a', body: { documentId: 'sale', amount: 1, pin: '1234' } })).statusCode, 403, 'Old PIN rejected after rotation');
  equal((await call('POST', '/api/documents/refund', { userId: 'employee-a', body: { documentId: 'sale', amount: 1, pin: '9999' } })).statusCode, 403, 'User-editable metadata PIN not trusted');
  equal((await call('POST', '/api/documents/refund', { userId: 'employee-a', body: { documentId: 'sale', amount: 1, pin: '5678', user_id: 'owner-b', issuer: { name: 'Spoof' }, originalAmount: 5000, refundHistory: [], type: 'DEVOLUCION' } })).body.document.amount, 89, 'Only requested ID, amount and PIN used');
  equal(state.documents.at(-1).document_data.issuer, document.issuer, 'Body cannot replace issuer');
  equal(state.documents.at(-1).document_data.originalAmount, 100, 'Body cannot replace original amount');

  for (const [method, route] of [['GET', '/api/company/pin/status'], ['POST', '/api/company/pin'], ['POST', '/api/documents/refund']]) {
    const requestBody = { pin: '5678', documentId: 'sale', amount: 1 };
    const count = state.documents.length;
    for (const [options, status] of [[{}, 401], [{ userId: 'unknown' }, 401], [{ userId: 'employee-a', sessionId: 'old-session' }, 409]]) {
      equal((await call(method, route, { ...options, body: requestBody })).statusCode, status, `Authentication enforced ${route}`);
    }
    for (const [id, role, ownerId] of [
      ['no-role-linked', undefined, 'owner-a'], ['wrong-role', 'admin', undefined],
      ['unlinked', 'empleado', undefined], ['self-linked', 'empleado', 'self-linked'],
      ['missing-owner', 'empleado', 'absent'], ['employee-owner', 'empleado', 'employee-a'],
      ['spoof-principal', 'principal', 'owner-a'],
    ]) {
      if (!state.users.some((candidate) => candidate.id === id)) state.users.push(user(id, role, ownerId));
      equal((await call(method, route, { userId: id, body: requestBody })).statusCode, 403, `Reject invalid role/company ${id} ${route}`);
    }
    equal(state.documents.length, count, 'Unauthorized calls cannot insert');
  }
  state.users.push(user('unbound', 'principal'));
  delete state.users.at(-1).app_metadata.active_session_id;
  equal((await call('GET', '/api/company/pin/status', { userId: 'unbound' })).statusCode, 409, 'Unbound session rejected');

  const retries = loadServer();
  await retries.call('POST', '/api/company/pin', { userId: 'owner-a', body: { pin: '1234' } });
  await retries.call('POST', '/api/company/pin', { userId: 'owner-b', body: { pin: '1234' } });
  await retries.call('POST', '/api/documents', { userId: 'owner-a', body: document });
  const refundCall = (actor, pin = '0000') => retries.call('POST', '/api/documents/refund', { userId: actor, body: { documentId: 'sale', amount: 1, pin } });
  const firstFailureAt = retries.state.now;
  for (let attempt = 0; attempt < 5; attempt += 1) equal((await refundCall('employee-a')).statusCode, 403, 'Five PIN attempts permitted');
  const hashesAfterFailures = retries.state.hashes;
  equal((await refundCall('employee-a', '1234')).statusCode, 429, 'Correct PIN blocked after five failures');
  equal(retries.state.hashes, hashesAfterFailures, 'Rate limit checked before scrypt');
  equal((await refundCall('employee-a')).body.retryAfterSeconds, 900, '15-minute retry TTL');
  equal((await retries.call('GET', '/api/company/pin/status', { userId: 'employee-a' })).body, { configured: true }, 'Status available while locked');
  equal((await retries.call('POST', '/api/company/pin', { userId: 'owner-a', body: { pin: '5678', currentPin: '0000' } })).statusCode, 403, 'Principal has independent actor attempts');
  retries.state.users.push(retries.user('employee-other', 'empleado', 'owner-a'));
  equal((await refundCall('employee-other', '1234')).statusCode, 200, 'Another company actor not locked');
  retries.state.users[1].app_metadata.company_owner_id = 'owner-b';
  equal((await refundCall('employee-a', '1234')).statusCode, 404, 'Same actor has independent account limit');
  retries.state.users[1].app_metadata.company_owner_id = 'owner-a';
  retries.state.now = firstFailureAt + 15 * 60 * 1000 - 1;
  equal((await refundCall('employee-a', '1234')).statusCode, 429, 'Limit active just before expiry');
  retries.state.now += 1;
  equal((await refundCall('employee-a', '1234')).statusCode, 200, 'Limit expires at 15 minutes');
  for (let attempt = 0; attempt < 4; attempt += 1) await refundCall('employee-a');
  equal((await refundCall('employee-a', '1234')).statusCode, 200, 'Valid PIN before limit resets failures');
  for (let attempt = 0; attempt < 5; attempt += 1) equal((await refundCall('employee-a', undefined)).statusCode, 403, 'New five-attempt budget after success');
  equal((await refundCall('employee-a', '1234')).statusCode, 429, 'New budget still bounded');

  const isolated = loadServer();
  await isolated.call('POST', '/api/company/pin', { userId: 'owner-a', body: { pin: '1234' } });
  await isolated.call('POST', '/api/documents', { userId: 'owner-b', body: { ...document, id: 'foreign' } });
  const beforeForeign = isolated.state.documents.length;
  equal((await isolated.call('POST', '/api/documents/refund', { userId: 'employee-a', body: { documentId: 'foreign', amount: 1, pin: '1234', company_owner_id: 'owner-b' } })).statusCode, 404, 'Cross-company document hidden');
  equal(isolated.state.documents.length, beforeForeign, 'Cross-company request cannot write');
  equal((await isolated.call('POST', '/api/documents/refund', { userId: 'owner-a', body: { documentId: 'foreign', amount: 1 } })).statusCode, 404, 'Principal cannot refund foreign company');
  isolated.state.documents.push({ user_id: 'employee-a', document_data: { ...document, id: 'legacy' }, created_at: '2020-01-01T00:00:00.000Z', public_token: 'legacy-token' });
  isolated.state.documents.push(...Array.from({ length: 510 }, (_, index) => ({ user_id: 'owner-a', document_data: { ...document, id: `other-${index}` }, created_at: '2030-01-01T00:00:00.000Z' })));
  equal((await isolated.call('POST', '/api/documents/refund', { userId: 'employee-a', body: { documentId: 'legacy', amount: 20, pin: '1234' } })).body.document.amount, 80, 'Legacy employee document found beyond latest 500');
  equal(isolated.state.queries.at(-2).order, ['created_at', { ascending: false }], 'Newest revision ordered');
  equal(isolated.state.queries.at(-2).limit, 1, 'Document-specific limit one');
  await isolated.call('POST', '/api/documents', { userId: 'owner-b', body: { ...document, id: 'legacy', amount: 5000 } });
  const second = await isolated.call('POST', '/api/documents/refund', { userId: 'employee-a', body: { documentId: 'legacy', amount: 80, pin: '1234' } });
  equal(second.body.document.amount, 0, 'Latest company revision used, not foreign same ID');
  equal(second.body.document.originalAmount, 100, 'Original amount persists across revisions');
  equal(second.body.document.refundHistory.map((entry) => entry.amount), [20, 80], 'Refund history accumulates');
  equal(second.body.document.isRefunded, true, 'Full depletion marked');
  equal(second.body.document.subtotal, 0, 'Zero subtotal on full refund');
  equal(second.body.document.iva, 0, 'Zero VAT on full refund');
  equal((await isolated.call('POST', '/api/documents/refund', { userId: 'owner-a', body: { documentId: 'legacy', amount: 0.01 } })).statusCode, 409, 'Cannot refund depleted document');
  equal((await isolated.call('POST', '/api/documents', { userId: 'employee-a', body: second.body.document })).statusCode, 403, 'Identical refund republication forbidden for employee');

  const bounds = loadServer();
  await bounds.call('POST', '/api/documents', { userId: 'owner-a', body: document });
  for (const amount of [0, -1, NaN, Infinity, -Infinity, '10', null, undefined, {}, 0.001, 1.234, Number.MAX_VALUE]) {
    equal((await bounds.call('POST', '/api/documents/refund', { userId: 'owner-a', body: { documentId: 'sale', amount } })).statusCode, 400, 'Invalid amount rejected');
  }
  for (const documentId of [null, undefined, '', '  ', 42, {}]) {
    equal((await bounds.call('POST', '/api/documents/refund', { userId: 'owner-a', body: { documentId, amount: 1 } })).statusCode, 400, 'Invalid document ID rejected');
  }
  equal((await bounds.call('POST', '/api/documents/refund', { userId: 'owner-a', body: { documentId: 'sale', amount: 100.01 } })).statusCode, 409, 'Overdraw rejected');
  equal((await bounds.call('POST', '/api/documents/refund', { userId: 'employee-a', body: { documentId: 'sale', amount: 1, pin: '9999' } })).body.code, 'pin_not_configured', 'Missing principal PIN fails closed');
  equal((await bounds.call('POST', '/api/documents/refund', { userId: 'owner-a', body: { documentId: 'sale', amount: 1 } })).statusCode, 200, 'Principal allowed without PIN or configuration');
  for (const [index, fields] of [
    { type: 'DEVOLUCION' }, { type: undefined }, { type: 'PRESUPUESTO' },
    { originalAmount: 99 }, { refundHistory: [{ amount: -1 }] }, { refundHistory: [{ amount: '1' }] },
    { refundHistory: {} }, { amount: -1 }, { amount: 0 }, { isRefunded: true },
    { ivaRateApplied: '21' }, { ivaRateApplied: -1 },
  ].entries()) {
    const id = `invalid-${index}`;
    bounds.state.documents.push({ user_id: 'owner-a', created_at: new Date(bounds.state.now++).toISOString(), document_data: { ...document, id, ...fields } });
    equal((await bounds.call('POST', '/api/documents/refund', { userId: 'owner-a', body: { documentId: id, amount: 1 } })).statusCode, 409, 'Invalid stored charge rejected');
  }
  await bounds.call('POST', '/api/documents', { userId: 'owner-a', body: { ...document, id: 'decimal', amount: 0.3, originalAmount: 0.3, ivaRateApplied: 0 } });
  equal((await bounds.call('POST', '/api/documents/refund', { userId: 'owner-a', body: { documentId: 'decimal', amount: 0.1 + 0.2 } })).body.document.amount, 0, 'Cent arithmetic avoids floating-point residue');

  for (const [amounts, expectedStatuses, expectedBalance] of [[[70, 70], [200, 409], 30], [[40, 40], [200, 200], 20], [Array(10).fill(20), [...Array(5).fill(200), ...Array(5).fill(409)], 0]]) {
    const concurrent = loadServer();
    await concurrent.call('POST', '/api/company/pin', { userId: 'owner-a', body: { pin: '1234' } });
    await concurrent.call('POST', '/api/documents', { userId: 'owner-a', body: document });
    const results = await Promise.all(amounts.map((amount) => concurrent.call('POST', '/api/documents/refund', { userId: 'employee-a', body: { documentId: 'sale', amount, pin: '1234' } })));
    equal(results.map((result) => result.statusCode).sort(), [...expectedStatuses].sort(), 'Concurrent refunds respect balance');
    equal(concurrent.state.documents.at(-1).document_data.amount, expectedBalance, 'No lost refund update');
    equal(concurrent.state.documents.at(-1).document_data.refundHistory.length, expectedStatuses.filter((status) => status === 200).length, 'Every successful concurrent refund persisted');
    equal(concurrent.state.documents.length, 1 + expectedStatuses.filter((status) => status === 200).length, 'Only authorized refund revisions inserted');
  }
  const setupRace = loadServer();
  const created = await Promise.all(['1234', '5678'].map((pin) => setupRace.call('POST', '/api/company/pin', { userId: 'owner-a', body: { pin } })));
  equal(created.map((result) => result.statusCode).sort(), [200, 403], 'Concurrent initial PIN uploads cannot overwrite');
  const initialPin = created[0].statusCode === 200 ? '1234' : '5678';
  const changed = await Promise.all(['2468', '8642'].map((pin) => setupRace.call('POST', '/api/company/pin', { userId: 'owner-a', body: { pin, currentPin: initialPin } })));
  equal(changed.map((result) => result.statusCode).sort(), [200, 403], 'Concurrent PIN changes recheck current hash');

  const simultaneousPins = loadServer();
  await simultaneousPins.call('POST', '/api/company/pin', { userId: 'owner-a', body: { pin: '0123', company_refund_pin_salt: 'fake', company_refund_pin_hash: 'fake' } });
  const pinMetadata = simultaneousPins.state.users[0].app_metadata;
  equal(pinMetadata.company_refund_pin_hash, crypto.scryptSync('0123', pinMetadata.company_refund_pin_salt, 64).toString('hex'), 'Leading zeros preserved, client hash/salt ignored');
  await simultaneousPins.call('POST', '/api/documents', { userId: 'owner-a', body: document });
  const invalidPins = await Promise.all(Array.from({ length: 8 }, () => simultaneousPins.call('POST', '/api/documents/refund', { userId: 'employee-a', body: { documentId: 'sale', amount: 1 } })));
  equal(invalidPins.map((result) => result.statusCode).sort(), [403, 403, 403, 403, 403, 429, 429, 429], 'Concurrent missing PIN attempts bounded by owner lock');
  equal(simultaneousPins.state.documents.length, 1, 'Bad concurrent PINs cannot insert');
  equal(simultaneousPins.state.comparisons, 5, 'Only five safe comparisons performed');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    equal((await simultaneousPins.call('POST', '/api/company/pin', { userId: 'owner-a', body: { pin: '12345678' } })).statusCode, 403, 'Missing current PIN consumes principal attempt');
  }
  equal((await simultaneousPins.call('POST', '/api/company/pin', { userId: 'owner-a', body: { pin: '12345678', currentPin: '0123' } })).statusCode, 429, 'PIN changes rate limited even with correct current PIN');
  simultaneousPins.state.now += 15 * 60 * 1000;
  equal((await simultaneousPins.call('POST', '/api/company/pin', { userId: 'owner-a', body: { pin: '12345678', currentPin: '0123' } })).statusCode, 200, 'PIN change available after TTL, eight digits accepted');

  const coordinated = loadServer();
  await coordinated.call('POST', '/api/company/pin', { userId: 'owner-a', body: { pin: '1234' } });
  await coordinated.call('POST', '/api/documents', { userId: 'owner-a', body: document });
  let release;
  let entered;
  const paused = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  coordinated.state.beforeMetadata = async () => { entered(); await paused; };
  const rotation = coordinated.call('POST', '/api/company/pin', { userId: 'owner-a', body: { pin: '5678', currentPin: '1234' } });
  await started;
  const duringRotation = coordinated.call('POST', '/api/documents/refund', { userId: 'employee-a', body: { documentId: 'sale', amount: 1, pin: '1234' } });
  release();
  equal((await rotation).statusCode, 200, 'Coordinated rotation finishes');
  equal((await duringRotation).statusCode, 403, 'Queued refund rechecks rotated PIN inside owner lock');
  coordinated.state.beforeMetadata = null;
  let releaseInsert;
  let enteredInsert;
  const insertion = new Promise((resolve) => { releaseInsert = resolve; });
  const insertStarted = new Promise((resolve) => { enteredInsert = resolve; });
  coordinated.state.beforeInsert = async () => { enteredInsert(); await insertion; };
  const inProgress = coordinated.call('POST', '/api/documents/refund', { userId: 'owner-a', body: { documentId: 'sale', amount: 1 } });
  await insertStarted;
  const republish = coordinated.call('POST', '/api/documents', { userId: 'employee-a', body: document });
  releaseInsert();
  equal((await inProgress).statusCode, 200, 'Refund insert finishes');
  equal((await republish).statusCode, 403, 'Concurrent employee publication cannot restore refunded balance');

  const failures = loadServer();
  failures.state.failMetadata = true;
  equal((await failures.call('POST', '/api/company/pin', { userId: 'owner-a', body: { pin: '1234' } })).body, { ok: false, error: 'No se pudo guardar el PIN.' }, 'Metadata error sanitized');
  equal(failures.state.users[0].app_metadata.company_refund_pin_hash, undefined, 'Failed setup not configured');
  failures.state.failMetadata = false;
  await failures.call('POST', '/api/company/pin', { userId: 'owner-a', body: { pin: '1234' } });
  await failures.call('POST', '/api/documents', { userId: 'owner-a', body: document });
  for (const failure of ['failRead', 'failInsert', 'failUsers']) {
    failures.state[failure] = true;
    const count = failures.state.documents.length;
    const failed = await failures.call('POST', '/api/documents/refund', { userId: 'employee-a', body: { documentId: 'sale', amount: 1, pin: '1234' } });
    equal(failed.statusCode, 500, `Storage failure ${failure} fails closed`);
    equal(failures.state.documents.length, count, 'Failed operation does not append revision');
    equal(JSON.stringify(failed.body).includes('Sensitive upstream failure'), false, 'Upstream error not exposed');
    failures.state[failure] = false;
  }
  equal((await failures.call('POST', '/api/documents/refund', { userId: 'owner-a', body: { documentId: 'sale', amount: 1 } })).statusCode, 200, 'Mutex released after failures');
  failures.state.users[0].app_metadata.company_refund_pin_hash = 'invalid';
  equal((await failures.call('GET', '/api/company/pin/status', { userId: 'employee-a' })).body, { configured: false }, 'Malformed hash not configured');
  equal((await failures.call('POST', '/api/company/pin', { userId: 'owner-a', body: { pin: '5678' } })).statusCode, 409, 'Malformed existing metadata cannot silently reset PIN');
  equal((await failures.call('POST', '/api/documents/refund', { userId: 'employee-a', body: { documentId: 'sale', amount: 1, pin: '1234' } })).statusCode, 409, 'Malformed PIN fails closed');
  failures.state.users[0].app_metadata.company_refund_pin_hash = '';
  failures.state.users[0].app_metadata.company_refund_pin_salt = '';
  equal((await failures.call('POST', '/api/company/pin', { userId: 'owner-a', body: { pin: '5678' } })).statusCode, 409, 'Empty corrupt credentials cannot silently reset PIN');
  for (const fixture of [state, retries.state, isolated.state, bounds.state, setupRace.state, coordinated.state, failures.state]) {
    equal(JSON.stringify(fixture.logs).includes('1234'), false, 'PIN never logged');
    equal(JSON.stringify(fixture.documents).includes('company_refund_pin'), false, 'PIN fields never persisted in documents');
  }
  console.log(`Company PIN: ${checks} checks passed (real handlers, VM mocks, no network).`);
};

main().catch((error) => { console.error(error); process.exitCode = 1; });