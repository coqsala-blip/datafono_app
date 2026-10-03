import { router, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { Text, View } from 'react-native';

// Pantalla de retorno tras pagar con el enlace o el QR: Stripe Checkout redirige aqui con el
// esquema de la app y volvemos al TPV, donde el cobro ya se confirma y se muestra el ticket.
export default function PagoCompletado() {
  const { flow } = useLocalSearchParams<{ flow?: string }>();
  const isPaymentMethodSetup = flow === 'payment-method-setup';

  useEffect(() => {
    const timeout = setTimeout(() => {
      if (isPaymentMethodSetup) {
        router.back();
      } else {
        router.replace('/');
      }
    }, 600);
    return () => clearTimeout(timeout);
  }, [isPaymentMethodSetup]);

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f1f5f9', padding: 24 }}>
      <Text style={{ fontSize: 18, fontWeight: 'bold', color: '#0f172a', textAlign: 'center' }}>
        {isPaymentMethodSetup ? 'Tarjeta guardada' : 'Pago recibido'}
      </Text>
      <Text style={{ fontSize: 13, color: '#475569', marginTop: 10, textAlign: 'center' }}>
        {isPaymentMethodSetup
          ? 'Volviendo para completar el cobro de las plazas...'
          : 'Volviendo a la aplicación para mostrar el ticket...'}
      </Text>
    </View>
  );
}