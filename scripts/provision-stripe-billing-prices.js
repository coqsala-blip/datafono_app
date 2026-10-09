#!/usr/bin/env node
/**
 * Crea (idempotente por lookup de metadata) los precios de suscripción del SaaS
 * en la cuenta de STRIPE_SECRET_KEY (test o live).
 *
 * Principal: 10,89 €/mes IVA incl.  |  Empleado: 3,03 €/mes IVA incl.
 *
 * Uso (con server/.env o env exportada):
 *   node scripts/provision-stripe-billing-prices.js
 *
 * Imprime los price_… para pegar en Render. No imprime la secret key.
 */
const path = require('node:path');
try {
  require('dotenv').config({ path: path.join(__dirname, '../server/.env') });
} catch {
  // opcional
}

let Stripe;
try {
  Stripe = require(path.join(__dirname, '../server/node_modules/stripe'));
} catch {
  Stripe = require('stripe');
}
const key = process.env.STRIPE_SECRET_KEY || '';
if (!/^sk_(test|live)_[A-Za-z0-9]+$/.test(key)) {
  console.error('STRIPE_SECRET_KEY debe ser sk_test_… o sk_live_…');
  process.exit(1);
}

const stripe = Stripe(key);
const mode = key.startsWith('sk_live_') ? 'live' : 'test';

const ensureProduct = async (name, metaKey) => {
  const listed = await stripe.products.list({ limit: 100, active: true });
  const found = listed.data.find((p) => p.metadata?.tpv_billing_role === metaKey);
  if (found) return found;
  return stripe.products.create({
    name,
    metadata: { tpv_billing_role: metaKey },
  });
};

const ensureMonthlyPrice = async (productId, unitAmount, metaKey) => {
  const listed = await stripe.prices.list({ product: productId, active: true, limit: 100 });
  const found = listed.data.find((p) => (
    p.metadata?.tpv_billing_role === metaKey
    && p.unit_amount === unitAmount
    && p.currency === 'eur'
    && p.recurring?.interval === 'month'
  ));
  if (found) return found;
  return stripe.prices.create({
    product: productId,
    currency: 'eur',
    unit_amount: unitAmount,
    recurring: { interval: 'month' },
    metadata: { tpv_billing_role: metaKey },
  });
};

const main = async () => {
  console.log(`Provisioning billing prices in Stripe ${mode} mode…`);
  const mainProduct = await ensureProduct('TPV Gestión — Cuenta principal', 'main');
  const addProduct = await ensureProduct('TPV Gestión — Usuario adicional', 'additional');
  const mainPrice = await ensureMonthlyPrice(mainProduct.id, 1089, 'main');
  const addPrice = await ensureMonthlyPrice(addProduct.id, 303, 'additional');
  console.log('Listo. Pega en Render (Environment):');
  console.log(`STRIPE_MAIN_SUBSCRIPTION_PRICE_ID=${mainPrice.id}`);
  console.log(`STRIPE_ADDITIONAL_USER_PRICE_ID=${addPrice.id}`);
  console.log('(STRIPE_SECRET_KEY y STRIPE_WEBHOOK_SECRET del mismo modo ya deben estar en Render)');
};

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
