# Checklist Google Play Store — TPV & GESTIÓN

Package: `com.hichfla.tpvapp`  
Canal OTA: `production`  
Build tienda: perfil EAS `production` → **Android App Bundle (`.aab`)**

---

## 1. Antes del build (ya en el repo)

- [x] `eas.json` → `production.android.buildType`: `"app-bundle"`
- [x] `app.json` → `android.package`: `com.hichfla.tpvapp`
- [x] `app.json` → `version`: `1.0.0` (+ `versionCode` / autoIncrement EAS)
- [x] Icono: `assets/icon.png` + adaptive `assets/adaptive-icon.png`
- [x] Permisos Android: Cámara, NFC, ubicación (coarse + fine), Bluetooth scan/connect
- [ ] Cuenta [Google Play Console](https://play.google.com/console) (pago único ~25 USD)
- [ ] Crear aplicación con el **mismo** package `com.hichfla.tpvapp` (no se puede cambiar después)

### Build de producción

```bash
npx eas build --platform android --profile production --non-interactive
```

- Perfil `production` → **`.aab`** (Play Store).
- Perfil `preview` → **`.apk`** (USB / demos).
- `.easignore` excluye APKs locales y la carpeta `android/` local (EAS hace prebuild limpio).
- Tras el build: descarga el `.aab` desde Expo / EAS Dashboard.
- Subida a Play: consola manual o `npx eas submit --platform android --profile production`.

**Nota:** el `versionCode` lo incrementa EAS (`appVersionSource: remote` + `autoIncrement`). No hace falta fijarlo en `app.json`.

### Último AAB generado (versionCode 3)

- Página EAS: https://expo.dev/accounts/hichfla/projects/tpv-app/builds/e5fd220c-bde9-48da-8f1a-3a4b1e6e0e05  
- Descarga `.aab`: https://expo.dev/artifacts/eas/zsAVMbyB3pMCPQuUDt-qsBlc_cipy6YCV2XnMmHPZWc.aab  
- Siguiente paso: subir este AAB a **Prueba interna** en Play Console.

---

## 2. Prueba interna (track Internal testing)

Sube el `.aab` a **Prueba interna** antes de producción.

### Dispositivos / cuentas
- [ ] 2–5 testers con cuenta Google añadidos a la lista interna
- [ ] Instalar desde el enlace de prueba interna (no el APK USB antiguo)
- [ ] Al menos un móvil con **NFC** y Tap to Pay (Android 11+, sin “Opciones de desarrollador” si cobras en Live)

### Flujos mínimos a validar
- [ ] Login principal y empleado (PIN de devoluciones si aplica)
- [ ] Cobro Tap to Pay 1,00 € (Live) → ticket / factura con QR
- [ ] Devolución parcial 0,50 € → aviso con `re_…` y reembolso en Stripe plataforma Live
- [ ] Cobro enlace/QR (métodos locales activos: Bancontact, MB WAY, EPS, etc.)
- [ ] Arrastrar hacia abajo → busca OTA; si hay update, franja roja y tocar para instalar
- [ ] Presupuesto / factura email-PDF + campo `21 IVA/TAX`
- [ ] Config: datos negocio, logo, IVA por defecto
- [ ] Cerrar sesión y volver a entrar; sincronizar historial

### No bloqueantes (pueden esperar)
- [ ] Bizum Live (aprobación Stripe/Openbank)
- [ ] Klarna / iDEAL / Wero / BLIK si aún no están habilitados en Dashboard Live

---

## 3. Ficha de Play Store (requerimientos clave)

### Textos e identidad
- [ ] **Nombre** en la ficha (valorar “TPV GESTION” sin `$` si el nombre con `$` da problemas en consola)
- [ ] Descripción corta (≤ 80 caracteres)
- [ ] Descripción completa (cobros presencial + enlace/QR, tickets, facturas, Stripe)
- [ ] Categoría: Negocios / Finanzas (la que mejor encaje)
- [ ] Email de contacto de soporte y, si aplica, teléfono / web

### Gráficos
- [ ] Icono alta resolución **512 × 512** PNG (sin transparencia en el asset de tienda, según plantilla actual de Play)
- [ ] Feature graphic **1024 × 500**
- [ ] Capturas de pantalla teléfono (mín. 2; recomendado 4–8): TPV, cobro, ticket, config
- [ ] (Opcional) capturas tablet

### Privacidad y datos (casi obligatorio con pagos)
- [ ] **URL de política de privacidad** pública (HTTPS): `https://tpv-gestor-backend.onrender.com/privacy`
- [ ] **URL de eliminación de cuenta** (Data safety): `https://tpv-gestor-backend.onrender.com/delete-account`
- [ ] Formulario **Data safety**: cuenta de usuario, datos de negocio, pagos procesados por Stripe, ubicación/NFC/Bluetooth para Tap to Pay
- [ ] Declarar que los cobros los procesa **Stripe** (no almacenáis PAN de tarjeta en vuestros servidores)

### Declaraciones de permisos / funciones
- [ ] Cámara → escanear códigos / documentos
- [ ] NFC → Tap to Pay / pagos contactless
- [ ] Ubicación → requisito Stripe Terminal / Tap to Pay
- [ ] Bluetooth → lectores Terminal compatibles
- [ ] Si Play pregunta por uso financiero / pagos: indicar app de cobro para comercios (TPV)

### Cumplimiento
- [ ] Contenido para mayores de edad / público objetivo comercio
- [ ] Países de distribución (empezar por ES / UE si aplica)
- [ ] Precio: gratuita (suscripción dentro de la app vía Stripe; revisar políticas de pagos de Play si cobráis suscripción digital — vuestra suscripción es de software SaaS; conviene releer la política de compras de Play)

---

## 4. Tras publicar

- [ ] Track **producción** o **abierta** cuando la interna esté OK
- [ ] Guardar keystore / credenciales EAS (no perder el firmado)
- [ ] OTA posteriores: `npx eas update --channel production` (sin nueva revisión si no cambia el binario nativo)
- [ ] Subidas nativas (SDK, permisos nuevos): nuevo `eas build` + nuevo `versionCode`

---

## 5. Comandos útiles

```bash
# Build AAB para Play Store
npx eas build --platform android --profile production

# Build APK solo para USB / demos
npx eas build --platform android --profile preview

# Enviar el último build a Play (requiere cuenta enlazada)
npx eas submit --platform android --latest

# Actualización JS/OTA sin pasar por revisión de binario
npx eas update --channel production --platform android --message "descripcion"
```

---

## 6. Notas del proyecto

| Concepto | Valor |
|----------|--------|
| Package | `com.hichfla.tpvapp` |
| Version name | `1.0.0` (`app.json` → `expo.version`) |
| Version code | `android.versionCode` + `autoIncrement` EAS remote |
| Backend | `https://tpv-gestor-backend.onrender.com` |
| Stripe | Connect Live + Terminal Tap to Pay; Bizum puede seguir pendiente |
| OTA | Canal `production`, aviso rojo + pull-to-refresh en la app |
