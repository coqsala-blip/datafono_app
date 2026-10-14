import * as Updates from 'expo-updates';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

export type OtaCheckStatus = 'available' | 'upToDate' | 'busy' | 'disabled' | 'error';

type UseAppOtaOptions = {
  /** No comprobar ni reiniciar durante un cobro Tap to Pay u otra operación crítica. */
  busy: boolean;
};

/**
 * Actualizaciones OTA (Expo Updates):
 * - Comprueba al abrir y al volver a la app.
 * - Pull-to-refresh llama a checkForOta.
 * - Si hay update, deja updateReady=true para mostrar el aviso; aplica con applyUpdate.
 */
export function useAppOta({ busy }: UseAppOtaOptions) {
  const [updateReady, setUpdateReady] = useState(false);
  const [checking, setChecking] = useState(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const checkingRef = useRef(false);

  const checkForOta = useCallback(async (): Promise<OtaCheckStatus> => {
    if (__DEV__ || !Updates.isEnabled) return 'disabled';
    if (busyRef.current) return 'busy';
    if (checkingRef.current) return 'busy';
    checkingRef.current = true;
    setChecking(true);
    try {
      const result = await Updates.checkForUpdateAsync();
      if (!result.isAvailable) {
        setUpdateReady(false);
        return 'upToDate';
      }
      await Updates.fetchUpdateAsync();
      if (busyRef.current) return 'busy';
      setUpdateReady(true);
      return 'available';
    } catch (error) {
      console.warn('OTA check failed:', error);
      return 'error';
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  }, []);

  const applyUpdate = useCallback(async () => {
    if (__DEV__ || !Updates.isEnabled) return;
    if (busyRef.current) return;
    try {
      if (!updateReady) {
        const status = await checkForOta();
        if (status !== 'available') return;
      }
      await Updates.reloadAsync();
    } catch (error) {
      console.warn('OTA apply failed:', error);
    }
  }, [checkForOta, updateReady]);

  useEffect(() => {
    void checkForOta();
  }, [checkForOta]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void checkForOta();
    });
    return () => sub.remove();
  }, [checkForOta]);

  return { updateReady, checking, checkForOta, applyUpdate };
}
