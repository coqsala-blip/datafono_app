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
- `POST /api/stripe/webhook`

### Plan actual

- Base: 7 € / mes
- Usuario adicional: 2 € / mes

### Fórmula

```text
total = 7 + ((usuarios_totales - 1) * 2)
```

> Si quieres, luego puedes conectar este backend con la app Expo y con una base de datos real.

### Despliegue en Render

El archivo `render.yaml` de la raíz configura este backend como un Web Service de Render.

1. En Render, crea un Blueprint conectado al repositorio y selecciona `render.yaml`.
2. Introduce en el panel las variables marcadas como secretas en `render.yaml`.
3. Cuando Render asigne la URL del servicio, configura `PUBLIC_API_URL` con esa URL completa usando `https://`.
4. Comprueba que `https://TU-SERVICIO.onrender.com/health` responde con `ok: true`.

No subas el archivo `server/.env` ni copies sus secretos al repositorio.
