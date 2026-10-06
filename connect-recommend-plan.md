# Stripe Connect para TPV

## Modelo confirmado

Cada comercio vende a sus compradores y gestiona sus reembolsos y reclamaciones.
La plataforma cobra solo la suscripcion del principal y sus plazas adicionales.
No cobra comisiones sobre las ventas ni recibe el dinero de los comercios.

## Cuenta del comercio

- API de cuentas: Accounts v2 (`/v2/core/accounts`), sin `type` legacy.
- Dashboard completo (`dashboard: full`).
- Stripe factura el procesamiento al comercio (`fees_collector: stripe`).
- Stripe asume los saldos negativos no recuperables de las cuentas conectadas
  segun la configuracion y condiciones aplicables (`losses_collector: stripe`).
- Configuracion `merchant` con capacidad `card_payments`.
- Configuracion `customer` para preparar la futura facturacion SaaS.
- No configuracion `recipient`: no se distribuyen fondos desde la plataforma.

## Cobros directos

Cada venta se creara en la cuenta conectada del comercio. La marca, saldo y
relacion de pago corresponden al comercio, no a la plataforma.
El empleado utilizara la cuenta conectada del principal de su empresa.
No se utilizara la cuenta de la plataforma como fallback.

```text
Comprador -> cuenta Stripe del comercio -> banco del comercio
            menos tarifas Stripe; comision de plataforma = 0

Comercio -> suscripcion de la aplicacion -> cuenta de la plataforma
```

No se enviara `application_fee_amount`: no hay comision de plataforma.
Si en el futuro existiera una, seria solo la comision propia
(`applicationFeeIncludes: platform_fee_only`), sin sumar procesamiento Stripe.
Tarifas: https://stripe.com/es/pricing y https://stripe.com/es/connect/pricing.
La tarifa publicada de Stripe gestionando los precios no incluye cargos
adicionales de Connect por cuenta o transferencia para la plataforma; confirmar
condiciones contratadas, productos adicionales y costes de suscripciones.

## Alta y Dashboard

El principal autenticado abre el alta alojada en Stripe desde Configuracion.
Stripe recoge y verifica identidad, actividad y banco en el navegador, no en
una WebView ni mediante claves secretas introducidas en la app.
El regreso del navegador no significa que la cuenta este aprobada.
La app consulta otra vez el estado real y permite retomar requisitos pendientes.
El comercio accede a su Dashboard completo en https://dashboard.stripe.com.

La primera fase crea nuevas cuentas de prueba: no implementa vinculacion OAuth
de cuentas existentes. Definir ese recorrido con Stripe antes de ofrecerlo;
no prometer que cualquier cuenta previa quedara vinculada automaticamente.

## Requisitos continuos

Comprobar `configuration.merchant.capabilities.card_payments.status` y
`configuration.merchant.capabilities.stripe_balance.payouts.status` mediante
Accounts v2 antes de activar cobros y mostrar estado de abonos.
No inferir disponibilidad de Bizum o Terminal solo por `card_payments`.
Mantener aviso de requisitos pendientes y ruta para subsanarlos.

Componentes web posibles para futuras fases: `account_onboarding`,
`notification_banner`, `account_management`, `payments` y `payouts`.
La primera entrega movil usa alta alojada y estado consultado al servidor;
no afirma haber implementado esos componentes integrados.

## Confirmacion de eventos

Usar webhooks con firmas verificadas y procesamiento idempotente para confirmar
pagos, cambios de cuenta y reembolsos, incluidos metodos asincronos.

## Responsabilidad por saldos negativos

La configuracion propuesta asigna a Stripe los saldos negativos no recuperables
de las cuentas conectadas; la plataforma sigue respondiendo por los de su cuenta.
Esto no elimina las obligaciones del comercio sobre sus ventas y reclamaciones.

## Gestion del riesgo

Usar las herramientas y controles Stripe correspondientes al comercio y los
controles de seguridad de la app: permisos, aislamiento por empresa, auditoria
e idempotencia. Prevencion del fraude y responsabilidad financiera son distintas.

## Suscripciones

Conservar los planes y suscripciones existentes durante la fase de pruebas.
Para nuevas cuentas v2 con configuracion customer, evaluar `customer_account`
en SetupIntent/Subscription sin crear otro Customer v1 para esas cuentas.
No migrar suscripciones activas ni duplicarlas sin un procedimiento probado.

## Plan de implementacion

1. Alta y consulta de cuenta de pruebas por empresa, con claves independientes.
2. Persistencia de pagos y referencia de cuenta conectada; cobros directos QR,
   tarjeta y Bizum; despues ubicaciones y lectores Terminal por comercio.
3. Confirmacion fiable y conciliacion con tickets, sin depender del movil.
4. Reembolsos reales ligados al pago original, con PIN para empleados, limites
   de saldo, solicitudes idempotentes y estados pendiente/completado/fallido.
5. Pruebas entre dos empresas, doble envio, sesiones movidas, requisitos
   incompletos, devoluciones parciales y reembolsos desde Dashboard.
6. Activacion gradual en produccion solo tras verificar configuracion Stripe,
   migracion de operaciones antiguas y pruebas de carga/recuperacion.

## Estado de la primera fase

Implementados endpoints nuevos de alta y estado, boton de Configuracion,
retorno neutral y pruebas automatizadas.
**Fase 2 (parcial):** con `STRIPE_CONNECT_TEST_ENABLED=true`:
- `POST /api/stripe/payment` Checkout directo (`Stripe-Account`).
- `POST /api/stripe/terminal/connection-token` y `payment-intent` con cuenta
  conectada + ubicacion Terminal (`tml_...`) creada/reutilizada por comercio.
- `POST /api/documents/refund` emite reembolso Stripe real si el ticket tiene
  `stripePaymentIntentId` (antes de actualizar el documento); sin PI sigue
  siendo solo documental.
Sin cuenta o sin `chargesEnabled` el cobro se bloquea (sin fallback a plataforma).
La app guarda refs de pago en el ticket. Catalogo UE27 con seleccion explicita del principal:
AT, BE, BG, HR, CY, CZ, DK, EE, FI, FR, DE, GR, HU, IE, IT, LV, LT, LU, MT, NL, PL, PT,
RO, SK, SI, ES, SE. No significa que los 27 paises tengan alta operativa o aprobacion Stripe.
La lista habilitada de la plataforma es `STRIPE_CONNECT_TEST_COUNTRIES`, por defecto ES.
Los demas candidatos requieren revision explicita antes de incluirse; los no aprobados se bloquean.
Francia se bloquea siempre con un mensaje de alta adicional compatible, sin crear cuenta ni
escribir metadata: esta fase no implementa `account_token` ni un recorrido frances validado.
El requisito Stripe se refiere a plataformas de paises obligatorios (por ejemplo Francia), no
simplemente al pais del comercio. El bloqueo del candidato FR es una politica conservadora;
verificar el pais de la plataforma y no usar el catalogo como prueba de conformidad.
Referencias: https://docs.stripe.com/api/v2/core/accounts/create y
https://docs.stripe.com/connect/account-tokens.
Desactivada por defecto, solo acepta clave `sk_test` independiente.
No crea cuentas ni hace llamadas Stripe mientras esta desactivada.
No modifica los endpoints existentes de ventas o suscripciones.
No implementa aun reembolsos de dinero.

La cuenta se vincula al principal en metadata administrada por servidor.
Se persiste el pais del intento y de la vinculacion, inmutable mientras exista cualquiera.
El pais real de `identity` debe coincidir antes de vincular, consultar o renovar/consumir callbacks;
si no coincide, 409 sin nueva mutacion. Los intentos legacy sin pais conservan ES para recuperacion.
El principal selecciona el pais en un modal UE27; no se confirma automaticamente el ES inicial.
La seleccion usa `issuer.country`, se captura antes de la solicitud y se reinicia al cambiar cuenta.
Los enlaces temporales se entregan solo dentro de la sesion autenticada.
Los callbacks llevan estado firmado, caducado y vinculado a sesion/dispositivo;
no incluyen el bearer token de la app.

Configuracion necesaria en entorno de pruebas:

- `STRIPE_CONNECT_TEST_ENABLED=true`
- `STRIPE_CONNECT_TEST_COUNTRIES`: codigos UE27 revisados, separados por comas; defecto ES.
- `STRIPE_CONNECT_TEST_SECRET_KEY`: clave de pruebas de la plataforma Connect.
- `STRIPE_CONNECT_STATE_SECRET`: secreto independiente de al menos 32 bytes.
- `PUBLIC_API_URL`: origen HTTPS del backend.

No introducir secretos en chat, archivos versionados ni variables publicas Expo.
Confirmar Connect habilitado y acceso Accounts v2 antes de una prueba real.
No habilitar esta primera fase como si enrutara ya las ventas.
Las pruebas son simuladas y comprueban contratos de los 26 candidatos no FR, no disponibilidad
real ni verificacion KYC completa. No se han consultado claves, Dashboard ni API autenticada.
Los cobros existentes siguen en EUR sin cambios; soportar monedas no EUR exige otra fase.

## Pendientes de confirmacion

- Aprobar cada combinacion de pais de plataforma/comercio antes de ampliar la lista de pruebas.
- Resolver y validar el flujo adicional de Francia; no anunciar alta funcional UE27 completa.
- Revisar habilitacion y condiciones de Connect en la cuenta de la plataforma.
- Definir compatibilidad de comercios que ya tienen una cuenta Stripe.
- Definir migracion/conciliacion de pagos existentes de la cuenta unica.
- Pasar bloqueos e idempotencia a almacenamiento compartido antes de multiples
  instancias; el mutex actual solo coordina un proceso.

## Checklist: claves live + Play Store

Hacerlo **después** de validar cobros/devoluciones Connect en test con 1–2 comercios piloto.

### Stripe live
1. Activar cuenta plataforma en modo real (KYC, IBAN, negocio).
2. Habilitar Connect en live; crear precios live de suscripción (10,89 € / 3,03 €).
3. Variables Render live: `STRIPE_SECRET_KEY=sk_live_...`, webhook `whsec_...`,
   price IDs live, `PUBLIC_API_URL` HTTPS.
4. Fase Connect live (equivalente a test): clave Connect live, paises aprobados,
   `STRIPE_CONNECT_STATE_SECRET` distinto y durable.
5. Ubicaciones Terminal live por comercio (o las que cree el backend en Connect).
6. Webhooks: pagos, `charge.refunded`, `account.updated` / capabilities.
7. Probar: cobro QR, Tap to Pay, devolución parcial/total, 2 empresas aisladas.

### Play Store
1. Cuenta Google Play Console (~25 USD).
2. Privacy policy URL pública + Data safety (pagos, ubicación, NFC).
3. `eas.json` production: API URL live, sin claves secretas en el APK.
4. Build EAS production (`eas build -p android --profile production`).
5. Internal testing → closed → production.
6. Tap to Pay: build **no depurable**; dispositivo/OS compatibles Stripe.
7. Revisar permisos NFC/ubicación/Bluetooth en ficha de la app.