# Actualizaciones de la app (EAS Update)

Así puedes corregir fallos de pantalla/lógica **sin** enviar un APK nuevo a cada país.
Los clientes solo tienen que **cerrar y abrir** la app (a veces dos veces).

## Qué se actualiza solo (OTA)

- Pantallas, textos, flujos (presupuesto, facturas, Config…)
- Lógica JS/TS y la mayoría de assets

## Qué obliga a un APK/AAB nuevo

- Librerías nativas (Stripe Terminal, NFC, cámara…)
- Permisos Android nuevos
- Cambio de `version` / runtime nativo

El **backend** (Render) se actualiza solo: no hace falta tocar el móvil.

## Canales

| Canal | Uso |
|--------|-----|
| `preview` | Pruebas internas |
| `production` | Usuarios reales |

## Flujo diario (parche JS)

1. Corrige el código.
2. Publica la actualización:

```bash
npm run update:production -- "Arregla facturas pendientes en Presupuesto"
```

o preview:

```bash
npm run update:preview -- "Prueba del parche X"
```

3. El usuario abre la app con internet → descarga el parche en segundo plano → al **reabrir**, ya tiene el arreglo.

## Primera vez / cambio nativo

Hace falta un build con `expo-updates` activado (este repo ya lo tiene):

```bash
# Local (APK)
.\android\gradlew.bat -p android :app:assembleRelease

# o EAS (recomendado para distribuir)
npx eas-cli build --profile production --platform android
npx eas-cli build --profile preview --platform android
```

Instala **ese** APK/AAB una vez. A partir de ahí, los parches JS van por OTA.

## Runtime version

`runtimeVersion` usa la política `appVersion` (= `expo.version` en `app.json`, ahora `1.0.0`).

- Parches OTA: **no** cambies `version`.
- Build nativo nuevo: sube `version` en `app.json` **y** el mismo valor en  
  `android/app/src/main/res/values/strings.xml` → `expo_runtime_version`.

Si no coinciden, la app no recibirá updates.

## Play Store (recomendado a medio plazo)

1. `eas build --profile production --platform android` (AAB si lo pides en el perfil).
2. `eas submit --platform android` o subida manual a Google Play.
3. Los usuarios actualizan desde Play; los parches JS siguen pudiendo ir por EAS Update.

## Límites

- Quien tenga un APK **viejo** (sin updates habilitados) no recibe OTA: debe instalar una build nueva una vez.
- Sin internet al abrir, usará la última versión ya descargada.
