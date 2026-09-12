require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');
const stripe = require('./config/stripe');

const app = express();
const PORT = process.env.PORT || 4000;
const PUBLIC_API_URL = (process.env.PUBLIC_API_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const NODE_ENV = process.env.NODE_ENV || 'development';

try {
  const publicApiUrl = new URL(PUBLIC_API_URL);
  if (NODE_ENV === 'production' && publicApiUrl.protocol !== 'https:') {
    throw new Error('PUBLIC_API_URL debe usar HTTPS en producción.');
  }
} catch (error) {
  throw new Error(`PUBLIC_API_URL no es válida: ${error.message}`);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

const stripeV2Request = async (path, method, body) => {
  const response = await fetch(`https://api.stripe.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/json',
      'Stripe-Version': '2026-08-26.dahlia',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error?.message || 'Stripe API error');
    error.code = result.error?.code;
    error.type = result.error?.type;
    throw error;
  }
  return result;
};

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

if (NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.path === '/health' || req.secure) {
      return next();
    }

    return res.redirect(`https://${req.get('host')}${req.originalUrl}`);
  });
}

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'TPV & GESTOR backend' });
});

const getBearerToken = (req) => {
  const authorization = req.headers.authorization || '';
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : null;
};

const requireAuth = async (req, res, next) => {
  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'Se requiere autenticación.' });
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    return res.status(401).json({ ok: false, error: 'La sesión no es válida o ha caducado.' });
  }

  req.user = data.user;
  return next();
};

app.post('/api/auth/register', async (req, res) => {
  const { email, password, fullName, companyName } = req.body || {};
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';

  if (!normalizedEmail || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ ok: false, error: 'Indica un email válido y una contraseña de al menos 8 caracteres.' });
  }

  const { data, error } = await supabase.auth.signUp({
    email: normalizedEmail,
    password,
    options: {
      data: {
        full_name: typeof fullName === 'string' ? fullName.trim() : '',
        company_name: typeof companyName === 'string' ? companyName.trim() : '',
        role: 'principal',
      },
    },
  });

  if (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }

  return res.status(201).json({
    ok: true,
    user: data.user,
    session: data.session,
    requiresEmailConfirmation: !data.session,
  });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';

  if (!normalizedEmail || typeof password !== 'string' || password.length === 0) {
    return res.status(400).json({ ok: false, error: 'Indica email y contraseña.' });
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email: normalizedEmail,
    password,
  });

  if (error || !data.user || !data.session) {
    return res.status(401).json({ ok: false, error: 'Email o contraseña incorrectos.' });
  }

  return res.json({ ok: true, user: data.user, session: data.session });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ ok: true, user: req.user });
});

const getConnectReturnUrl = () => `${PUBLIC_API_URL}/api/connect/return`;

app.get('/api/connect/status', requireAuth, async (req, res) => {
  const accountId = req.user.user_metadata?.stripe_connect_account_id;
  if (!accountId) {
    return res.json({ ok: true, connected: false, accountId: null, chargesEnabled: false, payoutsEnabled: false });
  }

  try {
    const account = await stripe.accounts.retrieve(accountId);
    return res.json({
      ok: true,
      connected: true,
      accountId: account.id,
      chargesEnabled: Boolean(account.charges_enabled),
      payoutsEnabled: Boolean(account.payouts_enabled),
      detailsSubmitted: Boolean(account.details_submitted),
      currentlyDue: account.requirements?.currently_due || [],
    });
  } catch (error) {
    console.error('Error consultando cuenta Connect:', error.message);
    return res.status(502).json({ ok: false, error: 'No se pudo consultar la cuenta de cobros.' });
  }
});

app.post('/api/connect/onboarding', requireAuth, async (req, res) => {
  let accountId = req.user.user_metadata?.stripe_connect_account_id;
  let onboardingStage = accountId ? 'account_link' : 'account_create';

  try {
    if (!accountId) {
      const account = await stripeV2Request('/v2/core/accounts', 'POST', {
        contact_email: req.user.email,
        display_name: req.user.user_metadata?.company_name || req.user.user_metadata?.full_name || 'Comercio TPV',
        identity: {
          country: 'ES',
          entity_type: 'company',
        },
        dashboard: 'express',
        configuration: {
          merchant: {
            capabilities: {
              card_payments: { requested: true },
            },
          },
        },
        defaults: {
          responsibilities: {
            fees_collector: 'application',
            losses_collector: 'application',
          },
        },
        metadata: { supabase_user_id: req.user.id },
        include: ['configuration.merchant', 'identity', 'defaults'],
      });
      accountId = account.id;
      onboardingStage = 'metadata_save';

      const { error: metadataError } = await supabase.auth.admin.updateUserById(req.user.id, {
        user_metadata: {
          ...req.user.user_metadata,
          stripe_connect_account_id: accountId,
        },
      });
      if (metadataError) {
        console.error('Cuenta Connect creada, pero no se pudo guardar la asociación en Supabase:', metadataError.message);
      }
    }

    onboardingStage = 'account_link';
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: getConnectReturnUrl(),
      return_url: getConnectReturnUrl(),
      type: 'account_onboarding',
    });

    return res.status(201).json({ ok: true, accountId, onboardingUrl: accountLink.url });
  } catch (error) {
    console.error('Error creando onboarding Connect:', {
      message: error.message,
      code: error.code,
      type: error.type,
      accountId,
      onboardingStage,
      userId: req.user.id,
    });
    return res.status(502).json({
      ok: false,
      error: `Stripe no pudo iniciar la configuración (${onboardingStage}). ${error.message || 'Revisa el estado de tu cuenta de plataforma.'}`,
    });
  }
});

app.get('/api/connect/return', (req, res) => {
  res.type('html').send('<h1>Configuración recibida</h1><p>Puedes volver a la aplicación para comprobar el estado de tu cuenta de cobros.</p>');
});

const activeSubscriptionStatuses = new Set(['active', 'trialing']);

app.get('/api/billing/status', requireAuth, async (req, res) => {
  const customerId = req.user.user_metadata?.stripe_customer_id;
  if (!customerId) {
    return res.json({ ok: true, active: false, status: 'missing' });
  }

  try {
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: 'all',
      limit: 10,
    });
    const subscription = subscriptions.data
      .sort((left, right) => right.created - left.created)[0];

    return res.json({
      ok: true,
      active: Boolean(subscription && activeSubscriptionStatuses.has(subscription.status)),
      status: subscription?.status || 'missing',
      subscriptionId: subscription?.id || null,
      currentPeriodEnd: subscription?.current_period_end || null,
    });
  } catch (error) {
    console.error('Error consultando suscripción:', error.message);
    return res.status(502).json({ ok: false, error: 'No se pudo consultar la suscripción.' });
  }
});

app.post('/api/terminal/connection-token', requireAuth, async (req, res) => {
  try {
    const token = await stripe.terminal.connectionTokens.create();
    return res.json({ ok: true, secret: token.secret });
  } catch (error) {
    console.error('Error creando token de conexión Terminal:', {
      message: error.message,
      code: error.code,
      type: error.type,
    });
    return res.status(502).json({ ok: false, error: `Stripe no pudo crear el token de conexión. ${error.message}` });
  }
});

app.post('/api/terminal/payment-intent', requireAuth, async (req, res) => {
  const rawAmount = req.body?.amount;
  const amountNumber = typeof rawAmount === 'string'
    ? Number(rawAmount.replace(',', '.'))
    : Number(rawAmount);
  const amount = Math.round(amountNumber * 100);
  const transactionId = typeof req.body?.transactionId === 'string' ? req.body.transactionId.trim() : '';

  if (!Number.isFinite(amountNumber) || !Number.isInteger(amount) || amount < 50 || amount > 99999999) {
    return res.status(400).json({ ok: false, error: `Importe no válido: ${String(rawAmount)}. Usa al menos 0,50 €.` });
  }

  if (!transactionId) {
    return res.status(400).json({ ok: false, error: 'Falta el identificador de la operación.' });
  }

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'eur',
      payment_method_types: ['card_present'],
      capture_method: 'automatic',
      metadata: {
        supabase_user_id: req.user.id,
        transaction_id: transactionId,
      },
    }, {
      idempotencyKey: `terminal-${req.user.id}-${transactionId}`,
    });

    return res.status(201).json({
      ok: true,
      paymentIntentId: paymentIntent.id,
      clientSecret: paymentIntent.client_secret,
    });
  } catch (error) {
    console.error('Error creando PaymentIntent Terminal:', error.message);
    return res.status(502).json({ ok: false, error: 'No se pudo preparar el cobro.' });
  }
});

app.post('/api/billing/checkout', requireAuth, async (req, res) => {
  const additionalUsers = Math.max(0, Math.min(50, Math.floor(Number(req.body?.additionalUsers) || 0)));
  const basePriceId = process.env.STRIPE_BASE_PRICE_ID;
  const extraPriceId = process.env.STRIPE_EXTRA_PRICE_ID;

  if (!basePriceId || !extraPriceId || basePriceId.includes('REEMPLAZAR') || extraPriceId.includes('REEMPLAZAR')) {
    return res.status(503).json({ ok: false, error: 'La facturación todavía no está configurada en Stripe.' });
  }

  try {
    const customerId = req.user.user_metadata?.stripe_customer_id || (
      await stripe.customers.create({
        email: req.user.email,
        name: req.user.user_metadata?.full_name || undefined,
        metadata: { supabase_user_id: req.user.id },
      })
    ).id;

    await supabase.auth.admin.updateUserById(req.user.id, {
      user_metadata: {
        ...req.user.user_metadata,
        stripe_customer_id: customerId,
      },
    });

    const lineItems = [{ price: basePriceId, quantity: 1 }];
    if (additionalUsers > 0) {
      lineItems.push({ price: extraPriceId, quantity: additionalUsers });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: lineItems,
      success_url: `${PUBLIC_API_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_API_URL}/billing/cancelled`,
      subscription_data: {
        metadata: {
          supabase_user_id: req.user.id,
          additional_users: String(additionalUsers),
        },
      },
      metadata: {
        supabase_user_id: req.user.id,
        additional_users: String(additionalUsers),
      },
    });

    const netMonthly = 9 + (additionalUsers * 2.5);
    const totalMonthlyWithVat = Number((netMonthly * 1.21).toFixed(2));

    return res.status(201).json({
      ok: true,
      checkoutUrl: session.url,
      totalMonthly: totalMonthlyWithVat,
    });
  } catch (error) {
    console.error('Error creando checkout de suscripción:', error.message);
    return res.status(502).json({ ok: false, error: 'No se pudo iniciar el pago de la suscripción.' });
  }
});

app.get('/billing/success', (req, res) => {
  res.type('html').send('<h1>Pago recibido</h1><p>Puedes volver a la aplicación. Comprobaremos tu suscripción automáticamente.</p>');
});

app.get('/billing/cancelled', (req, res) => {
  res.type('html').send('<h1>Pago cancelado</h1><p>Puedes cerrar esta página y volver a la aplicación.</p>');
});

app.post('/api/documents', async (req, res) => {
  const { id, ticketCode, documentType, amount, originalAmount, relatedTicketCode, refundHistory, isRefunded, createdAt, issuer, client, items, subtotal, iva, ivaRateApplied, type, hash, previousHash, tbaiId, complianceRegime } = req.body;

  if (!id || !ticketCode || !documentType || !Number.isFinite(Number(amount))) {
    return res.status(400).json({ ok: false, error: 'Faltan datos obligatorios del documento.' });
  }

  const token = crypto.randomBytes(24).toString('hex');
  const document = {
    id,
    ticketCode,
    documentType,
    amount: Number(amount),
    originalAmount: originalAmount !== undefined ? Number(originalAmount) : Number(amount),
    relatedTicketCode,
    refundHistory: Array.isArray(refundHistory) ? refundHistory : [],
    isRefunded: Boolean(isRefunded),
    createdAt,
    issuer,
    client,
    items,
    subtotal,
    iva,
    ivaRateApplied,
    type,
    hash,
    previousHash,
    tbaiId,
    complianceRegime: complianceRegime || issuer?.complianceRegime || 'verifactu',
  };

  const { error } = await supabase.from('documents').insert({
    ticket_code: ticketCode,
    document_type: documentType,
    amount: document.amount,
    original_amount: document.originalAmount,
    document_data: document,
    public_token: token,
  });

  if (error) {
    console.error('Error guardando documento en Supabase:', error.message);
    return res.status(500).json({ ok: false, error: 'No se pudo guardar el documento.' });
  }

  res.status(201).json({
    ok: true,
    token,
    publicUrl: `${PUBLIC_API_URL}/documents/${token}`,
  });
});

const escapeHtml = (value = '') => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const formatMoney = (value) => Number(value || 0).toFixed(2);

app.get('/documents/:token', async (req, res) => {
  const { data, error } = await supabase
    .from('documents')
    .select('document_data')
    .eq('public_token', req.params.token)
    .maybeSingle();
  const document = data?.document_data;

  if (error || !document) {
    if (error) console.error('Error consultando documento en Supabase:', error.message);
    return res.status(404).send('<h1>Documento no encontrado</h1><p>El enlace no es válido o ha caducado.</p>');
  }

  const publicUrl = `${PUBLIC_API_URL}/documents/${req.params.token}`;
  const qrDataUrl = await QRCode.toDataURL(publicUrl, { width: 220, margin: 1 });
  const itemsHtml = Array.isArray(document.items)
    ? document.items.map((item) => `<li>${escapeHtml(item.description)}: ${escapeHtml(item.price)} €</li>`).join('')
    : '';
  const logoHtml = typeof document.issuer?.logoUri === 'string' && document.issuer.logoUri.startsWith('data:image/')
    ? `<div class="logo"><img src="${document.issuer.logoUri}" alt="Logotipo de la empresa"></div>`
    : '';

  const totalRefunded = document.refundHistory.reduce((sum, refund) => sum + Number(refund.amount || 0), 0);
  const refundHistoryHtml = document.refundHistory.length > 0
    ? '<div class="section"><strong>COMPRA/DEVOLUCIONES</strong><br>Importe original: ' + formatMoney(document.originalAmount) + ' €<br>Total devuelto: -' + formatMoney(totalRefunded) + ' €<br>' + document.refundHistory.map((refund) => 'Devolución: -' + formatMoney(refund.amount) + ' € (' + escapeHtml(refund.date) + ')').join('<br>') + '<br><strong>Saldo restante: ' + formatMoney(document.amount) + ' €</strong></div>'
    : '';

  const regime = document.complianceRegime || document.issuer?.complianceRegime || 'verifactu';
  const isTicketBai = regime === 'ticketbai';
  const complianceHtml = `
    <div class="section" style="text-align:center;font-size:11px;color:#334155;">
      <strong>${isTicketBai ? 'TICKETBAI - TBAI' : 'VERI*FACTU - AEAT'}</strong><br/>
      ${isTicketBai ? 'Factura / Ticket registrado digitalmente en TicketBAI' : 'Factura emitida por sistema de facturación verificable (VERI*FACTU)'}<br/>
      ${document.tbaiId ? `<strong>ID TBAI: ${escapeHtml(document.tbaiId)}</strong><br/>` : ''}
      ${document.hash ? `<span class="muted">Huella SHA-256: ${escapeHtml(document.hash.slice(0, 20))}...</span>` : ''}
    </div>
  `;

  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.type('html').send(`<!doctype html>
<html lang="es">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(document.documentType)} ${escapeHtml(document.ticketCode)}</title>
  <style>body{font-family:'Courier New',monospace;background:#fff;color:#000;margin:0;padding:20px;display:flex;justify-content:center}.document{width:100%;max-width:420px;padding:18px;box-sizing:border-box}.logo{text-align:center;margin-bottom:10px}.logo img{width:85px;height:85px;object-fit:contain}.center{text-align:center}.title{font-size:18px;font-weight:bold;margin-bottom:5px}.subtitle{font-size:12px;margin-bottom:4px;color:#334155}.divider{border-top:1px dashed #000;margin:14px 0}.section{margin-top:12px;border-top:1px dashed #000;padding-top:10px}.row{display:flex;justify-content:space-between;font-size:13px;margin:7px 0}.total{display:flex;justify-content:space-between;font-size:17px;font-weight:bold;margin-top:10px;border-top:1px dashed #000;padding-top:8px}.qr{text-align:center;margin-top:18px;border-top:1px dashed #000;padding-top:14px}.qr img{width:180px;height:180px}.muted{color:#64748b;font-size:11px}</style></head>
  <body><main class="document">${logoHtml}<div class="center title">${escapeHtml(document.issuer?.name || '')}</div><div class="center subtitle">NIF: ${escapeHtml(document.issuer?.nif || '')}</div><div class="center subtitle">${escapeHtml(document.issuer?.address || '')}</div><div class="divider"></div><div class="center title">${escapeHtml(document.documentType)}</div><div class="subtitle">Ref: <strong>${escapeHtml(document.ticketCode)}</strong></div><div class="subtitle">Fecha: ${escapeHtml(document.createdAt || '')}</div>${document.client ? `<div class="section"><strong>DATOS FISCALES DEL CLIENTE:</strong><br>${escapeHtml(document.client.name)}<br>NIF/CIF: ${escapeHtml(document.client.nif)}<br>${escapeHtml(document.client.address)}</div>` : ''}${itemsHtml ? `<div class="section"><strong>PRODUCTOS / SERVICIOS:</strong><ul>${itemsHtml}</ul></div>` : ''}${refundHistoryHtml}<div class="divider"></div><div class="row"><span>Base imponible actual</span><span>${formatMoney(document.subtotal)} €</span></div><div class="row"><span>IVA (${escapeHtml(document.ivaRateApplied)}%)</span><span>${formatMoney(document.iva)} €</span></div><div class="total"><span>TOTAL ORIGINAL</span><span>${formatMoney(document.originalAmount)} €</span></div><div class="row"><span>Saldo tras devoluciones</span><span>${formatMoney(document.amount)} €</span></div>${complianceHtml}<div class="qr"><img src="${qrDataUrl}" alt="QR del ticket"><div>${escapeHtml(document.ticketCode)}</div><p class="muted">Escanea este QR para consultar este ticket.</p></div></main></body></html>`);
});

app.get('/api/documents/:token', async (req, res) => {
  const { data, error } = await supabase
    .from('documents')
    .select('document_data')
    .eq('public_token', req.params.token)
    .maybeSingle();
  if (error || !data?.document_data) {
    return res.status(404).json({ ok: false, error: 'Documento no encontrado.' });
  }
  res.json({ ok: true, document: data.document_data });
});

app.post('/api/companies', async (req, res) => {
  try {
    const {
      name,
      nif,
      address,
      email,
      bankName,
      iban,
      accountHolder,
      country,
      additionalUsers = 0,
    } = req.body;

    const customer = await stripe.customers.create({
      email,
      name,
      metadata: {
        company_name: name,
        nif,
        country,
      },
    });

    const baseAmount = 9;
    const extraAmount = Math.max(0, Number(additionalUsers)) * 2.5;
    const totalMonthly = Number(((baseAmount + extraAmount) * 1.21).toFixed(2));

    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: process.env.STRIPE_BASE_PRICE_ID }],
      metadata: {
        company_name: name,
        company_nif: nif,
        additional_users: String(additionalUsers),
        total_monthly: String(totalMonthly),
      },
      payment_behavior: 'default_incomplete',
      expand: ['latest_invoice.payment_intent'],
    });

    res.status(201).json({
      ok: true,
      company: {
        name,
        nif,
        address,
        email,
        bankName,
        iban,
        accountHolder,
        country,
        additionalUsers,
        totalMonthly,
      },
      customerId: customer.id,
      subscriptionId: subscription.id,
      subscription,
    });
  } catch (error) {
    console.error('Error creating company:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/subscriptions/create', async (req, res) => {
  try {
    const { customerId, additionalUsers = 0 } = req.body;

    const totalMonthly = Number(((9 + (Math.max(0, Number(additionalUsers)) * 2.5)) * 1.21).toFixed(2));

    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: process.env.STRIPE_BASE_PRICE_ID }],
      metadata: {
        additional_users: String(additionalUsers),
        total_monthly: String(totalMonthly),
      },
      payment_behavior: 'default_incomplete',
      expand: ['latest_invoice.payment_intent'],
    });

    res.json({ ok: true, subscription, totalMonthly });
  } catch (error) {
    console.error('Error creating subscription:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/companies/:companyId/users', async (req, res) => {
  try {
    const { totalUsers } = req.body;
    const extraUsers = Math.max(0, Number(totalUsers) - 1);
    const totalMonthly = 7 + (extraUsers * 2);

    res.json({ ok: true, totalMonthly, extraUsers });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'invoice.paid':
    case 'invoice.payment_failed':
      console.log('Stripe event handled:', event.type);
      break;
    default:
      console.log(`Unhandled event type: ${event.type}`);
  }

  res.json({ received: true });
});

app.listen(PORT, () => {
  console.log(`TPV & GESTOR backend running on http://localhost:${PORT}`);
});
