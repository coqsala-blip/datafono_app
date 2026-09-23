# TPV & GESTOR Backend

> ⚠️ **No ejecutes `npx expo start` dentro de esta carpeta.** Este directorio es solo el backend de
> Node/Express. Si Expo arranca aquí, Metro intenta empaquetar `src/server.js` como si fuera la app
> y falla con `Unable to resolve module crypto` / `DevLauncherErrorActivity`.
> Arranca siempre Metro desde la **raíz del repositorio** (`..`), no desde `server/`.

### Instalación

```bash
npm install
cp .env.example .env
```

### Ejecutar

```bash
npm run dev
```

### Endpoints principales

- `GET /health`
- `POST /api/companies`
- `POST /api/subscriptions/create`
- `POST /api/companies/:companyId/users`
- `POST /api/stripe/payment`
- `GET /api/stripe/payment/:paymentId`
- `GET /api/stripe/payment-methods` (diagnóstico de métodos; `?probe=1` comprueba el Checkout real)
- `GET /api/stripe/account` (datos de la cuenta y enlaces al Dashboard: cobros, pagos y banco)
- `POST /api/stripe/enable-bizum` (intenta activar Bizum en la configuración de la cuenta)
- `POST /api/stripe/terminal/connection-token`
- `POST /api/stripe/payment-intent`
- `POST /api/billing/checkout`
- `GET /api/billing/status`
- `POST /api/stripe/webhook`
- `POST /api/auth/refresh` (renueva la sesión del móvil con el refresh token y evita que los documentos se publiquen sin dueño)
- `POST /api/documents` (publica el ticket/factura y lo asocia a la cuenta autenticada)
- `GET /api/documents` (lista los documentos de la cuenta)
- `GET /api/documents/sync-all` (recupera documentos + gastos en una llamada: "Sincronizar historial")
- `POST /api/expenses/sync` / `GET /api/expenses` (guardar y listar los gastos de la cuenta)

### Plan actual

- Base usuario principal: 9,00 € / mes + 21% IVA (10,89 €)
- Usuario adicional (empleado): 2,50 € / mes + 21% IVA (3,03 €)

### Fórmula

```text
total_neto = 9 + (usuarios_adicionales * 2.5)
total_con_iva = total_neto * 1.21
```

Los cobros online/QR y las suscripciones se crean con Stripe Checkout. El backend también expone tokens y PaymentIntents para Stripe Terminal si se añade el SDK nativo de Terminal en la app.

### Sincronizar historial (recuperar tickets, facturas y gastos)

La app guarda cada ticket/factura y cada gasto en la nube asociados a la cuenta que los emite, para
poder recuperarlos con el botón **Sincronizar historial** (pestaña *Gastos/Facturación*) después de
borrar los datos de la app, cambiar de móvil o sufrir una avería.

Requisitos en Supabase (se asume que la tabla `documents` ya existe, creada al configurar el
proyecto). Ejecuta estos archivos en **Dashboard → SQL Editor → pegar y Run**:

1. `supabase-expenses.sql` — crea la tabla `expenses` con RLS y los permisos que necesita el backend.
2. `supabase-history-sync.sql` — añade `documents.user_id` (el vínculo con la cuenta) y
   `documents.updated_at`, concede los permisos del backend e incluye cómo adoptar (poner dueño a)
   los documentos antiguos que se guardaron sin sesión.

Si falta algún paso, el backend responde 500 y la app muestra el motivo exacto (por ejemplo
`documentos: column documents.user_id does not exist` o
`gastos: permission denied for table expenses`) en lugar de decir que no hay historial guardado.

Los access tokens de Supabase caducan en 1 hora: la app los renueva en segundo plano con
`POST /api/auth/refresh` (guardando el refresh token en el almacén seguro del móvil) para que los
tickets y gastos no queden nunca en la nube sin dueño.

### Despliegue en Render

El archivo `render.yaml` de la raíz configura este backend como un Web Service de Render.

1. En Render, crea un Blueprint conectado al repositorio y selecciona `render.yaml`.
2. Introduce en el panel las variables marcadas como secretas en `render.yaml`.
3. Cuando Render asigne la URL del servicio, configura `PUBLIC_API_URL` con esa URL completa usando `https://`.
4. Comprueba que `https://TU-SERVICIO.onrender.com/health` responde con `ok: true`.
5. Añade `STRIPE_SECRET_KEY` en Render con la clave secreta de prueba o producción correspondiente.
6. Crea en Stripe dos precios recurrentes mensuales: uno para la cuenta principal y otro para usuarios adicionales.
7. Añade en Render `STRIPE_MAIN_SUBSCRIPTION_PRICE_ID` con el precio principal y `STRIPE_ADDITIONAL_USER_PRICE_ID` con el precio de usuario adicional.
8. Configura en Stripe el webhook `https://TU-SERVICIO.onrender.com/api/stripe/webhook` y guarda su secreto en `STRIPE_WEBHOOK_SECRET`.

No subas el archivo `server/.env` ni copies sus secretos al repositorio.

### Pasar a producción (Stripe en modo real)

Los ingresos de las suscripciones se cobran con Stripe Checkout y se liquidan en la cuenta Stripe que
corresponde a la clave secreta configurada en el backend. Para cobrar de verdad:

1. Activa la cuenta de Stripe (modo real) completando la verificación del negocio (datos fiscales, CIF/NIF,
   titular y cuenta bancaria/IBAN para las transferencias). Sin esto Stripe no puede liquidar el dinero.
2. En el Dashboard de Stripe, **desactiva el modo de prueba** (interruptor "Test mode") y crea allí los productos:
   - Cuenta principal: 9,00 € + 21% IVA = **10,89 € / mes** (IVA incluido).
   - Usuario adicional: 2,50 € + 21% IVA = **3,03 € / mes** (IVA incluido).
   Copia los `price_...` generados en **modo real**.
3. Copia la clave secreta real (`sk_live_...`) de *Developers → API keys*.
4. En Stripe, *Developers → Webhooks → Add endpoint*, URL `https://TU-SERVICIO.onrender.com/api/stripe/webhook`,
   eventos `checkout.session.completed` y `checkout.session.async_payment_succeeded`, y copia el
   `whsec_...` del endpoint (modo real).
5. En Render, actualiza las variables (o añádelas si no existen) en *Environment*:
   `STRIPE_SECRET_KEY=sk_live_...`, `STRIPE_WEBHOOK_SECRET=whsec_...`,
   `STRIPE_MAIN_SUBSCRIPTION_PRICE_ID=price_...` (real) y, si aplica,
   `STRIPE_ADDITIONAL_USER_PRICE_ID=price_...` (real).
6. Guarda los cambios y deja que Render redespliegue. Comprueba `GET /health` y que
   `POST /api/billing/checkout` devuelve una `checkoutUrl` de Stripe.
7. Si usas Stripe Terminal (Tap to Pay / lectores), crea también una **ubicación en modo real** y
   actualiza `EXPO_PUBLIC_STRIPE_TERMINAL_LOCATION_ID` en `.env.local` y `eas.json`, y regenera el build.
8. Haz una suscripción real de prueba con una tarjeta propia y verifica en el Dashboard
   (*Payments* y *Billing → Subscriptions*) que el cobro entra en la cuenta real.

Los importes que muestra la app son solo informativos: lo que se cobra es el importe del `price_...`
creado en Stripe, así que los precios reales deben coincidir con 10,89 € y 3,03 € (IVA incluido).

### Cobrar con Bizum (cobros puntuales)

Bizum se ofrece a través de **Stripe Checkout** en el cobro online con enlace/QR
(`POST /api/stripe/payment`). En la app: *Cobrar* → *Cobrar con enlace o QR (Bizum/tarjeta)*.

Requisitos de Bizum según Stripe (https://docs.stripe.com/payments/bizum):

- Cuenta de Stripe con **ubicación de negocio en España** y **Bizum habilitado en el Dashboard**
  (*Settings → Payment methods*). Sin ese paso Stripe no muestra Bizum aunque el código esté listo.
- Solo **cobros puntuales** (`mode: 'payment'`): **no admite suscripciones ni pagos recurrentes**, por
  lo que el plan mensual (10,89 €/mes) sigue cobrándose con tarjeta.
- Importe entre **0,50 € y 5.000 €** y todas las partidas en **EUR**.
- El cliente necesita un **IBAN español** de un banco conectado a Bizum y su móvil vinculado: paga y
  aprueba desde la app de su banco.
- Reembolsos totales y parciales, pero **asíncronos (pueden tardar hasta 5 minutos)**. Se admiten
  disputas hasta 120 días después del cobro.

El backend usa **métodos dinámicos** por defecto
(`STRIPE_PAYMENT_METHOD_TYPES=auto`): no envía `payment_method_types` al Checkout, de modo que es
**Stripe quien muestra los métodos activados en Settings → Payment methods del Dashboard** —el modo
recomendado por Stripe, que garantiza que lo que actives allí salga siempre sin tocar el código
(tarjeta, Bizum en España, MB WAY en Portugal, Bancontact en Bélgica, EPS en Austria, iDEAL en
Países Bajos, Wero paneuropeo...). Si prefieres limitar la lista a mano, define
`STRIPE_PAYMENT_METHOD_TYPES` con tu propia lista (p. ej. `card,bizum`): en ese caso el backend
consulta la configuración real de la cuenta antes de cada cobro (cacheada 10 minutos), pide solo los
métodos disponibles, **excluye Bizum automáticamente** fuera del rango 0,50 €–5.000 € y, si Stripe
rechazara un método local, **lo retira y reintenta con límite** en lugar de fallar. Todos los métodos
locales requieren EUR y cobros puntuales; **ninguno admite suscripciones**, por lo que el plan mensual
sigue cobrándose con tarjeta.

`GET /api/stripe/payment-methods` (requiere sesión) devuelve el estado real de la cuenta. Con
`?probe=1` además crea un Checkout de 1,00 € que **caduca al momento** (no cobra nada) y devuelve
los métodos que Stripe resuelve de verdad, junto con el modo (test/live), el país de la cuenta, el
estado de cada método y un enlace al Dashboard para activarlos. En la app lo tienes en
**Config → "Comprobar Bizum en Stripe"**, junto al botón "Abrir Stripe para activar Bizum".

`GET /api/stripe/account` (requiere sesión) devuelve el estado de la cuenta —modo test/live, país,
cobros y pagos activados, calendario de pagos, requisitos pendientes y las **cuentas bancarias de
abono** (banco, `····last4`, divisa y estado)— junto con enlaces directos al Dashboard para
configurarla. Es lo que usa **Config → "CONFIGURAR TU CUENTA" → "CONFIGURAR DÓNDE RECIBIR LOS
COBROS"**: muestra el resumen real y abre en el navegador del móvil la página de Stripe donde el
comercio elige **dónde y cada cuánto** recibe el dinero
(`Settings → Payouts → Bank accounts and scheduling`, en modo test o live según la clave del
backend).

Si el listado de cuentas bancarias no se pudiera leer con la clave de la plataforma, la app lo
degrada con elegancia: muestra el resto del estado y abre igualmente la página correcta del
Dashboard para añadirla.

Si el Checkout solo ofrece tarjeta, es que Bizum (u otro método) **no está activado en esa cuenta o
modo**: test y live se activan por separado en el Dashboard y Bizum exige una cuenta con ubicación de
negocio en España.

Pruebas en modo test: en el Checkout elige Bizum y usa el teléfono `+34600000002` para simular un
rechazo del banco; cualquier otro número simula un pago correcto.

