import { MaterialIcons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { requestNeededAndroidPermissions, useStripeTerminal } from '@stripe/stripe-terminal-react-native';
import { Camera, CameraView } from 'expo-camera';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import * as ExpoLinking from 'expo-linking';
import * as MailComposer from 'expo-mail-composer';
import * as Print from 'expo-print';
import * as SecureStore from 'expo-secure-store';
import * as Sharing from 'expo-sharing';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { buildAuthRequestBody, classifySessionCheck, getOrCreateDeviceId, validateAuthForm, type AuthForm } from '../auth/auth-session';
import { LogoSettings } from '../components/logo-settings';
import { normalizeLogoSettings, renderIssuerBlock, type LogoOffset, type LogoPosition, type LogoSize } from '../documents/logo-layout';
import { buildPdfFilename, buildReportPdfFilename, copyPdfForExport } from '../documents/pdf-export';
import { APP_LOCALES, APP_LOCALE_STORAGE_KEY, detectDeviceLocale, formatCurrencyForLocale, isAppLocale, t as translateKey, type AppLocale } from '../i18n';
import { CONNECT_EU_COUNTRIES, connectCountryLabel, connectErrorKey, connectStatusKey, normalizeConnectCountry, parseConnectOnboardingUrl, parseConnectStatus, type ConnectCountry } from '../payments/connect-onboarding';
import { buildEmailedReport } from '../reports/emailed-report';

type DocumentType = 'TICKET DE VENTA' | 'FACTURA SIMPLIFICADA' | 'FACTURA COMPLETA' | 'TICKET DE DEVOLUCIÓN' | 'COMPRA/DEVOLUCIONES' | 'PRESUPUESTO' | 'FACTURA';
type TransactionType = 'COBRO' | 'DEVOLUCIÓN';
type Tab = 'gastos_facturacion' | 'tpv' | 'presupuesto' | 'stats' | 'config';
type UserRole = 'principal' | 'empleado';
type AuthenticatedUser = { id?: string; app_metadata?: { role?: unknown; company_owner_id?: unknown } };

type Client = { name: string; nif: string; address: string };
type Issuer = {
  name: string;
  nif: string;
  address: string;
  logoUri?: string;
  logoPosition?: LogoPosition;
  logoSize?: LogoSize;
  logoOffsetA4?: LogoOffset;
  logoOffsetTicket?: LogoOffset;
  managerEmail?: string;
  accountHolder?: string;
  iban?: string;
  bankName?: string;
  country?: string;
  additionalUsers?: number;
};
type InvoiceItem = { id: string; description: string; price: string };
type PendingInvoice = { client: Client; items: InvoiceItem[]; ivaRate: number; total: number; docType: DocumentType };
type StripeTerminalPaymentIntentResult = {
  paymentIntentId?: string;
  clientSecret?: string;
  accountId?: string | null;
  locationId?: string | null;
  chargeMode?: 'direct' | 'platform';
  code?: string;
  error?: string;
};
type StripePaymentRefs = {
  stripePaymentIntentId?: string;
  stripeAccountId?: string | null;
  chargeMode?: 'direct' | 'platform';
  stripeCheckoutSessionId?: string | null;
};
type StripeOnlinePaymentResult = {
  paymentId?: string;
  checkoutUrl?: string;
  redirectUrl?: string;
  qrDataUrl?: string | null;
  paymentMethods?: string[] | 'auto';
  accountId?: string | null;
  chargeMode?: 'direct' | 'platform';
  paymentIntentId?: string | null;
  code?: string;
  error?: string;
};
type StripeOnlinePaymentStatusResult = {
  status?: string;
  paymentStatus?: string;
  checkoutStatus?: string;
  usedMethod?: string | null;
  accountId?: string | null;
  chargeMode?: 'direct' | 'platform';
  paymentIntentId?: string | null;
  error?: string;
};
type SyncAllResult = {
  ok?: boolean;
  documents?: (Record<string, unknown> & { id?: string; ticketCode?: string; publicUrl?: string; createdAt?: string })[];
  expenses?: { local_id?: string; description?: string; amount?: number; date?: string | null; category?: string; synced_at?: string }[];
  error?: string;
};

const configuredDocumentApiUrl = process.env.EXPO_PUBLIC_DOCUMENT_API_URL?.replace(/\/$/, '');
const DOCUMENT_API_URL_CANDIDATES = configuredDocumentApiUrl ? [configuredDocumentApiUrl] : [];
const STRIPE_TERMINAL_LOCATION_ID = process.env.EXPO_PUBLIC_STRIPE_TERMINAL_LOCATION_ID?.trim();
// Enlace al que Stripe Checkout redirige al terminar el pago: devuelve al cliente a la app.
const ONLINE_PAYMENT_REDIRECT_URL = 'tpvapp://pago-completado';

const fetchWithTimeout = async (url: string, options: RequestInit = {}, timeoutMs = 1500) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    // AbortError expuesto tal cual confunde ('Aborted'): se traduce a un aviso accionable.
    if (controller.signal.aborted) {
      throw new Error(`El servidor no respondió en ${Math.round(timeoutMs / 1000)} s. Comprueba tu conexión e inténtalo de nuevo.`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
};

type Expense = {
  id: string;
  expenseCode: string;
  provider: string;
  amount: number;
  imageUri: string;
  createdAt: string;
  issuer: Issuer;
};

interface Transaction {
  id: string;
  ticketCode: string;
  type: TransactionType;
  documentType: DocumentType;
  amount: number;
  originalAmount?: number;
  relatedTicketCode?: string;
  subtotal: number;
  iva: number;
  ivaRateApplied: number;
  createdAt: string;
  method: string;
  issuer: Issuer;
  client?: Client;
  items?: InvoiceItem[];
  isRefunded?: boolean;
  refundHistory?: { amount: number; date: string; stripeRefundId?: string; stripeRefundStatus?: string }[];
  publicUrl?: string;
  stripePaymentIntentId?: string;
  stripeAccountId?: string | null;
  chargeMode?: 'direct' | 'platform';
  stripeCheckoutSessionId?: string | null;
}

// Estado de la suscripción que devuelve GET /api/billing/status, incluidos los datos de impago
// (plazo de cortesía y bloqueo) que calcula el backend.
type SubscriptionStatusResult = {
  active?: boolean;
  status?: string;
  additionalUsers?: number;
  totalMonthlyCents?: number;
  pastDue?: boolean;
  pastDueSince?: string | null;
  daysPastDue?: number;
  daysUntilLock?: number | null;
  locked?: boolean;
  lockAfterDays?: number;
  pastDueInvoiceUrl?: string | null;
  error?: string;
};

interface CashInvoiceDraft extends Transaction {
  documentType: 'FACTURA';
}

const initialIssuer: Issuer = {
  name: '',
  nif: '',
  address: '',
  logoUri: undefined,
  managerEmail: '',
  accountHolder: '',
  iban: '',
  bankName: '',
  country: 'ES',
  additionalUsers: 0,
};

const restoreIssuerSettings = (value: unknown): Issuer => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid issuer settings');
  const saved = value as Record<string, unknown>;
  const samples = {
    name: 'COMERCIO LOCAL AUTÓNOMO S.L.',
    nif: 'B98765432',
    address: 'Calle Mayor 45, Santander',
    managerEmail: 'gestor@tugestoria.com',
    accountHolder: 'Comercio Local Autónomo S.L.',
    iban: 'ES9121000418450200051332',
    bankName: 'Banco Santander',
  };
  const restored = { ...initialIssuer, ...normalizeLogoSettings(saved) };
  for (const field of Object.keys(samples) as (keyof typeof samples)[]) {
    if (saved[field] !== undefined && typeof saved[field] !== 'string') throw new Error('Invalid issuer field');
    restored[field] = saved[field] === samples[field] ? '' : (saved[field] as string | undefined) ?? '';
  }
  for (const field of ['country', 'logoUri'] as const) {
    if (saved[field] !== undefined && typeof saved[field] !== 'string') throw new Error('Invalid issuer field');
    if (typeof saved[field] === 'string') restored[field] = saved[field];
  }
  if (saved.additionalUsers !== undefined) {
    if (typeof saved.additionalUsers !== 'number' || !Number.isFinite(saved.additionalUsers) || saved.additionalUsers < 0) throw new Error('Invalid issuer seats');
    restored.additionalUsers = saved.additionalUsers;
  }
  return restored;
};

const STORAGE_KEY_TRANSACTIONS = '@tpv_transactions_v1';
const STORAGE_KEY_CASH_INVOICE_DRAFTS = '@tpv_cash_invoice_drafts_v1';
const STORAGE_KEY_EXPENSES = '@tpv_expenses_v1';
const STORAGE_KEY_ISSUER = '@tpv_issuer_v1';
const STORAGE_KEY_OWNER_PIN = '@tpv_owner_pin_v1';
const STORAGE_KEY_OWNER_RECOVERY_EMAIL = '@tpv_owner_recovery_email_v1';
const STORAGE_KEY_OWNER_RECOVERY_PHONE = '@tpv_owner_recovery_phone_v1';
// Cobro online pendiente: permite confirmar el ticket aunque la app se recargue al volver de Stripe.
const STORAGE_KEY_PENDING_ONLINE_PAYMENT = '@tpv_pending_online_payment_v1';
const AUTH_TOKEN_KEY = 'tpv_access_token';
// Sesión renovable: el refresh token y la caducidad del access token permiten renovar la sesión
// sin volver a pedir la contraseña (los access tokens de Supabase caducan en ~1 hora).
const AUTH_REFRESH_TOKEN_KEY = 'tpv_refresh_token';
const AUTH_TOKEN_EXPIRES_AT_KEY = 'tpv_access_token_expires_at';

type AuthSession = {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  expires_in?: number;
};

// Solo en este dispositivo: el iCloud/Keychain no lo copia a otro iPhone.
const DEVICE_ID_STORE = {
  getItemAsync: (key: string) => SecureStore.getItemAsync(key, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }),
  setItemAsync: (key: string, value: string) => SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }),
};
// Intervalo de comprobación de que esta sesión sigue siendo la activa de la cuenta.
const SESSION_CHECK_INTERVAL_MS = 30000;

const roleFromUser = (user?: AuthenticatedUser): UserRole =>
  user?.app_metadata?.role === 'empleado' ? 'empleado' : 'principal';

const storageScopeFromUser = (user?: AuthenticatedUser): string | null => {
  if (!user?.id?.trim()) return null;
  const ownerId = user.app_metadata?.company_owner_id;
  const companyId = typeof ownerId === 'string' && ownerId.trim() ? ownerId : user.id;
  return `${encodeURIComponent(companyId)}:${encodeURIComponent(user.id)}`;
};

// Las claves globales antiguas se conservan sin leer ni migrar: no tienen propietario verificable.
const accountStorageKey = (key: string, scope: string): string => `${key}:account:${scope}`;

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(amount);

const formatDate = (isoDate: string) =>
  new Intl.DateTimeFormat('es-ES', { dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' }).format(new Date(isoDate));

export default function TpvScreen() {
  const [digits, setDigits] = useState('0');
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [cashInvoiceDrafts, setCashInvoiceDrafts] = useState<CashInvoiceDraft[]>([]);
  const [transactionHistory, setTransactionHistory] = useState<Transaction[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [issuer, setIssuer] = useState<Issuer>(initialIssuer);
  const [userRole, setUserRole] = useState<UserRole>('principal');
  const [ownerPin, setOwnerPin] = useState('');
  const [companyPinConfigured, setCompanyPinConfigured] = useState<boolean | null>(null);
  const companyPinBusyRef = useRef(false);
  const syncCompanyPinRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const [ownerPinInput, setOwnerPinInput] = useState('');
  const [ownerRecoveryEmail, setOwnerRecoveryEmail] = useState('');
  const [ownerRecoveryPhone, setOwnerRecoveryPhone] = useState('');
  const [ownerPinSetupNew, setOwnerPinSetupNew] = useState('');
  const [ownerPinSetupConfirm, setOwnerPinSetupConfirm] = useState('');
  const [ownerPinChangeCurrent, setOwnerPinChangeCurrent] = useState('');
  const [ownerPinChangeNew, setOwnerPinChangeNew] = useState('');
  const [ownerPinChangeConfirm, setOwnerPinChangeConfirm] = useState('');
  const [ownerRecoveryCode, setOwnerRecoveryCode] = useState('');
  const [pinModalVisible, setPinModalVisible] = useState(false);
  const [recoverySectionVisible, setRecoverySectionVisible] = useState(false);
  const [userPermissionsModalVisible, setUserPermissionsModalVisible] = useState(false);
  const [pendingRefund, setPendingRefund] = useState<{ ticket: Transaction; amount: number } | null>(null);
  const refundBusyRef = useRef(false);
  const [ivaPercentage, setIvaPercentage] = useState('21');
  const [activeTab, setActiveTab] = useState<Tab>('tpv');
  const [isProcessing, setIsProcessing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTicket, setSelectedTicket] = useState<Transaction | null>(null);
  const [selectedExpense, setSelectedExpense] = useState<Expense | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [storageScope, setStorageScope] = useState<string | null>(null);
  const storageScopeRef = useRef<string | null>(null);
  const loadedScopeRef = useRef<string | null>(null);
  const issuerLoadedScopeRef = useRef<string | null>(null);
  const issuerWriteQueueRef = useRef<Promise<void>>(Promise.resolve());
  const issuerRef = useRef(issuer);
  issuerRef.current = issuer;
  const cacheGenerationRef = useRef(0);
  const [authLoading, setAuthLoading] = useState(true);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  // Marca de caducidad (segundos epoch) del access token actual: permite renovarlo a tiempo.
  const [tokenExpiresAt, setTokenExpiresAt] = useState(0);
  // Sesión única: identificador estable de este dispositivo en SecureStore. El acceso se bloquea
  // hasta tenerlo; las peticiones usan siempre la promesa compartida, no el estado de React.
  const [deviceIdStatus, setDeviceIdStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const deviceIdPromiseRef = useRef<Promise<string | null> | null>(null);
  const resolveDeviceId = () => {
    deviceIdPromiseRef.current ??= getOrCreateDeviceId(DEVICE_ID_STORE);
    return deviceIdPromiseRef.current;
  };
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [syncHistoryLoading, setSyncHistoryLoading] = useState(false);
  const [syncHistoryMessage, setSyncHistoryMessage] = useState('');
  const [syncHistoryError, setSyncHistoryError] = useState('');
  // La sincronización automática del historial se intenta una sola vez por sesión iniciada.
  const autoSyncDoneRef = useRef(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authFullName, setAuthFullName] = useState('');
  const [authCompanyName, setAuthCompanyName] = useState('');
  const [authRegistrationRole, setAuthRegistrationRole] = useState<UserRole | null>(null);
  const [authEmployeeAccessCode, setAuthEmployeeAccessCode] = useState('');
  const [employeeAccessCode, setEmployeeAccessCode] = useState('');
  const [authError, setAuthError] = useState('');
  const [subscriptionLoading, setSubscriptionLoading] = useState(false);
  const [hasActiveSubscription, setHasActiveSubscription] = useState(false);
  const [subscriptionStatus, setSubscriptionStatus] = useState('missing');
  const [subscriptionError, setSubscriptionError] = useState('');
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  // Plazas de empleado (usuarios adicionales) de la suscripción: se ajustan contra Stripe.
  const [seatsSyncLoading, setSeatsSyncLoading] = useState(false);
  const [seatsSyncMessage, setSeatsSyncMessage] = useState('');
  // Cuando el backend avisa de que no hay tarjeta guardada se muestra un boton explicito para abrir
  // Stripe. Se muestra siempre en la tarjeta, pero solo se resalta cuando hace falta de verdad.
  const [seatsCardMissing, setSeatsCardMissing] = useState(false);
// El bloque de usuarios adicionales va plegado por defecto: al entrar en Config solo se ve el
// titulo y se despliega al pulsarlo, para que la pantalla no sea un muro de explicaciones.
const [seatsPanelOpen, setSeatsPanelOpen] = useState(false);

  // Impago: 'pastDue' muestra el aviso rojo, 'locked' bloquea la app por completo. El plazo de 3 dias
  // lo cuenta el backend (GET /api/billing/status) y se guarda alli, no en el movil.
  const [subscriptionPastDue, setSubscriptionPastDue] = useState(false);
  const [subscriptionLocked, setSubscriptionLocked] = useState(false);
  const [subscriptionDaysUntilLock, setSubscriptionDaysUntilLock] = useState<number | null>(null);
  const [subscriptionPastDueInvoiceUrl, setSubscriptionPastDueInvoiceUrl] = useState<string | null>(null);
  const [pastDuePaying, setPastDuePaying] = useState(false);
  const [pastDueMessage, setPastDueMessage] = useState('');
  // Ultimo numero de plazas confirmado por Stripe (evita llamadas y cobros innecesarios).
  const seatsSyncedRef = useRef(0);
  const seatsSyncInFlightRef = useRef(false);
  // Alta de empleado: un unico boton que cobra las plazas y guarda el codigo del empleado.
  const [employeeSaveLoading, setEmployeeSaveLoading] = useState(false);
  const [terminalError, setTerminalError] = useState('');
  const [terminalMessage, setTerminalMessage] = useState('tpv.ready');

  const {
    initialize,
    isInitialized: isStripeTerminalInitialized,
    connectedReader,
    easyConnect,
    retrievePaymentIntent,
    collectPaymentMethod,
    processPaymentIntent,
  } = useStripeTerminal({
    onDidRequestReaderInput: (input) => {
      setTerminalMessage(`${tr('tpv.contactlessHint')} (${input.join(' / ')})`);
    },
    onDidRequestReaderDisplayMessage: (message) => {
      setTerminalMessage(String(message));
    },
    onDidChangeConnectionStatus: (status) => {
      if (status === 'connected') setTerminalMessage('tpv.ready');
      if (status === 'connecting') setTerminalMessage('tpv.preparing');
      if (status === 'discovering') setTerminalMessage('tpv.discovering');
    },
    onDidDisconnect: () => {
      setTerminalMessage('tpv.disconnected');
    },
  });

  // Estados para envío al gestor por rango de fechas (Global)
  const [managerModalVisible, setManagerModalVisible] = useState(false);
  const [startDateInput, setStartDateInput] = useState(''); 
  const [endDateInput, setEndDateInput] = useState(''); 

  // Estados para informe de transacciones por fechas
  const [transactionReportModalVisible, setTransactionReportModalVisible] = useState(false);
  const [periodDetails, setPeriodDetails] = useState<{
    startLabel: string;
    endLabel: string;
    transactions: Transaction[];
    expenses: Expense[];
    totalIncome: number;
    totalRefunds: number;
    totalExpenses: number;
  } | null>(null);
  const [transactionStartDateInput, setTransactionStartDateInput] = useState('');
  const [transactionEndDateInput, setTransactionEndDateInput] = useState('');

  // NUEVO: Estados para Informe Específico dentro de Gastos/Facturación
  const [expenseReportModalVisible, setExpenseReportModalVisible] = useState(false);
  const [expenseStartDateInput, setExpenseStartDateInput] = useState('');
  const [expenseEndDateInput, setExpenseEndDateInput] = useState('');
  const [chartGranularity, setChartGranularity] = useState<'day' | 'week' | 'month'>('week');
  
  // Modales
  const [scannerModalVisible, setScannerModalVisible] = useState(false);
  const [nfcModalVisible, setNfcModalVisible] = useState(false);
  const [clientModalVisible, setClientModalVisible] = useState(false);

  // Cobro online con enlace/QR (tarjeta y Bizum) sobre Stripe Checkout
  const [onlinePaymentModalVisible, setOnlinePaymentModalVisible] = useState(false);
  const [onlinePaymentLoading, setOnlinePaymentLoading] = useState(false);
  const [onlinePaymentError, setOnlinePaymentError] = useState('');
  const [onlinePaymentMessage, setOnlinePaymentMessage] = useState('');
  const [onlinePayment, setOnlinePayment] = useState<{
    paymentId: string;
    checkoutUrl: string;
    qrDataUrl: string | null;
    accountId?: string | null;
    chargeMode?: 'direct' | 'platform';
    paymentIntentId?: string | null;
  } | null>(null);
  const onlinePaymentConfirmedRef = useRef(false);
  // Idioma de la app: eleccion manual guardada en AsyncStorage; si no hay, el pais del movil.
  const [appLocale, setAppLocaleState] = useState<AppLocale>('es');
  // Selector de idioma: se abre desde el boton de la cabecera (ya no vive en la pestaña Config).
  const [languageModalVisible, setLanguageModalVisible] = useState(false);
  const tr = useCallback((key: string) => translateKey(appLocale, key), [appLocale]);
  // Los efectos de sesión (arranque y comprobación periódica) leen el idioma actual sin reiniciarse.
  const trRef = useRef(tr);
  trRef.current = tr;
  const formatUiCurrency = (value: number) => formatCurrencyForLocale(appLocale, value);
  const formatUiDate = (isoDate: string) => new Intl.DateTimeFormat(appLocale, {
    dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23',
  }).format(new Date(isoDate));
  const documentTypeLabel = (type: DocumentType) => {
    const keys: Record<DocumentType, string> = {
      'TICKET DE VENTA': 'document.sale',
      'FACTURA SIMPLIFICADA': 'document.simplified',
      'FACTURA COMPLETA': 'document.complete',
      'TICKET DE DEVOLUCIÓN': 'document.refund',
      'COMPRA/DEVOLUCIONES': 'document.purchaseRefunds',
      'PRESUPUESTO': 'document.quote',
      'FACTURA': 'document.invoice',
    };
    return tr(keys[type]);
  };
  // Al arrancar: idioma guardado > idioma del pais del dispositivo > espanol.
  // expo-localization es un modulo nativo: si el APK/cliente instalado es anterior a su
  // instalacion, cargarlo estaticamente romperia el arranque. Se importa de forma dinamica
  // y tolerante: sin el modulo, la app arranca en espanol y el selector sigue funcionando.
  useEffect(() => {
    (async () => {
      try {
        const stored = await AsyncStorage.getItem(APP_LOCALE_STORAGE_KEY);
        if (isAppLocale(stored)) {
          setAppLocaleState(stored);
          return;
        }
      } catch {
        // Sin almacen: sigue la deteccion por dispositivo.
      }
      try {
        const Localization = await import('expo-localization');
        const device = Localization.getLocales()[0];
        setAppLocaleState(detectDeviceLocale(device?.regionCode, device?.languageTag));
      } catch {
        // Cliente compilado sin expo-localization (habra que regenerarlo): espanol por defecto.
        setAppLocaleState('es');
      }
    })();
  }, []);
  const setAppLocale = async (locale: AppLocale) => {
    setAppLocaleState(locale);
    setLanguageModalVisible(false);
    try {
      await AsyncStorage.setItem(APP_LOCALE_STORAGE_KEY, locale);
      Alert.alert(translateKey(locale, 'lang.title'), translateKey(locale, 'lang.saved'));
    } catch {
      // Sin almacen persistente: el idioma se aplica solo en esta sesion.
    }
  };
  // Refs para leer el estado actual desde el sondeo sin depender de cierres obsoletos.
  // Estas tres funciones se recrean en cada render. Los refs permiten usarlas desde los
  // efectos sin depender de cierres obsoletas y sin volver a lanzar los efectos en cada
  // render (lo que provocaria bucles y peticiones de red innecesarias).
  const refreshUserSessionRef = useRef<() => Promise<string | null>>(() => Promise.resolve(null));
  const activateAccountCacheRef = useRef<(user?: AuthenticatedUser) => boolean>(() => false);
  const clearStoredSessionRef = useRef<() => Promise<void>>(() => Promise.resolve());
// Permite reler GET /api/billing/status (estado de pago y bloqueo) sin repetir el efecto completo.
const refreshSubscriptionStatusRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const registerTransactionDocumentRef = useRef<(transaction: Transaction) => Promise<Transaction>>(
    () => Promise.reject(new Error('No hay una URL de backend configurada en la aplicación.')),
  );
  const syncHistoryFromCloudRef = useRef<(options?: { silent?: boolean }) => Promise<void>>(() => Promise.resolve());
  const transactionsRef = useRef<Transaction[]>([]);
  transactionsRef.current = transactions;
  registerTransactionDocumentRef.current = registerTransactionDocument;

  const onlinePaymentRef = useRef<{
    paymentId: string;
    checkoutUrl: string;
    qrDataUrl: string | null;
    accountId?: string | null;
    chargeMode?: 'direct' | 'platform';
    paymentIntentId?: string | null;
  } | null>(null);
  const createOnlinePaymentRef = useRef<(method: string, paymentAmount: number, paymentRefs?: StripePaymentRefs) => void>(() => {});
  onlinePaymentRef.current = onlinePayment;

  const [stripeAccountLoading, setStripeAccountLoading] = useState(false);
  const stripeConnectBusyRef = useRef<number | null>(null);
  const [stripeMethodsInfo, setStripeMethodsInfo] = useState('');
  const [stripeMethodsError, setStripeMethodsError] = useState('');
  const [stripeCountryModalVisible, setStripeCountryModalVisible] = useState(false);
  const [stripeCountryConfirmed, setStripeCountryConfirmed] = useState<ConnectCountry | null>(null);
  const stripeCountryScopeRef = useRef<{ scope: string; generation: number } | null>(null);

  useEffect(() => () => { stripeConnectBusyRef.current = null; stripeCountryScopeRef.current = null; }, []);

  // Facturas y productos
  const [invoiceItems, setInvoiceItems] = useState<InvoiceItem[]>([{ id: '1', description: '', price: '' }]);
  const [invoiceIvaInput, setInvoiceIvaInput] = useState('21');
  const [pendingInvoice, setPendingInvoice] = useState<PendingInvoice | null>(null);

  // Estados específicos para Presupuesto
  const [presupuestoClient, setPresupuestoClient] = useState<Client>({ name: '', nif: '', address: '' });
  const [presupuestoItems, setPresupuestoItems] = useState<InvoiceItem[]>([{ id: '1', description: '', price: '' }]);
  const quoteScrollRef = useRef<ScrollView>(null);
  const quoteInputRefs = useRef<Record<string, TextInput | null>>({});
  const quoteFocusedInputRef = useRef<string | null>(null);
  const quoteFocusGenerationRef = useRef(0);
  const quoteScrollOffsetRef = useRef(0);
  const quoteKeyboardYRef = useRef<number | null>(null);
  const quoteNewLineRef = useRef<string | null>(null);
  const [quoteKeyboardHeight, setQuoteKeyboardHeight] = useState(0);
  const measureQuoteInput = useCallback((generation: number) => {
    const keyboardY = quoteKeyboardYRef.current;
    const scroll = quoteScrollRef.current;
    const key = quoteFocusedInputRef.current;
    const input = key === null ? null : quoteInputRefs.current[key];
    const offset = quoteScrollOffsetRef.current;
    const isCurrent = () => generation === quoteFocusGenerationRef.current &&
      keyboardY === quoteKeyboardYRef.current && scroll === quoteScrollRef.current &&
      key === quoteFocusedInputRef.current && offset === quoteScrollOffsetRef.current;
    if (keyboardY === null || !scroll || !isCurrent()) return;
    scroll.getNativeScrollRef()?.measureInWindow((_x, viewportY, _width, viewportHeight) => {
      if (!isCurrent() || viewportHeight <= 0) return;
      const viewportBottom = viewportY + viewportHeight;
      setQuoteKeyboardHeight(Platform.OS === 'android' ? Math.max(0, viewportBottom - keyboardY) : 0);
      if (!input) return;
      input.measureInWindow((_inputX, inputY, _inputWidth, inputHeight) => {
        if (!isCurrent() || quoteInputRefs.current[key!] !== input || inputHeight <= 0) return;
        const overlap = inputY + inputHeight - Math.min(viewportBottom, keyboardY);
        if (overlap > 0) scroll.scrollTo({ y: offset + overlap + 16, animated: true });
      });
    });
  }, []);
  const scheduleQuoteReveal = useCallback(() => {
    const generation = ++quoteFocusGenerationRef.current;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => measureQuoteInput(generation));
    });
  }, [measureQuoteInput]);
  const revealQuoteInput = (key: string) => {
    quoteFocusedInputRef.current = key;
    scheduleQuoteReveal();
  };
  const blurQuoteInput = (key: string) => {
    if (quoteFocusedInputRef.current !== key) return;
    quoteFocusedInputRef.current = null;
    quoteFocusGenerationRef.current += 1;
  };
  useEffect(() => {
    if (activeTab !== 'presupuesto') return;
    const updateKeyboard = (event: { endCoordinates: { screenY: number; height: number } }) => {
      if (event.endCoordinates.height <= 0) {
        quoteKeyboardYRef.current = null;
        quoteFocusGenerationRef.current += 1;
        setQuoteKeyboardHeight(0);
        return;
      }
      quoteKeyboardYRef.current = event.endCoordinates.screenY;
      scheduleQuoteReveal();
    };
    const subscription = Keyboard.addListener('keyboardDidShow', updateKeyboard);
    const frameSubscription = Keyboard.addListener('keyboardDidChangeFrame', updateKeyboard);
    const hideSubscription = Keyboard.addListener('keyboardDidHide', () => {
      quoteKeyboardYRef.current = null;
      quoteFocusGenerationRef.current += 1;
      setQuoteKeyboardHeight(0);
    });
    return () => {
      subscription.remove();
      frameSubscription.remove();
      hideSubscription.remove();
      quoteKeyboardYRef.current = null;
      quoteFocusedInputRef.current = null;
      quoteFocusGenerationRef.current += 1;
      setQuoteKeyboardHeight(0);
    };
  }, [activeTab, scheduleQuoteReveal]);
  const [presupuestoIvaInput, setPresupuestoIvaInput] = useState('21');
  const [presupuestoClientEmail, setPresupuestoClientEmail] = useState('');
  const [presupuestoDocumentType, setPresupuestoDocumentType] = useState<'PRESUPUESTO' | 'FACTURA'>('PRESUPUESTO');
  const resetQuoteForm = () => {
    quoteFocusGenerationRef.current += 1;
    quoteFocusedInputRef.current = null;
    quoteNewLineRef.current = null;
    quoteKeyboardYRef.current = null;
    quoteScrollOffsetRef.current = 0;
    Object.values(quoteInputRefs.current).forEach((input) => input?.blur());
    quoteInputRefs.current = {};
    setQuoteKeyboardHeight(0);
    setPresupuestoClient({ name: '', nif: '', address: '' });
    setPresupuestoClientEmail('');
    setPresupuestoItems([{ id: '1', description: '', price: '' }]);
    setPresupuestoIvaInput('21');
    Keyboard.dismiss();
    quoteScrollRef.current?.scrollTo({ y: 0, animated: false });
  };

  // Estados específicos para Gastos
  const [expenseProvider, setExpenseProvider] = useState('');
  const [expenseAmountInput, setExpenseAmountInput] = useState('');
  const [expenseImageUri, setExpenseImageUri] = useState<string | null>(null);

  // Devolución sobre ticket escaneado
  const [partialRefundModalVisible, setPartialRefundModalVisible] = useState(false);
  const [ticketToPartialRefund, setTicketToPartialRefund] = useState<Transaction | null>(null);
  const [partialAmountInput, setPartialAmountInput] = useState('');

  const [pendingDocumentType, setPendingDocumentType] = useState<DocumentType>('TICKET DE VENTA');
  const [client, setClient] = useState<Client>({ name: '', nif: '', address: '' });
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [scanned, setScanned] = useState(false);

  const resetAccountCache = () => {
    cacheGenerationRef.current += 1;
    loadedScopeRef.current = null;
    issuerLoadedScopeRef.current = null;
    setIsLoaded(false);
    autoSyncDoneRef.current = false;
    transactionsRef.current = [];
    onlinePaymentRef.current = null;
    onlinePaymentConfirmedRef.current = false;
    setTransactions([]);
    setTransactionHistory([]);
    setCashInvoiceDrafts([]);
    setExpenses([]);
    setIssuer({ ...initialIssuer });
    setOwnerPin('');
    setCompanyPinConfigured(null);
    companyPinBusyRef.current = false;
    refundBusyRef.current = false;
    setOwnerRecoveryEmail('');
    setOwnerRecoveryPhone('');
    setOwnerPinInput('');
    setOwnerPinSetupNew('');
    setOwnerPinSetupConfirm('');
    setOwnerPinChangeCurrent('');
    setOwnerPinChangeNew('');
    setOwnerPinChangeConfirm('');
    setOwnerRecoveryCode('');
    setPinModalVisible(false);
    setRecoverySectionVisible(false);
    setUserPermissionsModalVisible(false);
    setEmployeeAccessCode('');
    setSelectedTicket(null);
    setSelectedExpense(null);
    setPeriodDetails(null);
    setPendingRefund(null);
    setTicketToPartialRefund(null);
    setPartialRefundModalVisible(false);
    setPendingInvoice(null);
    setPendingDocumentType('TICKET DE VENTA');
    setClient({ name: '', nif: '', address: '' });
    setInvoiceItems([{ id: '1', description: '', price: '' }]);
    setInvoiceIvaInput('21');
    setPresupuestoClient({ name: '', nif: '', address: '' });
    setPresupuestoItems([{ id: '1', description: '', price: '' }]);
    setPresupuestoClientEmail('');
    setExpenseProvider('');
    setExpenseAmountInput('');
    setExpenseImageUri(null);
    setSearchQuery('');
    setDigits('0');
    setActiveTab('tpv');
    setOnlinePayment(null);
    setOnlinePaymentModalVisible(false);
    setOnlinePaymentLoading(false);
    setOnlinePaymentError('');
    setOnlinePaymentMessage('');
    setIsProcessing(false);
    setTerminalError('');
    setTerminalMessage('tpv.ready');
    setStripeMethodsInfo('');
    setStripeMethodsError('');
    setStripeAccountLoading(false);
    setStripeCountryModalVisible(false);
    setStripeCountryConfirmed(null);
    setSubscriptionLoading(false);
    setSeatsSyncMessage('');
    setSeatsCardMissing(false);
    setSeatsPanelOpen(false);
    setNfcModalVisible(false);
    setClientModalVisible(false);
    setScannerModalVisible(false);
    setManagerModalVisible(false);
    setTransactionReportModalVisible(false);
    setExpenseReportModalVisible(false);
    setSyncHistoryLoading(false);
    setSyncHistoryMessage('');
    setSyncHistoryError('');
    setHasActiveSubscription(false);
    setSubscriptionStatus('missing');
    setSubscriptionPastDue(false);
    setSubscriptionLocked(false);
    setSubscriptionDaysUntilLock(null);
    setSubscriptionPastDueInvoiceUrl(null);
    setSubscriptionError('');
    setPastDueMessage('');
    seatsSyncedRef.current = 0;
  };

  const activateAccountCache = (user?: AuthenticatedUser): boolean => {
    const scope = storageScopeFromUser(user);
    if (!scope) return false;
    if (storageScopeRef.current !== scope) {
      storageScopeRef.current = scope;
      resetAccountCache();
      setStorageScope(scope);
    }
    return true;
  };

  // CARGAR DATOS AL INICIAR
  useEffect(() => {
    if (!accessToken || !storageScope || storageScopeRef.current !== storageScope) return;
    if (loadedScopeRef.current === storageScope) return;
    issuerLoadedScopeRef.current = null;
    let cancelled = false;
    const generation = cacheGenerationRef.current;
    const isCurrent = () => !cancelled && cacheGenerationRef.current === generation && storageScopeRef.current === storageScope;
    (async () => {
      try {
        await issuerWriteQueueRef.current;
        if (!isCurrent()) return;
        const storedIssuer = await AsyncStorage.getItem(accountStorageKey(STORAGE_KEY_ISSUER, storageScope));
        if (!isCurrent()) return;
        if (storedIssuer !== null) {
          setIssuer(restoreIssuerSettings(JSON.parse(storedIssuer)));
        }
        issuerLoadedScopeRef.current = storageScope;
      } catch (error) {
        console.error('Error al cargar emisor:', error);
      }
      try {
        if (!isCurrent()) return;
        const [
          storedTransactions,
          storedCashInvoiceDrafts,
          storedExpenses,
          storedOwnerPin,
          storedRecoveryEmail,
          storedRecoveryPhone,
        ] = await AsyncStorage.multiGet([
          STORAGE_KEY_TRANSACTIONS,
          STORAGE_KEY_CASH_INVOICE_DRAFTS,
          STORAGE_KEY_EXPENSES,
          STORAGE_KEY_OWNER_PIN,
          STORAGE_KEY_OWNER_RECOVERY_EMAIL,
          STORAGE_KEY_OWNER_RECOVERY_PHONE,
        ].map((key) => accountStorageKey(key, storageScope))).then((entries) => entries.map(([, value]) => value)).catch((error) => {
          if (isCurrent()) issuerLoadedScopeRef.current = null;
          throw error;
        });

        if (!isCurrent()) return;

        if (storedTransactions) {
          const parsedTransactions = JSON.parse(storedTransactions) as Transaction[];
          const legacyRefunds = parsedTransactions.filter((transaction) => transaction.type === 'DEVOLUCIÓN' && transaction.relatedTicketCode);
          const sales = parsedTransactions.filter((transaction) => transaction.type !== 'DEVOLUCIÓN');

          legacyRefunds.forEach((refund) => {
            const sale = sales.find((transaction) => transaction.ticketCode === refund.relatedTicketCode);
            if (!sale) return;

            const existingRefunds = sale.refundHistory || [];
            const alreadyMigrated = existingRefunds.some((item) => Math.abs(item.amount - refund.amount) < 0.005);
            if (!alreadyMigrated) {
              sale.refundHistory = [...existingRefunds, { amount: refund.amount, date: refund.createdAt }];
            }

            const migratedRefundHistory = sale.refundHistory || [];
            const originalAmount = sale.originalAmount ?? (sale.amount + migratedRefundHistory.reduce((sum, item) => sum + item.amount, 0));
            const totalRefunded = migratedRefundHistory.reduce((sum, item) => sum + item.amount, 0);
            const remainingAmount = Math.max(0, originalAmount - totalRefunded);
            const updatedSubtotal = remainingAmount / (1 + (sale.ivaRateApplied / 100));
            sale.originalAmount = originalAmount;
            sale.amount = remainingAmount;
            sale.subtotal = updatedSubtotal;
            sale.iva = remainingAmount - updatedSubtotal;
            sale.isRefunded = remainingAmount <= 0.005;
            sale.documentType = 'COMPRA/DEVOLUCIONES';
          });

          sales.forEach((sale) => {
            if (sale.refundHistory && sale.refundHistory.length > 0) {
              sale.documentType = 'COMPRA/DEVOLUCIONES';
            }
          });

          setTransactions(sales);
        }
        if (storedCashInvoiceDrafts) setCashInvoiceDrafts(JSON.parse(storedCashInvoiceDrafts) as CashInvoiceDraft[]);
        if (storedExpenses) setExpenses(JSON.parse(storedExpenses));
        if (storedOwnerPin) setOwnerPin(storedOwnerPin);
        if (storedRecoveryEmail) setOwnerRecoveryEmail(storedRecoveryEmail);
        if (storedRecoveryPhone) setOwnerRecoveryPhone(storedRecoveryPhone);
      } catch (error) {
        console.error('Error al cargar datos guardados:', error);
      } finally {
        if (isCurrent()) {
          loadedScopeRef.current = storageScope;
          setIsLoaded(true);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [accessToken, storageScope]);

  // Plazas de empleado (usuarios adicionales): el número contratado vive en Stripe y aquí solo se
  // refleja. Se aplica al entrar (así sigue estando tras borrar los datos de la app) y cada cambio
  // del campo se sincroniza con POST /api/billing/seats, que cobra el prorrateo al momento.
  const applySubscriptionSeats = (value: unknown) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    const seats = Math.max(0, Math.min(50, Math.floor(value)));
    seatsSyncedRef.current = seats;
    setIssuer((current) => (current.additionalUsers === seats ? current : { ...current, additionalUsers: seats }));
  };

// Abre Stripe en modo 'setup' para GUARDAR UNA TARJETA. Devuelve si se guardo correctamente.
  const addSubscriptionPaymentMethod = async (): Promise<boolean> => {
    if (!accessToken || !configuredDocumentApiUrl) return false;
    setSeatsSyncLoading(true);

    try {
      const response = await fetchWithTimeout(`${configuredDocumentApiUrl}/api/billing/payment-method-setup`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      }, 30000);
      const result = await response.json() as { ok?: boolean; url?: string; checkoutUrl?: string; error?: string };
      const setupUrl = result.url || result.checkoutUrl;
      if (!response.ok || !result.ok || !setupUrl) {
        throw new Error(result.error || 'No se pudo abrir la pagina de tarjeta de Stripe.');
      }

      const browserResult = await WebBrowser.openAuthSessionAsync(setupUrl, ONLINE_PAYMENT_REDIRECT_URL);
      if (browserResult.type !== 'success' || !browserResult.url) {
        setSeatsSyncMessage('No se confirmó el regreso desde Stripe. Vuelve a la app e inténtalo otra vez.');
        return false;
      }
      const setupResult = ExpoLinking.parse(browserResult.url).queryParams?.result;
      if (setupResult !== 'success') {
        throw new Error('Stripe no confirmó la tarjeta como método predeterminado. No se ha cobrado ni añadido el usuario.');
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No se pudo guardar la tarjeta.';
      setSeatsSyncMessage(message);
      Alert.alert('Metodo de pago', message);
      return false;
    } finally {
      setSeatsSyncLoading(false);
    }
  };

  // Aplica las plazas contratadas a la suscripcion de Stripe (POST /api/billing/seats), que cobra el
  // prorrateo al momento. Devuelve como termino para que el alta de empleado encadene los pasos:
  //   - 'noChanges': el numero ya era el mismo, no se llama a Stripe ni se cobra nada.
  //   - 'needsPaymentMethod': no hay tarjeta guardada; hay que abrir Stripe y reintentar.
  //   - 'needsCheckout': todavia no hay suscripcion, las plazas se cobran con el plan.
  //   - 'error' / 'ok'.
  const syncAdditionalUsersWithStripe = async (
    requestedSeats: number,
  ): Promise<'noChanges' | 'ok' | 'needsPaymentMethod' | 'needsCheckout' | 'error'> => {
    const seats = Math.max(0, Math.min(50, Math.floor(Number(requestedSeats) || 0)));
    if (!accessToken || !configuredDocumentApiUrl) return 'error';
    if (userRole !== 'principal') return 'error';
    if (seatsSyncInFlightRef.current) return 'error';
    // Sin cambio real no se llama a Stripe: ni peticion ni factura de 0 € por repetir el numero.
    if (seats === seatsSyncedRef.current) return 'noChanges';

    seatsSyncInFlightRef.current = true;
    setSeatsSyncLoading(true);
    setSeatsSyncMessage('');

    try {
      const response = await fetchWithTimeout(`${configuredDocumentApiUrl}/api/billing/seats`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ additionalUsers: seats }),
      }, 30000);
      const result = await response.json() as {
        ok?: boolean;
        error?: string;
        needsCheckout?: boolean;
        needsPaymentMethod?: boolean;
        additionalUsers?: number;
        status?: string;
        invoiceAmountCents?: number;
      };

      if (!response.ok || !result.ok) {
        // Si Stripe no aplico el cambio se vuelve al numero que si esta contratado.
        applySubscriptionSeats(result.additionalUsers);
        // Se detecta la falta de tarjeta por la bandera del backend y, como red de seguridad, por el
        // texto del mensaje. Asi, si el backend no marca el caso, la app abre igualmente Stripe en
        // lugar de dejar al usuario con un aviso que no le deja hacer nada.
        const errorText = String(result.error || '');
        const faltaTarjeta = Boolean(result.needsPaymentMethod)
          || /tarjeta|metodo de pago|method of payment|payment method|card/i.test(errorText);
        // Se marca para que aparezca el boton de "Añadir tarjeta" en la tarjeta de empleados.
        setSeatsCardMissing(faltaTarjeta);
        if (faltaTarjeta) {
          setSeatsSyncMessage('No hay ninguna tarjeta guardada en Stripe. Añade una para poder cobrar las plazas de empleado.');
          return 'needsPaymentMethod';
        }
        if (result.needsCheckout) {
          setSeatsSyncMessage('Todavia no tienes suscripcion activa: contratala y las plazas se cobraran con el plan.');
          return 'needsCheckout';
        }
        setSeatsSyncMessage(result.error || 'No se pudieron actualizar las plazas de empleado en Stripe.');
        return 'error';
      }

      applySubscriptionSeats(result.additionalUsers ?? seats);
      if (result.status) setSubscriptionStatus(result.status);
      const charged = Number(result.invoiceAmountCents) || 0;
      if (charged > 0) {
        setSeatsSyncMessage(`Stripe ha cobrado ahora ${formatCurrency(charged / 100)} por el cambio de plazas.`);
      } else if (charged < 0) {
        setSeatsSyncMessage(`Stripe ha abonado ${formatCurrency(Math.abs(charged) / 100)} por el cambio de plazas.`);
      } else {
        setSeatsSyncMessage('Plazas de empleado actualizadas en Stripe.');
      }
      // La tarjeta quedo guardada: el aviso y su boton ya no hacen falta.
      setSeatsCardMissing(false);
      return 'ok';
    } catch (error) {
      setSeatsSyncMessage(error instanceof Error ? error.message : 'No se pudieron actualizar las plazas de empleado.');
      return 'error';
    } finally {
      seatsSyncInFlightRef.current = false;
      setSeatsSyncLoading(false);
    }
  };

// Alta de empleado: cobrar las plazas y guardar el codigo, todo desde un solo boton.
  //   1. Se cobran las plazas con la tarjeta ya guardada en Stripe.
  //   2. Si no hay ninguna guardada, se manda a Stripe a guardar una y se reintenta al volver.
  //   3. Solo cuando las plazas estan contratadas se guarda el codigo del empleado.
  const saveEmployeeWithSeats = async () => {
    if (!accessToken || !configuredDocumentApiUrl) return;
    const code = employeeAccessCode.trim();
    if (code && code.length < 8) {
      Alert.alert('Código demasiado corto', 'Usa un código de al menos 8 caracteres. No es el PIN del jefe.');
      return;
    }

    const seats = Math.max(0, Math.floor(Number(issuer.additionalUsers) || 0));
    setEmployeeSaveLoading(true);

    try {
      let outcome = await syncAdditionalUsersWithStripe(seats);

      // Sin tarjeta guardada: se abre Stripe y, al volver, se reintenta el cobro de las plazas.
      if (outcome === 'needsPaymentMethod') {
        setSeatsSyncMessage('Guardando tarjeta en Stripe...');
        const saved = await addSubscriptionPaymentMethod();
        if (!saved) {
          setSeatsSyncMessage('No se pudo guardar la tarjeta. Intentalo de nuevo.');
          return;
        }
        outcome = await syncAdditionalUsersWithStripe(seats);
        if (outcome === 'needsPaymentMethod') {
          Alert.alert('No se pudo cobrar', 'Stripe todavía no confirma una tarjeta guardada. No se ha añadido el usuario.');
          return;
        }
      }

      if (outcome === 'needsCheckout') {
        Alert.alert('Sin suscripcion activa', 'Contrata el plan y las plazas se cobraran junto con el.');
        return;
      }

      // Las plazas deben estar contratadas antes de dar de alta al empleado.
      if (outcome === 'error') {
        Alert.alert('No se pudieron contratar las plazas', 'No se han podido cobrar las plazas de empleado. Intentalo de nuevo.');
        return;
      }

      const response = await fetchWithTimeout(`${configuredDocumentApiUrl}/api/auth/employee-access-code`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ accessCode: code }),
      }, 10000);
      const responseText = await response.text();
      let result: { error?: string; accessCode?: string; companyEmail?: string } = {};
      try {
        result = JSON.parse(responseText) as { error?: string; accessCode?: string; companyEmail?: string };
      } catch {
        throw new Error('El servidor todavia no tiene disponible la funcion de empleados. Despliega la ultima version del backend en Render.');
      }
      if (!response.ok) throw new Error(result.error || 'No se pudo guardar el código.');

      setEmployeeAccessCode(result.accessCode || code);
      applySubscriptionSeats(seats);
      Alert.alert(
        'Empleado añadido',
        `${tr('auth.companyEmail')}: ${result.companyEmail || authEmail}\n${tr('registration.additionalCode')}: ${result.accessCode || code}`,
      );
    } catch (error) {
      Alert.alert('No se pudo añadir el empleado', error instanceof Error ? error.message : 'Intentalo de nuevo.');
    } finally {
      setEmployeeSaveLoading(false);
    }
  };

  // --- IMPAGO ---
  // Se llama desde el aviso rojo y desde la pantalla de bloqueo. Primero intenta cobrar la factura
  // vencida con la tarjeta ya guardada en Stripe; si no hay ninguna, abre Stripe para guardarla y
  // reintenta al volver. En ambos casos se vuelve a leer el estado real de la suscripción.
  const payPastDueInvoice = async () => {
    if (!accessToken || !configuredDocumentApiUrl || pastDuePaying) return;
    setPastDuePaying(true);
    setPastDueMessage('');

    try {
      const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
      const response = await fetchWithTimeout(`${configuredDocumentApiUrl}/api/billing/resolve-invoice`, {
        method: 'POST',
        headers,
      }, 30000);
      const result = await response.json().catch(() => ({})) as {
        ok?: boolean;
        needsPaymentMethod?: boolean;
        alreadyPaid?: boolean;
        error?: string;
      };

      if (result.needsPaymentMethod) {
        // No hay tarjeta: se ofrece guardarla. Al volver se reintenta el cobro solo.
        Alert.alert(tr('sub.pastDueTitle'), tr('sub.updateCard'), [
          { text: 'Ahora no', style: 'cancel' },
          {
            text: tr('sub.updateCard'),
            onPress: () => { void addSubscriptionPaymentMethod(); },
          },
        ]);
        return;
      }

      if (!response.ok || !result.ok) {
        setPastDueMessage(result.error || tr('sub.pastDueTitle'));
        return;
      }

      setPastDueMessage(tr('sub.paid'));
      setSubscriptionPastDue(false);
      setSubscriptionLocked(false);
    } catch (error) {
      setPastDueMessage(error instanceof Error ? error.message : tr('sub.pastDueTitle'));
    } finally {
      setPastDuePaying(false);
      // El estado de Stripe es la fuente de verdad: se vuelve a leer en cualquier caso.
      await refreshSubscriptionStatusRef.current();
    }
  };

  useEffect(() => {
    // Se espera a tener cargados los datos guardados para que las plazas de Stripe no las
    // sobrescriba el número que hubiera en el móvil.
    if (!isLoaded || !accessToken || !configuredDocumentApiUrl || !storageScope || loadedScopeRef.current !== storageScope || storageScopeRef.current !== storageScope) return;
    const generation = cacheGenerationRef.current;

    const runStatusCheck = async () => {
      setSubscriptionLoading(true);
      try {
        const response = await fetchWithTimeout(`${configuredDocumentApiUrl}/api/billing/status`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        }, 10000);
        const result = await response.json() as SubscriptionStatusResult;
        if (cacheGenerationRef.current !== generation) return;
        if (response.status === 401) {
          // El token caducó mientras la app estaba abierta: se renueva para no cortar la sesión.
          const renewed = await refreshUserSessionRef.current();
          if (!renewed) await clearStoredSessionRef.current();
          return;
        }
        setHasActiveSubscription(Boolean(result.active));
        setSubscriptionStatus(result.status || 'missing');
        // Impago: con aviso rojo los primeros 3 días y bloqueo total al cumplirlos.
        setSubscriptionPastDue(Boolean(result.pastDue));
        setSubscriptionLocked(Boolean(result.locked));
        setSubscriptionDaysUntilLock(typeof result.daysUntilLock === 'number' ? result.daysUntilLock : null);
        setSubscriptionPastDueInvoiceUrl(result.pastDueInvoiceUrl || null);
        if (!result.pastDue) setPastDueMessage('');
        // Las plazas de empleado contratadas se leen de Stripe: siguen ahí tras borrar los datos.
        applySubscriptionSeats(result.additionalUsers);
        setSubscriptionError(response.ok ? '' : (result.error || 'No se pudo consultar la suscripción.'));
      } catch {
        if (cacheGenerationRef.current !== generation) return;
        setSubscriptionError('No se pudo comprobar la suscripción. Comprueba tu conexión.');
      } finally {
        if (cacheGenerationRef.current === generation) setSubscriptionLoading(false);
      }
    };

    // Se guarda en el ref para poder releer el estado desde el aviso de impago y desde la
    // pantalla de bloqueo, sin depender del momento en que se monte el efecto.
    refreshSubscriptionStatusRef.current = runStatusCheck;
    void runStatusCheck();
  }, [accessToken, isLoaded, storageScope]);

  useEffect(() => {
    (async () => {
      // ID estable de este dispositivo para el bloqueo de sesion unica por cuenta.
      const bootDeviceId = await resolveDeviceId();
      setDeviceIdStatus(bootDeviceId ? 'ready' : 'unavailable');
      
      // La sesión se guarda como access token + refresh token + caducidad, para poder renovarla.
      let storedToken = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
      let storedExpiresAt = 0;
      try {
        storedExpiresAt = Number(await SecureStore.getItemAsync(AUTH_TOKEN_EXPIRES_AT_KEY)) || 0;
      } catch {
        storedExpiresAt = 0;
      }
      setTokenExpiresAt(storedExpiresAt);
      if (!storedToken) {
        setAuthLoading(false);
        return;
      }
      if (storedExpiresAt > 0 && storedExpiresAt * 1000 - Date.now() <= 60000) {
        // El token guardado ya caducó: se renueva con el refresh token antes de validar la sesión.
        storedToken = (await refreshUserSessionRef.current()) ?? '';
        if (!storedToken) {
          setAuthLoading(false);
          return;
        }
      }

      // /api/auth/me es la única ruta que enlaza la sesión a este dispositivo o la traslada.
      const verifySession = async (forceTransfer: boolean) => {
        const headers: Record<string, string> = { Authorization: `Bearer ${storedToken}` };
        if (bootDeviceId) headers['X-Device-Id'] = bootDeviceId;
        if (forceTransfer) headers['X-Device-Force'] = '1';
        return fetchWithTimeout(`${configuredDocumentApiUrl}/api/auth/me`, { headers }, 5000);
      };

      try {
        let response = await verifySession(false);

        if (response.status === 409 && bootDeviceId) {
          // La cuenta ya esta abierta en otro movil: ofrecer trasladar la sesion aqui.
          let transfer = false;
          await new Promise<void>((resolve) => {
            Alert.alert(
              trRef.current('auth.conflictTitle'),
              trRef.current('auth.conflictMessage'),
              [
                { text: trRef.current('auth.conflictCancel'), style: 'cancel', onPress: () => resolve() },
                { text: trRef.current('auth.conflictTransfer'), style: 'destructive', onPress: () => { transfer = true; resolve(); } },
              ],
              { cancelable: false },
            );
          });
          if (!transfer) {
            await clearStoredSessionRef.current();
            return;
          }
          response = await verifySession(true);
        }

        if (response.ok) {
          const result = await response.json() as { user?: AuthenticatedUser };
          if (!activateAccountCacheRef.current(result.user)) {
            await clearStoredSessionRef.current();
            return;
          }
          setUserRole(roleFromUser(result.user));
          setAccessToken(storedToken);
        } else if (response.status === 401) {
          // El token caducó: se intenta renovar con el refresh token antes de pedir la contraseña.
          const renewed = await refreshUserSessionRef.current();
          if (renewed) {
            storedToken = renewed;
            const verified = await verifySession(false);
            const result = await verified.json().catch(() => ({})) as { user?: AuthenticatedUser };
            if (verified.ok && activateAccountCacheRef.current(result.user)) {
              setUserRole(roleFromUser(result.user));
              setAccessToken(renewed);
            } else {
              await clearStoredSessionRef.current();
            }
          } else {
            await clearStoredSessionRef.current();
          }
        } else {
          await clearStoredSessionRef.current();
        }
      } catch {
        setAuthError(trRef.current('auth.errorNetwork'));
      } finally {
        setAuthLoading(false);
      }
    })();
  }, []);

  const selectAuthRole = (role: UserRole | null) => {
    setAuthRegistrationRole(role);
    setAuthMode('login');
    setAuthEmail('');
    setAuthPassword('');
    setAuthEmployeeAccessCode('');
    setAuthFullName('');
    setAuthCompanyName('');
    setAuthError('');
  };

  const submitAuth = async (forceDevice = false) => {
    if (authSubmitting || authRegistrationRole === null) return;
    setAuthError('');
    if (!configuredDocumentApiUrl) {
      setAuthError(tr('auth.errorNoBackend'));
      return;
    }
    const form: AuthForm = {
      mode: authRegistrationRole === 'empleado' ? 'login' : authMode,
      role: authRegistrationRole,
      email: authEmail,
      password: authPassword,
      fullName: authFullName,
      companyName: authCompanyName,
      employeeAccessCode: authEmployeeAccessCode,
    };
    const validationError = validateAuthForm(form);
    if (validationError) {
      setAuthError(tr(validationError));
      return;
    }
    // Sin identificador estable de dispositivo no se permite acceder (no hay modo sin bloqueo).
    const currentDeviceId = await resolveDeviceId();
    if (!currentDeviceId) {
      setDeviceIdStatus('unavailable');
      setAuthError(tr('auth.deviceUnavailable'));
      return;
    }

    setAuthSubmitting(true);
    try {
      const authEndpoint = form.role === 'empleado' ? 'employee-login' : form.mode;
      const response = await fetchWithTimeout(`${configuredDocumentApiUrl}/api/auth/${authEndpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildAuthRequestBody(form, currentDeviceId, forceDevice)),
      }, 10000);
      const result = await response.json().catch(() => ({})) as { error?: string; code?: string; user?: AuthenticatedUser; session?: AuthSession; requiresEmailConfirmation?: boolean };

      if (!response.ok) {
        if (response.status === 409 && result.code === 'device_conflict' && form.mode === 'login') {
          // La cuenta ya esta abierta en otro movil: se ofrece trasladar la sesion aqui.
          Alert.alert(
            tr('auth.conflictTitle'),
            tr('auth.conflictMessage'),
            [
              { text: tr('auth.conflictCancel'), style: 'cancel' },
              { text: tr('auth.conflictTransfer'), style: 'destructive', onPress: () => void submitAuth(true) },
            ],
          );
          return;
        }
        setAuthError(result.error || tr('auth.errorGeneric'));
        return;
      }

      if (form.mode === 'register' && result.requiresEmailConfirmation) {
        Alert.alert(tr('auth.confirmEmailTitle'), tr('auth.confirmEmailMessage'));
        setAuthMode('login');
        setAuthPassword('');
        return;
      }

      const token = result.session?.access_token;
      if (!token) {
        setAuthError(tr('auth.errorNoSession'));
        return;
      }
      if (!storageScopeFromUser(result.user)) {
        setAuthError(tr('auth.errorNoSession'));
        return;
      }

      // Se guardan también el refresh token y la caducidad para renovar la sesión sin volver a entrar.
      await persistSession(result.session);
      activateAccountCache(result.user);
      setUserRole(result.user ? roleFromUser(result.user) : form.role);
      setAccessToken(token);
      setAuthPassword('');
      setAuthEmployeeAccessCode('');
    } catch {
      setAuthError(tr('auth.errorNetwork'));
    } finally {
      setAuthSubmitting(false);
    }
  };

  const signOut = async () => {
    // Libera el dispositivo en el servidor (solo si esta sesión es la activa). Si falla, el
    // siguiente acceso desde otro móvil pedirá trasladar la sesión.
    if (accessToken && configuredDocumentApiUrl) {
      await fetchWithTimeout(`${configuredDocumentApiUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      }, 5000).catch(() => undefined);
    }
    await clearStoredSession();
    setUserRole('principal');
  };

  // Cierre de sesion con confirmacion: se pide confirmacion para no perder la sesion
  // por un toque accidental, y se avisa cuando se ha cerrado.
  const confirmSignOut = () => {
    Alert.alert(tr('auth.signOutTitle'), tr('auth.signOutMessage'), [
      { text: tr('auth.signOutCancel'), style: 'cancel' },
      {
        text: tr('auth.signOutConfirm'),
        style: 'destructive',
        onPress: () => { void signOut().then(() => Alert.alert(tr('auth.signOutDone'))); },
      },
    ]);
  };


  // Guarda la sesión del usuario (access token + refresh token + caducidad) para poder renovarla
  // sin volver a pedir la contraseña.
  const persistSession = async (session?: AuthSession | null) => {
    const token = session?.access_token;
    if (!token) return;
    const expiresAt = session?.expires_at
      ?? (session?.expires_in ? Math.floor(Date.now() / 1000) + Number(session.expires_in) : 0);
    try {
      await SecureStore.setItemAsync(AUTH_TOKEN_KEY, token);
      if (session?.refresh_token) await SecureStore.setItemAsync(AUTH_REFRESH_TOKEN_KEY, session.refresh_token);
      if (expiresAt) await SecureStore.setItemAsync(AUTH_TOKEN_EXPIRES_AT_KEY, String(expiresAt));
    } catch {
      // Sin almacenamiento seguro la sesión sigue activa en memoria.
    }
    setTokenExpiresAt(expiresAt || 0);
  };

  // Borra la sesión guardada (token, refresco y caducidad) y devuelve la app a la pantalla de acceso.
  const clearStoredSession = async () => {
    const scope = storageScopeRef.current;
    const issuerSave = scope && loadedScopeRef.current === scope && issuerLoadedScopeRef.current === scope
      ? writeIssuerSettings(scope, issuerRef.current)
      : issuerWriteQueueRef.current;
    storageScopeRef.current = null;
    setStorageScope(null);
    resetAccountCache();
    setAccessToken(null);
    setTokenExpiresAt(0);
    selectAuthRole(null);
    await issuerSave;
    try {
      await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY);
      await SecureStore.deleteItemAsync(AUTH_REFRESH_TOKEN_KEY);
      await SecureStore.deleteItemAsync(AUTH_TOKEN_EXPIRES_AT_KEY);
    } catch {
      // No hay nada que limpiar.
    }
    // Con una sesión nueva, el historial se volverá a sincronizar solo al abrir la app.
    autoSyncDoneRef.current = false;
  };

  // Renueva el access token con el refresh token. Devuelve el token nuevo o null si la sesión ya
  // no se puede renovar (entonces hay que volver a iniciar sesión).
  const refreshUserSession = async (): Promise<string | null> => {
    if (!configuredDocumentApiUrl) return null;
    const generation = cacheGenerationRef.current;
    let refreshToken: string | null = null;
    try {
      refreshToken = await SecureStore.getItemAsync(AUTH_REFRESH_TOKEN_KEY);
    } catch {
      refreshToken = null;
    }
    if (!refreshToken) {
      await clearStoredSession();
      return null;
    }

    try {
      const response = await fetchWithTimeout(`${configuredDocumentApiUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      }, 10000);
      const result = await response.json().catch(() => ({})) as { session?: AuthSession; user?: AuthenticatedUser; code?: string };
      if (cacheGenerationRef.current !== generation) return null;
      const renewedToken = result.session?.access_token;
      if (!response.ok || !renewedToken) {
        // Solo se cierra la sesión si el servidor confirma que el refresh token ya no vale (401) o
        // que la sesión se ha trasladado a otro dispositivo (409).
        // Un 404 (backend aún sin desplegar), un 502 (Render arrancando) o un fallo de red no deben
        // expulsar al usuario: se conserva la sesión y se reintenta en el siguiente uso.
        const outcome = classifySessionCheck(response.status, result.code);
        if (outcome === 'expired' || outcome === 'conflict') await clearStoredSession();
        if (outcome === 'conflict') Alert.alert(tr('auth.sessionMovedTitle'), tr('auth.sessionMovedMessage'));
        return null;
      }
      if (!storageScopeFromUser(result.user)) return null;
      await persistSession(result.session);
      if (cacheGenerationRef.current !== generation) return null;
      if (!authLoading) activateAccountCache(result.user);
      if (result.user) setUserRole(roleFromUser(result.user));
      if (!authLoading) setAccessToken(renewedToken);
      return renewedToken;
    } catch {
      // Sin conexión: se mantiene la sesión actual y se reintenta en el siguiente uso.
      return null;
    }
  };

  // Devuelve un token listo para usar, renovándolo si está a punto de caducar: así los tickets y
  // gastos se guardan asociados a la cuenta y se pueden recuperar al sincronizar el historial.
  const ensureFreshAccessToken = async (): Promise<string | null> => {
    if (!accessToken) return null;
    const expiresAtMs = tokenExpiresAt > 0 ? tokenExpiresAt * 1000 : 0;
    if (expiresAtMs === 0 || expiresAtMs - Date.now() > 60000) return accessToken;
    return (await refreshUserSession()) ?? accessToken;
  };

  const requestCompanyPin = async (pin?: string, currentPin?: string): Promise<{ configured?: boolean }> => {
    const generation = cacheGenerationRef.current;
    if (!accessToken || !configuredDocumentApiUrl) throw new Error('Inicia sesión y conecta con el servidor para configurar el PIN.');
    const token = await ensureFreshAccessToken();
    if (cacheGenerationRef.current !== generation) throw new Error('La cuenta ha cambiado.');
    if (!token) throw new Error('La sesión ha caducado. Vuelve a iniciar sesión.');
    const response = await fetchWithTimeout(`${configuredDocumentApiUrl}/api/company/pin${pin === undefined ? '/status' : ''}`, {
      method: pin === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      ...(pin === undefined ? {} : { body: JSON.stringify({ pin, ...(currentPin === undefined ? {} : { currentPin }) }) }),
    }, 15000);
    const result = await response.json() as { configured?: boolean; error?: string };
    if (cacheGenerationRef.current !== generation) throw new Error('La cuenta ha cambiado.');
    if (!response.ok) throw new Error(result.error || 'No se pudo configurar el PIN en el servidor.');
    if (pin === undefined && typeof result.configured !== 'boolean') throw new Error('El servidor no confirmó el estado del PIN.');
    return result;
  };

  const syncCompanyPin = async () => {
    if (!isLoaded || !accessToken || userRole !== 'principal' || !storageScope || loadedScopeRef.current !== storageScope || storageScopeRef.current !== storageScope || companyPinBusyRef.current) return;
    const generation = cacheGenerationRef.current;
    companyPinBusyRef.current = true;
    try {
      const status = await requestCompanyPin();
      if (cacheGenerationRef.current !== generation) return;
      setCompanyPinConfigured(status.configured === true);
      if (!status.configured && /^\d{4,6}$/.test(ownerPin)) {
        await requestCompanyPin(ownerPin);
        if (cacheGenerationRef.current === generation) setCompanyPinConfigured(true);
      }
    } catch (error) {
      if (cacheGenerationRef.current === generation) console.warn('No se pudo sincronizar el PIN principal:', error);
    } finally {
      if (cacheGenerationRef.current === generation) companyPinBusyRef.current = false;
    }
  };
  syncCompanyPinRef.current = syncCompanyPin;
  useEffect(() => {
    void syncCompanyPinRef.current();
  }, [isLoaded, accessToken, ownerPin, userRole, storageScope, userPermissionsModalVisible]);

  const saveCompanyPin = async (pin: string, currentPin?: string): Promise<boolean> => {
    if (userRole !== 'principal' || !isLoaded || !storageScope || loadedScopeRef.current !== storageScope || storageScopeRef.current !== storageScope || companyPinBusyRef.current) return false;
    const generation = cacheGenerationRef.current;
    companyPinBusyRef.current = true;
    try {
      if (currentPin === undefined) {
        const status = await requestCompanyPin();
        if (cacheGenerationRef.current !== generation) return false;
        setCompanyPinConfigured(status.configured === true);
        if (status.configured) throw new Error('El PIN ya está configurado. Usa Cambiar PIN principal.');
      }
      await requestCompanyPin(pin, currentPin);
      if (cacheGenerationRef.current !== generation) return false;
      setCompanyPinConfigured(true);
      setOwnerPin(pin);
      return true;
    } catch (error) {
      if (cacheGenerationRef.current === generation) Alert.alert('PIN no guardado', error instanceof Error ? error.message : 'No se pudo conectar con el servidor.');
      return false;
    } finally {
      if (cacheGenerationRef.current === generation) companyPinBusyRef.current = false;
    }
  };

  // Renovación automática antes de que caduque la sesión (1 hora por defecto en Supabase).
  useEffect(() => {
    if (!accessToken) return;
    const expiresAtMs = tokenExpiresAt > 0 ? tokenExpiresAt * 1000 : 0;
    const msUntilRenewal = expiresAtMs > 0 ? expiresAtMs - Date.now() - 60000 : 45 * 60 * 1000;
    const timer = setTimeout(() => { void refreshUserSessionRef.current(); }, Math.max(30000, msUntilRenewal));
    return () => clearTimeout(timer);
  }, [accessToken, tokenExpiresAt]);

  // Sesión única: cada 30 s y al volver a primer plano se confirma que esta sesión sigue siendo la
  // activa. Si se trasladó a otro dispositivo se cierra aquí (sin reclamarla de vuelta).
  const sessionCheckInFlightRef = useRef(false);
  useEffect(() => {
    if (!accessToken || !configuredDocumentApiUrl) return;
    let cancelled = false;
    const checkActiveSession = async () => {
      if (sessionCheckInFlightRef.current) return;
      sessionCheckInFlightRef.current = true;
      try {
        const currentDeviceId = await resolveDeviceId();
        const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
        if (currentDeviceId) headers['X-Device-Id'] = currentDeviceId;
        const response = await fetchWithTimeout(`${configuredDocumentApiUrl}/api/auth/me`, { headers }, 8000);
        const result = await response.json().catch(() => ({})) as { code?: string; user?: AuthenticatedUser };
        if (cancelled) return;
        const outcome = classifySessionCheck(response.status, result.code);
        if (outcome === 'ok') {
          if (!activateAccountCacheRef.current(result.user)) {
            await clearStoredSessionRef.current();
            return;
          }
          setUserRole(roleFromUser(result.user));
        } else if (outcome === 'conflict') {
          await clearStoredSessionRef.current();
          Alert.alert(trRef.current('auth.sessionMovedTitle'), trRef.current('auth.sessionMovedMessage'));
        } else if (outcome === 'expired') {
          await refreshUserSessionRef.current();
        }
      } catch {
        // Sin conexión: se vuelve a comprobar en el siguiente intervalo.
      } finally {
        sessionCheckInFlightRef.current = false;
      }
    };
    const interval = setInterval(() => { void checkActiveSession(); }, SESSION_CHECK_INTERVAL_MS);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void checkActiveSession();
    });
    return () => {
      cancelled = true;
      clearInterval(interval);
      subscription.remove();
    };
  }, [accessToken]);


  const startSubscriptionCheckout = async () => {
    if (!accessToken || !configuredDocumentApiUrl) {
      Alert.alert('Sesión requerida', 'Vuelve a iniciar sesión para activar la suscripción.');
      return;
    }
    // Si ya hay un checkout en curso no se abre otro: evita crear dos sesiones de
    // Stripe (y dos suscripciones) por pulsar dos veces el boton.
    if (checkoutLoading) return;
    setCheckoutLoading(true);
    setSubscriptionError('');
    const additionalUsers = Math.max(0, Math.min(50, Number(issuer.additionalUsers || 0)));

    try {
      const response = await fetchWithTimeout(`${configuredDocumentApiUrl}/api/billing/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ additionalUsers }),
      }, 15000);
      const result = await response.json() as { checkoutUrl?: string; redirectUrl?: string; url?: string; error?: string };
      const checkoutUrl = result.checkoutUrl || result.redirectUrl || result.url;
      if (!response.ok || !checkoutUrl) {
        const errorMessage = result.error || `Stripe no devolvió una URL de pago (HTTP ${response.status}).`;
        setSubscriptionError(errorMessage);
        Alert.alert('No se pudo abrir la suscripción', errorMessage);
        return;
      }

      await WebBrowser.openBrowserAsync(checkoutUrl);
      const statusResponse = await fetchWithTimeout(`${configuredDocumentApiUrl}/api/billing/status`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }, 10000);
      const statusResult = await statusResponse.json() as { active?: boolean; status?: string; additionalUsers?: number };
      setHasActiveSubscription(Boolean(statusResult.active));
      setSubscriptionStatus(statusResult.status || 'missing');
      applySubscriptionSeats(statusResult.additionalUsers);
      if (!statusResult.active) {
        setSubscriptionError('El pago todavía no aparece activo. Cierra la página de Stripe y vuelve a comprobarlo en unos segundos.');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'No se pudo completar la conexión con Stripe.';
      setSubscriptionError(errorMessage);
      Alert.alert('Error de suscripción Stripe', errorMessage);
    } finally {
      setCheckoutLoading(false);
    }
  };

  // GUARDAR TRANSACCIONES AUTOMÁTICAMENTE
  useEffect(() => {
    if (!isLoaded || !storageScope || loadedScopeRef.current !== storageScope || storageScopeRef.current !== storageScope) return;
    AsyncStorage.setItem(accountStorageKey(STORAGE_KEY_TRANSACTIONS, storageScope), JSON.stringify(transactions)).catch((error) =>
      console.error('Error al guardar transacciones:', error)
    );
  }, [transactions, isLoaded, storageScope]);

  useEffect(() => {
    if (!isLoaded || !storageScope || loadedScopeRef.current !== storageScope || storageScopeRef.current !== storageScope) return;
    AsyncStorage.setItem(accountStorageKey(STORAGE_KEY_CASH_INVOICE_DRAFTS, storageScope), JSON.stringify(cashInvoiceDrafts)).catch((error) =>
      console.error('Error al guardar facturas pendientes de cobro:', error)
    );
  }, [cashInvoiceDrafts, isLoaded, storageScope]);

  // GUARDAR GASTOS AUTOMÁTICAMENTE
  useEffect(() => {
    if (!isLoaded || !storageScope || loadedScopeRef.current !== storageScope || storageScopeRef.current !== storageScope) return;
    AsyncStorage.setItem(accountStorageKey(STORAGE_KEY_EXPENSES, storageScope), JSON.stringify(expenses)).catch((error) =>
      console.error('Error al guardar gastos:', error)
    );
  }, [expenses, isLoaded, storageScope]);

  // GUARDAR EMISOR AUTOMÁTICAMENTE
  const writeIssuerSettings = (scope: string, settings: Issuer): Promise<void> => {
    const serialized = JSON.stringify(settings);
    const pending = issuerWriteQueueRef.current.then(() =>
      AsyncStorage.setItem(accountStorageKey(STORAGE_KEY_ISSUER, scope), serialized)
    ).catch((error) => console.error('Error al guardar emisor:', error));
    issuerWriteQueueRef.current = pending;
    return pending;
  };

  useEffect(() => {
    if (!isLoaded || !storageScope || loadedScopeRef.current !== storageScope || storageScopeRef.current !== storageScope || issuerLoadedScopeRef.current !== storageScope) return;
    void writeIssuerSettings(storageScope, issuer);
  }, [issuer, isLoaded, storageScope]);

  useEffect(() => {
    if (!isLoaded || !storageScope || loadedScopeRef.current !== storageScope || storageScopeRef.current !== storageScope) return;
    AsyncStorage.setItem(accountStorageKey(STORAGE_KEY_OWNER_PIN, storageScope), ownerPin).catch((error) =>
      console.error('Error al guardar el PIN del jefe:', error)
    );
  }, [ownerPin, isLoaded, storageScope]);

  useEffect(() => {
    if (!isLoaded || !storageScope || loadedScopeRef.current !== storageScope || storageScopeRef.current !== storageScope) return;
    AsyncStorage.setItem(accountStorageKey(STORAGE_KEY_OWNER_RECOVERY_EMAIL, storageScope), ownerRecoveryEmail).catch((error) =>
      console.error('Error al guardar el email de recuperación:', error)
    );
  }, [ownerRecoveryEmail, isLoaded, storageScope]);

  useEffect(() => {
    if (!isLoaded || !storageScope || loadedScopeRef.current !== storageScope || storageScopeRef.current !== storageScope) return;
    AsyncStorage.setItem(accountStorageKey(STORAGE_KEY_OWNER_RECOVERY_PHONE, storageScope), ownerRecoveryPhone).catch((error) =>
      console.error('Error al guardar el teléfono de recuperación:', error)
    );
  }, [ownerRecoveryPhone, isLoaded, storageScope]);

  useEffect(() => {
    if (!isLoaded || !accessToken || !storageScope || loadedScopeRef.current !== storageScope || storageScopeRef.current !== storageScope || transactionsRef.current.length === 0) return;
    const generation = cacheGenerationRef.current;
    const transactionsNeedingPublication = transactionsRef.current.filter((transaction) =>
      !transaction.publicUrl && !transaction.refundHistory?.length && transaction.documentType !== 'COMPRA/DEVOLUCIONES'
    );
    if (transactionsNeedingPublication.length === 0) return;

    void Promise.all(transactionsNeedingPublication.map(async (transaction) => {
      const publishedTransaction = await registerTransactionDocumentRef.current(transaction);
      if (cacheGenerationRef.current !== generation) return;
      setTransactions((current) => current.map((item) =>
        item.id === publishedTransaction.id ? publishedTransaction : item
      ));
    }));
  }, [isLoaded, transactions.length, storageScope, accessToken]);

  useEffect(() => {
    if (userRole === 'empleado' && activeTab !== 'tpv') setActiveTab('tpv');
  }, [userRole, activeTab]);

  useEffect(() => {
    (async () => {
      const { status } = await Camera.requestCameraPermissionsAsync();
      setHasPermission(status === 'granted');
    })();
  }, []);

  useEffect(() => {
    if (!accessToken) return;

    (async () => {
      try {
        if (Platform.OS === 'android') {
          const permissions = await requestNeededAndroidPermissions({
            accessFineLocation: {
              title: 'Permiso de ubicación',
              message: 'Stripe Terminal necesita ubicación para aceptar pagos presenciales.',
              buttonPositive: 'Aceptar',
            },
          });
          if (permissions.error) {
            setTerminalError('Stripe Terminal necesita permisos de ubicación y Bluetooth para cobrar con contacto.');
            return;
          }
        }

        const { error } = await initialize();
        if (error) {
          setTerminalError(error.message || 'No se pudo iniciar Stripe Terminal.');
          return;
        }
        setTerminalError('');
        setTerminalMessage('tpv.ready');
      } catch (error) {
        setTerminalError(error instanceof Error ? error.message : 'No se pudo iniciar Stripe Terminal.');
      }
    })();
  }, [accessToken, initialize]);

  const amount = Number(digits) / 100;

  const filteredTransactions = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase('es-ES');
    if (!query) return transactions;
    return transactions.filter(({ ticketCode, client: transactionClient }) =>
      ticketCode.toLocaleLowerCase('es-ES').includes(query) ||
      transactionClient?.name.toLocaleLowerCase('es-ES').includes(query),
    );
  }, [searchQuery, transactions]);

  useEffect(() => {
    setTransactionHistory(filteredTransactions);
  }, [filteredTransactions]);

  const totals = useMemo(() => transactions.reduce(
    (result, transaction) => {
      if (transaction.type === 'COBRO') {
        const originalAmount = transaction.originalAmount ?? transaction.amount;
        const refundedAmount = (transaction.refundHistory || []).reduce((sum, refund) => sum + refund.amount, 0);
        return {
          charges: result.charges + originalAmount,
          refunds: result.refunds + refundedAmount,
        };
      } else {
        return {
          charges: result.charges,
          refunds: result.refunds + transaction.amount,
        };
      }
    },
    { charges: 0, refunds: 0 },
  ), [transactions]);

  // Importes con IVA en céntimos, iguales a los price_... de Stripe (10,89 € y 3,03 € por plaza):
  // así el total que se ve aquí coincide al céntimo con lo que cobra Stripe.
  const subscriptionBasePriceCents = 1089;
  const subscriptionAdditionalUserCents = 303;
  const currentSubscriptionTotal = useMemo(() => {
    const additionalUsers = Math.max(0, Number(issuer.additionalUsers || 0));
    return (subscriptionBasePriceCents + (additionalUsers * subscriptionAdditionalUserCents)) / 100;
  }, [issuer.additionalUsers]);

  // Traduce el estado que devuelve el backend a un texto que se ve en la cabecera.
  const subscriptionStatusLabel = () => {
    if (subscriptionLoading) return tr('sub.statusChecking');
    switch (subscriptionStatus) {
      case 'active':
      case 'trialing':
        return subscriptionStatus === 'trialing' ? tr('sub.statusTrialing') : tr('sub.statusActive');
      case 'past_due':
        return tr('sub.statusPastDue');
      case 'unpaid':
        return tr('sub.statusUnpaid');
      case 'incomplete':
      case 'incomplete_expired':
        return tr('sub.statusPending');
      case 'canceled':
        return tr('sub.statusInactive');
      default:
        return tr('sub.statusMissing');
    }
  };

  const requireSubscription = (feature: string) => {
    if (hasActiveSubscription) return true;

    // Impago dentro del plazo de cortesia: la app sigue funcionando y lo que hay es el aviso
    // rojo. No se bloquea el uso hasta que se cumplen los dias de margen.
    if (subscriptionPastDue && !subscriptionLocked) return true;

    Alert.alert(
      'Suscripción necesaria',
      `Activa la suscripción para ${feature}. Puedes seguir explorando la aplicación antes de contratarla.`,
      [
        { text: 'Ahora no', style: 'cancel' },
        { text: 'Activar suscripción', onPress: () => void startSubscriptionCheckout() },
      ],
    );
    return false;
  };

  const totalExpensesAmount = useMemo(() => expenses.reduce((acc, exp) => acc + exp.amount, 0), [expenses]);

  const chartData = useMemo(() => {
    const count = chartGranularity === 'day' ? 7 : chartGranularity === 'week' ? 8 : 6;
    const buckets: { label: string; income: number; expenses: number; net: number; start: Date; end: Date }[] = [];

    for (let index = 0; index < count; index += 1) {
      const base = new Date();
      const bucketDate = new Date(base);

      if (chartGranularity === 'day') {
        bucketDate.setDate(base.getDate() - (count - 1 - index));
        bucketDate.setHours(0, 0, 0, 0);
      }

      if (chartGranularity === 'week') {
        const dayOfWeek = (base.getDay() + 6) % 7;
        const startOfWeek = new Date(base);
        startOfWeek.setDate(base.getDate() - dayOfWeek);
        startOfWeek.setHours(0, 0, 0, 0);
        bucketDate.setTime(startOfWeek.getTime() - (count - 1 - index) * 7 * 24 * 60 * 60 * 1000);
      }

      if (chartGranularity === 'month') {
        bucketDate.setMonth(base.getMonth() - (count - 1 - index), 1);
        bucketDate.setHours(0, 0, 0, 0);
      }

      const start = new Date(bucketDate);
      const end = new Date(bucketDate);

      if (chartGranularity === 'day') {
        end.setHours(23, 59, 59, 999);
      } else if (chartGranularity === 'week') {
        start.setDate(bucketDate.getDate());
        end.setDate(bucketDate.getDate() + 6);
        end.setHours(23, 59, 59, 999);
      } else {
        end.setMonth(bucketDate.getMonth() + 1, 0);
        end.setHours(23, 59, 59, 999);
      }

      const income = transactions
        .filter((transaction) => {
          const date = new Date(transaction.createdAt);
          return date >= start && date <= end && transaction.type === 'COBRO';
        })
        .reduce((acc, transaction) => acc + transaction.amount, 0);

      const expensesAmount = expenses
        .filter((expense) => {
          const date = new Date(expense.createdAt);
          return date >= start && date <= end;
        })
        .reduce((acc, expense) => acc + expense.amount, 0);

      const net = income - expensesAmount;
      const label = chartGranularity === 'day'
        ? new Intl.DateTimeFormat(appLocale, { day: '2-digit', month: '2-digit' }).format(bucketDate)
        : chartGranularity === 'week'
          ? `${tr('reports.week')} ${index + 1}`
          : new Intl.DateTimeFormat(appLocale, { month: 'short' }).format(bucketDate);

      buckets.push({ label, income, expenses: expensesAmount, net, start, end });
    }

    return buckets;
  }, [appLocale, chartGranularity, expenses, transactions, tr]);

  const maxChartValue = useMemo(() => {
    if (chartData.length === 0) return 1;
    return Math.max(1, ...chartData.map((item) => Math.max(item.income, item.expenses, Math.max(item.net, 0))));
  }, [chartData]);

  const parseDateInput = (value: string): Date | null => {
    const trimmed = value.trim();
    if (!trimmed) return null;

    const spanishMatch = trimmed.match(/^\d{2}\/\d{2}\/\d{4}$/);
    if (spanishMatch) {
      const [day, month, year] = trimmed.split('/').map(Number);
      const parsed = new Date(year, month - 1, day, 12, 0, 0);
      return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day
        ? parsed
        : null;
    }

    const isoMatch = trimmed.match(/^\d{4}-\d{2}-\d{2}$/);
    if (isoMatch) {
      const [year, month, day] = trimmed.split('-').map(Number);
      const parsed = new Date(year, month - 1, day, 12, 0, 0);
      return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day
        ? parsed
        : null;
    }

    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };

  const formatReportDate = (date: Date): string => {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${day}/${month}/${date.getFullYear()}`;
  };

  const openChartPeriodReport = (period: { start: Date; end: Date; label: string }) => {
    setTransactionStartDateInput(formatReportDate(period.start));
    setTransactionEndDateInput(formatReportDate(period.end));
    setTransactionReportModalVisible(true);
  };

  const showPeriodDetails = () => {
    const start = parseDateInput(transactionStartDateInput);
    const end = parseDateInput(transactionEndDateInput);
    if (!start || !end) {
      Alert.alert(tr('validation.error'), tr('validation.dates'));
      return;
    }
    if (start > end) {
      Alert.alert(tr('validation.error'), tr('validation.dates'));
      return;
    }

    const endExclusive = new Date(end);
    endExclusive.setHours(23, 59, 59, 999);
    const periodTransactions = transactions.filter((transaction) => {
      const date = new Date(transaction.createdAt);
      return date >= start && date <= endExclusive;
    });
    const periodExpenses = expenses.filter((expense) => {
      const date = new Date(expense.createdAt);
      return date >= start && date <= endExclusive;
    });
    const totalIncome = periodTransactions
      .filter((transaction) => transaction.type === 'COBRO')
      .reduce((sum, transaction) => sum + (transaction.originalAmount ?? transaction.amount), 0);
    const totalRefunds = periodTransactions.reduce((sum, transaction) => {
      if (transaction.type === 'DEVOLUCIÓN') return sum + transaction.amount;
      return sum + (transaction.refundHistory || []).reduce((refundSum, refund) => refundSum + refund.amount, 0);
    }, 0);

    setPeriodDetails({
      startLabel: transactionStartDateInput,
      endLabel: transactionEndDateInput,
      transactions: periodTransactions,
      expenses: periodExpenses,
      totalIncome,
      totalRefunds,
      totalExpenses: periodExpenses.reduce((sum, expense) => sum + expense.amount, 0),
    });
  };

  const setExpenseReportPeriod = (period: 'day' | 'week' | 'month') => {
    const today = new Date();
    const start = new Date(today);
    const end = new Date(today);

    if (period === 'week') {
      const dayOfWeek = (today.getDay() + 6) % 7;
      start.setDate(today.getDate() - dayOfWeek);
      end.setDate(start.getDate() + 6);
    } else if (period === 'month') {
      start.setDate(1);
      end.setMonth(today.getMonth() + 1, 0);
    }

    setExpenseStartDateInput(formatReportDate(start));
    setExpenseEndDateInput(formatReportDate(end));
  };

  const TransactionHistory = () => (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>📜 {tr('history.title').replace('{count}', String(transactionHistory.length))}</Text>
      <TextInput
        style={styles.input}
        placeholder={tr('history.search')}
        placeholderTextColor="#94a3b8"
        value={searchQuery}
        onChangeText={setSearchQuery}
      />
      {transactionHistory.length === 0 ? (
        <Text style={styles.emptyText}>{tr('history.empty')}</Text>
      ) : (
        transactionHistory.map((t) => (
          <Pressable key={t.id} style={styles.listItem} onPress={() => setSelectedTicket(t)}>
            <View>
              <Text style={styles.listItemTitle}>{t.ticketCode} ({documentTypeLabel(t.documentType)})</Text>
              <Text style={styles.listItemSubtitle}>{formatUiDate(t.createdAt)} • {t.client?.name || tr('workflow.generalClient')}</Text>
            </View>
            <Text style={[styles.listItemAmount, t.type === 'DEVOLUCIÓN' && { color: '#dc2626' }]}>
              {t.type === 'DEVOLUCIÓN' ? '-' : ''}{formatUiCurrency(t.amount)}
            </Text>
          </Pressable>
        ))
      )}
    </View>
  );

  async function registerTransactionDocument(transaction: Transaction): Promise<Transaction> {
    if (!isLoaded || !storageScope || loadedScopeRef.current !== storageScope || storageScopeRef.current !== storageScope) return transaction;
    const generation = cacheGenerationRef.current;
    if (DOCUMENT_API_URL_CANDIDATES.length === 0) {
      const error = new Error('No hay una URL de backend configurada en la aplicación.');
      setTerminalError(error.message);
      return transaction;
    }

    const logoDataUrl = transaction.issuer.logoUri
      ? await convertImageToBase64(transaction.issuer.logoUri)
      : undefined;

    const requestBody = JSON.stringify({
      ...transaction,
      issuer: {
        name: transaction.issuer.name,
        nif: transaction.issuer.nif,
        address: transaction.issuer.address,
        logoUri: logoDataUrl || transaction.issuer.logoUri,
      },
    });

    // Si la sesión está a punto de caducar se renueva aquí: así el documento se guarda asociado a
    // la cuenta y se puede recuperar después con "Sincronizar historial" (no queda sin dueño).
    const authToken = await ensureFreshAccessToken();
    if (cacheGenerationRef.current !== generation) return transaction;
    if (accessToken && !authToken) {
      setTerminalError('La sesión ha caducado. Vuelve a iniciar sesión para guardar el ticket en la nube.');
      return transaction;
    }

    let lastError: unknown;
    for (const baseUrl of DOCUMENT_API_URL_CANDIDATES) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (cacheGenerationRef.current !== generation) return transaction;
        try {
          const response = await fetchWithTimeout(`${baseUrl}/api/documents`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              // Con sesion iniciada, el ticket/factura queda asociado a la cuenta y podra
              // recuperarse desde otro movil o tras borrar los datos (Sincronizar historial).
              ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
            },
            body: requestBody,
          }, 10000);

          if (!response.ok) {
            let errorMessage = `HTTP ${response.status}`;
            try {
              const errorResult = await response.json() as { error?: string };
              errorMessage = errorResult.error || errorMessage;
            } catch {
              // Mantener el error HTTP si el backend no devuelve JSON.
            }
            throw new Error(`${baseUrl}: ${errorMessage}`);
          }

          const result = await response.json() as { publicUrl?: string };
          if (cacheGenerationRef.current !== generation) return transaction;
          if (!result.publicUrl) {
            throw new Error(`${baseUrl}: el backend no devolvió una URL pública.`);
          }

          const publishedTransaction = { ...transaction, publicUrl: result.publicUrl };
          setTransactions((current) => current.map((item) =>
            item.id === transaction.id ? publishedTransaction : item
          ));
          setSelectedTicket((current) =>
            current?.id === transaction.id ? publishedTransaction : current
          );
          setTerminalError('');
          return publishedTransaction;
        } catch (error) {
          lastError = error;
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }

    const errorMessage = lastError instanceof Error ? lastError.message : 'No se pudo publicar el documento.';
    console.warn('No se pudo publicar el documento; se mantiene sin QR.', errorMessage);
    setTerminalError(`No se pudo publicar el documento: ${errorMessage}`);
    return transaction;
  }

  const handleKey = useCallback((key: string) => {
    if (isProcessing) return;
    setDigits((current) => {
      if (key === 'C') return '0';
      if (key === '⌫') return current.length <= 1 ? '0' : current.slice(0, -1);
      const next = current === '0' ? key : `${current}${key}`;
      return next.length <= 8 ? next : current;
    });
  }, [isProcessing]);

  const createTransaction = useCallback((
    type: TransactionType,
    documentType: DocumentType,
    method: string,
    customAmount?: number,
    transactionClient?: Client,
    customItems?: InvoiceItem[],
    customIvaRate?: number,
    paymentRefs?: StripePaymentRefs,
  ) => {
    if (!isLoaded || !storageScope || loadedScopeRef.current !== storageScope || storageScopeRef.current !== storageScope) return;
    const generation = cacheGenerationRef.current;
    const finalAmount = customAmount !== undefined ? customAmount : amount;
    if (type === 'COBRO' && finalAmount <= 0) {
      Alert.alert('Importe inválido', 'Introduce una cantidad superior a 0,00 €.');
      return;
    }

    setIsProcessing(true);
    setTerminalError('');
    const createdAt = new Date().toISOString();
    const randomSuffix = Math.random().toString(36).slice(2, 6).toUpperCase();
    const id = `${Date.now()}-${randomSuffix}`;
    const prefix = documentType === 'TICKET DE VENTA' ? 'TK' : documentType === 'TICKET DE DEVOLUCIÓN' ? 'DEV' : 'FAC';
    const activeIva = customIvaRate !== undefined ? customIvaRate : Number(ivaPercentage);
    const taxMultiplier = 1 + (activeIva / 100);
    const subtotal = finalAmount / taxMultiplier;
    
    const ticketCode = `${prefix}-${Date.now().toString().slice(-6)}-${randomSuffix}`;
    const transaction: Transaction = {
      id,
      ticketCode,
      type,
      documentType,
      amount: finalAmount,
      originalAmount: finalAmount,
      subtotal,
      iva: finalAmount - subtotal,
      ivaRateApplied: activeIva,
      createdAt,
      method,
      issuer: { ...issuer },
      client: transactionClient,
      items: customItems,
      isRefunded: false,
      refundHistory: [],
      ...(paymentRefs?.stripePaymentIntentId ? { stripePaymentIntentId: paymentRefs.stripePaymentIntentId } : {}),
      ...(paymentRefs?.stripeAccountId ? { stripeAccountId: paymentRefs.stripeAccountId } : {}),
      ...(paymentRefs?.chargeMode ? { chargeMode: paymentRefs.chargeMode } : {}),
      ...(paymentRefs?.stripeCheckoutSessionId ? { stripeCheckoutSessionId: paymentRefs.stripeCheckoutSessionId } : {}),
    };

    setTransactions((current) => [transaction, ...current]);
    setSelectedTicket(transaction);
    setDigits('0');
    setIsProcessing(false);

    setTimeout(async () => {
      if (cacheGenerationRef.current !== generation) return;
      const publishedTransaction = await registerTransactionDocumentRef.current(transaction);
      if (cacheGenerationRef.current !== generation) return;
      setTransactions((current) => current.map((item) =>
        item.id === publishedTransaction.id ? publishedTransaction : item
      ));
      setSelectedTicket(publishedTransaction);
    }, 0);
  }, [amount, ivaPercentage, issuer, isLoaded, storageScope]);

  const startPayment = (documentType: DocumentType) => {
    if (!requireSubscription('realizar cobros')) return;
    if (documentType === 'FACTURA COMPLETA' || documentType === 'FACTURA SIMPLIFICADA') {
      setPendingDocumentType(documentType);
      setClientModalVisible(true);
      return;
    }
    if (amount <= 0) {
      Alert.alert(tr('validation.error'), tr('validation.amount'));
      return;
    }
    setPendingDocumentType(documentType);
    setNfcModalVisible(true);
  };

  const submitClientModal = () => {
    const validClient = Object.fromEntries(Object.entries(client).map(([key, value]) => [key, value.trim()])) as Client;
    if (!validClient.name || !validClient.nif || !validClient.address) {
      Alert.alert(tr('validation.error'), tr('validation.client'));
      return;
    }

    const validItems = invoiceItems
      .map(i => ({ ...i, description: i.description.trim(), price: i.price.trim() }))
      .filter(i => i.description !== '' && i.price !== '');

    if (validItems.length === 0) {
      Alert.alert(tr('validation.error'), tr('validation.items'));
      return;
    }

    const subtotal = validItems.reduce((acc, item) => acc + (parseFloat(item.price.replace(',', '.')) || 0), 0);
    if (subtotal <= 0) {
      Alert.alert(tr('validation.error'), tr('validation.amount'));
      return;
    }

    const parsedIva = parseFloat(invoiceIvaInput.replace(',', '.')) || 21;
    if (parsedIva < 0 || parsedIva > 100) {
      Alert.alert(tr('validation.error'), tr('validation.vat'));
      return;
    }

    const totalWithIva = subtotal * (1 + (parsedIva / 100));

    setClientModalVisible(false);
    setPendingInvoice({ 
      client: validClient, 
      items: validItems, 
      ivaRate: parsedIva, 
      total: totalWithIva, 
      docType: pendingDocumentType 
    });
    setNfcModalVisible(true);
  };

  const createStripeTerminalPaymentIntent = async (paymentAmount: number, orderId: string): Promise<{
    clientSecret: string;
    paymentIntentId: string;
    accountId: string | null;
    locationId: string | null;
    chargeMode: 'direct' | 'platform';
  }> => {
    if (!accessToken || !configuredDocumentApiUrl) {
      throw new Error('Inicia sesión para poder cobrar con Stripe.');
    }

    const response = await fetchWithTimeout(`${configuredDocumentApiUrl}/api/stripe/payment-intent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ amount: paymentAmount, orderId }),
    }, 15000);
    const result = await response.json() as StripeTerminalPaymentIntentResult;
    if (!response.ok || !result.clientSecret || !result.paymentIntentId) {
      if (result.code && ['connect_not_connected', 'connect_charges_not_enabled'].includes(result.code)) {
        throw new Error(tr(connectErrorKey(result)));
      }
      throw new Error(result.error || 'Stripe no devolvió un PaymentIntent para cobro presencial.');
    }

    return {
      clientSecret: result.clientSecret,
      paymentIntentId: result.paymentIntentId,
      accountId: result.accountId || null,
      locationId: result.locationId || null,
      chargeMode: result.chargeMode === 'direct' ? 'direct' : 'platform',
    };
  };

  const createTransactionFromConfirmedPayment = (method: string, paymentAmount: number, paymentRefs?: StripePaymentRefs): void => {
    setNfcModalVisible(false);

    // createTransaction ya deja el ticket seleccionado (setSelectedTicket) y lo publica con su QR,
    // asi que al confirmarse el pago se abre directamente el recibo/factura para el cliente.
    if (pendingInvoice) {
      createTransaction(
        'COBRO',
        pendingInvoice.docType,
        method,
        paymentAmount,
        pendingInvoice.client,
        pendingInvoice.items,
        pendingInvoice.ivaRate,
        paymentRefs,
      );
      setPendingInvoice(null);
      setClient({ name: '', nif: '', address: '' });
      setInvoiceItems([{ id: '1', description: '', price: '' }]);
      setInvoiceIvaInput('21');
    } else {
      createTransaction('COBRO', pendingDocumentType, method, paymentAmount, undefined, undefined, undefined, paymentRefs);
    }
  };
  useEffect(() => {
    createOnlinePaymentRef.current = createTransactionFromConfirmedPayment;
  });

  const ensureTapToPayReader = async (locationId?: string | null) => {
    const resolvedLocationId = (typeof locationId === 'string' && locationId.trim()) || STRIPE_TERMINAL_LOCATION_ID;
    if (!resolvedLocationId) {
      throw new Error('Falta la ubicación de Stripe Terminal. Completa Connect o configura EXPO_PUBLIC_STRIPE_TERMINAL_LOCATION_ID.');
    }

    if (!isStripeTerminalInitialized) {
      setTerminalMessage('tpv.preparing');
      const { error } = await initialize();
      if (error) throw new Error(error.message || 'No se pudo iniciar Stripe Terminal.');
    }

    if (connectedReader) return connectedReader;

    setTerminalMessage('tpv.preparing');
    const connectionResult = await easyConnect({
      discoveryMethod: 'tapToPay',
      // Stripe no permite el lector Tap to Pay real en una app depurable.
      // El lector simulado solo se activa durante el desarrollo local.
      simulated: __DEV__,
      locationId: resolvedLocationId,
      merchantDisplayName: issuer.name,
      autoReconnectOnUnexpectedDisconnect: true,
    });
    if (connectionResult.error) {
      throw new Error(connectionResult.error.message || 'No se pudo conectar Tap to Pay.');
    }

    return connectionResult.reader;
  };

  const completePayment = async () => {
    if (!accessToken || !configuredDocumentApiUrl) {
      Alert.alert(tr('pay.sessionRequired'), tr('pay.sessionRequiredBody'));
      return;
    }

    const paymentAmount = pendingInvoice ? pendingInvoice.total : amount;
    const orderId = `stripe-terminal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setIsProcessing(true);
    setTerminalError('');
    setTerminalMessage('tpv.preparing');

    try {
      // Primero el PaymentIntent (y location Connect); después el lector Tap to Pay.
      const intent = await createStripeTerminalPaymentIntent(paymentAmount, orderId);
      await ensureTapToPayReader(intent.locationId);
      const retrievedResult = await retrievePaymentIntent(intent.clientSecret);
      if (retrievedResult.error || !retrievedResult.paymentIntent) {
        throw new Error(retrievedResult.error?.message || 'No se pudo preparar el cobro presencial.');
      }

      setTerminalMessage('tpv.contactlessHint');
      const collectedResult = await collectPaymentMethod({
        paymentIntent: retrievedResult.paymentIntent,
        customerCancellation: 'disableIfAvailable',
      });
      if (collectedResult.error || !collectedResult.paymentIntent) {
        throw new Error(collectedResult.error?.message || 'No se pudo leer la tarjeta o wallet.');
      }

      setTerminalMessage('common.checking');
      const processedResult = await processPaymentIntent({ paymentIntent: collectedResult.paymentIntent });
      if (processedResult.error || !processedResult.paymentIntent) {
        throw new Error(processedResult.error?.message || 'No se pudo confirmar el cobro presencial.');
      }
      if (processedResult.paymentIntent.status !== 'succeeded') {
        throw new Error(`Stripe Terminal devolvió el estado ${processedResult.paymentIntent.status || 'desconocido'}.`);
      }

      setTerminalMessage('pay.confirmedTicket');
      createTransactionFromConfirmedPayment('Stripe Terminal - Contactless', paymentAmount, {
        stripePaymentIntentId: intent.paymentIntentId,
        stripeAccountId: intent.accountId,
        chargeMode: intent.chargeMode,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No se pudo completar el cobro presencial.';
      setTerminalError(message);
      Alert.alert('Error de Stripe', message);
    } finally {
      setIsProcessing(false);
    }
  };

  const cancelPayment = () => {
    setNfcModalVisible(false);
    setPendingInvoice(null);
  };

  const closeOnlinePaymentModal = () => {
    setOnlinePaymentModalVisible(false);
    setOnlinePayment(null);
    setOnlinePaymentError('');
    setOnlinePaymentMessage('');
    onlinePaymentConfirmedRef.current = false;
  };

  const openOnlinePaymentModal = () => {
    setNfcModalVisible(false);
    setOnlinePayment(null);
    setOnlinePaymentError('');
    setOnlinePaymentMessage('');
    onlinePaymentConfirmedRef.current = false;
    setOnlinePaymentModalVisible(true);
  };

  const backToTerminalModal = () => {
    closeOnlinePaymentModal();
    setNfcModalVisible(true);
  };

  const createOnlinePayment = async () => {
    if (!isLoaded || !storageScope || loadedScopeRef.current !== storageScope || storageScopeRef.current !== storageScope) return;
    const generation = cacheGenerationRef.current;
    if (!accessToken || !configuredDocumentApiUrl) {
      Alert.alert('Sesión requerida', 'Inicia sesión para poder cobrar con Stripe.');
      return;
    }

    const paymentAmount = pendingInvoice ? pendingInvoice.total : amount;
    if (!Number.isFinite(paymentAmount) || paymentAmount < 0.5) {
      setOnlinePaymentError('El importe debe ser de al menos 0,50 €.');
      return;
    }
    if (paymentAmount > 999999.99) {
      setOnlinePaymentError('El importe supera el máximo permitido para el cobro online.');
      return;
    }

    const orderId = `stripe-online-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setOnlinePaymentLoading(true);
    setOnlinePaymentError('');
    setOnlinePaymentMessage('Generando el enlace y el QR de pago...');

    try {
      // Si Connect test está activo, el cobro es directo: exigir cuenta con cobros habilitados.
      const connectResponse = await fetchWithTimeout(`${configuredDocumentApiUrl}/api/stripe/connect/status`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }, 15000);
      const connectResult: unknown = await connectResponse.json();
      if (cacheGenerationRef.current !== generation) return;
      if (connectResponse.ok) {
        const status = parseConnectStatus(connectResult);
        if (status?.enabled) {
          if (!status.connected) throw new Error(tr('connect.notConnected'));
          if (!status.chargesEnabled) throw new Error(tr('connect.chargesNotEnabled'));
        }
      }

      const response = await fetchWithTimeout(`${configuredDocumentApiUrl}/api/stripe/payment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ amount: paymentAmount, orderId }),
      }, 30000);
      const result = await response.json() as StripeOnlinePaymentResult;
      if (cacheGenerationRef.current !== generation) return;
      const checkoutUrl = result.checkoutUrl || result.redirectUrl;
      if (!response.ok || !checkoutUrl || !result.paymentId) {
        if (result.code && ['connect_not_connected', 'connect_charges_not_enabled'].includes(result.code)) {
          throw new Error(tr(connectErrorKey(result)));
        }
        throw new Error(result.error || `Stripe no devolvió un enlace de pago (HTTP ${response.status}).`);
      }

      setOnlinePayment({
        paymentId: result.paymentId,
        checkoutUrl,
        qrDataUrl: result.qrDataUrl || null,
        accountId: result.accountId || null,
        chargeMode: result.chargeMode === 'direct' ? 'direct' : 'platform',
        paymentIntentId: result.paymentIntentId || null,
      });
      // Se indican al vendedor los métodos que Stripe ofrece en este cobro concreto.
      const offeredMethods = Array.isArray(result.paymentMethods) && result.paymentMethods.length > 0
        ? result.paymentMethods.join(', ')
        : '';
      const directHint = result.chargeMode === 'direct'
        ? ' Cobro directo a tu cuenta Connect de prueba.'
        : '';
      setOnlinePaymentMessage(
        offeredMethods
          ? `Muestra el QR al cliente o abre el enlace de pago. Métodos en este cobro: ${offeredMethods}.${directHint}`
          : `Muestra el QR al cliente o abre el enlace de pago. Stripe mostrará los métodos activados en tu cuenta (tarjeta, Bizum...).${directHint}`,
      );
      // Persistir el cobro pendiente: al volver del navegador la app puede remontarse y
      // perder el estado en memoria; asi se reanuda la comprobacion automaticamente.
      try {
        await AsyncStorage.setItem(accountStorageKey(STORAGE_KEY_PENDING_ONLINE_PAYMENT, storageScope), JSON.stringify({
          paymentId: result.paymentId,
          checkoutUrl,
          qrDataUrl: result.qrDataUrl || null,
          accountId: result.accountId || null,
          chargeMode: result.chargeMode || null,
          paymentIntentId: result.paymentIntentId || null,
          paymentAmount,
          pendingDocumentType,
          pendingInvoice,
          createdAt: new Date().toISOString(),
        }));
      } catch {
        // Error no bloqueante: la comprobacion en memoria sigue funcionando.
      }
    } catch (error) {
      setOnlinePaymentMessage('');
      setOnlinePaymentError(error instanceof Error ? error.message : 'No se pudo generar el cobro online.');
    } finally {
      setOnlinePaymentLoading(false);
    }
  };

  const checkOnlinePaymentStatus = async () => {
    if (!accessToken || !configuredDocumentApiUrl || !onlinePaymentRef.current) return;

    setOnlinePaymentLoading(true);
    setOnlinePaymentError('');
    setOnlinePaymentMessage('Comprobando el pago en Stripe...');

    try {
      const finished = await confirmOnlinePaymentInBackground(onlinePaymentRef.current.paymentId);
      if (!finished) {
        setOnlinePaymentMessage('Stripe todavía no confirma el pago. Con Bizum el banco puede tardar unos segundos: seguimos comprobando automáticamente.');
      }
    } catch (error) {
      setOnlinePaymentError(error instanceof Error ? error.message : 'No se pudo comprobar el pago.');
    } finally {
      setOnlinePaymentLoading(false);
    }
  };

  const readOnlinePaymentStatus = async (paymentId?: string): Promise<StripeOnlinePaymentStatusResult | null> => {
    const targetPaymentId = paymentId || onlinePaymentRef.current?.paymentId || onlinePayment?.paymentId;
    if (!accessToken || !configuredDocumentApiUrl || !targetPaymentId) return null;

    const response = await fetchWithTimeout(`${configuredDocumentApiUrl}/api/stripe/payment/${targetPaymentId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }, 10000);
    const result = await response.json() as StripeOnlinePaymentStatusResult;
    if (!response.ok) {
      throw new Error(result.error || 'No se pudo consultar el pago en Stripe.');
    }

    return result;
  };

  const methodLabelFor = (method: string | null | undefined): 'bizum' | 'card' | null => {
    if (method === 'bizum') return 'bizum';
    if (method === 'card') return 'card';
    return null;
  };

  // Comprueba el pago sin tocar los mensajes de la interfaz (para la espera automatica).
  // Devuelve true cuando ya no hay que seguir esperando (pago confirmado o enlace caducado).
  const confirmOnlinePaymentInBackground = async (paymentId?: string): Promise<boolean> => {
    if (!isLoaded || !storageScope || loadedScopeRef.current !== storageScope || storageScopeRef.current !== storageScope) return false;
    const generation = cacheGenerationRef.current;
    const payment = await readOnlinePaymentStatus(paymentId);
    if (cacheGenerationRef.current !== generation) return true;
    const status = payment?.status;
    if (!status) return false;

    const paymentAmount = pendingInvoice ? pendingInvoice.total : amount;
    const usedMethod = methodLabelFor(payment?.usedMethod);

    if (status === 'SUCCEEDED') {
      if (onlinePaymentConfirmedRef.current) return true;
      onlinePaymentConfirmedRef.current = true;
      setOnlinePaymentMessage('Pago confirmado. Generando el ticket con su QR...');
      const currentOnline = onlinePaymentRef.current;
      createTransactionFromConfirmedPayment(
        usedMethod === 'bizum' ? 'Stripe - Bizum (enlace o QR)' : usedMethod === 'card' ? 'Stripe - Tarjeta online' : 'Stripe - Enlace o QR (tarjeta o Bizum)',
        paymentAmount,
        {
          stripePaymentIntentId: payment?.paymentIntentId || currentOnline?.paymentIntentId || undefined,
          stripeAccountId: payment?.accountId || currentOnline?.accountId || null,
          chargeMode: payment?.chargeMode || currentOnline?.chargeMode || 'platform',
          stripeCheckoutSessionId: currentOnline?.paymentId || paymentId || null,
        },
      );
      try {
        await AsyncStorage.removeItem(accountStorageKey(STORAGE_KEY_PENDING_ONLINE_PAYMENT, storageScope));
      } catch {
        // No bloqueante.
      }
      if (cacheGenerationRef.current !== generation) return true;
      closeOnlinePaymentModal();
      // createTransaction ya deja el ticket en selectedTicket: el recibo/factura con su QR
      // para el cliente se muestra solo al volver del pago.
      return true;
    }

    // Pago rechazado por el banco (p. ej. Bizum declinado con +34600000002): el enlace sigue
    // sirviendo, asi que NO se borra el cobro y el cliente puede reintentar. Hay que mostrarlo
    // en vez de dejar la espera girando.
    if (status === 'FAILED') {
      setOnlinePaymentMessage(usedMethod === 'bizum'
        ? 'Bizum ha sido rechazado por el banco. El cliente puede reintentar el pago con el mismo enlace o QR.'
        : 'El pago ha sido rechazado. El cliente puede reintentar el pago con el mismo enlace o QR.');
      return false;
    }

    if (status === 'EXPIRED') {
      setOnlinePayment(null);
      setOnlinePaymentError('El enlace de pago ha caducado. Genera uno nuevo.');
      try {
        await AsyncStorage.removeItem(accountStorageKey(STORAGE_KEY_PENDING_ONLINE_PAYMENT, storageScope));
      } catch {
        // No bloqueante.
      }
      return true;
    }

    return false;
  };

  // Espera automatica: comprueba el pago cada 3 segundos mientras el QR este en pantalla,
  // asi el ticket aparece solo cuando el cliente termina de pagar.
  useEffect(() => {
    if (!onlinePaymentModalVisible || !onlinePayment || !accessToken || !configuredDocumentApiUrl) return;

    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      if (cancelled) return;
      attempts += 1;

      let finished = false;
      try {
        finished = await confirmOnlinePaymentInBackground();
      } catch {
        // Si una comprobacion puntual falla, se reintenta en el siguiente ciclo.
      }
      if (cancelled || finished) return;

      if (attempts >= 120) {
        setOnlinePaymentMessage('No hemos podido confirmar el pago automáticamente. Pulsa "Ya ha pagado: comprobar ahora".');
        return;
      }

      timer = setTimeout(poll, 3000);
    };

    timer = setTimeout(poll, 2500);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlinePaymentModalVisible, onlinePayment?.paymentId, accessToken]);

  const openOnlinePaymentPage = async () => {
    const currentOnlinePayment = onlinePaymentRef.current;
    if (!currentOnlinePayment?.checkoutUrl) return;

    try {
      // openAuthSessionAsync cierra el navegador solo cuando Checkout redirige a la app.
      await WebBrowser.openAuthSessionAsync(currentOnlinePayment.checkoutUrl, ONLINE_PAYMENT_REDIRECT_URL);
    } catch {
      await WebBrowser.openBrowserAsync(currentOnlinePayment.checkoutUrl);
    }

    await checkOnlinePaymentStatus();
  };

  // Al volver del navegador (incluso del mismo movil), el sistema puede remontar la app y
  // vaciar el estado en memoria. Aqui se recupera el cobro pendiente guardado y se sigue
  // comprobando hasta que Stripe confirma el pago y se muestra el ticket con su QR.
  useEffect(() => {
    if (!accessToken || !configuredDocumentApiUrl || !isLoaded || !storageScope || loadedScopeRef.current !== storageScope || storageScopeRef.current !== storageScope) return;

    let cancelled = false;
    const generation = cacheGenerationRef.current;
    const isCurrent = () => !cancelled && cacheGenerationRef.current === generation && storageScopeRef.current === storageScope;

    const readOnlinePaymentStatusWith = async (paymentId: string): Promise<StripeOnlinePaymentStatusResult | null> => {
      if (!accessToken || !configuredDocumentApiUrl) return null;
      const response = await fetchWithTimeout(`${configuredDocumentApiUrl}/api/stripe/payment/${paymentId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }, 10000);
      const result = await response.json() as StripeOnlinePaymentStatusResult;
      if (!response.ok) {
        throw new Error(result.error || 'No se pudo consultar el pago en Stripe.');
      }
      return result;
    };

    const resumePendingOnlinePayment = async () => {
      let stored: string | null = null;
      try {
        stored = await AsyncStorage.getItem(accountStorageKey(STORAGE_KEY_PENDING_ONLINE_PAYMENT, storageScope));
      } catch {
        return;
      }
      if (!isCurrent() || !stored) return;

      let pending: {
        paymentId?: string;
        checkoutUrl?: string;
        qrDataUrl?: string | null;
        accountId?: string | null;
        chargeMode?: 'direct' | 'platform' | null;
        paymentIntentId?: string | null;
        paymentAmount?: number;
        pendingDocumentType?: DocumentType;
        pendingInvoice?: PendingInvoice | null;
      } | null = null;
      try {
        pending = JSON.parse(stored);
      } catch {
        return;
      }
      if (!isCurrent() || !pending?.paymentId || !pending?.checkoutUrl) return;

      // Restaurar el contexto del cobro para generar el mismo ticket al confirmarse.
      // digits guarda centimos (amount = Number(digits) / 100), asi que se multiplica por 100.
      if (typeof pending.paymentAmount === 'number' && Number.isFinite(pending.paymentAmount)) {
        setDigits(String(Math.max(0, Math.round(pending.paymentAmount * 100))));
      }
      if (pending.pendingDocumentType) setPendingDocumentType(pending.pendingDocumentType);
      if (pending.pendingInvoice) {
        setPendingInvoice(pending.pendingInvoice);
        setClient(pending.pendingInvoice.client);
        setInvoiceItems(pending.pendingInvoice.items);
        setInvoiceIvaInput(String(pending.pendingInvoice.ivaRate));
      }

      onlinePaymentConfirmedRef.current = false;
      setOnlinePayment({
        paymentId: pending.paymentId,
        checkoutUrl: pending.checkoutUrl,
        qrDataUrl: pending.qrDataUrl || null,
        accountId: pending.accountId || null,
        chargeMode: pending.chargeMode === 'direct' ? 'direct' : 'platform',
        paymentIntentId: pending.paymentIntentId || null,
      });
      setOnlinePaymentError('');
      setOnlinePaymentMessage('Comprobando el pago realizado...');
      setOnlinePaymentModalVisible(true);

      const amountToConfirm = pending.pendingInvoice ? pending.pendingInvoice.total : (pending.paymentAmount || 0);
      let attempts = 0;
      while (isCurrent() && attempts < 120) {
        attempts += 1;
        try {
          const payment = await readOnlinePaymentStatusWith(pending.paymentId);
          if (!isCurrent()) return;
          const status = payment?.status;
          const resumeUsedMethod = methodLabelFor(payment?.usedMethod);
          if (status === 'SUCCEEDED') {
            if (!onlinePaymentConfirmedRef.current) {
              onlinePaymentConfirmedRef.current = true;
              setOnlinePaymentMessage('Pago confirmado. Generando el ticket con su QR...');
              createOnlinePaymentRef.current(
                resumeUsedMethod === 'bizum' ? 'Stripe - Bizum (enlace o QR)' : resumeUsedMethod === 'card' ? 'Stripe - Tarjeta online' : 'Stripe - Enlace o QR (tarjeta o Bizum)',
                amountToConfirm,
                {
                  stripePaymentIntentId: payment?.paymentIntentId || pending.paymentIntentId || undefined,
                  stripeAccountId: payment?.accountId || pending.accountId || null,
                  chargeMode: payment?.chargeMode || (pending.chargeMode === 'direct' ? 'direct' : 'platform'),
                  stripeCheckoutSessionId: pending.paymentId,
                },
              );
            }
            try {
              await AsyncStorage.removeItem(accountStorageKey(STORAGE_KEY_PENDING_ONLINE_PAYMENT, storageScope));
            } catch {
              // No bloqueante.
            }
            if (!isCurrent()) return;
            setOnlinePaymentModalVisible(false);
            setOnlinePayment(null);
            onlinePaymentConfirmedRef.current = false;
            return;
          }
          // Rechazado (p. ej. Bizum declinado): el enlace sigue sirviendo, se muestra y se sigue
          // esperando un reintento del cliente en vez de dejar la espera girando en silencio.
          if (status === 'FAILED') {
            setOnlinePaymentMessage(resumeUsedMethod === 'bizum'
              ? 'Bizum ha sido rechazado por el banco. El cliente puede reintentar el pago con el mismo enlace o QR.'
              : 'El pago ha sido rechazado. El cliente puede reintentar el pago con el mismo enlace o QR.');
          }
          if (status === 'EXPIRED') {
            try {
              await AsyncStorage.removeItem(accountStorageKey(STORAGE_KEY_PENDING_ONLINE_PAYMENT, storageScope));
            } catch {
              // No bloqueante.
            }
            if (!isCurrent()) return;
            setOnlinePayment(null);
            setOnlinePaymentModalVisible(false);
            setOnlinePaymentError('El enlace de pago ha caducado. Genera uno nuevo.');
            return;
          }
        } catch {
          // Error puntual de red: se reintenta en el siguiente ciclo.
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }

      if (isCurrent()) {
        setOnlinePaymentMessage('No hemos podido confirmar el pago automáticamente. Pulsa "Ya ha pagado: comprobar ahora".');
      }
    };

    void resumePendingOnlinePayment();

    return () => {
      cancelled = true;
    };
  }, [accessToken, isLoaded, storageScope]);

  const openStripeCountrySelector = () => {
    if (userRole !== 'principal' || !isLoaded || !storageScope || stripeAccountLoading ||
      loadedScopeRef.current !== storageScope || storageScopeRef.current !== storageScope) return;
    stripeCountryScopeRef.current = { scope: storageScope, generation: cacheGenerationRef.current };
    setStripeCountryModalVisible(true);
  };

  const selectStripeConnectCountry = (country: ConnectCountry) => {
    const selection = stripeCountryScopeRef.current;
    if (!selection || selection.generation !== cacheGenerationRef.current || selection.scope !== storageScope ||
      storageScopeRef.current !== selection.scope || loadedScopeRef.current !== selection.scope ||
      userRole !== 'principal' || stripeAccountLoading || !normalizeConnectCountry(country)) return;
    setIssuer(current => ({ ...current, country }));
    setStripeCountryConfirmed(country);
    setStripeCountryModalVisible(false);
    stripeCountryScopeRef.current = null;
    setStripeMethodsError('');
    setStripeMethodsInfo('');
  };

  const openStripeAccountSettings = async () => {
    const generation = cacheGenerationRef.current;
    if (stripeConnectBusyRef.current === generation) return;
    if (userRole !== 'principal') {
      setStripeMethodsError('connect.principalOnly');
      return;
    }
    if (!accessToken || !configuredDocumentApiUrl || !isLoaded || !storageScope ||
      storageScopeRef.current !== storageScope || loadedScopeRef.current !== storageScope) {
      setStripeMethodsError('connect.sessionRequired');
      return;
    }
    // País del negocio (Config). Si no es un país Connect válido, abrir el selector.
    const country = normalizeConnectCountry(issuer.country);
    if (!country) {
      setStripeMethodsError('connect.chooseCountry');
      openStripeCountrySelector();
      return;
    }
    if (stripeCountryConfirmed !== country) setStripeCountryConfirmed(country);
    stripeConnectBusyRef.current = generation;
    const isCurrent = () => cacheGenerationRef.current === generation && storageScopeRef.current === storageScope &&
      stripeConnectBusyRef.current === generation;
    setStripeAccountLoading(true);
    setStripeMethodsError('');
    setStripeMethodsInfo('');

    const request = async (onboarding = false): Promise<unknown> => {
      const token = await ensureFreshAccessToken();
      if (!isCurrent()) return null;
      if (!token) throw new Error();
      const response = await fetchWithTimeout(`${configuredDocumentApiUrl}/api/stripe/connect/${onboarding ? 'onboarding' : 'status'}`, {
        method: onboarding ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${token}`, ...(onboarding ? { 'Content-Type': 'application/json' } : {}) },
        ...(onboarding ? { body: JSON.stringify({ country }) } : {}),
      }, 30000);
      const result: unknown = await response.json();
      if (!isCurrent()) return null;
      if (!response.ok) throw new Error(connectErrorKey(result));
      return result;
    };
    const readStatus = async () => {
      const result = await request();
      if (!isCurrent()) return null;
      const status = parseConnectStatus(result);
      if (!status) throw new Error();
      setStripeMethodsInfo(connectStatusKey(status));
      return status;
    };

    try {
      const status = await readStatus();
      if (!isCurrent() || !status?.enabled) return;
      const result = await request(true);
      if (!isCurrent()) return;
      if (!result || typeof result !== 'object') throw new Error('connect.failed');
      const url = parseConnectOnboardingUrl(result, status.accountId);
      if (!url) {
        throw new Error(connectErrorKey(result) === 'connect.failed' ? 'connect.linkInvalid' : connectErrorKey(result));
      }
      // openBrowserAsync abre Stripe en el navegador del móvil (flujo fiable en Android).
      await WebBrowser.openBrowserAsync(url, { enableDefaultShareMenuItem: false });
      if (isCurrent()) {
        setStripeMethodsInfo('');
        try {
          await readStatus();
        } catch {
          // El alta puede seguir pendiente tras volver; no marcar error si Stripe ya se abrió.
          if (isCurrent()) setStripeMethodsInfo('connect.pending');
        }
      }
    } catch (error) {
      if (isCurrent()) setStripeMethodsError(error instanceof Error &&
        ['connect.countryRequiresSupport', 'connect.countryNotApproved', 'connect.countryMismatch',
          'connect.notConnected', 'connect.chargesNotEnabled', 'connect.linkInvalid', 'connect.upstream',
          'connect.sessionRequired', 'connect.chooseCountry', 'connect.principalOnly'].includes(error.message)
        ? error.message : 'connect.failed');
    } finally {
      if (isCurrent()) {
        stripeConnectBusyRef.current = null;
        setStripeAccountLoading(false);
      }
    }
  };

    const pickExpenseImage = async (useCamera: boolean) => {
    if (useCamera) {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Permiso denegado', 'Se requiere acceso a la cámara para fotografiar el gasto.');
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        allowsEditing: true,
        quality: 0.7,
      });
      if (!result.canceled && result.assets[0].uri) {
        setExpenseImageUri(result.assets[0].uri);
      }
    } else {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Permiso denegado', 'Se requiere acceso a la galería.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        quality: 0.7,
      });
      if (!result.canceled && result.assets[0].uri) {
        setExpenseImageUri(result.assets[0].uri);
      }
    }
  };

  const saveExpense = () => {
    if (!requireSubscription('guardar gastos')) return;
    const cleanProvider = expenseProvider.trim();
    const parsedAmount = parseFloat(expenseAmountInput.replace(',', '.'));

    if (!cleanProvider) {
      Alert.alert(tr('validation.error'), tr('validation.provider'));
      return;
    }
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      Alert.alert(tr('validation.error'), tr('validation.amount'));
      return;
    }
    if (!expenseImageUri) {
      Alert.alert(tr('validation.error'), tr('validation.photo'));
      return;
    }

    const randomSuffix = Math.random().toString(36).slice(2, 6).toUpperCase();
    const newExpense: Expense = {
      id: `${Date.now()}-${randomSuffix}`,
      expenseCode: `GAST-${Date.now().toString().slice(-6)}-${randomSuffix}`,
      provider: cleanProvider,
      amount: parsedAmount,
      imageUri: expenseImageUri,
      createdAt: new Date().toISOString(),
      issuer: { ...issuer },
    };

    setExpenses((current) => [newExpense, ...current]);
    setExpenseProvider('');
    setExpenseAmountInput('');
    setExpenseImageUri(null);
    Alert.alert(tr('expense.save'), tr('expense.saved'));
  
    // Copia del gasto a la nube (mejor esfuerzo) para poder recuperarlo al sincronizar.
    void uploadExpensesToCloud([newExpense]).catch((error) =>
      console.warn('No se pudo guardar el gasto en la nube:', error)
    );
  };

  // Sube gastos locales a la nube para que se puedan recuperar tras borrar datos o cambiar de movil.
  const uploadExpensesToCloud = async (list: Expense[]): Promise<void> => {
    if (!isLoaded || !storageScope || loadedScopeRef.current !== storageScope || storageScopeRef.current !== storageScope) return;
    const generation = cacheGenerationRef.current;
    if (list.length === 0 || !accessToken || DOCUMENT_API_URL_CANDIDATES.length === 0) return;
    // El gasto se sube con un token vigente para que quede asociado a la cuenta del usuario.
    const authToken = await ensureFreshAccessToken();
    if (cacheGenerationRef.current !== generation) return;
    if (!authToken) {
      throw new Error('La sesión ha caducado. Vuelve a iniciar sesión para guardar el gasto en la nube.');
    }
    const response = await fetchWithTimeout(DOCUMENT_API_URL_CANDIDATES[0] + '/api/expenses/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + authToken,
      },
      body: JSON.stringify({
        expenses: list.map((gasto) => ({
          id: gasto.id,
          description: gasto.provider,
          amount: gasto.amount,
          date: gasto.createdAt,
          category: 'Gasto',
        })),
      }),
    }, 15000);
    if (!response.ok) {
      const result = await response.json().catch(() => ({}) as { error?: string });
      throw new Error(result.error || 'HTTP ' + response.status);
    }
  };

  // Recupera de la nube todo el historial del usuario (tickets, facturas y gastos) y lo restaura
  // en la app. Pensado para: datos borrados, movil nuevo o averia.
  const mergeCloudTransactions = (current: Transaction[], cloud: Transaction[]): Transaction[] => {
    const latest = new Map<string, Transaction>();
    for (const document of cloud) {
      const previous = latest.get(document.id);
      if (!previous || (document.refundHistory?.length ?? 0) > (previous.refundHistory?.length ?? 0)) latest.set(document.id, document);
    }
    const keys = new Set(current.flatMap((document) => [document.id, document.ticketCode]));
    const merged = current.map((document) => {
      const revision = latest.get(document.id);
      if (!document.publicUrl || !revision || (document.refundHistory?.length ?? 0) > (revision.refundHistory?.length ?? 0)) return document;
      return revision;
    });
    const additions = [...latest.values()].filter((document) => {
      if (keys.has(document.id) || keys.has(document.ticketCode)) return false;
      keys.add(document.id);
      keys.add(document.ticketCode);
      return true;
    });
    return [...additions, ...merged];
  };

  const syncHistoryFromCloud = async (options?: { silent?: boolean }) => {
    if (!isLoaded || !storageScope || loadedScopeRef.current !== storageScope || storageScopeRef.current !== storageScope) return;
    const generation = cacheGenerationRef.current;
    // Modo silencioso: lo usa la sincronización automática del arranque, que no debe mostrar avisos
    // de "no hay historial" ni errores en pantalla (sí en la consola).
    const silent = options?.silent === true;
    if (syncHistoryLoading) return;
    if (!accessToken) {
      setSyncHistoryMessage('');
      if (!silent) setSyncHistoryError(tr('sync.login'));
      return;
    }
    if (DOCUMENT_API_URL_CANDIDATES.length === 0) {
      setSyncHistoryMessage('');
      if (!silent) setSyncHistoryError('No hay una URL de backend configurada en la aplicacion.');
      return;
    }

    setSyncHistoryLoading(true);
    setSyncHistoryError('');
    setSyncHistoryMessage('');

    try {
      // 1) Subir los gastos locales para que queden a salvo en la nube (si falla, se continua).
      try {
        await uploadExpensesToCloud(expenses);
      } catch (uploadError) {
        console.warn('No se pudieron subir los gastos locales antes de sincronizar:', uploadError);
      }

      // 2) Descargar todo el historial del usuario (documentos + gastos) en una sola llamada.
      // Se renueva la sesión si hace falta: con un token caducado el servidor respondería 401.
      const authToken = await ensureFreshAccessToken();
      if (cacheGenerationRef.current !== generation) return;
      if (!authToken) {
        if (!silent) setSyncHistoryError(tr('sync.login'));
        return;
      }
      const response = await fetchWithTimeout(DOCUMENT_API_URL_CANDIDATES[0] + '/api/documents/sync-all?limit=500', {
        headers: { Authorization: 'Bearer ' + authToken },
      }, 30000);
      const result = await response.json() as SyncAllResult;
      if (cacheGenerationRef.current !== generation) return;
      if (!response.ok || !result.ok) {
        throw new Error(result.error || 'HTTP ' + response.status);
      }

      // 3) Restaurar tickets/facturas sin duplicar (se comparan por id y codigo de ticket).
      const restoredDocs = (Array.isArray(result.documents) ? result.documents : [])
        .filter((doc) => doc && doc.id && doc.ticketCode)
        .map((doc) => ({
          ...(doc as Record<string, unknown>),
          id: String(doc.id),
          ticketCode: String(doc.ticketCode),
          publicUrl: doc.publicUrl,
          createdAt: doc.createdAt,
        }) as unknown as Transaction);
      // El recuento se calcula fuera del setState: si se calcula dentro, el aviso podría decir
      // "todavía no hay historial" aunque los tickets sí se hayan recuperado.
      const mergedDocs = mergeCloudTransactions(transactions, restoredDocs);
      const restoredDocsCount = mergedDocs.filter((document) => {
        const previous = transactions.find((item) => item.id === document.id);
        return !previous || JSON.stringify(previous) !== JSON.stringify(document);
      }).length;
      setTransactions((current) => cacheGenerationRef.current === generation ? mergeCloudTransactions(current, restoredDocs) : current);
      setSelectedTicket((current) => current && cacheGenerationRef.current === generation
        ? mergeCloudTransactions([current], restoredDocs).find((document) => document.id === current.id) ?? current
        : current);

      // 4) Restaurar gastos (los datos si; la foto no se sube a la nube).
      const restoredExpenses = (Array.isArray(result.expenses) ? result.expenses : [])
        .filter((row) => row && row.local_id)
        .map((row) => ({
          id: String(row.local_id),
          expenseCode: 'GAST-' + (String(row.local_id).replace(/[^A-Za-z0-9]/g, '').slice(-6).toUpperCase() || 'SYNC'),
          provider: row.description || 'Gasto',
          amount: Number(row.amount) || 0,
          imageUri: '',
          createdAt: row.date || row.synced_at || new Date().toISOString(),
          issuer: { ...issuer },
        }) as Expense);
      const existingExpenseIds = new Set(expenses.map((item) => item.id));
      const restoredExpensesToAdd = restoredExpenses.filter((item) => {
        // Igual que con los tickets: un gasto repetido en la nube no se duplica en la app.
        if (existingExpenseIds.has(item.id)) return false;
        existingExpenseIds.add(item.id);
        return true;
      });
      const restoredExpensesCount = restoredExpensesToAdd.length;
      if (restoredExpensesToAdd.length > 0) {
        setExpenses((current) => {
          const currentIds = new Set(current.map((item) => item.id));
          const additions = restoredExpensesToAdd.filter((item) => !currentIds.has(item.id));
          return [...additions, ...current];
        });
      }

      if (restoredDocsCount === 0 && restoredExpensesCount === 0) {
        // En modo silencioso (sincronización automática al abrir) no se avisa de que no hay nada.
        if (!silent) setSyncHistoryMessage(tr('sync.empty'));
      } else {
        setSyncHistoryMessage(
          tr('sync.done').replace('{docs}', String(restoredDocsCount)).replace('{gastos}', String(restoredExpensesCount)),
        );
      }
    } catch (error) {
      if (cacheGenerationRef.current !== generation) return;
      if (silent) {
        console.warn('No se pudo sincronizar el historial automaticamente:', error);
      } else {
        setSyncHistoryError(error instanceof Error ? error.message : tr('sync.error'));
      }
    } finally {
      if (cacheGenerationRef.current === generation) setSyncHistoryLoading(false);
    }
  };

  // Sincronización automática: al abrir la app con una cuenta cuya suscripción está activa se
  // recupera el historial de la nube (tickets, facturas y gastos) sin pulsar el botón.
  useEffect(() => {
    if (!isLoaded || !accessToken || !hasActiveSubscription || !storageScope || loadedScopeRef.current !== storageScope || storageScopeRef.current !== storageScope) return;
    if (autoSyncDoneRef.current) return;
    autoSyncDoneRef.current = true;
    void syncHistoryFromCloudRef.current({ silent: true });
  }, [isLoaded, accessToken, hasActiveSubscription, storageScope]);
  useEffect(() => {
    if (!isLoaded || !accessToken || !hasActiveSubscription || !storageScope) return;
    const refreshHistory = () => {
      if (AppState.currentState === 'active') void syncHistoryFromCloudRef.current({ silent: true });
    };
    const interval = setInterval(refreshHistory, 60000);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshHistory();
    });
    return () => {
      clearInterval(interval);
      subscription.remove();
    };
  }, [isLoaded, accessToken, hasActiveSubscription, storageScope]);
  syncHistoryFromCloudRef.current = syncHistoryFromCloud;
  refreshUserSessionRef.current = refreshUserSession;
  activateAccountCacheRef.current = activateAccountCache;
  clearStoredSessionRef.current = clearStoredSession;

  const generateExpensePdfUri = async (expense: Expense): Promise<string> => {
    const filename = buildPdfFilename([tr('expense.detail'), expense.expenseCode]);
    const expenseImageBase64 = await convertImageToBase64(expense.imageUri);
    if (!expenseImageBase64) {
      throw new Error('No se pudo convertir la foto del gasto para el PDF.');
    }

    let expenseLogo = '';
    if (expense.issuer?.logoUri) {
      try {
        expenseLogo = await convertImageToBase64(expense.issuer.logoUri);
      } catch {
        expenseLogo = '';
      }
    }
    const expenseIssuer = expense.issuer ? renderIssuerBlock(expense.issuer, expenseLogo, true) : { topHtml: '', bottomHtml: '' };

    const htmlContent = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <style>
            @page { size: A4; margin: 20px; }
            body { font-family: 'Courier New', Courier, monospace; background-color: #ffffff; color: #000000; margin: 0; padding: 0; }
            .container { width: 600px; max-width: 600px; margin: 0 auto; background: #fff; padding: 20px; border: 1px solid #cbd5e1; }
            .center { text-align: center; }
            .bold { font-weight: bold; }
            .title { font-size: 16px; font-weight: bold; margin-bottom: 4px; }
            .subtitle { font-size: 11px; margin-bottom: 3px; color: #334155; }
            .divider { border-top: 1px dashed #000; margin: 10px 0; }
            .row { display: flex; justify-content: space-between; font-size: 12px; margin: 5px 0; }
            .total-row { display: flex; justify-content: space-between; font-size: 14px; font-weight: bold; margin-top: 8px; border-top: 1px dashed #000; padding-top: 6px; }
            .img-container { text-align: center; margin-top: 15px; }
            .expense-img { max-width: 100%; max-height: 450px; object-fit: contain; border: 1px solid #94a3b8; }
          </style>
        </head>
        <body>
          <div class="container">
            ${expenseIssuer.topHtml}
            <div class="center title">COMPROBANTE DE GASTO</div>
            <div class="center subtitle">Ref: ${expense.expenseCode}</div>
            <div class="divider"></div>
            <div class="row">
              <span class="bold">Proveedor:</span>
              <span>${expense.provider}</span>
            </div>
            <div class="row">
              <span class="bold">Fecha de Registro:</span>
              <span>${formatDate(expense.createdAt)}</span>
            </div>
            <div class="total-row">
              <span>IMPORTE DEL GASTO</span>
              <span>${formatCurrency(expense.amount)}</span>
            </div>
            <div class="divider"></div>
            <div class="center subtitle bold">FOTO / TICKET ORIGINAL:</div>
            <div class="img-container">
              <img src="${expenseImageBase64}" class="expense-img" />
            </div>
            ${expenseIssuer.bottomHtml}
          </div>
        </body>
      </html>
    `;
    const { uri } = await Print.printToFileAsync({ html: htmlContent, width: 595.28, height: 841.89, margins: { top: 15, bottom: 15, left: 15, right: 15 } });
    return copyPdfForExport(uri, filename);
  };

  const generateAndShareExpensePdf = async (expense: Expense) => {
    try {
      const uri = await generateExpensePdfUri(expense);
      await Sharing.shareAsync(uri, { UTI: '.pdf', mimeType: 'application/pdf' });
    } catch {
      Alert.alert('Error', 'No se pudo generar el PDF del gasto.');
    }
  };

  const sendPresupuestoByEmail = async () => {
    if (!requireSubscription('enviar presupuestos o facturas')) return;
    const validClient = Object.fromEntries(Object.entries(presupuestoClient).map(([key, value]) => [key, value.trim()])) as Client;
    if (!validClient.name || !validClient.nif || !validClient.address) {
      Alert.alert(tr('validation.error'), tr('validation.client'));
      return;
    }
    if (!presupuestoClientEmail.trim()) {
      Alert.alert(tr('validation.error'), tr('validation.email'));
      return;
    }

    const validItems = presupuestoItems
      .map(i => ({ ...i, description: i.description.trim(), price: i.price.trim() }))
      .filter(i => i.description !== '' && i.price !== '');

    if (validItems.length === 0) {
      Alert.alert(tr('validation.error'), tr('validation.items'));
      return;
    }

    const subtotal = validItems.reduce((acc, item) => acc + (parseFloat(item.price.replace(',', '.')) || 0), 0);
    const parsedIva = parseFloat(presupuestoIvaInput.replace(',', '.')) || 21;
    const totalWithIva = subtotal * (1 + (parsedIva / 100));

    try {
      const isAvailable = await MailComposer.isAvailableAsync();
      if (!isAvailable) {
        Alert.alert(tr('validation.error'), tr('validation.mailUnavailable'));
        return;
      }

      const ticketCode = `${presupuestoDocumentType === 'FACTURA' ? 'FAC' : 'PRES'}-${Date.now().toString().slice(-6)}`;
      const createdAt = new Date().toISOString();
      const tempPresupuestoTransaction: Transaction = {
        id: `pres-${Date.now()}`,
        ticketCode,
        type: 'COBRO',
        documentType: presupuestoDocumentType,
        amount: totalWithIva,
        subtotal: subtotal,
        iva: totalWithIva - subtotal,
        ivaRateApplied: parsedIva,
        createdAt,
        method: presupuestoDocumentType === 'FACTURA' ? 'Factura' : 'Presupuesto',
        issuer: { ...issuer },
        client: validClient,
        items: validItems,
        isRefunded: false,
        refundHistory: [],
      };

      const publishedDocument = await registerTransactionDocument(tempPresupuestoTransaction);

      if (presupuestoDocumentType === 'FACTURA') {
        setCashInvoiceDrafts((current) => [publishedDocument as CashInvoiceDraft, ...current]);
      }

      const pdfUri = await generatePdfFileUri(publishedDocument);

      const result = await MailComposer.composeAsync({
        recipients: [presupuestoClientEmail.trim()],
        subject: `${presupuestoDocumentType === 'FACTURA' ? 'Factura' : 'Presupuesto'} de Servicios - Ref: ${publishedDocument.ticketCode} (${issuer.name})`,
        body: `Estimado/a ${validClient.name},\n\nAdjunto le hacemos llegar la ${presupuestoDocumentType === 'FACTURA' ? 'factura' : 'presupuesto'} solicitada con importe total de ${formatCurrency(totalWithIva)}.\n\nAtentamente,\n${issuer.name}`,
        attachments: [pdfUri],
      });

      if (result.status === MailComposer.MailComposerStatus.SENT || result.status === MailComposer.MailComposerStatus.SAVED) {
        resetQuoteForm();
      }
    } catch {
      Alert.alert(tr('validation.error'), tr('quote.sendFailed'));
    }
  };

  const markCashInvoiceAsPaid = async (draft: CashInvoiceDraft) => {
    const createdAt = new Date().toISOString();
    const paidTransaction: Transaction = {
      ...draft,
      createdAt,
      method: 'Efectivo',
      publicUrl: undefined,
    };

    setCashInvoiceDrafts((current) => current.filter((item) => item.id !== draft.id));
    setTransactions((current) => [paidTransaction, ...current]);
    setSelectedTicket(paidTransaction);

    const publishedTransaction = await registerTransactionDocument(paidTransaction);
    setTransactions((current) => current.map((item) =>
      item.id === publishedTransaction.id ? publishedTransaction : item
    ));
    setSelectedTicket(publishedTransaction);
    resetQuoteForm();
    Alert.alert(documentTypeLabel('FACTURA'), tr('cash.saved'));
  };

  const deleteCashInvoiceDraft = (draft: CashInvoiceDraft) => {
    Alert.alert(
      tr('workflow.delete'),
      tr('cash.deleteConfirm').replace('{code}', draft.ticketCode),
      [
        { text: tr('common.cancel'), style: 'cancel' },
        { text: tr('workflow.delete'), style: 'destructive', onPress: () => setCashInvoiceDrafts((current) => current.filter((item) => item.id !== draft.id)) },
      ],
    );
  };

  const saveLogoToStorage = async (tempUri: string): Promise<string> => {
    try {
      console.log('💾 Guardando logo en almacenamiento...');
      
      // Leer imagen como base64 inmediatamente
      const base64String = await FileSystemLegacy.readAsStringAsync(tempUri, { encoding: 'base64' });
      if (!base64String) {
        console.log('❌ No se pudo leer la imagen');
        return tempUri;
      }
      
      // Detectar extensión
      const extension = tempUri.toLowerCase().split('?')[0].split('.').pop() || 'jpeg';
      const mimeType = extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : extension === 'gif' ? 'image/gif' : 'image/jpeg';
      
      // Crear data URL
      const dataUrl = `data:${mimeType};base64,${base64String}`;
      console.log('✅ Logo convertido a base64, longitud:', dataUrl.length);
      
      return dataUrl;
    } catch (error) {
      console.log('❌ Error al guardar logo:', error);
      return tempUri;
    }
  };

  const pickLogoImage = async () => {
    const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permissionResult.granted) {
      Alert.alert('Permiso denegado', 'Se requiere acceso a la galería para seleccionar el logotipo.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: false,
      quality: 0.7,
    });

    if (!result.canceled && result.assets[0].uri) {
      const permanentUri = await saveLogoToStorage(result.assets[0].uri);
      setIssuer((current) => ({ ...current, logoUri: permanentUri }));
      Alert.alert('✅ Logotipo actualizado', 'El logotipo se ha guardado correctamente.');
    }
  };

  const captureLogoWithCamera = async () => {
    const permissionResult = await Camera.requestCameraPermissionsAsync();
    if (!permissionResult.granted) {
      Alert.alert('Permiso denegado', 'Se requiere acceso a la cámara para capturar el logotipo.');
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: false,
      quality: 0.7,
    });

    if (!result.canceled && result.assets[0].uri) {
      const permanentUri = await saveLogoToStorage(result.assets[0].uri);
      setIssuer((current) => ({ ...current, logoUri: permanentUri }));
      Alert.alert('✅ Foto capturada', 'El logotipo se ha guardado correctamente.');
    }
  };

  const removeLogo = () => {
    Alert.alert(
      'Eliminar Logotipo',
      '¿Estás seguro de que quieres eliminar el logotipo actual?',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Eliminar',
          style: 'destructive',
          onPress: () => {
            setIssuer((current) => ({ ...current, logoUri: undefined }));
            Alert.alert('✅ Logotipo eliminado', 'El logotipo ha sido eliminado correctamente.');
          },
        },
      ]
    );
  };

  const convertImageToBase64 = async (imageUri: string): Promise<string> => {
    try {
      if (!imageUri) {
        console.log('❌ ImageUri vacío');
        return '';
      }
      
      // Si ya es un data URL, retornarlo directamente
      if (imageUri.startsWith('data:')) {
        console.log('✅ Ya es data URL, longitud:', imageUri.length);
        return imageUri;
      }
      
      console.log('📸 Intentando leer imagen desde URI:', imageUri);
      
      // Verificar que el archivo existe
      const fileInfo = await FileSystemLegacy.getInfoAsync(imageUri);
      if (!fileInfo.exists) {
        console.log('❌ Archivo no existe');
        return '';
      }
      
      console.log('✅ Archivo existe');
      
      // Detectar el tipo de imagen para que expo-print pueda incrustarla.
      const extension = imageUri.toLowerCase().split('?')[0].split('.').pop() || 'jpeg';
      const mimeType = extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : extension === 'gif' ? 'image/gif' : 'image/jpeg';
      
      // Leer como base64
      const base64String = await FileSystemLegacy.readAsStringAsync(imageUri, { encoding: 'base64' });
      if (!base64String) {
        console.log('❌ Base64 vacío');
        return '';
      }
      
      const result = `data:${mimeType};base64,${base64String}`;
      console.log('✅ Base64 leído correctamente, longitud:', result.length);
      return result;
    } catch (error) {
      console.log('❌ Error en convertImageToBase64:', error);
      return '';
    }
  };

  const applyRefundToTicket = async (targetTicket: Transaction, refundVal: number, pin?: string): Promise<boolean> => {
    if (!isLoaded || !storageScope || loadedScopeRef.current !== storageScope || storageScopeRef.current !== storageScope) return false;
    if (refundBusyRef.current) return false;
    if (!Number.isFinite(refundVal) || refundVal <= 0) {
      Alert.alert('Importe inválido', 'Introduce un importe positivo para devolver.');
      return false;
    }
    if (userRole === 'empleado' && (typeof pin !== 'string' || !pin.trim())) {
      setPendingRefund({ ticket: targetTicket, amount: refundVal });
      setOwnerPinInput('');
      setPinModalVisible(true);
      return false;
    }

    if (targetTicket.type !== 'COBRO') {
      Alert.alert('Acción no permitida', 'Solo se pueden realizar devoluciones sobre tickets de cobro originales.');
      return false;
    }
    if (targetTicket.isRefunded || targetTicket.amount <= 0) {
      Alert.alert('⚠️ Devolución bloqueada', `El ticket ${targetTicket.ticketCode} ya no tiene saldo disponible.`);
      return false;
    }

    if (refundVal > targetTicket.amount) {
      Alert.alert('Importe excedido', `El importe a devolver no puede superar el saldo actual del ticket (${formatCurrency(targetTicket.amount)}).`);
      return false;
    }
    const generation = cacheGenerationRef.current;
    refundBusyRef.current = true;
    try {
      if (!accessToken || !configuredDocumentApiUrl) throw new Error('Inicia sesión y conecta con el servidor para devolver.');
      const authToken = await ensureFreshAccessToken();
      if (cacheGenerationRef.current !== generation) return false;
      if (!authToken) throw new Error('La sesión ha caducado. Vuelve a iniciar sesión.');
      const hasPreviousRefunds = Boolean(targetTicket.refundHistory?.length || targetTicket.documentType === 'COMPRA/DEVOLUCIONES');
      const original = targetTicket.publicUrl || hasPreviousRefunds ? targetTicket : await registerTransactionDocument(targetTicket);
      if (cacheGenerationRef.current !== generation) return false;
      if (!original.publicUrl && !hasPreviousRefunds) throw new Error('No se pudo publicar el ticket original. Reintenta la devolución.');
      const response = await fetchWithTimeout(`${configuredDocumentApiUrl}/api/documents/refund`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ documentId: original.id, amount: refundVal, ...(userRole === 'empleado' ? { pin: pin?.trim() } : {}) }),
      }, 15000);
      const result = await response.json() as { ok?: boolean; document?: Transaction; error?: string };
      if (cacheGenerationRef.current !== generation) return false;
      if (!response.ok || !result.ok || !result.document || result.document.id !== targetTicket.id || !result.document.publicUrl || !Number.isFinite(result.document.amount)) {
        throw new Error(result.error || 'El servidor no confirmó la devolución.');
      }
      const updatedTicket = result.document;
      setTransactions((current) => current.map((transaction) => transaction.id === targetTicket.id ? updatedTicket : transaction));
      setSelectedTicket(updatedTicket);
      return true;
    } catch (error) {
      if (cacheGenerationRef.current === generation) Alert.alert('Devolución no realizada', error instanceof Error ? error.message : 'No se pudo conectar con el servidor.');
      return false;
    } finally {
      if (cacheGenerationRef.current === generation) refundBusyRef.current = false;
    }
  };

  const confirmRefundPin = async () => {
    const refund = pendingRefund;
    const pin = ownerPinInput.trim();
    const generation = cacheGenerationRef.current;
    if (!refund || refundBusyRef.current) return;
    if (!/^\d{4,6}$/.test(pin)) {
      Alert.alert('PIN inválido', 'El PIN debe tener entre 4 y 6 dígitos.');
      return;
    }
    if (await applyRefundToTicket(refund.ticket, refund.amount, pin) && cacheGenerationRef.current === generation) {
      setPinModalVisible(false);
      setPendingRefund(null);
      setOwnerPinInput('');
    }
  };

  const handleSetupOwnerPin = async () => {
    const generation = cacheGenerationRef.current;
    const trimmedNew = ownerPinSetupNew.trim();
    const trimmedConfirm = ownerPinSetupConfirm.trim();

    if (!/^\d{4,6}$/.test(trimmedNew)) {
      Alert.alert('PIN inválido', 'El PIN debe tener entre 4 y 6 dígitos.');
      return;
    }

    if (trimmedNew !== trimmedConfirm) {
      Alert.alert('PIN no coincide', 'La confirmación del PIN no coincide.');
      return;
    }

    if (!await saveCompanyPin(trimmedNew) || cacheGenerationRef.current !== generation) return;
    setOwnerPinSetupNew('');
    setOwnerPinSetupConfirm('');
    Alert.alert('PIN guardado', 'Tu PIN principal se ha configurado correctamente.');
  };

  const handleChangeOwnerPin = async () => {
    const generation = cacheGenerationRef.current;
    const current = ownerPinChangeCurrent.trim();
    const next = ownerPinChangeNew.trim();
    const confirm = ownerPinChangeConfirm.trim();

    if (!/^\d{4,6}$/.test(current)) {
      Alert.alert('PIN inválido', 'El PIN actual debe tener entre 4 y 6 dígitos.');
      return;
    }

    if (!/^\d{4,6}$/.test(next)) {
      Alert.alert('PIN inválido', 'El nuevo PIN debe tener entre 4 y 6 dígitos.');
      return;
    }

    if (next !== confirm) {
      Alert.alert('PIN no coincide', 'La confirmación del nuevo PIN no coincide.');
      return;
    }

    if (!await saveCompanyPin(next, current) || cacheGenerationRef.current !== generation) return;
    setOwnerPinChangeCurrent('');
    setOwnerPinChangeNew('');
    setOwnerPinChangeConfirm('');
    Alert.alert('PIN actualizado', 'Tu PIN principal se ha actualizado correctamente.');
  };

  const handleRecoveryRequest = () => {
    const email = ownerRecoveryEmail.trim();
    const phone = ownerRecoveryPhone.trim();

    if (!email && !phone) {
      Alert.alert('Datos requeridos', 'Introduce al menos un email o un teléfono para recuperar el acceso.');
      return;
    }

    const recoveryCode = Math.floor(100000 + Math.random() * 900000).toString();
    setOwnerRecoveryCode(recoveryCode);
    Alert.alert(
      'Código de recuperación',
      `Se ha generado un código temporal para recuperación: ${recoveryCode}. En una versión con backend real, este código se enviaría por email o SMS.`
    );
  };

  const handleBarCodeScanned = async ({ data }: { data: string }) => {
    if (scanned) return;
    setScanned(true);
    setScannerModalVisible(false);
    setTimeout(() => setScanned(false), 1200);

    let scannedValue = data.trim();

    const normalizedScannedValue = scannedValue.toLocaleLowerCase('es-ES');
    const scannedDocumentToken = scannedValue.match(/\/documents\/([a-f0-9]+)\/?$/i)?.[1]?.toLowerCase();
    const localMatch = transactions.find((transaction) => {
      const sameTicketCode = transaction.ticketCode.toLocaleLowerCase('es-ES') === normalizedScannedValue;
      const transactionToken = transaction.publicUrl?.match(/\/documents\/([a-f0-9]+)\/?$/i)?.[1]?.toLowerCase();
      const sameDocumentToken = Boolean(scannedDocumentToken && transactionToken && scannedDocumentToken === transactionToken);

      return sameTicketCode || sameDocumentToken;
    });

    if (localMatch) {
      if (localMatch.type === 'DEVOLUCIÓN') {
        Alert.alert('Aviso', 'Este documento es un ticket de devolución/abono.');
        setSelectedTicket(localMatch);
        return;
      }

      if (localMatch.isRefunded || localMatch.amount <= 0) {
        Alert.alert('Ticket completado', `El ticket ${localMatch.ticketCode} ya no tiene saldo disponible.`);
        setSelectedTicket(localMatch);
        return;
      }

      Alert.alert(
        '🎟️ Ticket Localizado',
        `Ref: ${localMatch.ticketCode}\nSaldo Actual Disponible: ${formatCurrency(localMatch.amount)}\nCliente: ${localMatch.client?.name || 'General'}\n\nSelecciona la gestión de devolución:`,
        [
          { text: '🔄 Devolución Total del Saldo', style: 'destructive', onPress: () => applyRefundToTicket(localMatch, localMatch.amount) },
          { text: '✂️ Devolución Parcial (Importe)', onPress: () => {
              setTicketToPartialRefund(localMatch);
              setPartialAmountInput('');
              setPartialRefundModalVisible(true);
            }
          },
          { text: '📁 Ver Detalle', onPress: () => setSelectedTicket(localMatch) },
          { text: 'Cancelar', style: 'cancel' }
        ]
      );
      return;
    }

    const documentUrlMatch = scannedValue.match(/^(https?:\/\/[^\s]+\/documents\/([a-f0-9]+))\/?$/i);

    if (documentUrlMatch) {
      const documentToken = documentUrlMatch[2];
      const lookupCandidates = Array.from(new Set([
        `${documentUrlMatch[1].replace(/\/documents\//i, '/api/documents/')}`,
        ...DOCUMENT_API_URL_CANDIDATES.map((baseUrl) => `${baseUrl}/api/documents/${documentToken}`),
      ]));

      try {
        await Promise.any(
          lookupCandidates.map(async (candidateUrl) => {
            const response = await fetchWithTimeout(candidateUrl, {}, 900);
            if (!response.ok) {
              throw new Error(`HTTP ${response.status}`);
            }

            const result = await response.json() as { document?: { ticketCode?: string } };
            if (!result.document?.ticketCode) {
              throw new Error('Documento sin ticketCode');
            }

            scannedValue = result.document.ticketCode;
            return result;
          })
        );
      } catch {
        Alert.alert('Backend no disponible', 'No se pudo consultar el ticket escaneado. Comprueba que el backend esté encendido y conectado a la misma red.');
        return;
      }
    }

    const query = scannedValue.toLocaleLowerCase('es-ES');
    const match = transactions.find((transaction) => transaction.ticketCode.toLocaleLowerCase('es-ES') === query);

    if (match) {
      if (match.type === 'DEVOLUCIÓN') {
        Alert.alert('Aviso', 'Este documento es un ticket de devolución/abono.');
        setSelectedTicket(match);
        return;
      }

      if (match.isRefunded || match.amount <= 0) {
        Alert.alert('Ticket completado', `El ticket ${match.ticketCode} ya no tiene saldo disponible.`);
        setSelectedTicket(match);
        return;
      }

      Alert.alert(
        '🎟️ Ticket Localizado',
        `Ref: ${match.ticketCode}\nSaldo Actual Disponible: ${formatCurrency(match.amount)}\nCliente: ${match.client?.name || 'General'}\n\nSelecciona la gestión de devolución:`,
        [
          { text: '🔄 Devolución Total del Saldo', style: 'destructive', onPress: () => applyRefundToTicket(match, match.amount) },
          { text: '✂️ Devolución Parcial (Importe)', onPress: () => {
              setTicketToPartialRefund(match);
              setPartialAmountInput('');
              setPartialRefundModalVisible(true);
            } 
          },
          { text: '📁 Ver Detalle', onPress: () => setSelectedTicket(match) },
          { text: 'Cancelar', style: 'cancel' }
        ]
      );
    } else {
      Alert.alert('No encontrado', `No se encontró ningún ticket con el código: ${scannedValue}`);
    }
  };

  const getTransactionQrContent = (transaction: Transaction): string | null => {
    return transaction.publicUrl || null;
  };

  const getTransactionQrUrl = (transaction: Transaction, size = 180): string | null => {
    const content = getTransactionQrContent(transaction);
    if (!content) return null;
    return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(content)}`;
  };

  const generatePdfFileUri = async (transaction: Transaction): Promise<string> => {
    const filename = buildPdfFilename([documentTypeLabel(transaction.documentType), transaction.ticketCode]);
    const qrApiUrl = getTransactionQrUrl(transaction, 140);
    const isA4 = transaction.documentType === 'FACTURA COMPLETA' ||
      transaction.documentType === 'FACTURA' ||
      transaction.documentType === 'PRESUPUESTO';

    let logoDataURL = '';
    if (transaction.issuer.logoUri) {
      console.log('🖼️ Procesando logo para PDF...');
      try {
        const base64Logo = await convertImageToBase64(transaction.issuer.logoUri);
        if (base64Logo && base64Logo.length > 50) {
          console.log('✅ Logo convertido correctamente');
          logoDataURL = base64Logo;
        } else {
          console.log('❌ Logo base64 no válido, longitud:', base64Logo?.length || 0);
        }
      } catch (logoError) {
        console.log('❌ Error procesando logo:', logoError);
      }
    }
    const documentLogo = renderIssuerBlock(transaction.issuer, logoDataURL, isA4);

    const clientHtml = transaction.client ? `
      <div style="margin-top: 10px; border-top: 1px dashed #000; padding-top: 8px;">
        <div style="font-weight: bold; font-size: 11px;">DATOS DEL CLIENTE:</div>
        <div style="font-size: 10px;">${transaction.client.name}</div>
        <div style="font-size: 10px;">NIF/CIF: ${transaction.client.nif}</div>
        <div style="font-size: 10px;">${transaction.client.address}</div>
      </div>
    ` : '';

    const itemsHtml = transaction.items && transaction.items.length > 0 ? `
      <div style="margin-top: 10px; border-top: 1px dashed #000; padding-top: 8px;">
        <div style="font-weight: bold; font-size: 11px; margin-bottom: 6px;">PRODUCTOS / SERVICIOS:</div>
        ${transaction.items.map(item => `
          <div style="display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 4px;">
            <span style="flex: 2; padding-right: 10px;">- ${item.description}</span>
            <span style="flex: 1; text-align: right; font-weight: bold;">${formatCurrency(parseFloat(item.price.replace(',', '.')) || 0)}</span>
          </div>
        `).join('')}
      </div>
    ` : '';

    const historyHtml = transaction.refundHistory && transaction.refundHistory.length > 0 ? `
      <div style="margin-top: 10px; border-top: 1px dashed #000; padding-top: 8px; font-size: 9px;">
        <div style="font-weight: bold;">HISTORIAL DE DEVOLUCIONES APLICADAS:</div>
        ${transaction.refundHistory.map(r => `<div>- Descontado: ${formatCurrency(r.amount)} (${formatDate(r.date)})</div>`).join('')}
      </div>
    ` : '';

    const refundSummaryHtml = transaction.refundHistory && transaction.refundHistory.length > 0 ? `
      <div class="subtitle">Importe original de la compra: <b>${formatCurrency(transaction.originalAmount ?? transaction.amount)}</b></div>
      <div class="subtitle">Total devuelto: <b>${formatCurrency(transaction.refundHistory.reduce((sum, refund) => sum + refund.amount, 0))}</b></div>
      <div class="subtitle">Saldo restante: <b>${formatCurrency(transaction.amount)}</b></div>
    ` : '';

    const qrSectionHtml = qrApiUrl
      ? `
        <div class="qr-section">
          <img src="${qrApiUrl}" class="qr-image" />
          <div class="qr-text">${transaction.ticketCode}</div>
        </div>
      `
      : '';

    const containerStyle = isA4
      ? 'width: 600px; max-width: 600px; background: #fff; padding: 20px; border: 1px solid #cbd5e1;'
      : 'width: 280px; background: #fff; padding: 12px; font-size: 11px;';

    const htmlContent = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <style>
            @page { size: A4; margin: 20px; }
            body { font-family: 'Courier New', Courier, monospace; background-color: #ffffff; color: #000000; margin: 0; padding: 0; }
            .container { ${containerStyle} margin: 0 auto; }
            .center { text-align: center; }
            .bold { font-weight: bold; }
            .title { font-size: ${isA4 ? '16px' : '13px'}; font-weight: bold; margin-bottom: 4px; }
            .subtitle { font-size: ${isA4 ? '11px' : '9px'}; margin-bottom: 3px; color: #334155; }
            .divider { border-top: 1px dashed #000; margin: 10px 0; }
            .row { display: flex; justify-content: space-between; font-size: ${isA4 ? '12px' : '10px'}; margin: 5px 0; }
            .total-row { display: flex; justify-content: space-between; font-size: ${isA4 ? '14px' : '12px'}; font-weight: bold; margin-top: 8px; border-top: 1px dashed #000; padding-top: 6px; }
            .qr-section { text-align: center; margin-top: 15px; padding-top: 10px; border-top: 1px dashed #000; }
            .qr-image { width: ${isA4 ? '110px' : '80px'}; height: ${isA4 ? '110px' : '80px'}; margin-bottom: 4px; }
            .qr-text { font-size: ${isA4 ? '11px' : '9px'}; font-weight: bold; }
          </style>
        </head>
        <body>
          <div class="container">
            ${documentLogo.topHtml}
            <div class="divider"></div>
            <div class="center bold" style="font-size: ${isA4 ? '14px' : '11px'}; margin-bottom: 6px;">${transaction.documentType}</div>
            <div class="subtitle">Ref: <b>${transaction.ticketCode}</b></div>
            <div class="subtitle">Fecha: ${formatDate(transaction.createdAt)}</div>
            ${transaction.relatedTicketCode ? `<div class="subtitle">Ticket original: <b>${transaction.relatedTicketCode}</b></div>` : ''}
            ${refundSummaryHtml}
            
            ${clientHtml}
            ${itemsHtml}
            ${historyHtml}

            <div class="divider"></div>
            <div class="row">
              <span>Base imponible actual</span>
              <span>${formatCurrency(transaction.subtotal)}</span>
            </div>
            <div class="row">
              <span>IVA (${transaction.ivaRateApplied}%)</span>
              <span>${formatCurrency(transaction.iva)}</span>
            </div>
            <div class="total-row">
              <span>${transaction.refundHistory && transaction.refundHistory.length > 0 ? 'SALDO RESTANTE' : 'TOTAL'}</span>
              <span>${formatCurrency(transaction.amount)}</span>
            </div>
            ${qrSectionHtml}
            ${documentLogo.bottomHtml}
          </div>
        </body>
      </html>
    `;

    const logoHtml = documentLogo.topHtml + documentLogo.bottomHtml;
    console.log('📄 HTML generado, Logo HTML incluido?', logoHtml.length > 0);
    if (logoHtml.length > 0) {
      console.log('   Logo HTML (primeros 100 caracteres):', logoHtml.substring(0, 100));
    }
    console.log('📄 Longitud total HTML:', htmlContent.length);

    const { uri } = await Print.printToFileAsync({ html: htmlContent, ...(isA4 ? { width: 595.28, height: 841.89, margins: { top: 15, bottom: 15, left: 15, right: 15 } } : {}) });
    console.log('✅ PDF generado:', uri);
    return copyPdfForExport(uri, filename);
  };

  const ensurePublishedTransaction = async (transaction: Transaction): Promise<Transaction> => {
    if (transaction.publicUrl) {
      return transaction;
    }

    return registerTransactionDocument(transaction);
  };

  const generateAndSharePdf = async (transaction: Transaction) => {
    try {
      console.log('📑 Iniciando generación de PDF...');
      const publishedTransaction = await ensurePublishedTransaction(transaction);
      console.log('   Logo URI:', publishedTransaction.issuer.logoUri ? 'Presente' : 'No hay');
      console.log('   Public URL:', publishedTransaction.publicUrl ? 'Disponible' : 'No disponible');
      const uri = await generatePdfFileUri(publishedTransaction);
      console.log('📄 PDF generado, compartiendo...');
      await Sharing.shareAsync(uri, { UTI: '.pdf', mimeType: 'application/pdf' });
      console.log('✅ PDF compartido exitosamente');
    } catch (error) {
      console.log('❌ Error en generateAndSharePdf:', error);
      Alert.alert('Error', `No se pudo generar el documento PDF: ${error instanceof Error ? error.message : 'Error desconocido'}`);
    }
  };

  const sendByEmail = async (transaction: Transaction) => {
    if (!requireSubscription('enviar documentos por correo')) return;
    try {
      const isAvailable = await MailComposer.isAvailableAsync();
      if (!isAvailable) {
        Alert.alert('Correo no disponible', 'Este dispositivo no tiene configurado un cliente de correo.');
        return;
      }

      const publishedTransaction = await ensurePublishedTransaction(transaction);
      const pdfUri = await generatePdfFileUri(publishedTransaction);

      await MailComposer.composeAsync({
        recipients: [issuer.managerEmail || ''],
        subject: `${publishedTransaction.documentType} - Ref: ${publishedTransaction.ticketCode}`,
        body: `Adjunto documento ${publishedTransaction.documentType} con referencia ${publishedTransaction.ticketCode} por un importe de ${formatCurrency(publishedTransaction.amount)}.`,
        attachments: [pdfUri],
      });
    } catch (error) {
      console.log('❌ Error en sendByEmail:', error);
      Alert.alert('Error', 'No se pudo enviar el correo.');
    }
  };

  const sendManagerReportByEmail = async () => {
    const reportLocale = appLocale;
    const reportTr = (key: string) => translateKey(reportLocale, key);
    if (!requireSubscription(reportTr('emailReport.manager.feature'))) return;
    if (!startDateInput.trim() || !endDateInput.trim()) {
      Alert.alert(reportTr('emailReport.datesRequiredTitle'), reportTr('emailReport.datesRequired'));
      return;
    }

    const start = parseDateInput(startDateInput);
    const end = parseDateInput(endDateInput);

    if (!start || !end) {
      Alert.alert(reportTr('emailReport.invalidDateTitle'), reportTr('emailReport.invalidDate'));
      return;
    }

    if (start > end) {
      Alert.alert(reportTr('emailReport.invalidRangeTitle'), reportTr('emailReport.invalidRange'));
      return;
    }

    const endExclusive = new Date(end);
    endExclusive.setHours(23, 59, 59, 999);

    const filtered = transactions.filter(t => {
      const d = new Date(t.createdAt);
      return d >= start && d <= endExclusive;
    });

    const filteredExpenses = expenses.filter(e => {
      const d = new Date(e.createdAt);
      return d >= start && d <= endExclusive;
    });

    if (filtered.length === 0 && filteredExpenses.length === 0) {
      Alert.alert(reportTr('emailReport.emptyTitle'), reportTr('emailReport.manager.empty'));
      return;
    }

    const totalIncome = filtered.filter(t => t.type === 'COBRO').reduce((acc, t) => acc + (t.originalAmount ?? t.amount), 0);
    const totalRefunds = filtered.reduce((acc, t) => {
      if (t.type === 'DEVOLUCIÓN') return acc + t.amount;
      return acc + (t.refundHistory || []).reduce((sum, refund) => sum + refund.amount, 0);
    }, 0);
    const totalExp = filteredExpenses.reduce((acc, e) => acc + e.amount, 0);
    const netIncome = totalIncome - totalRefunds;

    const report = buildEmailedReport({
      locale: reportLocale,
      kind: 'manager',
      issuer,
      range: { start, end },
      transactions: filtered,
      expenses: filteredExpenses,
      totals: { income: totalIncome, refunds: totalRefunds, expenses: totalExp, netIncome, netBalance: netIncome - totalExp },
    });

    const filename = buildReportPdfFilename(reportTr('emailReport.manager.title'), start, end);
    try {
      const { uri: generatedUri } = await Print.printToFileAsync({ html: report.html });
      const uri = await copyPdfForExport(generatedUri, filename);
      const isAvailable = await MailComposer.isAvailableAsync();
      if (!isAvailable) {
        await Sharing.shareAsync(uri, { UTI: '.pdf', mimeType: 'application/pdf' });
        return;
      }

      await MailComposer.composeAsync({
        recipients: [issuer.managerEmail || ''],
        subject: report.subject,
        body: report.body,
        attachments: [uri],
      });
      setManagerModalVisible(false);
    } catch {
      Alert.alert(reportTr('validation.error'), reportTr('emailReport.manager.error'));
    }
  };

  const sendCombinedReportByEmail = async () => {
    const reportLocale = appLocale;
    const reportTr = (key: string) => translateKey(reportLocale, key);
    if (!requireSubscription(reportTr('emailReport.combined.feature'))) return;
    if (!transactionStartDateInput.trim() || !transactionEndDateInput.trim()) {
      Alert.alert(reportTr('validation.error'), reportTr('validation.dates'));
      return;
    }

    const start = parseDateInput(transactionStartDateInput);
    const end = parseDateInput(transactionEndDateInput);

    if (!start || !end) {
      Alert.alert(reportTr('validation.error'), reportTr('validation.dates'));
      return;
    }

    if (start > end) {
      Alert.alert(reportTr('validation.error'), reportTr('validation.dates'));
      return;
    }

    const endExclusive = new Date(end);
    endExclusive.setHours(23, 59, 59, 999);

    const filteredTransactions = transactions.filter(t => {
      const d = new Date(t.createdAt);
      return d >= start && d <= endExclusive;
    });

    const filteredExpenses = expenses.filter(e => {
      const d = new Date(e.createdAt);
      return d >= start && d <= endExclusive;
    });

    const totalIncome = filteredTransactions.filter(t => t.type === 'COBRO').reduce((acc, t) => acc + (t.originalAmount ?? t.amount), 0);
    const totalRefunds = filteredTransactions.reduce((acc, t) => {
      if (t.type === 'DEVOLUCIÓN') return acc + t.amount;
      return acc + (t.refundHistory || []).reduce((sum, refund) => sum + refund.amount, 0);
    }, 0);
    const totalExpenses = filteredExpenses.reduce((acc, e) => acc + e.amount, 0);
    const netBalance = totalIncome - totalRefunds - totalExpenses;

    if (filteredTransactions.length === 0 && filteredExpenses.length === 0) {
      Alert.alert(reportTr('emailReport.emptyTitle'), reportTr('emailReport.combined.empty'));
      return;
    }

    const report = buildEmailedReport({
      locale: reportLocale,
      kind: 'combined',
      issuer,
      range: { start, end },
      transactions: filteredTransactions,
      expenses: filteredExpenses,
      totals: { income: totalIncome, refunds: totalRefunds, expenses: totalExpenses, netIncome: totalIncome - totalRefunds, netBalance },
    });

    const filename = buildReportPdfFilename(reportTr('emailReport.combined.title'), start, end);
    try {
      const { uri: generatedUri } = await Print.printToFileAsync({ html: report.html });
      const uri = await copyPdfForExport(generatedUri, filename);
      const isAvailable = await MailComposer.isAvailableAsync();
      if (!isAvailable) {
        await Sharing.shareAsync(uri, { UTI: '.pdf', mimeType: 'application/pdf' });
        return;
      }

      await MailComposer.composeAsync({
        recipients: [issuer.managerEmail || ''],
        subject: report.subject,
        body: report.body,
        attachments: [uri],
      });
      setTransactionReportModalVisible(false);
    } catch {
      Alert.alert(reportTr('validation.error'), reportTr('emailReport.combined.error'));
    }
  };

  // NUEVA FUNCIÓN: Generar y enviar informe específico desde la pestaña Gastos/Facturación
  const sendExpenseSpecificReport = async () => {
    const reportLocale = appLocale;
    const reportTr = (key: string) => translateKey(reportLocale, key);
    if (!requireSubscription(reportTr('emailReport.expenses.feature'))) return;
    if (!expenseStartDateInput.trim() || !expenseEndDateInput.trim()) {
      Alert.alert(reportTr('validation.error'), reportTr('validation.dates'));
      return;
    }

    const start = parseDateInput(expenseStartDateInput);
    const end = parseDateInput(expenseEndDateInput);

    if (!start || !end) {
      Alert.alert(reportTr('validation.error'), reportTr('validation.dates'));
      return;
    }

    if (start > end) {
      Alert.alert(reportTr('validation.error'), reportTr('validation.dates'));
      return;
    }

    const endExclusive = new Date(end);
    endExclusive.setHours(23, 59, 59, 999);

    const filteredExpenses = expenses.filter(e => {
      const d = new Date(e.createdAt);
      return d >= start && d <= endExclusive;
    });

    if (filteredExpenses.length === 0) {
      Alert.alert(reportTr('report.expenses'), reportTr('report.noExpenses'));
      return;
    }

    const totalExp = filteredExpenses.reduce((acc, e) => acc + e.amount, 0);

    const report = buildEmailedReport({
      locale: reportLocale,
      kind: 'expenses',
      issuer,
      range: { start, end },
      transactions: [],
      expenses: filteredExpenses,
      totals: { income: 0, refunds: 0, expenses: totalExp, netIncome: 0, netBalance: 0 },
    });

    const filename = buildReportPdfFilename(reportTr('emailReport.expenses.title'), start, end);
    try {
      const { uri: generatedUri } = await Print.printToFileAsync({ html: report.html });
      const uri = await copyPdfForExport(generatedUri, filename);
      const isAvailable = await MailComposer.isAvailableAsync();
      if (!isAvailable) {
        await Sharing.shareAsync(uri, { UTI: '.pdf', mimeType: 'application/pdf' });
        return;
      }

      await MailComposer.composeAsync({
        recipients: [issuer.managerEmail || ''],
        subject: report.subject,
        body: report.body,
        attachments: [uri],
      });
      setExpenseReportModalVisible(false);
    } catch {
      Alert.alert(reportTr('validation.error'), reportTr('emailReport.expenses.error'));
    }
  };

  if (authLoading || (accessToken && (!isLoaded || !storageScope || loadedScopeRef.current !== storageScope))) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 }}>
          <Text style={styles.modalTitle}>{tr('auth.loading')}</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!accessToken) {
    const switchAuthMode = (mode: 'login' | 'register') => { setAuthMode(mode); setAuthError(''); };
    const authReady = authRegistrationRole !== null && deviceIdStatus === 'ready' && !authSubmitting;
    const authFieldLabel = { fontSize: 12, fontWeight: '600' as const, color: '#334155', marginTop: 10 };
    return (
      <SafeAreaView style={styles.safeArea}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 24 }} keyboardShouldPersistTaps="handled">
          <View style={[styles.card, { padding: 20 }]}>
            <Text style={styles.modalTitle}>TPV & GESTIÓN</Text>
            {authRegistrationRole === null ? (
                <View style={[styles.rowButtons, { marginTop: 14 }]}>
                  <Pressable testID="auth-role-principal" accessibilityRole="button" style={[styles.secondaryButton, { flex: 1, backgroundColor: '#dcfce7' }]} onPress={() => selectAuthRole('principal')}>
                    <Text style={styles.secondaryButtonText}>{tr('auth.rolePrincipal')}</Text>
                  </Pressable>
                  <Pressable testID="auth-role-empleado" accessibilityRole="button" style={[styles.secondaryButton, { flex: 1, marginLeft: 8, backgroundColor: '#dbeafe' }]} onPress={() => selectAuthRole('empleado')}>
                    <Text style={styles.secondaryButtonText}>{tr('auth.roleEmployee')}</Text>
                  </Pressable>
                </View>
            ) : (
              <>
                <Pressable testID="auth-change-role" accessibilityRole="button" disabled={authSubmitting} style={{ marginTop: 14, marginBottom: 10 }} onPress={() => selectAuthRole(null)}>
                  <Text style={styles.secondaryButtonText}>{tr('auth.changeRole')}</Text>
                </Pressable>
                {authRegistrationRole === 'principal' ? (
                  <View style={styles.rowButtons} accessibilityRole="tablist">
                    <Pressable testID="auth-tab-login" accessibilityRole="tab" accessibilityState={{ selected: authMode === 'login' }} disabled={authSubmitting} style={[styles.secondaryButton, { flex: 1, backgroundColor: authMode === 'login' ? '#0f172a' : '#f1f5f9' }]} onPress={() => switchAuthMode('login')}>
                      <Text style={[styles.secondaryButtonText, authMode === 'login' ? { color: '#ffffff' } : null]}>{tr('auth.tabLogin')}</Text>
                    </Pressable>
                    <Pressable testID="auth-tab-register" accessibilityRole="tab" accessibilityState={{ selected: authMode === 'register' }} disabled={authSubmitting} style={[styles.secondaryButton, { flex: 1, marginLeft: 8, backgroundColor: authMode === 'register' ? '#0f172a' : '#f1f5f9' }]} onPress={() => switchAuthMode('register')}>
                      <Text style={[styles.secondaryButtonText, authMode === 'register' ? { color: '#ffffff' } : null]}>{tr('auth.tabRegister')}</Text>
                    </Pressable>
                  </View>
                ) : null}
                {authRegistrationRole === 'empleado' || authMode === 'register' ? (
                  <>
                    <Text style={authFieldLabel}>{tr('auth.fullName')}</Text>
                    <TextInput testID="auth-full-name" style={styles.input} placeholder={tr('auth.fullName')} placeholderTextColor="#94a3b8" autoComplete="name" value={authFullName} onChangeText={setAuthFullName} />
                  </>
                ) : null}
                {authRegistrationRole === 'principal' && authMode === 'register' ? (
                  <>
                    <Text style={authFieldLabel}>{tr('auth.companyName')}</Text>
                    <TextInput testID="auth-company-name" style={styles.input} placeholder={tr('auth.companyName')} placeholderTextColor="#94a3b8" value={authCompanyName} onChangeText={setAuthCompanyName} />
                  </>
                ) : null}
                <Text style={authFieldLabel}>{tr(authRegistrationRole === 'empleado' ? 'auth.companyEmail' : 'auth.email')}</Text>
                <TextInput testID="auth-email" style={styles.input} placeholder={tr(authRegistrationRole === 'empleado' ? 'auth.companyEmail' : 'auth.email')} placeholderTextColor="#94a3b8" keyboardType="email-address" autoCapitalize="none" autoCorrect={false} value={authEmail} onChangeText={setAuthEmail} />
                {authRegistrationRole === 'empleado' ? (
                  <>
                    <Text style={authFieldLabel}>{tr('registration.additionalCode')}</Text>
                    <TextInput testID="auth-employee-code" style={styles.input} placeholder={tr('registration.additionalCode')} placeholderTextColor="#94a3b8" autoCapitalize="characters" autoCorrect={false} value={authEmployeeAccessCode} onChangeText={setAuthEmployeeAccessCode} />
                  </>
                ) : null}
                {authRegistrationRole === 'principal' ? (
                  <>
                    <Text style={authFieldLabel}>{tr('auth.password')}</Text>
                    <TextInput testID="auth-password" style={styles.input} placeholder={authMode === 'register' ? tr('auth.passwordHint') : tr('auth.password')} placeholderTextColor="#94a3b8" secureTextEntry value={authPassword} onChangeText={setAuthPassword} />
                  </>
                ) : null}
                {authError ? <Text style={{ color: '#b91c1c', fontSize: 12, marginTop: 8 }}>{authError}</Text> : null}
                {deviceIdStatus === 'unavailable' && !authError ? <Text style={{ color: '#b91c1c', fontSize: 12, marginTop: 8 }}>{tr('auth.deviceUnavailable')}</Text> : null}
                <Pressable testID="auth-submit" disabled={!authReady} style={[styles.primaryButton, { marginTop: 14, opacity: authReady ? 1 : 0.5 }]} onPress={() => void submitAuth()}>
                  <Text style={styles.primaryButtonText}>
                    {deviceIdStatus === 'loading' ? tr('auth.preparingDevice') : authSubmitting ? tr('auth.submitting') : authRegistrationRole === 'empleado' || authMode === 'login' ? tr('auth.submitLogin') : tr('auth.submitRegister')}
                  </Text>
                </Pressable>
              </>
            )}
          </View>
        </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  // Botones del aviso de impago: cobrar la factura vencida con la tarjeta guardada y, si no hay
  // ninguna, abrir Stripe para guardarla. Al volver, el estado se relee solo.
  const renderPastDueActions = () => {
    // Cualquier usuario de la cuenta puede pagar: el backend resuelve la suscripcion del titular,
    // asi que un empleado que pague descuenta la cuenta de su empresa y no la suya.
    return (
    <View style={{ flexDirection: 'row', marginTop: 8 }}>
      <Pressable
        style={[styles.primaryButton, { flex: 1, opacity: pastDuePaying ? 0.6 : 1 }]}
        onPress={() => { void payPastDueInvoice(); }}
        accessibilityRole="button"
        accessibilityLabel={tr('sub.payNow')}
      >
        <Text style={styles.primaryButtonText}>
          {pastDuePaying ? tr('sub.checkingPayment') : tr('sub.payNow')}
        </Text>
      </Pressable>
      {subscriptionPastDueInvoiceUrl ? (
        <Pressable
          style={[styles.secondaryButton, { flex: 1, marginLeft: 8 }]}
          onPress={() => { void WebBrowser.openBrowserAsync(subscriptionPastDueInvoiceUrl); }}
          accessibilityRole="button"
          accessibilityLabel={tr('sub.updateCard')}
        >
          <Text style={styles.secondaryButtonText}>{tr('sub.updateCard')}</Text>
        </Pressable>
      ) : null}
      </View>
    );
  };

  // Aviso de impago. Se pinta en DOS sitios a proposito: encima de las pestanas y debajo de
  // ellas. Asi el recuadro rojo queda siempre a la vista, se este en la pestana que se este.
  const renderPastDueBanner = () => {
    if (!subscriptionPastDue || subscriptionLocked) return null;
    const days = subscriptionDaysUntilLock ?? 0;
    return (
      <View
        style={{
          backgroundColor: '#fee2e2',
          borderColor: '#b91c1c',
          borderWidth: 2,
          borderRadius: 8,
          marginHorizontal: 10,
          marginTop: 8,
          padding: 12,
        }}
      >
        <Text style={{ color: '#b91c1c', fontWeight: 'bold', fontSize: 13 }}>
          ⚠️ {tr('sub.pastDueTitle')}
        </Text>
        <Text style={{ color: '#7f1d1d', fontSize: 12, marginTop: 4 }}>
          {days > 0 ? tr('sub.pastDueBody').replace('{days}', String(days)) : tr('sub.pastDueOverdue')}
        </Text>
        {pastDueMessage ? (
          <Text style={{ color: '#b91c1c', fontSize: 12, marginTop: 4 }}>{pastDueMessage}</Text>
        ) : null}
        {renderPastDueActions()}
      </View>
    );
  };

  // Bloqueo total por impago. Afecta a TODOS los que usan la cuenta (principal y empleados):
  // la suscripcion esta a nombre del principal, asi que si no se paga, nadie puede trabajar. Al
  // pagar se relee el estado de Stripe y la app se reabre sola, conservando todo el historial: el
  // bloqueo solo oculta la interfaz, nunca borra tickets, gastos ni documentos.
  if (subscriptionLocked) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 24 }}>
          <View style={[styles.card, { padding: 20, borderWidth: 2, borderColor: '#b91c1c' }]}>
            <Text style={[styles.modalTitle, { color: '#b91c1c' }]}>
              {tr('sub.pastDueTitle')}
            </Text>
            <Text style={[styles.modalSubtitle, { marginTop: 8 }]}>
              {tr('sub.pastDueLocked')}
            </Text>
            {pastDueMessage ? (
              <Text style={{ color: '#b91c1c', fontSize: 12, marginTop: 10 }}>{pastDueMessage}</Text>
            ) : null}
            {renderPastDueActions()}
            <Pressable style={{ marginTop: 16 }} onPress={confirmSignOut} accessibilityRole="button">
              <Text style={{ color: '#475569', fontSize: 12, textAlign: 'center' }}>
                {tr('auth.signOut')}
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle}>TPV & GESTIÓN</Text>
            <Text style={styles.headerSubtitle}>{issuer.name}</Text>
            {/* Estado real de la suscripcion: lo devuelve el backend y antes no se mostraba. */}
            {subscriptionLoading ? (
              <Text style={{ color: '#64748b', fontSize: 11, marginTop: 4 }}>
                {subscriptionStatusLabel()}
              </Text>
            ) : null}
            {!subscriptionLoading && !hasActiveSubscription ? (
              <Pressable onPress={() => void startSubscriptionCheckout()}>
                <Text style={{ color: '#b45309', fontSize: 11, marginTop: 4 }}>
                  {tr('sub.statusMissing')} · {subscriptionStatusLabel()}
                </Text>
              </Pressable>
            ) : null}
            {subscriptionError ? (
              <Text style={{ color: '#b91c1c', fontSize: 11, marginTop: 4 }}>
                {tr('sub.errorTitle')}: {subscriptionError}
              </Text>
            ) : null}
          </View>
          <Pressable
            style={{ marginLeft: 10, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 6, backgroundColor: '#e0e7ff' }}
            onPress={() => setLanguageModalVisible(true)}
            accessibilityRole="button"
            accessibilityLabel={tr('lang.title')}
          >
            <Text style={{ fontSize: 11, fontWeight: 'bold', color: '#0f172a' }}>🌍 {appLocale.toUpperCase()}</Text>
          </Pressable>
          <Pressable
            style={{ marginLeft: 10, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 6, backgroundColor: userRole === 'principal' ? '#dcfce7' : '#dbeafe' }}
            onPress={() => { if (userRole === 'principal') setUserPermissionsModalVisible(true); }}
          >
            <Text style={{ fontSize: 11, fontWeight: 'bold', color: '#0f172a' }}>
              {userRole === 'principal' ? 'Principal' : 'Empleado'}
            </Text>
          </Pressable>
          <Pressable
            style={{ marginLeft: 10, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 6, backgroundColor: '#fee2e2' }}
            onPress={confirmSignOut}
            accessibilityRole="button"
            accessibilityLabel={tr('auth.signOut')}
          >
            <Text style={{ fontSize: 11, fontWeight: 'bold', color: '#0f172a' }}>⏻ {tr('auth.signOut')}</Text>
          </Pressable>
        </View>
      </View>

      {/* AVISO DE IMPAGO (encima de las pestañas) */}
      {renderPastDueBanner()}

      {/* PESTAÑAS DE NAVEGACIÓN */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tabContent}
        style={styles.tabContainer}
      >
        {userRole === 'principal' && (
          <Pressable style={[styles.tabButton, activeTab === 'gastos_facturacion' && styles.tabButtonActive]} onPress={() => setActiveTab('gastos_facturacion')}>
            <Text style={[styles.tabText, activeTab === 'gastos_facturacion' && styles.tabTextActive]}>{tr('tab.expenses')}</Text>
          </Pressable>
        )}
        <Pressable style={[styles.tabButton, activeTab === 'tpv' && styles.tabButtonActive]} onPress={() => setActiveTab('tpv')}>
          <Text style={[styles.tabText, activeTab === 'tpv' && styles.tabTextActive]}>{tr('tab.tpv')}</Text>
        </Pressable>
        {userRole === 'principal' && (
          <>
            <Pressable style={[styles.tabButton, activeTab === 'presupuesto' && styles.tabButtonActive]} onPress={() => setActiveTab('presupuesto')}>
              <Text style={[styles.tabText, activeTab === 'presupuesto' && styles.tabTextActive]}>{tr('tab.quote')}</Text>
            </Pressable>
            <Pressable style={[styles.tabButton, activeTab === 'stats' && styles.tabButtonActive]} onPress={() => setActiveTab('stats')}>
              <Text style={[styles.tabText, activeTab === 'stats' && styles.tabTextActive]}>{tr('tab.reports')}</Text>
            </Pressable>
            <Pressable style={[styles.tabButton, activeTab === 'config' && styles.tabButtonActive]} onPress={() => { if (requireSubscription('abrir Configuración')) setActiveTab('config'); }}>
              <Text style={[styles.tabText, activeTab === 'config' && styles.tabTextActive]}>{tr('tab.config')}</Text>
            </Pressable>
          </>
        )}
      </ScrollView>

      {/* AVISO DE IMPAGO (debajo de las pestañas) */}
      {renderPastDueBanner()}

      <View style={styles.content}>
        {/* PESTAÑA: GASTOS Y FACTURACIÓN */}
        {activeTab === 'gastos_facturacion' && (
          <ScrollView contentContainerStyle={styles.scrollContent}>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>📥 {tr('expense.new')}</Text>
              <TextInput
                style={styles.input}
                placeholder={tr('expense.providerInput')}
                placeholderTextColor="#94a3b8"
                value={expenseProvider}
                onChangeText={setExpenseProvider}
              />
              <TextInput
                style={styles.input}
                placeholder={tr('expense.amountInput')}
                placeholderTextColor="#94a3b8"
                keyboardType="numeric"
                value={expenseAmountInput}
                onChangeText={setExpenseAmountInput}
              />
              <View style={styles.rowButtons}>
                <Pressable style={styles.secondaryButton} onPress={() => pickExpenseImage(true)}>
                  <Text style={styles.secondaryButtonText}>📷 {tr('expense.photo')}</Text>
                </Pressable>
                <Pressable style={styles.secondaryButton} onPress={() => pickExpenseImage(false)}>
                  <Text style={styles.secondaryButtonText}>🖼️ {tr('expense.gallery')}</Text>
                </Pressable>
              </View>
              {expenseImageUri && (
                <View style={styles.previewContainer}>
                  <Image source={{ uri: expenseImageUri }} style={styles.previewImage} />
                  <Pressable onPress={() => setExpenseImageUri(null)}>
                    <Text style={styles.removePhotoText}>{tr('expense.removePhoto')}</Text>
                  </Pressable>
                </View>
              )}
              <Pressable style={styles.primaryButton} onPress={saveExpense}>
                <Text style={styles.primaryButtonText}>{tr('expense.save')}</Text>
              </Pressable>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>☁️ {tr('sync.title')}</Text>
              <Text style={[styles.modalSubtitle, { textAlign: 'left', marginTop: 4 }]}>
                {tr('sync.subtitle')}
              </Text>
              <Pressable
                style={[styles.primaryButton, { marginTop: 10 }]}
                onPress={() => void syncHistoryFromCloud()}
                disabled={syncHistoryLoading}
              >
                <Text style={styles.primaryButtonText}>{syncHistoryLoading ? tr('common.checking') : tr('sync.button')}</Text>
              </Pressable>
              {syncHistoryMessage ? (
                <Text style={{ color: '#0f172a', fontSize: 12, marginTop: 10, lineHeight: 18 }}>{syncHistoryMessage}</Text>
              ) : null}
              {syncHistoryError ? (
                <Text style={{ color: '#b91c1c', fontSize: 12, marginTop: 8 }}>{syncHistoryError}</Text>
              ) : null}
            </View>
            <TransactionHistory />

            <View style={{ marginBottom: 16 }}>
              <Pressable style={[styles.primaryButton, { backgroundColor: '#0284c7' }]} onPress={() => setTransactionReportModalVisible(true)}>
                <Text style={styles.primaryButtonText}>📄 {tr('report.generateCombined')}</Text>
              </Pressable>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>📋 {tr('expense.list').replace('{count}', String(expenses.length))}</Text>
              {expenses.length === 0 ? (
                <Text style={styles.emptyText}>{tr('expense.empty')}</Text>
              ) : (
                expenses.map((exp) => (
                  <Pressable key={exp.id} style={styles.listItem} onPress={() => setSelectedExpense(exp)}>
                    <View>
                      <Text style={styles.listItemTitle}>{exp.provider}</Text>
                      <Text style={styles.listItemSubtitle}>{formatUiDate(exp.createdAt)} • {tr('workflow.reference')}: {exp.expenseCode}</Text>
                    </View>
                    <Text style={styles.listItemAmount}>{formatUiCurrency(exp.amount)}</Text>
                  </Pressable>
                ))
              )}
            </View>
          </ScrollView>
        )}

        {/* PESTAÑA: TPV CAJA */}
        {activeTab === 'tpv' && (
          <View style={styles.tpvContainer}>
            <View style={styles.displayContainer}>
              <Text style={styles.displayLabel}>{tr('tpv.amount')}</Text>
              <Text style={styles.displayText}>{formatUiCurrency(amount)}</Text>
            </View>

            <View style={styles.keypad}>
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map((key) => (
                <Pressable key={key} style={styles.keyButton} onPress={() => handleKey(key)}>
                  <Text style={styles.keyText}>{key}</Text>
                </Pressable>
              ))}
            </View>

            <View style={styles.actionButtonsContainer}>
              <Pressable style={styles.actionBtnTicket} onPress={() => startPayment('TICKET DE VENTA')}>
                <Text style={styles.actionBtnText}>{documentTypeLabel('TICKET DE VENTA')}</Text>
              </Pressable>
              <Pressable style={styles.actionBtnFactura} onPress={() => startPayment('FACTURA SIMPLIFICADA')}>
                <Text style={styles.actionBtnText}>{documentTypeLabel('FACTURA SIMPLIFICADA')}</Text>
              </Pressable>
              <Pressable style={styles.actionBtnFacturaCompleta} onPress={() => startPayment('FACTURA COMPLETA')}>
                <Text style={styles.actionBtnText}>{documentTypeLabel('FACTURA COMPLETA')}</Text>
              </Pressable>
            </View>

            <View style={styles.scanBarRow}>
              <Pressable style={styles.scanBarcodeBtn} onPress={() => setScannerModalVisible(true)}>
                <Text style={styles.scanBarcodeText}>📷 {tr('scanner.open')}</Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* PESTAÑA: PRESUPUESTO */}
        {activeTab === 'presupuesto' && (
          <KeyboardAvoidingView style={styles.content} behavior="padding" enabled={Platform.OS === 'ios'}>
          <ScrollView
            ref={quoteScrollRef}
            contentContainerStyle={[styles.scrollContent, { paddingBottom: 16 + (Platform.OS === 'android' ? quoteKeyboardHeight : 0) }]}
            onLayout={scheduleQuoteReveal}
            onContentSizeChange={scheduleQuoteReveal}
            onScroll={(event) => { quoteScrollOffsetRef.current = event.nativeEvent.contentOffset.y; }}
            onScrollBeginDrag={() => { quoteFocusGenerationRef.current += 1; }}
            scrollEventThrottle={16}
            keyboardShouldPersistTaps="handled"
            automaticallyAdjustKeyboardInsets={false}
          >
            <View style={styles.card}>
              <Text style={styles.cardTitle}>📑 {tr('quote.create')}</Text>
              <View style={styles.rowButtons}>
                <Pressable
                  style={[styles.secondaryButton, { flex: 1, backgroundColor: presupuestoDocumentType === 'PRESUPUESTO' ? '#dbeafe' : '#f8fafc' }]}
                  onPress={() => setPresupuestoDocumentType('PRESUPUESTO')}
                >
                  <Text style={styles.secondaryButtonText}>{documentTypeLabel('PRESUPUESTO')}</Text>
                </Pressable>
                <Pressable
                  style={[styles.secondaryButton, { flex: 1, marginLeft: 8, backgroundColor: presupuestoDocumentType === 'FACTURA' ? '#dcfce7' : '#f8fafc' }]}
                  onPress={() => setPresupuestoDocumentType('FACTURA')}
                >
                  <Text style={styles.secondaryButtonText}>{documentTypeLabel('FACTURA')}</Text>
                </Pressable>
              </View>
              <Text style={[styles.modalSubtitle, { textAlign: 'left', marginTop: 8 }]}>{tr('quote.format')}</Text>
              <TextInput style={styles.input} ref={(input) => { quoteInputRefs.current.name = input; }} onFocus={() => revealQuoteInput('name')} onBlur={() => blurQuoteInput('name')} placeholder={tr('quote.name')} placeholderTextColor="#94a3b8" value={presupuestoClient.name} onChangeText={(t) => setPresupuestoClient(c => ({ ...c, name: t }))} />
              <TextInput style={styles.input} ref={(input) => { quoteInputRefs.current.nif = input; }} onFocus={() => revealQuoteInput('nif')} onBlur={() => blurQuoteInput('nif')} placeholder={tr('workflow.taxId')} placeholderTextColor="#94a3b8" value={presupuestoClient.nif} onChangeText={(t) => setPresupuestoClient(c => ({ ...c, nif: t }))} />
              <TextInput style={styles.input} ref={(input) => { quoteInputRefs.current.address = input; }} onFocus={() => revealQuoteInput('address')} onBlur={() => blurQuoteInput('address')} placeholder={tr('quote.address')} placeholderTextColor="#94a3b8" value={presupuestoClient.address} onChangeText={(t) => setPresupuestoClient(c => ({ ...c, address: t }))} />
              <TextInput style={styles.input} ref={(input) => { quoteInputRefs.current.email = input; }} onFocus={() => revealQuoteInput('email')} onBlur={() => blurQuoteInput('email')} placeholder={tr('quote.email')} placeholderTextColor="#94a3b8" keyboardType="email-address" value={presupuestoClientEmail} onChangeText={setPresupuestoClientEmail} />

              <Text style={[styles.cardTitle, { marginTop: 15 }]}>{tr('quote.products')}</Text>
              {presupuestoItems.map((item, index) => (
                <View key={item.id} style={styles.invoiceItemRow}>
                  <TextInput
                    style={[styles.input, { flex: 2, marginBottom: 0 }]}
                    placeholder={tr('quote.description').replace('{number}', String(index + 1))}
                    ref={(input) => {
                      quoteInputRefs.current[`description-${item.id}`] = input;
                      if (input && quoteNewLineRef.current === item.id) {
                        quoteNewLineRef.current = null;
                        input.focus();
                      }
                    }}
                    onFocus={() => revealQuoteInput(`description-${item.id}`)}
                    onBlur={() => blurQuoteInput(`description-${item.id}`)}
                    placeholderTextColor="#94a3b8"
                    value={item.description}
                    onChangeText={(text) => {
                      const updated = [...presupuestoItems];
                      updated[index].description = text;
                      setPresupuestoItems(updated);
                    }}
                  />
                  <TextInput
                    style={[styles.input, { flex: 1, marginBottom: 0, marginLeft: 6 }]}
                    placeholder={tr('quote.price')}
                    ref={(input) => { quoteInputRefs.current[`price-${item.id}`] = input; }}
                    onFocus={() => revealQuoteInput(`price-${item.id}`)}
                    onBlur={() => blurQuoteInput(`price-${item.id}`)}
                    placeholderTextColor="#94a3b8"
                    keyboardType="numeric"
                    value={item.price}
                    onChangeText={(text) => {
                      const updated = [...presupuestoItems];
                      updated[index].price = text;
                      setPresupuestoItems(updated);
                    }}
                  />
                </View>
              ))}
              <Pressable style={styles.secondaryButton} onPress={() => {
                const id = `${Date.now()}`;
                quoteNewLineRef.current = id;
                setPresupuestoItems(curr => [...curr, { id, description: '', price: '' }]);
              }}>
                <Text style={styles.secondaryButtonText}>+ {tr('quote.add')}</Text>
              </Pressable>

              <TextInput
                style={[styles.input, { marginTop: 10 }]}
                placeholder={tr('quote.vatInput')}
                ref={(input) => { quoteInputRefs.current.iva = input; }}
                onFocus={() => revealQuoteInput('iva')}
                onBlur={() => blurQuoteInput('iva')}
                placeholderTextColor="#94a3b8"
                keyboardType="numeric"
                value={presupuestoIvaInput}
                onChangeText={setPresupuestoIvaInput}
              />

              <Pressable style={styles.primaryButton} onPress={sendPresupuestoByEmail}>
                <Text style={styles.primaryButtonText}>{tr('quote.send').replace('{document}', documentTypeLabel(presupuestoDocumentType))}</Text>
              </Pressable>
            </View>

            {cashInvoiceDrafts.length > 0 && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>🧾 {tr('cash.pending').replace('{count}', String(cashInvoiceDrafts.length))}</Text>
                <Text style={[styles.modalSubtitle, { textAlign: 'left', marginBottom: 10 }]}>{tr('cash.guidance')}</Text>
                {cashInvoiceDrafts.map((draft) => (
                  <View key={draft.id} style={[styles.listItem, { flexDirection: 'column', alignItems: 'stretch' }]}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <View>
                        <Text style={styles.listItemTitle}>{draft.ticketCode}</Text>
                        <Text style={styles.listItemSubtitle}>{draft.client?.name || tr('workflow.generalClient')} · {formatUiDate(draft.createdAt)}</Text>
                      </View>
                      <Text style={styles.listItemAmount}>{formatUiCurrency(draft.amount)}</Text>
                    </View>
                    <View style={[styles.rowButtons, { marginTop: 8 }]}>
                      <Pressable style={[styles.primaryButton, { flex: 1, marginTop: 0, backgroundColor: '#16a34a' }]} onPress={() => void markCashInvoiceAsPaid(draft)}>
                        <Text style={styles.primaryButtonText}>{tr('cash.paid')}</Text>
                      </Pressable>
                      <Pressable style={[styles.secondaryButton, { flex: 1, marginLeft: 8, marginTop: 0, backgroundColor: '#fee2e2' }]} onPress={() => deleteCashInvoiceDraft(draft)}>
                        <Text style={[styles.secondaryButtonText, { color: '#dc2626' }]}>{tr('workflow.delete')}</Text>
                      </Pressable>
                    </View>
                  </View>
                ))}
              </View>
            )}
          </ScrollView>
          </KeyboardAvoidingView>
        )}

        {/* PESTAÑA: INFORMES Y ESTADÍSTICAS */}
        {activeTab === 'stats' && (
          <ScrollView contentContainerStyle={styles.scrollContent}>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>📊 {tr('reports.summary')}</Text>
              <View style={styles.statRow}>
                <Text style={styles.statLabel}>{tr('reports.charges')}</Text>
                <Text style={[styles.statValue, { color: '#16a34a' }]}>{formatCurrency(totals.charges)}</Text>
              </View>
              <View style={styles.statRow}>
                <Text style={styles.statLabel}>{tr('reports.refunds')}</Text>
                <Text style={[styles.statValue, { color: '#dc2626' }]}>{formatCurrency(totals.refunds)}</Text>
              </View>
              <View style={styles.statRow}>
                <Text style={styles.statLabel}>{tr('reports.expenses')}</Text>
                <Text style={[styles.statValue, { color: '#ca8a04' }]}>{formatCurrency(totalExpensesAmount)}</Text>
              </View>
              <View style={[styles.statRow, { borderTopWidth: 1, borderColor: '#cbd5e1', paddingTop: 8, marginTop: 4 }]}>
                <Text style={[styles.statLabel, { fontWeight: 'bold' }]}>{tr('reports.net')}</Text>
                <Text style={[styles.statValue, { fontWeight: 'bold', color: '#0f172a' }]}>{formatCurrency(totals.charges - totals.refunds - totalExpensesAmount)}</Text>
              </View>

              <View style={{ marginTop: 12 }}>
                <Text style={styles.emptyText}>{tr('reports.guidance')}</Text>
              </View>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>📈 {tr('reports.evolution')}</Text>
              <View style={styles.segmentedControl}>
                {(['day', 'week', 'month'] as const).map((mode) => (
                  <Pressable
                    key={mode}
                    style={[styles.segmentButton, chartGranularity === mode && styles.segmentButtonActive]}
                    onPress={() => setChartGranularity(mode)}
                  >
                    <Text style={[styles.segmentButtonText, chartGranularity === mode && styles.segmentButtonTextActive]}>
                      {tr(`reports.${mode}`)}
                    </Text>
                  </Pressable>
                ))}
              </View>

              <View style={styles.chartWrapper}>
                {chartData.map((item) => (
                  <Pressable
                    key={`${chartGranularity}-${item.label}`}
                    style={styles.chartColumn}
                    onPress={() => openChartPeriodReport(item)}
                    accessibilityRole="button"
                    accessibilityLabel={tr('reports.openPeriod').replace('{period}', item.label)}
                  >
                    <View style={styles.chartStack}>
                      <View
                        style={{
                          height: `${Math.max(0, (Math.max(item.net, 0) / maxChartValue) * 100)}%`,
                          backgroundColor: '#22c55e',
                          width: '100%',
                          borderRadius: 6,
                        }}
                      />
                      <View
                        style={{
                          height: `${Math.max(0, (item.expenses / maxChartValue) * 100)}%`,
                          backgroundColor: '#f97316',
                          width: '100%',
                          borderRadius: 6,
                          marginTop: 4,
                        }}
                      />
                    </View>
                    <Text style={styles.chartLabel}>{item.label}</Text>
                  </Pressable>
                ))}
              </View>

              <View style={styles.chartLegendRow}>
                <View style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: '#22c55e' }]} />
                  <Text style={styles.legendText}>{tr('reports.profit')}</Text>
                </View>
                <View style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: '#f97316' }]} />
                  <Text style={styles.legendText}>{tr('reports.expenseLegend')}</Text>
                </View>
              </View>
            </View>

          </ScrollView>
        )}

        {/* PESTAÑA: CONFIGURACIÓN */}
        {activeTab === 'config' && (
          <ScrollView contentContainerStyle={styles.scrollContent}>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>📦 {tr('config.plan')}</Text>
              <View style={styles.statRow}>
                <Text style={styles.statLabel}>{tr('config.primaryUser')}</Text>
                <Text style={[styles.statValue, { color: '#0f172a', fontWeight: 'bold' }]}>{formatCurrency(9)} + 21% {tr('config.vat')} ({formatCurrency(10.89)})</Text>
              </View>
              <View style={styles.statRow}>
                <Text style={styles.statLabel}>{tr('config.additionalUser')}</Text>
                <Text style={[styles.statValue, { color: '#0f172a' }]}>{formatCurrency(2.5)} + 21% {tr('config.vat')} ({formatCurrency(3.03)})</Text>
              </View>
              <View style={[styles.statRow, { borderTopWidth: 1, borderColor: '#cbd5e1', paddingTop: 8, marginTop: 4 }]}>
                <Text style={[styles.statLabel, { fontWeight: 'bold' }]}>{tr('config.monthlyTotal')}</Text>
                <Text style={[styles.statValue, { color: '#16a34a', fontWeight: 'bold' }]}>{formatCurrency(currentSubscriptionTotal)}</Text>
              </View>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>💳 {tr('connect.title')}</Text>
              <Text style={{ color: '#0f172a', fontSize: 12, lineHeight: 18 }}>{tr('connect.phase')}</Text>
              {userRole !== 'principal' ? <Text style={{ fontSize: 12, marginTop: 8 }}>{tr('connect.principalOnly')}</Text> : null}
              <Text style={{ fontSize: 12, marginTop: 10 }}>{tr('connect.country')}</Text>
              <Pressable style={[styles.secondaryButton, { marginTop: 6, flexDirection: 'row', alignItems: 'center' }]} onPress={openStripeCountrySelector}
                disabled={stripeAccountLoading || userRole !== 'principal' || !isLoaded}
                accessibilityRole="button" accessibilityLabel={tr('connect.chooseCountry')}>
                <Text style={[styles.secondaryButtonText, { flex: 1 }]}>{
                  (stripeCountryConfirmed || normalizeConnectCountry(issuer.country))
                    ? connectCountryLabel((stripeCountryConfirmed || normalizeConnectCountry(issuer.country)) as ConnectCountry, appLocale)
                    : tr('connect.chooseCountry')
                }</Text>
                <MaterialIcons name="expand-more" size={20} color="#0f766e" />
              </Pressable>
              <Pressable
                style={[styles.primaryButton, {
                  marginTop: 12,
                  backgroundColor: '#0f766e',
                  opacity: (stripeAccountLoading || userRole !== 'principal' || !isLoaded) ? 0.55 : 1,
                }]}
                onPress={openStripeAccountSettings}
                disabled={stripeAccountLoading || userRole !== 'principal' || !isLoaded}
                accessibilityRole="button"
                accessibilityLabel={tr('connect.continue')}
              >
                <Text style={styles.primaryButtonText}>
                  {stripeAccountLoading ? tr('common.checking') : tr('connect.continue')}
                </Text>
              </Pressable>
              {stripeMethodsInfo ? (
                <Text style={{ color: '#0f172a', fontSize: 12, marginTop: 10, lineHeight: 18 }}>{tr(stripeMethodsInfo)}</Text>
              ) : null}
              {stripeMethodsError ? (
                <Text style={{ color: '#b91c1c', fontSize: 12, marginTop: 10 }}>{tr(stripeMethodsError)}</Text>
              ) : null}
            </View>
              <View style={styles.card}>
                <Pressable
                  onPress={() => setSeatsPanelOpen((open) => !open)}
                  accessibilityRole="button"
                  accessibilityLabel={tr('config.addUser')}
                  style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
                >
                  <Text style={styles.cardTitle}>👥 {tr('config.addUser')}</Text>
                  <Text style={{ color: '#0f172a', fontSize: 18, fontWeight: 'bold' }}>{seatsPanelOpen ? '−' : '+'}</Text>
                </Pressable>
                {seatsPanelOpen ? (
                  <View>
                    <TextInput
                      style={styles.input}
                      placeholder={tr('config.userCount')}
                      placeholderTextColor="#94a3b8"
                      keyboardType="numeric"
                      value={String(issuer.additionalUsers || 0)}
                      onChangeText={(t) => setIssuer(i => ({ ...i, additionalUsers: Number(t.replace(/[^0-9]/g, '')) || 0 }))}
                    />
                    <TextInput
                      style={styles.input}
                      placeholder={tr('config.accessCode')}
                      placeholderTextColor="#94a3b8"
                      autoCapitalize="characters"
                      autoCorrect={false}
                      value={employeeAccessCode}
                      onChangeText={setEmployeeAccessCode}
                    />
                    <Pressable
                      style={[styles.secondaryButton, { marginTop: 4 }]}
                      onPress={() => void saveEmployeeWithSeats()}
                      disabled={employeeSaveLoading}
                    >
                      <Text style={styles.secondaryButtonText}>
                        {employeeSaveLoading
                        ? tr('config.saving')
                        : Number(issuer.additionalUsers || 0) > 0
                        ? tr('config.chargeAndCode').replace('{amount}', formatCurrency((subscriptionAdditionalUserCents * Number(issuer.additionalUsers || 0)) / 100))
                        : tr('config.generateCode')}
                      </Text>
                    </Pressable>
                    {seatsSyncLoading ? (
                      <Text style={[styles.modalSubtitle, { textAlign: 'left', marginTop: 6, color: '#0284c7' }]}>{tr('config.applyingSeats')}</Text>
                    ) : null}
                    {seatsSyncMessage ? (
                      <Text style={[styles.modalSubtitle, { textAlign: 'left', marginTop: 6, color: '#0f172a' }]}>{seatsSyncMessage}</Text>
                    ) : null}
                    {seatsCardMissing ? (
                      <Pressable
                        style={[styles.secondaryButton, { marginTop: 6 }]}
                        onPress={() => void addSubscriptionPaymentMethod()}
                        disabled={seatsSyncLoading}
                      >
                        <Text style={styles.secondaryButtonText}>
                          {seatsSyncLoading ? tr('stripe.accountLoading') : tr('config.addCard')}
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                ) : null}
              </View>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>⚙️ {tr('config.business')}</Text>
              <Text style={styles.statLabel}>{tr('config.businessName')}</Text>
              <TextInput style={styles.input} placeholder={tr('config.businessName')} placeholderTextColor="#94a3b8" value={issuer.name} onChangeText={(t) => setIssuer(i => ({ ...i, name: t }))} />
              <Text style={styles.statLabel}>{tr('config.taxId')}</Text>
              <TextInput style={styles.input} placeholder={tr('config.taxId')} placeholderTextColor="#94a3b8" value={issuer.nif} onChangeText={(t) => setIssuer(i => ({ ...i, nif: t }))} />
              <Text style={styles.statLabel}>{tr('config.address')}</Text>
              <TextInput style={styles.input} placeholder={tr('config.address')} placeholderTextColor="#94a3b8" value={issuer.address} onChangeText={(t) => setIssuer(i => ({ ...i, address: t }))} />
              <Text style={styles.statLabel}>{tr('config.managerEmail')}</Text>
              <TextInput style={styles.input} placeholder={tr('config.managerEmail')} placeholderTextColor="#94a3b8" keyboardType="email-address" autoCapitalize="none" autoCorrect={false} value={issuer.managerEmail || ''} onChangeText={(t) => setIssuer(i => ({ ...i, managerEmail: t }))} />

              <Text style={[styles.cardTitle, { marginTop: 15 }]}>🎨 {tr('config.logo')}</Text>
              {issuer.logoUri && (
                <View style={styles.previewContainer}>
                  <Image source={{ uri: issuer.logoUri }} style={styles.previewImage} resizeMode="contain" />
                  <Text style={styles.emptyText}>{tr('config.currentLogo')}</Text>
                </View>
              )}
              {!issuer.logoUri && (
                <View style={[styles.previewContainer, { backgroundColor: '#f8fafc', borderRadius: 8, padding: 20 }]}>
                  <Text style={{ fontSize: 40, marginBottom: 8 }}>📷</Text>
                  <Text style={styles.emptyText}>{tr('config.noLogo')}</Text>
                </View>
              )}
              <View style={styles.rowButtons}>
                <Pressable style={[styles.secondaryButton, { flex: 1 }]} onPress={captureLogoWithCamera}>
                  <Text style={styles.secondaryButtonText}>📸 {tr('config.takePhoto')}</Text>
                </Pressable>
                <Pressable style={[styles.secondaryButton, { flex: 1, marginLeft: 8 }]} onPress={pickLogoImage}>
                  <Text style={styles.secondaryButtonText}>🖼️ {tr('config.gallery')}</Text>
                </Pressable>
              </View>
              {issuer.logoUri && (
                <Pressable style={[styles.secondaryButton, { backgroundColor: '#fee2e2' }]} onPress={removeLogo}>
                  <Text style={[styles.secondaryButtonText, { color: '#dc2626' }]}>🗑️ {tr('config.removeLogo')}</Text>
                </Pressable>
              )}
              <LogoSettings issuer={issuer} locale={appLocale} onChange={settings => setIssuer(current => ({ ...current, ...settings }))} />

              <TextInput
                style={[styles.input, { marginTop: 15 }]}
                placeholder={tr('config.defaultVat')}
                placeholderTextColor="#94a3b8"
                keyboardType="numeric"
                value={ivaPercentage}
                onChangeText={setIvaPercentage}
              />
            </View>
          </ScrollView>
        )}
      </View>

      {/* MODAL: ESCANEAR CÓDIGO QR / BARRAS */}
      <Modal visible={scannerModalVisible} animationType="slide" transparent={false}>
        <View style={styles.modalContainer}>
          <Text style={styles.modalTitle}>{tr('scanner.title')}</Text>
          {hasPermission ? (
            <CameraView
              style={StyleSheet.absoluteFillObject}
              facing="back"
              onBarcodeScanned={scanned ? undefined : handleBarCodeScanned}
            />
          ) : (
            <Text style={styles.errorText}>{tr('scanner.permission')}</Text>
          )}
          <Pressable style={[styles.primaryButton, { position: 'absolute', bottom: 30, left: 20, right: 20, backgroundColor: '#dc2626' }]} onPress={() => setScannerModalVisible(false)}>
            <Text style={styles.primaryButtonText}>{tr('common.close')}</Text>
          </Pressable>
        </View>
      </Modal>

      {/* MODAL: COBRO CONTACTLESS CON STRIPE TERMINAL */}
      <Modal visible={nfcModalVisible} animationType="fade" transparent={true}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>💳 {tr('tpv.contactless')}</Text>
            <Text style={styles.modalSubtitle}>{tr('tpv.amount')}: {formatUiCurrency(pendingInvoice ? pendingInvoice.total : amount)}</Text>
            <Text style={[styles.modalSubtitle, { marginBottom: 8 }]}>{tr('tpv.contactlessHint')}</Text>
            <Text style={[styles.modalSubtitle, { color: terminalError ? '#b91c1c' : '#166534', fontWeight: 'bold' }]}>{tr(terminalMessage)}</Text>

            {terminalError ? <Text style={{ color: '#b91c1c', fontSize: 12, marginTop: 10, textAlign: 'center' }}>{terminalError}</Text> : null}

            <Pressable style={[styles.primaryButton, { backgroundColor: '#0f766e', marginTop: 15 }]} onPress={completePayment} disabled={isProcessing}>
              <Text style={styles.primaryButtonText}>{isProcessing ? tr('common.loading') : tr('pay.tapToPay')}</Text>
            </Pressable>

            <Pressable style={[styles.secondaryButton, { marginTop: 12 }]} onPress={openOnlinePaymentModal}>
              <Text style={styles.secondaryButtonText}>{tr('pay.chargeQr')}</Text>
            </Pressable>

            <Pressable style={[styles.secondaryButton, { marginTop: 12 }]} onPress={cancelPayment}>
              <Text style={styles.secondaryButtonText}>{tr('common.cancel')}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* MODAL: COBRO ONLINE CON ENLACE O QR (TARJETA Y BIZUM) */}
      <Modal visible={onlinePaymentModalVisible} animationType="fade" transparent={true}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { maxHeight: '90%' }]}>
            <ScrollView contentContainerStyle={{ alignItems: 'center' }}>
              <Text style={styles.modalTitle}>🔗 {tr('tpv.online')}</Text>
              <Text style={styles.modalSubtitle}>
                {tr('tpv.amount')}: {formatUiCurrency(pendingInvoice ? pendingInvoice.total : amount)}
              </Text>
              <Text style={[styles.modalSubtitle, { marginBottom: 8 }]}>
                {tr('pay.waitBody')}
              </Text>

              {onlinePayment?.qrDataUrl ? (
                <Image
                  source={{ uri: onlinePayment.qrDataUrl }}
                  style={{ width: 220, height: 220, marginVertical: 8 }}
                />
              ) : null}

              {onlinePaymentMessage ? (
                <Text style={[styles.modalSubtitle, { color: onlinePaymentError ? '#b91c1c' : '#166534', fontWeight: 'bold' }]}>
                  {onlinePaymentMessage}
                </Text>
              ) : null}

              {onlinePaymentError ? (
                <Text style={{ color: '#b91c1c', fontSize: 12, marginTop: 6, textAlign: 'center' }}>{onlinePaymentError}</Text>
              ) : null}

              {onlinePayment ? (
                <>
                  <Pressable style={[styles.primaryButton, { backgroundColor: '#0f766e', marginTop: 15, width: '100%' }]} onPress={openOnlinePaymentPage} disabled={onlinePaymentLoading}>
                    <Text style={styles.primaryButtonText}>{tr('pay.openPage')}</Text>
                  </Pressable>

                  <Pressable style={[styles.secondaryButton, { marginTop: 10, width: '100%' }]} onPress={checkOnlinePaymentStatus} disabled={onlinePaymentLoading}>
                    <Text style={styles.secondaryButtonText}>{onlinePaymentLoading ? tr('pay.checkingShort') : tr('pay.checkNow')}</Text>
                  </Pressable>
                </>
              ) : (
                <Pressable style={[styles.primaryButton, { backgroundColor: '#0f766e', marginTop: 15, width: '100%' }]} onPress={createOnlinePayment} disabled={onlinePaymentLoading}>
                  <Text style={styles.primaryButtonText}>{onlinePaymentLoading ? tr('pay.generatingShort') : tr('pay.newLink')}</Text>
                </Pressable>
              )}

              <Pressable style={[styles.secondaryButton, { marginTop: 10, width: '100%' }]} onPress={backToTerminalModal}>
                <Text style={styles.secondaryButtonText}>{tr('pay.back')}</Text>
              </Pressable>
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal visible={stripeCountryModalVisible} animationType="slide" transparent={true}
        onRequestClose={() => { setStripeCountryModalVisible(false); stripeCountryScopeRef.current = null; }}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { maxHeight: '85%' }]}>
            <Text style={styles.modalTitle}>{tr('connect.country')}</Text>
            <ScrollView>
              {CONNECT_EU_COUNTRIES.map(country => (
                <Pressable key={country} onPress={() => selectStripeConnectCountry(country)}
                  accessibilityRole="radio" accessibilityState={{ checked: stripeCountryConfirmed === country }}
                  accessibilityLabel={connectCountryLabel(country, appLocale)}
                  style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 12,
                    marginTop: 4, borderRadius: 8, backgroundColor: stripeCountryConfirmed === country ? '#ccfbf1' : '#f1f5f9' }}>
                  <MaterialIcons name={stripeCountryConfirmed === country ? 'radio-button-checked' : 'radio-button-unchecked'}
                    size={20} color="#0f766e" style={{ marginRight: 8 }} />
                  <Text style={{ flex: 1, fontSize: 14, color: '#0f172a' }}>{connectCountryLabel(country, appLocale)}</Text>
                  <Text style={{ marginLeft: 8, color: '#64748b', fontSize: 12 }}>{country}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <Pressable style={[styles.secondaryButton, { marginTop: 12 }]}
              onPress={() => { setStripeCountryModalVisible(false); stripeCountryScopeRef.current = null; }}>
              <Text style={styles.secondaryButtonText}>{tr('pay.back')}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* MODAL: IDIOMA DE LA APLICACIÓN (se abre desde el botón 🌍 de la cabecera) */}
      <Modal visible={languageModalVisible} animationType="slide" transparent={true}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { maxHeight: '85%' }]}>
            <ScrollView>
              <Text style={styles.modalTitle}>🌍 {tr('lang.title').toUpperCase()}</Text>
              <Text style={[styles.modalSubtitle, { textAlign: 'left' }]}>{tr('lang.subtitle')}</Text>
              {APP_LOCALES.map((option) => (
                <Pressable
                  key={option.code}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingVertical: 10,
                    paddingHorizontal: 12,
                    borderRadius: 8,
                    marginTop: 6,
                    backgroundColor: appLocale === option.code ? '#ccfbf1' : '#f1f5f9',
                    borderWidth: appLocale === option.code ? 2 : 0,
                    borderColor: '#0f766e',
                  }}
                  onPress={() => void setAppLocale(option.code)}
                  accessibilityRole="button"
                  accessibilityLabel={option.label}
                >
                  <Text style={{ flex: 1, color: '#0f172a', fontSize: 14, fontWeight: appLocale === option.code ? 'bold' : 'normal' }}>
                    {option.label}
                  </Text>
                  <Text style={{ color: '#64748b', fontSize: 11, textAlign: 'right' }}>{option.countries}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <Pressable style={[styles.secondaryButton, { marginTop: 12 }]} onPress={() => setLanguageModalVisible(false)}>
              <Text style={styles.secondaryButtonText}>{tr('pay.back')}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* MODAL: DATOS DE CLIENTE Y PRODUCTOS PARA FACTURA */}
      <Modal visible={clientModalVisible} animationType="slide" transparent={true}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { maxHeight: '85%' }]}>
            <ScrollView>
              <Text style={styles.modalTitle}>{tr('invoice.billing')}</Text>
              <TextInput style={styles.input} placeholder={tr('quote.name')} placeholderTextColor="#94a3b8" value={client.name} onChangeText={(t) => setClient(c => ({ ...c, name: t }))} />
              <TextInput style={styles.input} placeholder={tr('workflow.taxId')} placeholderTextColor="#94a3b8" value={client.nif} onChangeText={(t) => setClient(c => ({ ...c, nif: t }))} />
              <TextInput style={styles.input} placeholder={tr('quote.address')} placeholderTextColor="#94a3b8" value={client.address} onChangeText={(t) => setClient(c => ({ ...c, address: t }))} />

              <Text style={[styles.cardTitle, { marginTop: 10 }]}>{tr('quote.products')}</Text>
              {invoiceItems.map((item, index) => (
                <View key={item.id} style={styles.invoiceItemRow}>
                  <TextInput
                    style={[styles.input, { flex: 2, marginBottom: 0 }]}
                    placeholder={tr('quote.description').replace('{number}', String(index + 1))}
                    placeholderTextColor="#94a3b8"
                    value={item.description}
                    onChangeText={(text) => {
                      const updated = [...invoiceItems];
                      updated[index].description = text;
                      setInvoiceItems(updated);
                    }}
                  />
                  <TextInput
                    style={[styles.input, { flex: 1, marginBottom: 0, marginLeft: 6 }]}
                    placeholder={tr('quote.price')}
                    placeholderTextColor="#94a3b8"
                    keyboardType="numeric"
                    value={item.price}
                    onChangeText={(text) => {
                      const updated = [...invoiceItems];
                      updated[index].price = text;
                      setInvoiceItems(updated);
                    }}
                  />
                </View>
              ))}
              <Pressable style={styles.secondaryButton} onPress={() => setInvoiceItems(curr => [...curr, { id: `${Date.now()}`, description: '', price: '' }])}>
                <Text style={styles.secondaryButtonText}>+ {tr('quote.add')}</Text>
              </Pressable>

              <TextInput
                style={[styles.input, { marginTop: 10 }]}
                placeholder={tr('quote.vatInput')}
                placeholderTextColor="#94a3b8"
                keyboardType="numeric"
                value={invoiceIvaInput}
                onChangeText={setInvoiceIvaInput}
              />

              <Pressable style={styles.primaryButton} onPress={submitClientModal}>
                <Text style={styles.primaryButtonText}>{tr('invoice.continue')}</Text>
              </Pressable>
              <Pressable style={[styles.secondaryButton, { marginTop: 8 }]} onPress={() => setClientModalVisible(false)}>
                <Text style={styles.secondaryButtonText}>{tr('common.cancel')}</Text>
              </Pressable>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* MODAL: DETALLE DE TICKET SELECCIONADO */}
      <Modal visible={selectedTicket !== null} animationType="slide" transparent={true}
        onRequestClose={() => setSelectedTicket(null)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { maxHeight: '80%' }]}>
            <ScrollView>
              {selectedTicket && (
                <>
                  <Text style={styles.modalTitle}>{tr('ticket.detail')}</Text>
                  <Text style={styles.modalSubtitle}>{tr('workflow.reference')}: {selectedTicket.ticketCode}</Text>
                  <Text style={styles.modalSubtitle}>{tr('workflow.date')}: {formatUiDate(selectedTicket.createdAt)}</Text>
                  <Text style={styles.modalSubtitle}>{tr('workflow.type')}: {documentTypeLabel(selectedTicket.documentType)}</Text>
                  {selectedTicket.refundHistory && selectedTicket.refundHistory.length > 0 && (
                    <View style={{ marginVertical: 8, padding: 8, backgroundColor: '#fff7ed', borderRadius: 4 }}>
                      <Text style={{ fontWeight: 'bold', fontSize: 11 }}>{documentTypeLabel('COMPRA/DEVOLUCIONES')}</Text>
                      <Text style={{ fontSize: 10 }}>{tr('ticket.original')}: {formatUiCurrency(selectedTicket.originalAmount ?? selectedTicket.amount)}</Text>
                      {selectedTicket.refundHistory.map((refund, index) => (
                        <Text key={`${refund.date}-${index}`} style={{ fontSize: 10 }}>{tr('ticket.refundLine').replace('{number}', String(index + 1))}: -{formatUiCurrency(refund.amount)}</Text>
                      ))}
                      <Text style={{ fontWeight: 'bold', fontSize: 11, marginTop: 3 }}>{tr('ticket.balance')}: {formatUiCurrency(selectedTicket.amount)}</Text>
                    </View>
                  )}
                  {selectedTicket.client && (
                    <View style={{ marginVertical: 8, padding: 8, backgroundColor: '#f1f5f9', borderRadius: 4 }}>
                      <Text style={{ fontWeight: 'bold', fontSize: 11 }}>{tr('workflow.client')}: {selectedTicket.client.name || tr('workflow.generalClient')}</Text>
                      <Text style={{ fontSize: 10 }}>{tr('workflow.taxId')}: {selectedTicket.client.nif}</Text>
                      <Text style={{ fontSize: 10 }}>{selectedTicket.client.address}</Text>
                    </View>
                  )}
                  {selectedTicket.items && selectedTicket.items.length > 0 && (
                    <View style={{ marginVertical: 6 }}>
                      <Text style={{ fontWeight: 'bold', fontSize: 11, marginBottom: 4 }}>{tr('ticket.items')}:</Text>
                      {selectedTicket.items.map(it => (
                        <Text key={it.id} style={{ fontSize: 10, color: '#334155' }}>- {it.description}: {formatUiCurrency(parseFloat(it.price.replace(',', '.')) || 0)}</Text>
                      ))}
                    </View>
                  )}
                  <View style={{ borderTopWidth: 1, borderColor: '#cbd5e1', marginTop: 10, paddingTop: 10 }}>
                    {selectedTicket.type === 'DEVOLUCIÓN' && selectedTicket.relatedTicketCode ? (
                      <Text style={styles.modalSubtitle}>{tr('ticket.originalReceipt')}: {selectedTicket.relatedTicketCode}</Text>
                    ) : null}
                    {selectedTicket.type === 'DEVOLUCIÓN' && selectedTicket.originalAmount !== undefined ? (
                      <>
                        <Text style={styles.modalSubtitle}>{tr('ticket.original')}: {formatUiCurrency(selectedTicket.originalAmount)}</Text>
                        <Text style={styles.modalSubtitle}>{tr('ticket.refunded')}: {formatUiCurrency(selectedTicket.amount)}</Text>
                        <Text style={styles.modalSubtitle}>{tr('ticket.balance')}: {formatUiCurrency(selectedTicket.originalAmount - selectedTicket.amount)}</Text>
                      </>
                    ) : null}
                    <Text style={styles.modalSubtitle}>{tr(selectedTicket.type === 'DEVOLUCIÓN' ? 'ticket.refunded' : 'ticket.taxBase')}: {formatUiCurrency(selectedTicket.subtotal)}</Text>
                    <Text style={styles.modalSubtitle}>{tr('workflow.vat')} ({selectedTicket.ivaRateApplied}%): {formatUiCurrency(selectedTicket.iva)}</Text>
                    <Text style={[styles.modalSubtitle, { fontWeight: 'bold', fontSize: 13, color: '#0f172a' }]}>
                      {tr(selectedTicket.type === 'DEVOLUCIÓN' ? 'ticket.refunded' : 'ticket.balance')}: {formatUiCurrency(selectedTicket.amount)}
                    </Text>
                  </View>

                  <View style={{ alignItems: 'center', marginTop: 16, paddingTop: 12, borderTopWidth: 1, borderColor: '#cbd5e1' }}>
                    <Text style={[styles.modalSubtitle, { fontWeight: 'bold', color: '#0f172a' }]}>{tr('ticket.qr')}</Text>
                    {selectedTicket.publicUrl ? (
                      <Image
                        source={{ uri: getTransactionQrUrl(selectedTicket)! }}
                        style={{ width: 180, height: 180, marginVertical: 8 }}
                      />
                    ) : (
                      <View style={{ alignItems: 'center', marginVertical: 12 }}>
                        <Text style={[styles.modalSubtitle, { textAlign: 'center', color: terminalError ? '#b91c1c' : '#b45309', fontWeight: 'bold' }]}>
                          {tr(terminalError ? 'ticket.qrFailed' : 'ticket.qrLoading')}
                        </Text>
                        <Text style={[styles.modalSubtitle, { textAlign: 'center', color: '#64748b', marginTop: 4 }]}>
                          {terminalError || tr('ticket.publishing')}
                        </Text>
                        {terminalError ? (
                          <Pressable
                            style={[styles.secondaryButton, { marginTop: 8 }]}
                            onPress={() => void registerTransactionDocument(selectedTicket)}
                          >
                            <Text style={styles.secondaryButtonText}>{tr('ticket.retry')}</Text>
                          </Pressable>
                        ) : null}
                      </View>
                    )}
                    <Text style={[styles.modalSubtitle, { textAlign: 'center' }]}>{tr('ticket.code')}: {selectedTicket.ticketCode}</Text>
                    <Text style={[styles.modalSubtitle, { textAlign: 'center', color: '#64748b' }]}>{tr('ticket.qrHint')}</Text>
                  </View>

                  <Pressable style={[styles.primaryButton, { marginTop: 15 }]} onPress={() => generateAndSharePdf(selectedTicket)}>
                    <Text style={styles.primaryButtonText}>📄 {tr('ticket.share')}</Text>
                  </Pressable>
                  <Pressable style={[styles.secondaryButton, { marginTop: 8 }]} onPress={() => sendByEmail(selectedTicket)}>
                    <Text style={styles.secondaryButtonText}>✉️ {tr('ticket.emailManager')}</Text>
                  </Pressable>
                  <Pressable style={[styles.secondaryButton, { marginTop: 8, backgroundColor: '#fee2e2' }]} onPress={() => setSelectedTicket(null)}>
                    <Text style={[styles.secondaryButtonText, { color: '#dc2626' }]}>{tr('common.close')}</Text>
                  </Pressable>
                </>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* MODAL: DETALLE DE GASTO SELECCIONADO */}
      <Modal visible={selectedExpense !== null} animationType="slide" transparent={true}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { maxHeight: '80%' }]}>
            <ScrollView>
              {selectedExpense && (
                <>
                  <Text style={styles.modalTitle}>{tr('expense.detail')}</Text>
                  <Text style={styles.modalSubtitle}>{tr('workflow.reference')}: {selectedExpense.expenseCode}</Text>
                  <Text style={styles.modalSubtitle}>{tr('workflow.provider')}: {selectedExpense.provider}</Text>
                  <Text style={styles.modalSubtitle}>{tr('workflow.date')}: {formatUiDate(selectedExpense.createdAt)}</Text>
                  <Text style={[styles.modalSubtitle, { fontWeight: 'bold', fontSize: 14, color: '#0f172a', marginVertical: 8 }]}>{tr('workflow.amount')}: {formatUiCurrency(selectedExpense.amount)}</Text>
                  
                  {selectedExpense.imageUri && (
                    <Image source={{ uri: selectedExpense.imageUri }} style={{ width: '100%', height: 250, resizeMode: 'contain', marginVertical: 10, borderRadius: 6 }} />
                  )}

                  <Pressable style={[styles.primaryButton, { marginTop: 15 }]} onPress={() => generateAndShareExpensePdf(selectedExpense)}>
                    <Text style={styles.primaryButtonText}>📄 {tr('expense.share')}</Text>
                  </Pressable>
                  <Pressable style={[styles.secondaryButton, { marginTop: 8, backgroundColor: '#fee2e2' }]} onPress={() => setSelectedExpense(null)}>
                    <Text style={[styles.secondaryButtonText, { color: '#dc2626' }]}>{tr('common.close')}</Text>
                  </Pressable>
                </>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* MODAL: DEVOLUCIÓN PARCIAL DE TICKET ESCANEADO */}
      <Modal visible={partialRefundModalVisible} animationType="fade" transparent={true}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>DEVOLUCIÓN PARCIAL</Text>
            <Text style={styles.modalSubtitle}>Saldo actual disponible: {ticketToPartialRefund ? formatCurrency(ticketToPartialRefund.amount) : ''}</Text>
            <TextInput
              style={styles.input}
              placeholder="Importe parcial a devolver €"
              placeholderTextColor="#94a3b8"
              keyboardType="numeric"
              value={partialAmountInput}
              onChangeText={setPartialAmountInput}
            />
            <Pressable
              style={[styles.primaryButton, { backgroundColor: '#ea580c', marginTop: 10 }]}
              onPress={() => {
                const val = parseFloat(partialAmountInput.replace(',', '.'));
                if (isNaN(val) || val <= 0) {
                  Alert.alert('Importe inválido', 'Introduce un importe válido.');
                  return;
                }
                if (ticketToPartialRefund) {
                  applyRefundToTicket(ticketToPartialRefund, val);
                  setPartialRefundModalVisible(false);
                  setTicketToPartialRefund(null);
                }
              }}
            >
              <Text style={styles.primaryButtonText}>Aplicar Devolución Parcial</Text>
            </Pressable>
            <Pressable style={[styles.secondaryButton, { marginTop: 8 }]} onPress={() => setPartialRefundModalVisible(false)}>
              <Text style={styles.secondaryButtonText}>Cancelar</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* MODAL: AUTORIZACIÓN DEL JEFE */}
      <Modal visible={pinModalVisible} animationType="fade" transparent={true}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>🔐 AUTORIZACIÓN DEL JEFE</Text>
            <Text style={styles.modalSubtitle}>Esta devolución necesita el PIN del usuario principal.</Text>
            <TextInput
              style={styles.input}
              placeholder="PIN del jefe"
              placeholderTextColor="#94a3b8"
              keyboardType="number-pad"
              secureTextEntry
              maxLength={6}
              value={ownerPinInput}
              onChangeText={(value) => setOwnerPinInput(value.replace(/[^0-9]/g, ''))}
              autoFocus
            />
            <Pressable style={[styles.primaryButton, { marginTop: 10 }]} onPress={confirmRefundPin}>
              <Text style={styles.primaryButtonText}>Autorizar devolución</Text>
            </Pressable>
            <Pressable style={[styles.secondaryButton, { marginTop: 8 }]} onPress={() => { setPinModalVisible(false); setPendingRefund(null); }}>
              <Text style={styles.secondaryButtonText}>Cancelar</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* MODAL: USUARIOS Y PERMISOS */}
      <Modal visible={userPermissionsModalVisible} animationType="fade" transparent={true}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { width: '92%', maxWidth: 460 }]}>
            <Text style={styles.modalTitle}>👥 USUARIOS Y PERMISOS</Text>
            <Text style={styles.modalSubtitle}>Ajusta el perfil activo y la seguridad del usuario principal.</Text>

            {companyPinConfigured === true ? <Text style={[styles.emptyText, { textAlign: 'left', marginTop: 10, color: '#166534' }]}>PIN principal configurado y activo. Los empleados se crean desde Configuración con un código de acceso.</Text> : null}

            {!(companyPinConfigured === true || ownerPin) ? (
              <View style={{ marginTop: 12 }}>
                <Text style={[styles.modalSubtitle, { fontWeight: 'bold', color: '#0f172a' }]}>Crear PIN principal</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Nuevo PIN (4-6 dígitos)"
                  placeholderTextColor="#94a3b8"
                  keyboardType="number-pad"
                  secureTextEntry
                  maxLength={6}
                  value={ownerPinSetupNew}
                  onChangeText={(value) => setOwnerPinSetupNew(value.replace(/[^0-9]/g, ''))}
                />
                <TextInput
                  style={styles.input}
                  placeholder="Confirmar PIN"
                  placeholderTextColor="#94a3b8"
                  keyboardType="number-pad"
                  secureTextEntry
                  maxLength={6}
                  value={ownerPinSetupConfirm}
                  onChangeText={(value) => setOwnerPinSetupConfirm(value.replace(/[^0-9]/g, ''))}
                />
                <Pressable style={[styles.primaryButton, { marginTop: 8 }]} onPress={handleSetupOwnerPin}>
                  <Text style={styles.primaryButtonText}>Guardar PIN principal</Text>
                </Pressable>
              </View>
            ) : (
              <View style={{ marginTop: 12 }}>
                <Text style={[styles.modalSubtitle, { fontWeight: 'bold', color: '#0f172a' }]}>Cambiar PIN principal</Text>
                <TextInput
                  style={styles.input}
                  placeholder="PIN actual"
                  placeholderTextColor="#94a3b8"
                  keyboardType="number-pad"
                  secureTextEntry
                  maxLength={6}
                  value={ownerPinChangeCurrent}
                  onChangeText={(value) => setOwnerPinChangeCurrent(value.replace(/[^0-9]/g, ''))}
                />
                <TextInput
                  style={styles.input}
                  placeholder="Nuevo PIN (4-6 dígitos)"
                  placeholderTextColor="#94a3b8"
                  keyboardType="number-pad"
                  secureTextEntry
                  maxLength={6}
                  value={ownerPinChangeNew}
                  onChangeText={(value) => setOwnerPinChangeNew(value.replace(/[^0-9]/g, ''))}
                />
                <TextInput
                  style={styles.input}
                  placeholder="Confirmar nuevo PIN"
                  placeholderTextColor="#94a3b8"
                  keyboardType="number-pad"
                  secureTextEntry
                  maxLength={6}
                  value={ownerPinChangeConfirm}
                  onChangeText={(value) => setOwnerPinChangeConfirm(value.replace(/[^0-9]/g, ''))}
                />
                <Pressable style={[styles.primaryButton, { marginTop: 8 }]} onPress={handleChangeOwnerPin}>
                  <Text style={styles.primaryButtonText}>Actualizar PIN</Text>
                </Pressable>
              </View>
            )}

            <Pressable
              style={[styles.secondaryButton, { marginTop: 12, backgroundColor: '#eff6ff', borderColor: '#bfdbfe' }]}
              onPress={() => setRecoverySectionVisible((visible) => !visible)}
            >
              <Text style={styles.secondaryButtonText}>{recoverySectionVisible ? 'Ocultar recuperación de acceso' : 'Recuperación de acceso'}</Text>
            </Pressable>

            {recoverySectionVisible ? (
              <View style={{ marginTop: 8, padding: 10, borderRadius: 8, backgroundColor: '#eff6ff', borderWidth: 1, borderColor: '#bfdbfe' }}>
                <Text style={[styles.modalSubtitle, { color: '#475569' }]}>Añade un email o teléfono para recuperar el PIN si lo olvidas.</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Email de recuperación"
                  placeholderTextColor="#94a3b8"
                  keyboardType="email-address"
                  value={ownerRecoveryEmail}
                  onChangeText={setOwnerRecoveryEmail}
                />
                <TextInput
                  style={styles.input}
                  placeholder="Teléfono de recuperación"
                  placeholderTextColor="#94a3b8"
                  keyboardType="phone-pad"
                  value={ownerRecoveryPhone}
                  onChangeText={setOwnerRecoveryPhone}
                />
                <Pressable style={[styles.secondaryButton, { marginTop: 8, backgroundColor: '#dbeafe' }]} onPress={handleRecoveryRequest}>
                  <Text style={styles.secondaryButtonText}>Guardar datos de recuperación</Text>
                </Pressable>
                {ownerRecoveryCode ? (
                  <Text style={[styles.emptyText, { textAlign: 'left', marginTop: 8, color: '#0f766e' }]}>Código temporal: {ownerRecoveryCode}</Text>
                ) : null}
              </View>
            ) : null}

            <Pressable style={[styles.secondaryButton, { marginTop: 14 }]} onPress={() => setUserPermissionsModalVisible(false)}>
              <Text style={styles.secondaryButtonText}>Cerrar</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* MODAL: ENVÍO DE INFORME AL GESTOR POR RANGO DE FECHAS (Global) */}
      <Modal visible={managerModalVisible} animationType="fade" transparent={true}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>📤 ENVIAR INFORME AL GESTOR</Text>
            <Text style={styles.modalSubtitle}>Introduce el rango de fechas (YYYY-MM-DD):</Text>
            <TextInput
              style={styles.input}
              placeholder="Fecha Inicio (ej: 2026-01-01)"
              placeholderTextColor="#94a3b8"
              value={startDateInput}
              onChangeText={setStartDateInput}
            />
            <TextInput
              style={styles.input}
              placeholder="Fecha Fin (ej: 2026-03-31)"
              placeholderTextColor="#94a3b8"
              value={endDateInput}
              onChangeText={setEndDateInput}
            />
            <Pressable style={[styles.primaryButton, { backgroundColor: '#0f172a', marginTop: 10 }]} onPress={sendManagerReportByEmail}>
              <Text style={styles.primaryButtonText}>Generar y Enviar Informe</Text>
            </Pressable>
            <Pressable style={[styles.secondaryButton, { marginTop: 8 }]} onPress={() => setManagerModalVisible(false)}>
              <Text style={styles.secondaryButtonText}>Cancelar</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* MODAL: INFORME CONSOLIDADO DE TICKETS, FACTURAS Y GASTOS */}
      <Modal visible={transactionReportModalVisible} animationType="fade" transparent={true}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>📄 {tr('report.combined')}</Text>
            <Text style={styles.modalSubtitle}>{tr('report.periodInput')}</Text>
            <TextInput
              style={styles.input}
              placeholder={tr('report.start')}
              placeholderTextColor="#94a3b8"
              value={transactionStartDateInput}
              onChangeText={setTransactionStartDateInput}
            />
            <TextInput
              style={styles.input}
              placeholder={tr('report.end')}
              placeholderTextColor="#94a3b8"
              value={transactionEndDateInput}
              onChangeText={setTransactionEndDateInput}
            />
            <Pressable style={[styles.primaryButton, { backgroundColor: '#0284c7', marginTop: 10 }]} onPress={sendCombinedReportByEmail}>
              <Text style={styles.primaryButtonText}>{tr('report.sendCombined')}</Text>
            </Pressable>
            <Pressable style={[styles.secondaryButton, { marginTop: 8 }]} onPress={showPeriodDetails}>
              <Text style={styles.secondaryButtonText}>{tr('report.viewPeriod')}</Text>
            </Pressable>
            <Pressable style={[styles.secondaryButton, { marginTop: 8 }]} onPress={() => setTransactionReportModalVisible(false)}>
              <Text style={styles.secondaryButtonText}>{tr('common.cancel')}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* MODAL: DETALLES DEL PERIODO SELECCIONADO */}
      <Modal visible={periodDetails !== null} animationType="slide" transparent={true}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { maxHeight: '85%' }]}>
            <ScrollView>
              {periodDetails && (
                <>
                  <Text style={styles.modalTitle}>{tr('report.periodDetails')}</Text>
                  <Text style={styles.modalSubtitle}>{tr('report.range').replace('{start}', periodDetails.startLabel).replace('{end}', periodDetails.endLabel)}</Text>
                  <View style={{ marginVertical: 10, padding: 10, backgroundColor: '#f1f5f9', borderRadius: 6 }}>
                    <Text style={styles.modalSubtitle}>{tr('reports.charges')} {formatUiCurrency(periodDetails.totalIncome)}</Text>
                    <Text style={styles.modalSubtitle}>{tr('reports.refunds')} {formatUiCurrency(periodDetails.totalRefunds)}</Text>
                    <Text style={styles.modalSubtitle}>{tr('reports.expenses')} {formatUiCurrency(periodDetails.totalExpenses)}</Text>
                    <Text style={[styles.modalSubtitle, { fontWeight: 'bold' }]}>{tr('report.totalVat')}: {formatUiCurrency(periodDetails.totalIncome - periodDetails.totalRefunds - periodDetails.totalExpenses)}</Text>
                  </View>
                  <Text style={styles.cardTitle}>{tr('report.documents').replace('{count}', String(periodDetails.transactions.length))}</Text>
                  {periodDetails.transactions.length === 0 ? (
                    <Text style={styles.emptyText}>{tr('report.noDocuments')}</Text>
                  ) : periodDetails.transactions.map((transaction) => (
                    <View key={transaction.id} style={styles.listItem}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.listItemTitle}>{transaction.ticketCode}</Text>
                        <Text style={styles.listItemSubtitle}>{documentTypeLabel(transaction.documentType)} · {formatUiDate(transaction.createdAt)}</Text>
                        {transaction.refundHistory?.map((refund, index) => (
                          <Text key={`${refund.date}-${index}`} style={styles.listItemSubtitle}>{tr('ticket.refundLine').replace('{number}', String(index + 1))}: -{formatUiCurrency(refund.amount)}</Text>
                        ))}
                      </View>
                      <Text style={styles.listItemAmount}>{formatUiCurrency(transaction.type === 'COBRO' ? (transaction.originalAmount ?? transaction.amount) : transaction.amount)}</Text>
                    </View>
                  ))}
                  <Text style={[styles.cardTitle, { marginTop: 12 }]}>{tr('expense.list').replace('{count}', String(periodDetails.expenses.length))}</Text>
                  {periodDetails.expenses.length === 0 ? (
                    <Text style={styles.emptyText}>{tr('report.noExpenses')}</Text>
                  ) : periodDetails.expenses.map((expense) => (
                    <View key={expense.id} style={styles.listItem}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.listItemTitle}>{expense.expenseCode}</Text>
                        <Text style={styles.listItemSubtitle}>{expense.provider} · {formatUiDate(expense.createdAt)}</Text>
                      </View>
                      <Text style={styles.listItemAmount}>{formatUiCurrency(expense.amount)}</Text>
                    </View>
                  ))}
                  <Pressable style={[styles.secondaryButton, { marginTop: 12 }]} onPress={() => setPeriodDetails(null)}>
                    <Text style={styles.secondaryButtonText}>{tr('report.back')}</Text>
                  </Pressable>
                </>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* NUEVO MODAL: INFORME ESPECÍFICO DE GASTOS */}
      <Modal visible={expenseReportModalVisible} animationType="fade" transparent={true}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>📄 {tr('report.expenses')}</Text>
            <Text style={styles.modalSubtitle}>{tr('report.choosePeriod')}</Text>
            <View style={{ flexDirection: 'row', gap: 6, marginVertical: 10 }}>
              <Pressable style={[styles.secondaryButton, { flex: 1, paddingHorizontal: 6 }]} onPress={() => setExpenseReportPeriod('day')}>
                <Text style={[styles.secondaryButtonText, { fontSize: 12 }]}>{tr('reports.day')}</Text>
              </Pressable>
              <Pressable style={[styles.secondaryButton, { flex: 1, paddingHorizontal: 6 }]} onPress={() => setExpenseReportPeriod('week')}>
                <Text style={[styles.secondaryButtonText, { fontSize: 12 }]}>{tr('reports.week')}</Text>
              </Pressable>
              <Pressable style={[styles.secondaryButton, { flex: 1, paddingHorizontal: 6 }]} onPress={() => setExpenseReportPeriod('month')}>
                <Text style={[styles.secondaryButtonText, { fontSize: 12 }]}>{tr('reports.month')}</Text>
              </Pressable>
            </View>
            <TextInput
              style={styles.input}
              placeholder={tr('report.start')}
              placeholderTextColor="#94a3b8"
              value={expenseStartDateInput}
              onChangeText={setExpenseStartDateInput}
            />
            <TextInput
              style={styles.input}
              placeholder={tr('report.end')}
              placeholderTextColor="#94a3b8"
              value={expenseEndDateInput}
              onChangeText={setExpenseEndDateInput}
            />
            <Pressable style={[styles.primaryButton, { backgroundColor: '#0284c7', marginTop: 10 }]} onPress={sendExpenseSpecificReport}>
              <Text style={styles.primaryButtonText}>{tr('report.sendExpenses')}</Text>
            </Pressable>
            <Pressable style={[styles.secondaryButton, { marginTop: 8 }]} onPress={() => setExpenseReportModalVisible(false)}>
              <Text style={styles.secondaryButtonText}>{tr('common.cancel')}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#f1f5f9' },
  header: { paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#ffffff', borderBottomWidth: 1, borderColor: '#cbd5e1' },
  headerTitle: { fontSize: 16, fontWeight: 'bold', color: '#0f172a' },
  headerSubtitle: { fontSize: 12, color: '#64748b' },
  tabContainer: { flexGrow: 0, backgroundColor: '#ffffff', borderBottomWidth: 1, borderColor: '#cbd5e1' },
  tabContent: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  tabButton: { minWidth: 108, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 8, alignItems: 'center', backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0' },
  tabButtonActive: { backgroundColor: '#0f172a', borderColor: '#0f172a' },
  tabText: { fontSize: 11, fontWeight: '600', color: '#64748b' },
  tabTextActive: { fontSize: 11, fontWeight: 'bold', color: '#ffffff' },
  content: { flex: 1 },
  scrollContent: { padding: 16 },
  card: { backgroundColor: '#ffffff', borderRadius: 8, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: '#cbd5e1' },
  cardTitle: { fontSize: 13, fontWeight: 'bold', color: '#0f172a', marginBottom: 12 },
  segmentedControl: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  segmentButton: { flex: 1, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: '#cbd5e1', backgroundColor: '#f8fafc', alignItems: 'center' },
  segmentButtonActive: { backgroundColor: '#0f172a', borderColor: '#0f172a' },
  segmentButtonText: { fontSize: 11, color: '#334155', fontWeight: 'bold' },
  segmentButtonTextActive: { color: '#ffffff' },
  chartWrapper: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', height: 150, gap: 8 },
  chartColumn: { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
  chartStack: { width: '100%', height: 120, justifyContent: 'flex-end', alignItems: 'center', borderRadius: 8, backgroundColor: '#f8fafc', paddingHorizontal: 4, paddingBottom: 4 },
  chartLabel: { fontSize: 10, color: '#64748b', marginTop: 6 },
  chartLegendRow: { flexDirection: 'row', justifyContent: 'center', gap: 16, marginTop: 12 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 10, height: 10, borderRadius: 999 },
  legendText: { fontSize: 11, color: '#334155' },
  input: { borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 6, paddingHorizontal: 12, paddingVertical: 10, fontSize: 13, color: '#0f172a', marginBottom: 10, backgroundColor: '#fff' },
  primaryButton: { backgroundColor: '#0f172a', borderRadius: 6, paddingVertical: 12, alignItems: 'center', marginTop: 6 },
  primaryButtonText: { color: '#ffffff', fontSize: 13, fontWeight: 'bold' },
  secondaryButton: { borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 6, paddingVertical: 10, alignItems: 'center', marginTop: 6, backgroundColor: '#f8fafc' },
  secondaryButtonText: { color: '#334155', fontSize: 12, fontWeight: 'bold' },
  rowButtons: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  previewContainer: { alignItems: 'center', marginVertical: 10 },
  previewImage: { width: 100, height: 100, borderRadius: 6, resizeMode: 'cover' },
  removePhotoText: { color: '#dc2626', fontSize: 11, marginTop: 4 },
  emptyText: { color: '#64748b', fontSize: 12, textAlign: 'center', marginVertical: 10 },
  listItem: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderColor: '#f1f5f9' },
  listItemTitle: { fontSize: 13, fontWeight: 'bold', color: '#0f172a' },
  listItemSubtitle: { fontSize: 11, color: '#64748b' },
  listItemAmount: { fontSize: 13, fontWeight: 'bold', color: '#16a34a' },
  tpvContainer: { flex: 1, padding: 16, justifyContent: 'space-between' },
  displayContainer: { backgroundColor: '#ffffff', borderRadius: 8, padding: 16, borderWidth: 1, borderColor: '#cbd5e1', alignItems: 'flex-end' },
  displayLabel: { fontSize: 10, color: '#64748b', marginBottom: 4 },
  displayText: { fontSize: 32, fontWeight: 'bold', color: '#0f172a' },
  keypad: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  keyButton: { width: '31%', backgroundColor: '#ffffff', borderRadius: 8, paddingVertical: 14, alignItems: 'center', marginBottom: 10, borderWidth: 1, borderColor: '#cbd5e1' },
  keyText: { fontSize: 20, fontWeight: 'bold', color: '#0f172a' },
  actionButtonsContainer: { gap: 8 },
  actionBtnTicket: { backgroundColor: '#16a34a', borderRadius: 6, paddingVertical: 12, alignItems: 'center' },
  actionBtnFactura: { backgroundColor: '#0284c7', borderRadius: 6, paddingVertical: 12, alignItems: 'center' },
  actionBtnFacturaCompleta: { backgroundColor: '#7c3aed', borderRadius: 6, paddingVertical: 12, alignItems: 'center' },
  actionBtnDevolucion: { backgroundColor: '#dc2626', borderRadius: 6, paddingVertical: 12, alignItems: 'center' },
  actionBtnText: { color: '#ffffff', fontSize: 13, fontWeight: 'bold' },
  scanBarRow: { marginTop: 4 },
  scanBarcodeBtn: { backgroundColor: '#475569', borderRadius: 6, paddingVertical: 12, alignItems: 'center' },
  scanBarcodeText: { color: '#ffffff', fontSize: 12, fontWeight: 'bold' },
  modalContainer: { flex: 1, backgroundColor: '#000000', justifyContent: 'center', alignItems: 'center' },
  modalTitle: { fontSize: 15, fontWeight: 'bold', color: '#0f172a', marginBottom: 8, textAlign: 'center' },
  modalSubtitle: { fontSize: 12, color: '#64748b', marginBottom: 12, textAlign: 'center' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 20 },
  modalContent: { backgroundColor: '#ffffff', borderRadius: 12, padding: 20, borderWidth: 1, borderColor: '#cbd5e1' },
  errorText: { color: '#ffffff', fontSize: 14, textAlign: 'center' },
  invoiceItemRow: { flexDirection: 'row', marginBottom: 8, alignItems: 'center' },
  statRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
  statLabel: { fontSize: 12, color: '#334155' },
  statValue: { fontSize: 12, fontWeight: 'bold' },
});
