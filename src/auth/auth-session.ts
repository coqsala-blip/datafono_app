// Utilidades puras de acceso: identificador de dispositivo, validación del formulario y cuerpo de
// las peticiones de login/registro. Sin dependencias nativas para poder probarlas en Node.

export type AuthMode = 'login' | 'register';
export type AuthRole = 'principal' | 'empleado';

export type AuthForm = {
  mode: AuthMode;
  role: AuthRole;
  email: string;
  password: string;
  fullName: string;
  companyName: string;
  employeeAccessCode: string;
};

export type DeviceIdStore = {
  getItemAsync: (key: string) => Promise<string | null>;
  setItemAsync: (key: string, value: string) => Promise<void>;
};

// Clave de SecureStore (excluida de las copias de seguridad); no se reutiliza el ID antiguo de
// AsyncStorage porque una copia restaurada en otro móvil lo duplicaría.
export const DEVICE_ID_KEY = 'tpv_device_id_v2';
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

const randomHex = (bytes: number): string => {
  const buffer = new Uint8Array(bytes);
  const cryptoApi = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;
  if (typeof cryptoApi?.getRandomValues === 'function') {
    cryptoApi.getRandomValues(buffer);
  } else {
    for (let index = 0; index < bytes; index += 1) buffer[index] = Math.floor(Math.random() * 256);
  }
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const generateDeviceId = (): string => `dev-${Date.now().toString(36)}-${randomHex(16)}`;

// Devuelve el ID guardado o crea uno nuevo. Si no se puede guardar y releer, devuelve null: sin ID
// estable no se permite iniciar sesión.
export const getOrCreateDeviceId = async (store: DeviceIdStore): Promise<string | null> => {
  try {
    const existing = await store.getItemAsync(DEVICE_ID_KEY);
    if (existing && DEVICE_ID_PATTERN.test(existing)) return existing;
  } catch {
    // Valor ilegible (p. ej. restaurado sin su clave del Keystore): se genera uno nuevo.
  }
  const deviceId = generateDeviceId();
  try {
    await store.setItemAsync(DEVICE_ID_KEY, deviceId);
    return (await store.getItemAsync(DEVICE_ID_KEY)) === deviceId ? deviceId : null;
  } catch {
    return null;
  }
};

export const normalizeAccessCodeInput = (code: string): string => code.normalize('NFKC').trim().toUpperCase();

// Devuelve la clave de traducción del primer error o null si el formulario es válido.
export const validateAuthForm = (form: AuthForm): string | null => {
  const email = form.email.trim();
  if (form.role === 'empleado') {
    if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) return 'auth.errorEmail';
    if (!form.fullName.trim()) return 'auth.errorFullName';
    if (normalizeAccessCodeInput(form.employeeAccessCode).length < 8) return 'auth.errorCode';
    return null;
  }
  if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) return 'auth.errorEmail';
  if (form.mode === 'login') return form.password ? null : 'auth.errorPassword';
  if (form.password.length < 8) return 'auth.errorPasswordLength';
  if (!form.fullName.trim()) return 'auth.errorFullName';
  if (!form.companyName.trim()) return 'auth.errorCompanyName';
  return null;
};

export const buildAuthRequestBody = (form: AuthForm, deviceId: string, force = false): Record<string, unknown> => {
  if (form.role === 'empleado') {
    return {
      companyEmail: form.email.trim().toLowerCase(),
      fullName: form.fullName.trim(),
      employeeAccessCode: form.employeeAccessCode.normalize('NFKC').trim(),
      deviceId,
    };
  }
  const base = { email: form.email.trim().toLowerCase(), password: form.password, deviceId };
  if (form.mode === 'login') return { ...base, force };
  return {
    ...base,
    role: form.role,
    fullName: form.fullName.trim(),
    companyName: form.companyName.trim(),
  };
};

export type SessionCheckOutcome = 'ok' | 'conflict' | 'expired' | 'unknown';

export const classifySessionCheck = (status: number, code?: unknown): SessionCheckOutcome => {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 409 && code === 'device_conflict') return 'conflict';
  if (status === 401) return 'expired';
  return 'unknown';
};
