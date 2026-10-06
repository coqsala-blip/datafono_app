import AsyncStorage from '@react-native-async-storage/async-storage';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { APP_LOCALE_STORAGE_KEY, isAppLocale, t, type AppLocale } from '../i18n';

// Pantalla de retorno tras pagar con el enlace o el QR: Stripe Checkout redirige aqui con el
// esquema de la app y volvemos al TPV, donde el cobro ya se confirma y se muestra el ticket.
export default function PagoCompletado() {
  const { flow, result, connect } = useLocalSearchParams<{ flow?: string; result?: string; connect?: string }>();
  const isConnectOnboarding = connect === 'return';
  const isPaymentMethodSetup = flow === 'payment-method-setup';
  const paymentMethodSaved = isPaymentMethodSetup && result === 'success';
  const [locale, setLocale] = useState<AppLocale>('es');

  useEffect(() => {
    if (!isConnectOnboarding) return;
    let cancelled = false;
    void AsyncStorage.getItem(APP_LOCALE_STORAGE_KEY).then((saved) => {
      if (!cancelled && isAppLocale(saved)) setLocale(saved);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [isConnectOnboarding]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      if (isConnectOnboarding || isPaymentMethodSetup) {
        router.back();
      } else {
        router.replace('/');
      }
    }, 600);
    return () => clearTimeout(timeout);
  }, [isConnectOnboarding, isPaymentMethodSetup]);

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f1f5f9', padding: 24 }}>
      <Text style={{ fontSize: 18, fontWeight: 'bold', color: '#0f172a', textAlign: 'center' }}>
        {isConnectOnboarding ? t(locale, 'connect.returnTitle') : isPaymentMethodSetup
          ? paymentMethodSaved ? 'Tarjeta guardada' : 'No se confirmó la tarjeta'
          : 'Pago recibido'}
      </Text>
      <Text style={{ fontSize: 13, color: '#475569', marginTop: 10, textAlign: 'center' }}>
        {isConnectOnboarding ? t(locale, 'connect.returnBody') : isPaymentMethodSetup
          ? paymentMethodSaved
            ? 'Volviendo para completar el cobro de las plazas...'
            : 'Vuelve a Configuración para intentarlo de nuevo. No se ha añadido el usuario.'
          : 'Volviendo a la aplicación para mostrar el ticket...'}
      </Text>
    </View>
  );
}