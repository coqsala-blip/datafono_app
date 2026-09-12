# TPV & GESTOR Backend

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
- `POST /api/monei/payment`
- `GET /api/monei/payment/:paymentId`
- `POST /api/monei/callback`

### Plan actual

- Base usuario principal: 9,00 € / mes + 21% IVA (10,89 €)
- Usuario adicional (empleado): 2,50 € / mes + 21% IVA (3,03 €)

### Fórmula

```text
total_neto = 9 + (usuarios_adicionales * 2.5)
total_con_iva = total_neto * 1.21
```

> Si quieres, luego puedes conectar este backend con la app Expo y con una base de datos real.

Las suscripciones todavía requieren conectar el endpoint de suscripciones de MONEI; no se utiliza Stripe.

### Despliegue en Render

El archivo `render.yaml` de la raíz configura este backend como un Web Service de Render.

1. En Render, crea un Blueprint conectado al repositorio y selecciona `render.yaml`.
2. Introduce en el panel las variables marcadas como secretas en `render.yaml`.
3. Cuando Render asigne la URL del servicio, configura `PUBLIC_API_URL` con esa URL completa usando `https://`.
4. Comprueba que `https://TU-SERVICIO.onrender.com/health` responde con `ok: true`.
5. Añade `MONEI_API_KEY` en Render con la clave de prueba o producción correspondiente.
6. Configura en MONEI el callback `https://TU-SERVICIO.onrender.com/api/monei/callback` si usas webhooks de cuenta.

No subas el archivo `server/.env` ni copies sus secretos al repositorio.
