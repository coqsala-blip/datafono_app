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
  const state = {
    users: [], tokens: new Map(), documents: [], expenses: [], queries: [], pages: [],
    failPage: null, throwPage: null, failTable: null, malformedPage: null,
    payments: new Map(), stripeCalls: [],
  };
  const client = {
    auth: {
      async getUser(token) {
        const user = state.users.find((candidate) => candidate.id === state.tokens.get(token));
        return { data: { user: user ? clone(user) : null }, error: null };
      },
      admin: {
        async getUserById(id) {
          const user = state.users.find((candidate) => candidate.id === id);
          return { data: { user: user ? clone(user) : null }, error: null };
        },
        async listUsers({ page, perPage }) {
          state.pages.push({ page, perPage });
          if (state.throwPage === page) throw new Error('Auth unavailable');
          if (state.failPage === page) return { data: null, error: { message: 'Auth unavailable' } };
          if (state.malformedPage === page) return { data: {}, error: null };
          return { data: { users: clone(state.users.slice((page - 1) * perPage, page * perPage)) }, error: null };
        },
      },
    },
    from(table) {
      const record = { table, filters: [] };
      state.queries.push(record);
      const query = {
        select(columns) { record.columns = columns; return query; },
        in(column, values) { record.filters.push(['in', column, [...values]]); return query; },
        eq(column, value) { record.filters.push(['eq', column, value]); return query; },
        gte(column, value) { record.filters.push(['gte', column, value]); return query; },
        order(column, options) { record.order = [column, options]; return query; },
        limit(value) { record.limit = value; return query; },
        async insert(row) { state[table].push({ created_at: '2026-10-04T00:00:00.000Z', ...clone(row) }); return { error: null }; },
        async upsert(rows, options) {
          record.onConflict = options.onConflict;
          for (const row of clone(rows)) {
            const index = state[table].findIndex((existing) => options.onConflict.every((key) => existing[key] === row[key]));
            if (index === -1) state[table].push(row);
            else state[table][index] = row;
          }
          return { error: null };
        },
        then(resolve, reject) {
          if (state.failTable === table) return Promise.resolve({ data: null, error: { message: 'Database unavailable' } }).then(resolve, reject);
          let rows = state[table].filter((row) => record.filters.every(([operator, column, value]) => {
            if (operator === 'in') return value.includes(row[column]);
            if (operator === 'gte') return row[column] >= value;
            return row[column] === value;
          }));
          if (record.order) {
            const [column, options] = record.order;
            rows = [...rows].sort((left, right) => String(left[column]).localeCompare(String(right[column])) * (options.ascending ? 1 : -1));
          }
          if (record.limit) rows = rows.slice(0, record.limit);
          const columns = record.columns.split(',');
          return Promise.resolve({ data: clone(rows.map((row) => Object.fromEntries(columns.filter((column) => column in row).map((column) => [column, row[column]])))), error: null }).then(resolve, reject);
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
    dotenv: { config() {} }, express, crypto, qrcode: { toDataURL: async () => '' },
    stripe: () => ({
      paymentIntents: { async create(payload) { state.stripeCalls.push(clone(payload)); return { id: 'pi-test', client_secret: 'test-secret' }; } },
      checkout: { sessions: {
        async create(payload) { state.stripeCalls.push(clone(payload)); return { id: 'cs-test', url: 'https://checkout.test', metadata: payload.metadata }; },
        async retrieve(id) { return state.payments.get(id); },
      } },
    }), '@supabase/supabase-js': { createClient: () => client },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'server/src/server.js'), 'utf8'), {
    require(name) {
      if (name === './stripe-connect') return require('../server/src/stripe-connect');
      if (!(name in modules)) throw new Error(`Unexpected module: ${name}`);
      return modules[name];
    },
    process: { env: { STRIPE_SECRET_KEY: 'sk_test_fixture', PUBLIC_API_URL: 'http://localhost:4000', NODE_ENV: 'test', SUPABASE_URL: 'http://supabase.test', SUPABASE_SECRET_KEY: 'test' } },
    console: { log() {}, warn() {}, error() {}, info() {} },
    Buffer, URL, setTimeout, clearTimeout, setImmediate,
  }, { filename: 'server.js' });
  const tokenFor = (id, sessionId = `session-${id}`) => {
    const payload = { sub: id, session_id: sessionId, app_metadata: { company_owner_id: 'owner-b' } };
    const token = `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
    state.tokens.set(token, id);
    return token;
  };
  const call = async (method, route, { userId, token, body = {}, query = {}, params = {} } = {}) => {
    const handlers = routes.get(`${method} ${route}`);
    assert.ok(handlers, `Route registered: ${route}`);
    const accessToken = token || (userId ? tokenFor(userId) : null);
    const req = { method, path: route, body, query, params, headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {} };
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
    assert.notEqual(res.body, null, `Response completed: ${route}`);
    return res;
  };
  return { state, call, tokenFor };
};

const main = async () => {
  const { state, call, tokenFor } = loadServer();
  const user = (id, ownerId) => ({
    id, app_metadata: { active_session_id: `session-${id}`, ...(ownerId ? { role: 'empleado', company_owner_id: ownerId } : {}) },
    user_metadata: { company_owner_id: 'owner-b' },
  });
  state.users = [user('owner-a'), user('employee-a', 'owner-a'), user('owner-b'), user('employee-b', 'owner-b'), user('spoof')];
  state.users.push(...Array.from({ length: 995 }, (_, index) => user(`unrelated-${index}`)));
  state.users.push(user('employee-late', 'owner-a'));
  state.users.find((candidate) => candidate.id === 'spoof').user_metadata.company_owner_id = 'owner-a';
  for (const id of ['owner-a', 'employee-a', 'employee-late', 'owner-b', 'employee-b', 'spoof']) {
    state.documents.push({ user_id: id, document_data: { id: `old-${id}` }, public_token: id, created_at: '2026-10-01T00:00:00.000Z' });
    state.expenses.push({ user_id: id, local_id: `old-${id}`, description: id, amount: 5, date: '2026-10-01', based_on: 'client' });
  }
  state.documents.push({ document_data: { id: 'anonymous' }, created_at: '2026-10-01T00:00:00.000Z' });
  for (const id of ['owner-a', 'employee-a', 'employee-late', 'owner-b']) {
    const ownerId = id === 'owner-b' ? 'owner-b' : 'owner-a';
    const body = { id: `new-${id}`, ticketCode: id, documentType: 'ticket', amount: 12, user_id: 'spoof', company_owner_id: 'spoof', createdAt: '2026-10-04T00:00:00.000Z' };
    const published = await call('POST', '/api/documents', { userId: id, body });
    equal(published.statusCode, 201, `Publish ${id}`);
    equal(state.documents.at(-1).user_id, ownerId, `Authoritative document owner ${id}`);
    equal(state.documents.at(-1).document_data.user_id, undefined, 'Body user_id not persisted');
    equal(published.body.publicUrl, `http://localhost:4000/documents/${published.body.token}`, 'Public URL retained');
    const synced = await call('POST', '/api/expenses/sync', { userId: id, body: { user_id: 'spoof', expenses: [{ id: `new-${id}`, user_id: 'spoof', amount: 7 }] } });
    equal(synced.body, { ok: true, count: 1 }, `Sync expenses ${id}`);
    equal(state.expenses.at(-1).user_id, ownerId, `Authoritative expense owner ${id}`);
  }
  for (const id of ['owner-a', 'employee-a', 'employee-late', 'owner-b', 'employee-b', 'spoof']) {
    const companyIds = id === 'spoof' ? ['spoof'] : id.endsWith('-b') ? ['owner-b', 'employee-b'] : ['owner-a', 'employee-a', 'employee-late'];
    const expectedDocuments = state.documents.filter((row) => companyIds.includes(row.user_id)).map((row) => row.document_data.id).sort();
    const expectedExpenses = state.expenses.filter((row) => companyIds.includes(row.user_id)).map((row) => row.local_id).sort();
    for (const route of ['/api/documents', '/api/expenses', '/api/documents/sync-all']) {
      state.pages = [];
      const firstQuery = state.queries.length;
      const result = await call('GET', route, { userId: id, query: { user_id: 'spoof', company_owner_id: 'spoof' } });
      equal(result.statusCode, 200, `Read ${id} ${route}`);
      if (result.body.documents) equal(result.body.documents.map((row) => row.id).sort(), expectedDocuments, `Isolated documents ${id} ${route}`);
      if (result.body.expenses) equal(result.body.expenses.map((row) => row.local_id).sort(), expectedExpenses, `Isolated expenses ${id} ${route}`);
      equal(state.pages, [{ page: 1, perPage: 1000 }, { page: 2, perPage: 1000 }], 'Membership lookup paginated');
      for (const query of state.queries.slice(firstQuery)) equal(query.filters, [['in', 'user_id', companyIds]], 'Explicit company IN filter');
    }
  }
  for (const route of ['/api/documents', '/api/expenses', '/api/documents/sync-all']) {
    for (const failure of ['failPage', 'throwPage', 'malformedPage']) {
      state[failure] = 2;
      const queryCount = state.queries.length;
      equal((await call('GET', route, { userId: 'owner-a' })).statusCode, 500, `Membership failure ${failure} ${route}`);
      equal(state.queries.length, queryCount, 'No partial-history database read');
      state[failure] = null;
    }
    state.failTable = route === '/api/expenses' ? 'expenses' : 'documents';
    equal((await call('GET', route, { userId: 'owner-a' })).statusCode, 500, `Database error ${route}`);
    state.failTable = null;
  }
  state.failTable = 'expenses';
  equal((await call('GET', '/api/documents/sync-all', { userId: 'employee-a' })).statusCode, 500, 'Combined history expense failure surfaced');
  state.failTable = null;
  for (const [method, route] of [['POST', '/api/documents'], ['POST', '/api/expenses/sync'], ['GET', '/api/documents'], ['GET', '/api/expenses'], ['GET', '/api/documents/sync-all']]) {
    const queryCount = state.queries.length;
    equal((await call(method, route)).statusCode, 401, `Anonymous rejected ${route}`);
    equal((await call(method, route, { token: 'invalid' })).statusCode, 401, `Invalid token rejected ${route}`);
    equal((await call(method, route, { token: tokenFor('employee-a', 'old-session') })).statusCode, 409, `Moved session rejected ${route}`);
    equal(state.queries.length, queryCount, 'Unauthenticated request cannot access tables');
  }
  equal((await call('POST', '/api/documents', { userId: 'employee-a', body: { user_id: 'spoof' } })).statusCode, 400, 'Document validation retained');
  equal((await call('POST', '/api/expenses/sync', { userId: 'employee-a' })).statusCode, 400, 'Expense validation retained');
  const limited = await call('GET', '/api/documents', { userId: 'employee-a', query: { limit: 1, since: '2026-10-02' } });
  equal(limited.body.documents.length, 1, 'Since and limit preserved for stored timestamps');
  equal(limited.body.documents[0].id.startsWith('new-'), true, 'Since excludes legacy documents');
  equal(state.queries.at(-1).limit, 1, 'Requested limit preserved');
  for (const route of ['/api/stripe/payment-intent', '/api/stripe/payment']) {
    equal((await call('POST', route, { userId: 'employee-a', body: { amount: 12, orderId: 'test-order', supabase_user_id: 'owner-b' } })).statusCode, 201, 'Payment created');
    equal(state.stripeCalls.at(-1).metadata, {
      supabase_user_id: 'owner-a', operator_user_id: 'employee-a', order_id: 'test-order', charge_mode: 'platform',
    }, 'Payment owned by company with separate operator');
    if (route === '/api/stripe/payment') equal(state.stripeCalls.at(-1).payment_intent_data.metadata, state.stripeCalls.at(-1).metadata, 'Intent inherits owner metadata');
  }
  for (const paymentOwner of ['owner-a', 'employee-a', 'owner-b', 'employee-b', undefined]) {
    state.payments.set('payment-test', { id: 'payment-test', status: 'complete', payment_status: 'paid', metadata: { supabase_user_id: paymentOwner } });
    const params = { paymentId: 'payment-test' };
    const expected = ['owner-a', 'employee-a'].includes(paymentOwner) ? 200 : 403;
    equal((await call('GET', '/api/stripe/payment/:paymentId', { userId: 'employee-a', params })).statusCode, expected, 'Payment access restricted to company');
    equal((await call('GET', '/api/stripe/payment/:paymentId', { userId: 'owner-a', params })).statusCode, expected, 'Principal can read new and legacy company payments only');
  }
  console.log(`Company history: ${checks} checks passed (real server handlers, VM doubles, no network).`);
};

main().catch((error) => { console.error(error); process.exitCode = 1; });