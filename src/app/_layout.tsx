import { StripeTerminalProvider } from '@stripe/stripe-terminal-react-native';
import { Stack } from 'expo-router';
import * as SecureStore from 'expo-secure-store';

const API_URL = process.env.EXPO_PUBLIC_DOCUMENT_API_URL?.replace(/\/$/, '');
const AUTH_TOKEN_KEY = 'tpv_access_token';

const fetchTerminalToken = async () => {
  const token = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
  if (!API_URL || !token) {
    throw new Error('No hay una sesión activa para iniciar Stripe Terminal.');
  }

  const response = await fetch(`${API_URL}/api/terminal/connection-token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const result = await response.json() as { secret?: string; error?: string };
  if (!response.ok || !result.secret) {
    throw new Error(result.error || 'No se pudo obtener el token de Stripe Terminal.');
  }

  return result.secret;
};

export default function RootLayout() {
  return (
    <StripeTerminalProvider tokenProvider={fetchTerminalToken} logLevel="verbose">
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
      </Stack>
    </StripeTerminalProvider>
  );
}
