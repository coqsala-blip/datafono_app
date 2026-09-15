import { StripeTerminalProvider } from '@stripe/stripe-terminal-react-native';
import { Stack } from 'expo-router';
import * as SecureStore from 'expo-secure-store';

const AUTH_TOKEN_KEY = 'tpv_access_token';
const configuredDocumentApiUrl = process.env.EXPO_PUBLIC_DOCUMENT_API_URL?.replace(/\/$/, '');

const fetchStripeTerminalToken = async () => {
  if (!configuredDocumentApiUrl) {
    throw new Error('No hay una URL de backend configurada.');
  }

  const accessToken = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
  if (!accessToken) {
    throw new Error('Inicia sesión para poder cobrar con tarjeta presencial.');
  }

  const response = await fetch(`${configuredDocumentApiUrl}/api/stripe/terminal/connection-token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const result = await response.json() as { secret?: string; error?: string };
  if (!response.ok || !result.secret) {
    throw new Error(result.error || 'No se pudo conectar con Stripe Terminal.');
  }

  return result.secret;
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
