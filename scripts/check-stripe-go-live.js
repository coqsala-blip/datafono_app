#!/usr/bin/env node
/**
 * Valida la configuración por fases (sin imprimir secretos):
 * Fase 1: billing live + Connect test.
 * Fase 2: Connect live (test apagado).
 *
 * Uso:
 *   node scripts/check-stripe-go-live.js
 *   node scripts/check-stripe-go-live.js --phase1-env   # lee process.env / server/.env vía dotenv si existe
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { resolveConnectMode } = require('../server/src/stripe-connect-env');

const PRICE = /^price_[A-Za-z0-9]+$/;
const WHSEC = /^whsec_[A-Za-z0-9]+$/;
const SK_TEST = /^sk_test_[A-Za-z0-9]+$/;
const SK_LIVE = /^sk_live_[A-Za-z0-9]+$/;

const assess = (env) => {
  const billingKey = env.STRIPE_SECRET_KEY || '';
  const billingMode = SK_LIVE.test(billingKey) ? 'live' : (SK_TEST.test(billingKey) ? 'test' : 'missing');
  const connect = resolveConnectMode(env);
  const connectMode = connect.enabled ? (connect.livemode ? 'live' : 'test') : 'off';
  const mainPrice = PRICE.test(env.STRIPE_MAIN_SUBSCRIPTION_PRICE_ID || '') ? 'ok' : 'missing';
  const addPrice = PRICE.test(env.STRIPE_ADDITIONAL_USER_PRICE_ID || '') ? 'ok' : 'missing';
  const webhook = WHSEC.test(env.STRIPE_WEBHOOK_SECRET || '') ? 'ok' : 'missing';
  // Typo frecuente en Render: COUNTRI en lugar de COUNTRIES.
  const countriesTypo = Object.prototype.hasOwnProperty.call(env, 'STRIPE_CONNECT_TEST_COUNTRI');
  const phase1Ready = billingMode === 'live' && connectMode === 'test' && mainPrice === 'ok'
    && addPrice === 'ok' && webhook === 'ok' && !countriesTypo && connect.code !== 'connect_mode_ambiguous';
  const phase2Ready = connectMode === 'live' && billingMode === 'live' && !countriesTypo;
  return {
    billingMode, connectMode, mainPrice, addPrice, webhook,
    countriesTypo,
    phase1Ready, phase2Ready,
    connectCode: connect.code,
  };
};

const main = () => {
  // Comprobaciones unitarias del resolver (sin secretos reales).
  assert.deepEqual(resolveConnectMode({}), { enabled: false, livemode: null, secretKey: null, countries: null, code: 'connect_disabled' });
  assert.equal(resolveConnectMode({
    STRIPE_CONNECT_TEST_ENABLED: 'true', STRIPE_CONNECT_TEST_SECRET_KEY: 'sk_test_abc',
  }).enabled, true);
  assert.equal(resolveConnectMode({
    STRIPE_CONNECT_TEST_ENABLED: 'true', STRIPE_CONNECT_TEST_SECRET_KEY: 'sk_test_abc',
  }).livemode, false);
  assert.equal(resolveConnectMode({
    STRIPE_CONNECT_LIVE_ENABLED: 'true', STRIPE_CONNECT_LIVE_SECRET_KEY: 'sk_live_abc',
  }).livemode, true);
  assert.equal(resolveConnectMode({
    STRIPE_CONNECT_TEST_ENABLED: 'true', STRIPE_CONNECT_LIVE_ENABLED: 'true',
    STRIPE_CONNECT_TEST_SECRET_KEY: 'sk_test_abc', STRIPE_CONNECT_LIVE_SECRET_KEY: 'sk_live_abc',
  }).code, 'connect_mode_ambiguous');

  const phase1Env = {
    STRIPE_SECRET_KEY: 'sk_live_fixturekey',
    STRIPE_WEBHOOK_SECRET: 'whsec_fixture',
    STRIPE_MAIN_SUBSCRIPTION_PRICE_ID: 'price_main',
    STRIPE_ADDITIONAL_USER_PRICE_ID: 'price_add',
    STRIPE_CONNECT_TEST_ENABLED: 'true',
    STRIPE_CONNECT_TEST_SECRET_KEY: 'sk_test_fixture',
    STRIPE_CONNECT_TEST_COUNTRIES: 'ES',
  };
  assert.equal(assess(phase1Env).phase1Ready, true);
  assert.equal(assess(phase1Env).phase2Ready, false);

  const phase2Env = {
    STRIPE_SECRET_KEY: 'sk_live_fixturekey',
    STRIPE_WEBHOOK_SECRET: 'whsec_fixture',
    STRIPE_MAIN_SUBSCRIPTION_PRICE_ID: 'price_main',
    STRIPE_ADDITIONAL_USER_PRICE_ID: 'price_add',
    STRIPE_CONNECT_LIVE_ENABLED: 'true',
    STRIPE_CONNECT_LIVE_SECRET_KEY: 'sk_live_connect',
    STRIPE_CONNECT_LIVE_COUNTRIES: 'ES',
  };
  const phase2 = assess(phase2Env);
  assert.equal(phase2.connectMode, 'live');
  assert.equal(phase2.billingMode, 'live');
  assert.equal(phase2.phase2Ready, true);
  assert.equal(phase2.phase1Ready, false);

  assert.equal(assess({ ...phase1Env, STRIPE_CONNECT_TEST_COUNTRI: 'ES' }).countriesTypo, true);

  if (process.argv.includes('--phase1-env')) {
    try {
      require('dotenv').config({ path: path.join(__dirname, '../server/.env') });
    } catch {
      // opcional
    }
    const report = assess(process.env);
    console.log('Stripe go-live assessment (no secrets):', JSON.stringify(report, null, 2));
    if (report.countriesTypo) {
      console.error('ERROR: renombra STRIPE_CONNECT_TEST_COUNTRI → STRIPE_CONNECT_TEST_COUNTRIES');
      process.exitCode = 1;
    }
    if (!report.phase1Ready && !report.phase2Ready) {
      console.error('Ni Fase 1 ni Fase 2 están listas. Revisa billing live + Connect test (Fase 1) o Connect live (Fase 2).');
      process.exitCode = 1;
    } else if (report.phase1Ready) {
      console.log('Fase 1 lista: billing live + Connect test.');
    } else if (report.phase2Ready) {
      console.log('Fase 2 lista: Connect live + billing live.');
    }
  } else {
    console.log('Stripe go-live: resolver + Fase1/Fase2 fixtures OK (mocked, no network).');
  }
};

main();
