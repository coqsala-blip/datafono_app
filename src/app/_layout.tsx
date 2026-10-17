import { StripeTerminalProvider } from '@stripe/stripe-terminal-react-native';
import { Stack } from 'expo-router';
import * as SecureStore from 'expo-secure-store';

const AUTH_TOKEN_KEY = 'tpv_access_token';
const configuredDocumentApiUrl = process.env.EXPO_PUBLIC_DOCUMENT_API_URL?.replace(/\/$/, '');
const TOKEN_TIMEOUT_MS = 45000;
const TOKEN_RETRIES = 2;

const fetchWithTimeout = async (url: string, options: RequestInit, timeoutMs: number) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
};

const fetchStripeTerminalToken = async () => {
  if (!configuredDocumentApiUrl) {
    throw new Error('No hay una URL de backend configurada.');
  }

  const accessToken = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
  if (!accessToken) {
    throw new Error('Inicia sesión para poder cobrar con tarjeta presencial.');
  }

  // Despierta Render antes del token (cold start).
  try {
    await fetchWithTimeout(`${configuredDocumentApiUrl}/health`, {}, 20000);
  } catch {
    // Si health falla, igual intentamos el token.
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= TOKEN_RETRIES; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        `${configuredDocumentApiUrl}/api/stripe/terminal/connection-token`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}` },
        },
        TOKEN_TIMEOUT_MS,
      );
      const result = await response.json() as { secret?: string; error?: string };
      if (!response.ok || !result.secret) {
        throw new Error(result.error || 'No se pudo conectar con Stripe Terminal.');
      }
      return result.secret;
    } catch (error) {
      const aborted = error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(error.message));
      lastError = aborted
        ? new Error('El servidor tardó demasiado en preparar Stripe. Espera unos segundos y vuelve a intentarlo.')
        : error instanceof Error
          ? error
          : new Error('No se pudo conectar con Stripe Terminal.');
      if (attempt < TOKEN_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
  }

  throw lastError || new Error('No se pudo conectar con Stripe Terminal.');
};

export default function RootLayout() {
  return (
    <StripeTerminalProvider tokenProvider={fetchStripeTerminalToken} logLevel="verbose">
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
      </Stack>
    </StripeTerminalProvider>
  );
}
