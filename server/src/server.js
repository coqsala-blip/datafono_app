require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');

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

const moneiRequest = async (path, method, body) => {
  if (!process.env.MONEI_API_KEY) {
    throw new Error('MONEI_API_KEY no está configurada en el backend.');
  }

  const response = await fetch(`https://api.monei.com/v1${path}`, {
    method,
    headers: {
      Authorization: process.env.MONEI_API_KEY,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.message || result.error?.message || 'MONEI API error');
  }
  return result;
};

const verifyMoneiSignature = (rawBody, signature) => {
  if (!process.env.MONEI_API_KEY || typeof signature !== 'string') return false;
  const values = Object.fromEntries(signature.split(',').map((part) => part.split('=')));
  if (!values.t || !values.v1) return false;
  const signedPayload = `${values.t}.${rawBody}`;
  const expected = crypto.createHmac('sha256', process.env.MONEI_API_KEY).update(signedPayload).digest('hex');
  if (expected.length !== values.v1.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(values.v1));
};

app.set('trust proxy', 1);
app.post('/api/monei/callback', express.raw({ type: 'application/json' }), (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  const signature = req.headers['monei-signature'];

  if (!rawBody.trim() || rawBody.trim() === '{}') {
    return res.status(200).json({ received: true });
  }

  if (!signature) {
    return res.status(200).json({ received: true });
  }

  if (!verifyMoneiSignature(rawBody, signature)) {
    console.warn('Callback MONEI recibido con firma no verificable; se ignora el contenido.');
    return res.status(200).json({ received: true });
  }

  let payment;
  try {
    payment = JSON.parse(rawBody);
  } catch {
    return res.status(200).json({ received: true });
  }
  const resource = payment.object || payment;
  const status = resource.status || payment.type || 'UNKNOWN';
  console.log('MONEI callback recibido:', resource.id, status);
  const subscriptionId = resource.subscriptionId || resource.subscription?.id || resource.id;
  const userId = resource.metadata?.supabase_user_id || resource.metadata?.user_id;
  if (userId && subscriptionId) {
    void supabase.auth.admin.updateUserById(userId, {
      user_metadata: {
        subscription_provider: 'monei',
        monei_subscription_id: subscriptionId,
        monei_subscription_status: status,
        monei_subscription_updated_at: new Date().toISOString(),
      },
    }).catch((error) => console.error('Error guardando estado de suscripción MONEI:', error.message));
  }
  return res.status(200).json({ received: true });
});

app.get('/api/monei/callback', (req, res) => {
  res.status(200).json({ ok: true, service: 'MONEI callback' });
});

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

app.get('/api/billing/status', requireAuth, (req, res) => {
  const status = req.user.user_metadata?.monei_subscription_status || 'missing';
  const activeStatuses = new Set([
    'ACTIVE',
    'TRIALING',
    'SUCCEEDED',
    'active',
    'trialing',
    'succeeded',
    'subscription.activated',
    'subscription.updated',
  ]);
  return res.json({
    ok: true,
    provider: 'monei',
    active: activeStatuses.has(status),
    status,
    subscriptionId: req.user.user_metadata?.monei_subscription_id || null,
  });
});

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

app.post('/api/monei/payment', requireAuth, async (req, res) => {
  const amountNumber = typeof req.body?.amount === 'string'
    ? Number(req.body.amount.replace(',', '.'))
    : Number(req.body?.amount);
  const amount = Math.round(amountNumber * 100);
  const orderId = typeof req.body?.orderId === 'string' ? req.body.orderId.trim() : '';

  if (!Number.isFinite(amountNumber) || !Number.isInteger(amount) || amount < 50 || amount > 99999999) {
    return res.status(400).json({ ok: false, error: 'Importe no válido. Usa al menos 0,50 €.' });
  }
  if (!orderId) {
    return res.status(400).json({ ok: false, error: 'Falta el identificador de la operación.' });
  }

  try {
    const payment = await moneiRequest('/payments', 'POST', {
      amount,
      currency: 'EUR',
      orderId,
      description: `TPV - ${orderId}`,
      callbackUrl: `${PUBLIC_API_URL}/api/monei/callback`,
      completeUrl: `${PUBLIC_API_URL}/monei/complete?orderId=${encodeURIComponent(orderId)}`,
      cancelUrl: `${PUBLIC_API_URL}/monei/cancel?orderId=${encodeURIComponent(orderId)}`,
    });

    const redirectUrl = payment.nextAction?.redirectUrl ||
      payment.redirectUrl ||
      payment.checkoutUrl ||
      payment.url;
    const qrDataUrl = redirectUrl
      ? await QRCode.toDataURL(redirectUrl, { width: 420, margin: 2 })
      : null;

    return res.status(201).json({
      ok: true,
      paymentId: payment.id,
      redirectUrl,
      qrDataUrl,
    });
  } catch (error) {
    console.error('Error creando pago MONEI:', error.message);
    return res.status(502).json({ ok: false, error: `MONEI: ${error.message}` });
  }
});

app.get('/api/monei/payment/:paymentId', requireAuth, async (req, res) => {
  try {
    const payment = await moneiRequest(`/payments/${encodeURIComponent(req.params.paymentId)}`, 'GET');
    return res.json({ ok: true, paymentId: payment.id, status: payment.status });
  } catch (error) {
    console.error('Error consultando pago MONEI:', error.message);
    return res.status(502).json({ ok: false, error: 'No se pudo consultar el estado del pago MONEI.' });
  }
});

app.get('/monei/complete', (req, res) => {
  res.type('html').send('<h1>Pago recibido</h1><p>Puedes volver a la aplicación. El estado definitivo se confirma con MONEI.</p>');
});

app.get('/monei/cancel', (req, res) => {
  res.type('html').send('<h1>Pago cancelado</h1><p>Puedes volver a la aplicación e intentarlo de nuevo.</p>');
});

app.post('/api/billing/checkout', requireAuth, async (req, res) => {
  const additionalUsers = Math.max(0, Math.min(50, Math.floor(Number(req.body?.additionalUsers) || 0)));
  const amount = 1089 + (additionalUsers * 303);
  const orderId = `subscription-${req.user.id}-${Date.now()}`;

  try {
    const subscription = await moneiRequest('/subscriptions', 'POST', {
      amount,
      currency: 'EUR',
      interval: 'month',
      intervalCount: 1,
      orderId,
      description: `TPV Gestor - suscripción - ${additionalUsers} empleados`,
      customer: {
        email: req.user.email,
      },
      metadata: {
        supabase_user_id: req.user.id,
        additional_users: String(additionalUsers),
        total_monthly_cents: String(amount),
      },
      callbackUrl: `${PUBLIC_API_URL}/api/monei/callback`,
      paymentCallbackUrl: `${PUBLIC_API_URL}/api/monei/callback`,
    });

    const subscriptionId = subscription.id || subscription.subscriptionId;
    if (!subscriptionId) {
      throw new Error('MONEI no devolvió el identificador de la suscripción.');
    }

    const activation = await moneiRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}/activate`, 'POST', {
      completeUrl: `${PUBLIC_API_URL}/billing/success?orderId=${encodeURIComponent(orderId)}`,
    });

    await supabase.auth.admin.updateUserById(req.user.id, {
      user_metadata: {
        ...req.user.user_metadata,
        subscription_provider: 'monei',
        monei_subscription_id: subscriptionId || null,
        monei_subscription_status: subscription.status || 'PENDING',
        monei_subscription_additional_users: String(additionalUsers),
        monei_subscription_amount_cents: String(amount),
      },
    });

    const checkoutUrl = activation.nextAction?.redirectUrl || activation.redirectUrl || activation.checkoutUrl || activation.url;
    return res.status(201).json({
      ok: true,
      subscriptionId,
      checkoutUrl,
      redirectUrl: checkoutUrl,
      amount,
      additionalUsers,
    });
  } catch (error) {
    console.error('Error creando suscripción MONEI:', error.message);
    return res.status(502).json({ ok: false, error: `MONEI: ${error.message}` });
  }
});

app.get('/billing/success', (req, res) => {
  res.type('html').send('<h1>Pago recibido</h1><p>Puedes volver a la aplicación. Comprobaremos tu suscripción automáticamente.</p>');
});

app.get('/billing/cancelled', (req, res) => {
  res.type('html').send('<h1>Pago cancelado</h1><p>Puedes cerrar esta página y volver a la aplicación.</p>');
});

app.post('/api/documents', async (req, res) => {
  const { id, ticketCode, documentType, amount, originalAmount, relatedTicketCode, refundHistory, isRefunded, createdAt, issuer, client, items, subtotal, iva, ivaRateApplied, type } = req.body;

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
    return res.status(500).json({ ok: false, error: `Supabase: ${error.message}` });
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
  const qrDataUrl = await QRCode.toDataURL(publicUrl, {
    width: 420,
    margin: 2,
    errorCorrectionLevel: 'M',
  });
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

  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.type('html').send(`<!doctype html>
<html lang="es">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(document.documentType)} ${escapeHtml(document.ticketCode)}</title>
  <style>body{font-family:'Courier New',monospace;background:#fff;color:#000;margin:0;padding:20px;display:flex;justify-content:center}.document{width:100%;max-width:420px;padding:18px;box-sizing:border-box}.logo{text-align:center;margin-bottom:10px}.logo img{width:85px;height:85px;object-fit:contain}.center{text-align:center}.title{font-size:18px;font-weight:bold;margin-bottom:5px}.subtitle{font-size:12px;margin-bottom:4px;color:#334155}.divider{border-top:1px dashed #000;margin:14px 0}.section{margin-top:12px;border-top:1px dashed #000;padding-top:10px}.row{display:flex;justify-content:space-between;font-size:13px;margin:7px 0}.total{display:flex;justify-content:space-between;font-size:17px;font-weight:bold;margin-top:10px;border-top:1px dashed #000;padding-top:8px}.qr{text-align:center;margin:0 0 18px;padding:0 2mm 2mm}.qr img{width:35mm;height:35mm}.muted{color:#64748b;font-size:11px}</style></head>
  <body><main class="document">${logoHtml}<div class="center title">${escapeHtml(document.issuer?.name || '')}</div><div class="center subtitle">NIF: ${escapeHtml(document.issuer?.nif || '')}</div><div class="center subtitle">${escapeHtml(document.issuer?.address || '')}</div><div class="divider"></div><div class="center title">${escapeHtml(document.documentType)}</div><div class="subtitle">Nº de serie: <strong>${escapeHtml(document.ticketCode)}</strong></div><div class="subtitle">Fecha: ${escapeHtml(document.createdAt || '')}</div>${document.client ? `<div class="section"><strong>DATOS DEL CLIENTE:</strong><br>${escapeHtml(document.client.name)}<br>NIF/CIF: ${escapeHtml(document.client.nif)}<br>${escapeHtml(document.client.address)}</div>` : ''}${itemsHtml ? `<div class="section"><strong>PRODUCTOS / SERVICIOS:</strong><ul>${itemsHtml}</ul></div>` : ''}${refundHistoryHtml}<div class="divider"></div><div class="row"><span>Base imponible actual</span><span>${formatMoney(document.subtotal)} €</span></div><div class="row"><span>IVA (${escapeHtml(document.ivaRateApplied)}%)</span><span>${formatMoney(document.iva)} €</span></div><div class="total"><span>TOTAL ORIGINAL</span><span>${formatMoney(document.originalAmount)} €</span></div><div class="row"><span>Saldo tras devoluciones</span><span>${formatMoney(document.amount)} €</span></div><div class="qr"><img src="${qrDataUrl}" alt="QR del documento"><div>Nº de serie: <strong>${escapeHtml(document.ticketCode)}</strong></div></div></main></body></html>`);
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
  res.status(503).json({ ok: false, error: 'El alta de suscripciones MONEI todavía no está configurada.' });
});

app.post('/api/subscriptions/create', async (req, res) => {
  res.status(503).json({ ok: false, error: 'Las suscripciones MONEI todavía no están configuradas.' });
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

app.listen(PORT, () => {
  console.log(`TPV & GESTOR backend running on http://localhost:${PORT}`);
});
