import AsyncStorage from '@react-native-async-storage/async-storage';
import { requestNeededAndroidPermissions, useStripeTerminal } from '@stripe/stripe-terminal-react-native';
import { Camera, CameraView } from 'expo-camera';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import * as MailComposer from 'expo-mail-composer';
import * as Print from 'expo-print';
import * as SecureStore from 'expo-secure-store';
import * as Sharing from 'expo-sharing';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Image,
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

type DocumentType = 'TICKET DE VENTA' | 'FACTURA SIMPLIFICADA' | 'FACTURA COMPLETA' | 'TICKET DE DEVOLUCIÓN' | 'COMPRA/DEVOLUCIONES' | 'PRESUPUESTO' | 'FACTURA';
type TransactionType = 'COBRO' | 'DEVOLUCIÓN';
type Tab = 'gastos_facturacion' | 'tpv' | 'presupuesto' | 'stats' | 'config';
type UserRole = 'principal' | 'empleado';
type AuthenticatedUser = { app_metadata?: { role?: unknown } };

type Client = { name: string; nif: string; address: string };
type Issuer = {
  name: string;
  nif: string;
  address: string;
  logoUri?: string;
  managerEmail?: string;
  accountHolder?: string;
  iban?: string;
  bankName?: string;
  country?: string;
  additionalUsers?: number;
};
type InvoiceItem = { id: string; description: string; price: string };
type PendingInvoice = { client: Client; items: InvoiceItem[]; ivaRate: number; total: number; docType: DocumentType };
type StripeTerminalPaymentIntentResult = { paymentIntentId?: string; clientSecret?: string; error?: string };

const configuredDocumentApiUrl = process.env.EXPO_PUBLIC_DOCUMENT_API_URL?.replace(/\/$/, '');
const DOCUMENT_API_URL_CANDIDATES = configuredDocumentApiUrl ? [configuredDocumentApiUrl] : [];
const STRIPE_TERMINAL_LOCATION_ID = process.env.EXPO_PUBLIC_STRIPE_TERMINAL_LOCATION_ID?.trim();

const fetchWithTimeout = async (url: string, options: RequestInit = {}, timeoutMs = 1500) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
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
  refundHistory?: { amount: number; date: string }[];
  publicUrl?: string;
}

interface CashInvoiceDraft extends Transaction {
  documentType: 'FACTURA';
}

const initialIssuer: Issuer = {
  name: 'COMERCIO LOCAL AUTÓNOMO S.L.',
  nif: 'B98765432',
  address: 'Calle Mayor 45, Santander',
  logoUri: undefined,
  managerEmail: 'gestor@tugestoria.com',
  accountHolder: 'Comercio Local Autónomo S.L.',
  iban: 'ES9121000418450200051332',
  bankName: 'Banco Santander',
  country: 'ES',
  additionalUsers: 0,
};

function sha256Hex(ascii: string): string {
  function rightRotate(value: number, amount: number) {
    return (value >>> amount) | (value << (32 - amount));
  }
  let result = '';
  const words: number[] = [];
  const asciiLength = ascii.length * 8;
  let hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ];
  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  let i = 0;
  for (i = 0; i < ascii.length; i++) {
    words[i >> 2] |= ascii.charCodeAt(i) << ((3 - (i % 4)) * 8);
  }
  words[asciiLength >> 5] |= 0x80 << ((3 - ((asciiLength >> 3) % 4)) * 8);
  words[(((asciiLength + 64) >> 9) << 4) + 15] = asciiLength;

  for (i = 0; i < words.length; i += 16) {
    const w = words.slice(i, i + 16);
    const oldHash = hash.slice(0);
    for (let j = 0; j < 64; j++) {
      if (j >= 16) {
        const s0 = rightRotate(w[j - 15], 7) ^ rightRotate(w[j - 15], 18) ^ (w[j - 15] >>> 3);
        const s1 = rightRotate(w[j - 2], 17) ^ rightRotate(w[j - 2], 19) ^ (w[j - 2] >>> 10);
        w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0;
      }
      const ch = (hash[4] & hash[5]) ^ (~hash[4] & hash[6]);
      const maj = (hash[0] & hash[1]) ^ (hash[0] & hash[2]) ^ (hash[1] & hash[2]);
      const temp1 = hash[7] + (rightRotate(hash[4], 6) ^ rightRotate(hash[4], 11) ^ rightRotate(hash[4], 25)) + ch + k[j] + (w[j] | 0);
      const temp2 = (rightRotate(hash[0], 2) ^ rightRotate(hash[0], 13) ^ rightRotate(hash[0], 22)) + maj;
      hash[7] = hash[6];
      hash[6] = hash[5];
      hash[5] = hash[4];
      hash[4] = (hash[3] + temp1) | 0;
      hash[3] = hash[2];
      hash[2] = hash[1];
      hash[1] = hash[0];
      hash[0] = (temp1 + temp2) | 0;
    }
    for (let j = 0; j < 8; j++) {
      hash[j] = (hash[j] + oldHash[j]) | 0;
    }
  }
  for (i = 0; i < 8; i++) {
    for (let j = 3; j >= 0; j--) {
      const b = (hash[i] >> (j * 8)) & 0xff;
      result += (b < 16 ? '0' : '') + b.toString(16);
    }
  }
  return result;
}

const STORAGE_KEY_TRANSACTIONS = '@tpv_transactions_v1';
const STORAGE_KEY_CASH_INVOICE_DRAFTS = '@tpv_cash_invoice_drafts_v1';
const STORAGE_KEY_EXPENSES = '@tpv_expenses_v1';
const STORAGE_KEY_ISSUER = '@tpv_issuer_v1';
const STORAGE_KEY_OWNER_PIN = '@tpv_owner_pin_v1';
const STORAGE_KEY_OWNER_RECOVERY_EMAIL = '@tpv_owner_recovery_email_v1';
const STORAGE_KEY_OWNER_RECOVERY_PHONE = '@tpv_owner_recovery_phone_v1';
const AUTH_TOKEN_KEY = 'tpv_access_token';

const roleFromUser = (user?: AuthenticatedUser): UserRole =>
  user?.app_metadata?.role === 'empleado' ? 'empleado' : 'principal';

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(amount);

const formatDate = (isoDate: string) =>
  new Intl.DateTimeFormat('es-ES', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(isoDate));

export default function TpvScreen() {
  const [digits, setDigits] = useState('0');
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [cashInvoiceDrafts, setCashInvoiceDrafts] = useState<CashInvoiceDraft[]>([]);
  const [transactionHistory, setTransactionHistory] = useState<Transaction[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [issuer, setIssuer] = useState<Issuer>(initialIssuer);
  const [userRole, setUserRole] = useState<UserRole>('principal');
  const [ownerPin, setOwnerPin] = useState('');
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
  const [ivaPercentage, setIvaPercentage] = useState('21');
  const [activeTab, setActiveTab] = useState<Tab>('gastos_facturacion');
  const [isProcessing, setIsProcessing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTicket, setSelectedTicket] = useState<Transaction | null>(null);
  const [selectedExpense, setSelectedExpense] = useState<Expense | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authFullName, setAuthFullName] = useState('');
  const [authCompanyName, setAuthCompanyName] = useState('');
  const [authRegistrationRole, setAuthRegistrationRole] = useState<UserRole>('principal');
  const [authEmployeeAccessCode, setAuthEmployeeAccessCode] = useState('');
  const [employeeAccessCode, setEmployeeAccessCode] = useState('');
  const [authError, setAuthError] = useState('');
  const [subscriptionLoading, setSubscriptionLoading] = useState(false);
  const [hasActiveSubscription, setHasActiveSubscription] = useState(false);
  const [subscriptionStatus, setSubscriptionStatus] = useState('missing');
  const [subscriptionAdditionalUsers, setSubscriptionAdditionalUsers] = useState('0');
  const [subscriptionError, setSubscriptionError] = useState('');
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [terminalError, setTerminalError] = useState('');
  const [terminalMessage, setTerminalMessage] = useState('Listo para cobrar con tarjeta o wallet contactless.');

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
      setTerminalMessage(`Acerca la tarjeta o wallet al móvil (${input.join(' / ')}).`);
    },
    onDidRequestReaderDisplayMessage: (message) => {
      setTerminalMessage(String(message));
    },
    onDidChangeConnectionStatus: (status) => {
      if (status === 'connected') setTerminalMessage('Lector Tap to Pay listo.');
      if (status === 'connecting') setTerminalMessage('Preparando lector Tap to Pay...');
      if (status === 'discovering') setTerminalMessage('Buscando compatibilidad Tap to Pay...');
    },
    onDidDisconnect: () => {
      setTerminalMessage('El lector se ha desconectado. Vuelve a iniciar el cobro.');
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

  // Facturas y productos
  const [invoiceItems, setInvoiceItems] = useState<InvoiceItem[]>([{ id: '1', description: '', price: '' }]);
  const [invoiceIvaInput, setInvoiceIvaInput] = useState('21');
  const [pendingInvoice, setPendingInvoice] = useState<PendingInvoice | null>(null);

  // Estados específicos para Presupuesto
  const [presupuestoClient, setPresupuestoClient] = useState<Client>({ name: '', nif: '', address: '' });
  const [presupuestoItems, setPresupuestoItems] = useState<InvoiceItem[]>([{ id: '1', description: '', price: '' }]);
  const [presupuestoIvaInput, setPresupuestoIvaInput] = useState('21');
  const [presupuestoClientEmail, setPresupuestoClientEmail] = useState('');
  const [presupuestoDocumentType, setPresupuestoDocumentType] = useState<'PRESUPUESTO' | 'FACTURA'>('PRESUPUESTO');

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

  // CARGAR DATOS AL INICIAR
  useEffect(() => {
    (async () => {
      try {
        const [
          storedTransactions,
          storedCashInvoiceDrafts,
          storedExpenses,
          storedIssuer,
          storedOwnerPin,
          storedRecoveryEmail,
          storedRecoveryPhone,
        ] = await AsyncStorage.multiGet([
          STORAGE_KEY_TRANSACTIONS,
          STORAGE_KEY_CASH_INVOICE_DRAFTS,
          STORAGE_KEY_EXPENSES,
          STORAGE_KEY_ISSUER,
          STORAGE_KEY_OWNER_PIN,
          STORAGE_KEY_OWNER_RECOVERY_EMAIL,
          STORAGE_KEY_OWNER_RECOVERY_PHONE,
        ]).then((entries) => entries.map(([, value]) => value));

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
              sale.publicUrl = undefined;
            }
          });

          setTransactions(sales);
          void Promise.all(sales.filter((sale) => sale.refundHistory && sale.refundHistory.length > 0).map(async (sale) => {
            const publishedSale = await registerTransactionDocument(sale);
            setTransactions((current) => current.map((transaction) =>
              transaction.id === publishedSale.id ? publishedSale : transaction
            ));
          }));
        }
        if (storedCashInvoiceDrafts) setCashInvoiceDrafts(JSON.parse(storedCashInvoiceDrafts) as CashInvoiceDraft[]);
        if (storedExpenses) setExpenses(JSON.parse(storedExpenses));
        if (storedIssuer) setIssuer(JSON.parse(storedIssuer));
        if (storedOwnerPin) setOwnerPin(storedOwnerPin);
        if (storedRecoveryEmail) setOwnerRecoveryEmail(storedRecoveryEmail);
        if (storedRecoveryPhone) setOwnerRecoveryPhone(storedRecoveryPhone);
      } catch (error) {
        console.error('Error al cargar datos guardados:', error);
      } finally {
        setIsLoaded(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (!accessToken || !configuredDocumentApiUrl) return;

    (async () => {
      setSubscriptionLoading(true);
      try {
        const response = await fetchWithTimeout(`${configuredDocumentApiUrl}/api/billing/status`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        }, 10000);
        const result = await response.json() as { active?: boolean; status?: string; error?: string };
        if (response.status === 401) {
          await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY);
          setAccessToken(null);
          return;
        }
        setHasActiveSubscription(Boolean(result.active));
        setSubscriptionStatus(result.status || 'missing');
        setSubscriptionError(response.ok ? '' : (result.error || 'No se pudo consultar la suscripción.'));
      } catch {
        setSubscriptionError('No se pudo comprobar la suscripción. Comprueba tu conexión.');
      } finally {
        setSubscriptionLoading(false);
      }
    })();
  }, [accessToken]);

  useEffect(() => {
    (async () => {
      const storedToken = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
      if (!storedToken) {
        setAuthLoading(false);
        return;
      }

      try {
        const response = await fetchWithTimeout(`${configuredDocumentApiUrl}/api/auth/me`, {
          headers: { Authorization: `Bearer ${storedToken}` },
        }, 5000);
        if (response.ok) {
          const result = await response.json() as { user?: AuthenticatedUser };
          setUserRole(roleFromUser(result.user));
          setAccessToken(storedToken);
        } else {
          await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY);
        }
      } catch {
        setAccessToken(storedToken);
      } finally {
        setAuthLoading(false);
      }
    })();
  }, []);

  const submitAuth = async () => {
    setAuthError('');
    const email = authEmail.trim().toLowerCase();
    if (!configuredDocumentApiUrl) {
      setAuthError('No hay una URL de backend configurada.');
      return;
    }

    try {
      const response = await fetchWithTimeout(`${configuredDocumentApiUrl}/api/auth/${authMode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
          email,
          password: authPassword,
          fullName: authFullName,
          companyName: authCompanyName,
          role: authRegistrationRole,
          employeeAccessCode: authEmployeeAccessCode,
        }),
      }, 10000);
      const result = await response.json() as { error?: string; user?: AuthenticatedUser; session?: { access_token?: string }; requiresEmailConfirmation?: boolean };

      if (!response.ok) {
        setAuthError(result.error || 'No se pudo completar la operación.');
        return;
      }

      if (authMode === 'register' && result.requiresEmailConfirmation) {
        Alert.alert('Confirma tu email', 'Revisa tu correo para activar la cuenta y después inicia sesión.');
        setAuthMode('login');
        return;
      }

      const token = result.session?.access_token;
      if (!token) {
        setAuthError('El servidor no devolvió una sesión válida.');
        return;
      }

      await SecureStore.setItemAsync(AUTH_TOKEN_KEY, token);
      setUserRole(roleFromUser(result.user));
      setAccessToken(token);
      setAuthPassword('');
    } catch {
      setAuthError('No se pudo conectar con el servidor. Comprueba tu conexión.');
    }
  };

  const signOut = async () => {
    await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY);
    setAccessToken(null);
    setUserRole('principal');
    setAuthPassword('');
  };

  const saveEmployeeAccessCode = async () => {
    if (!accessToken || !configuredDocumentApiUrl) return;
    try {
      const response = await fetchWithTimeout(`${configuredDocumentApiUrl}/api/auth/employee-access-code`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ accessCode: employeeAccessCode }),
      }, 10000);
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || 'No se pudo guardar el código.');
      setEmployeeAccessCode('');
      Alert.alert('Código de empleado guardado', 'Compártelo solo con los empleados que deban acceder al TPV.');
    } catch (error) {
      Alert.alert('No se pudo guardar el código', error instanceof Error ? error.message : 'Inténtalo de nuevo.');
    }
  };

  const startSubscriptionCheckout = async () => {
    if (!accessToken || !configuredDocumentApiUrl) {
      Alert.alert('Sesión requerida', 'Vuelve a iniciar sesión para activar la suscripción.');
      return;
    }
    setCheckoutLoading(true);
    setSubscriptionError('');
    const additionalUsers = Math.max(0, Math.min(50, Number(subscriptionAdditionalUsers) || 0));

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
      const statusResult = await statusResponse.json() as { active?: boolean; status?: string };
      setHasActiveSubscription(Boolean(statusResult.active));
      setSubscriptionStatus(statusResult.status || 'missing');
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
    if (!isLoaded) return;
    AsyncStorage.setItem(STORAGE_KEY_TRANSACTIONS, JSON.stringify(transactions)).catch((error) =>
      console.error('Error al guardar transacciones:', error)
    );
  }, [transactions, isLoaded]);

  useEffect(() => {
    if (!isLoaded) return;
    AsyncStorage.setItem(STORAGE_KEY_CASH_INVOICE_DRAFTS, JSON.stringify(cashInvoiceDrafts)).catch((error) =>
      console.error('Error al guardar facturas pendientes de cobro:', error)
    );
  }, [cashInvoiceDrafts, isLoaded]);

  // GUARDAR GASTOS AUTOMÁTICAMENTE
  useEffect(() => {
    if (!isLoaded) return;
    AsyncStorage.setItem(STORAGE_KEY_EXPENSES, JSON.stringify(expenses)).catch((error) =>
      console.error('Error al guardar gastos:', error)
    );
  }, [expenses, isLoaded]);

  // GUARDAR EMISOR AUTOMÁTICAMENTE
  useEffect(() => {
    if (!isLoaded) return;
    AsyncStorage.setItem(STORAGE_KEY_ISSUER, JSON.stringify(issuer)).catch((error) =>
      console.error('Error al guardar emisor:', error)
    );
  }, [issuer, isLoaded]);

  useEffect(() => {
    if (!isLoaded) return;
    AsyncStorage.setItem(STORAGE_KEY_OWNER_PIN, ownerPin).catch((error) =>
      console.error('Error al guardar el PIN del jefe:', error)
    );
  }, [ownerPin, isLoaded]);

  useEffect(() => {
    if (!isLoaded) return;
    AsyncStorage.setItem(STORAGE_KEY_OWNER_RECOVERY_EMAIL, ownerRecoveryEmail).catch((error) =>
      console.error('Error al guardar el email de recuperación:', error)
    );
  }, [ownerRecoveryEmail, isLoaded]);

  useEffect(() => {
    if (!isLoaded) return;
    AsyncStorage.setItem(STORAGE_KEY_OWNER_RECOVERY_PHONE, ownerRecoveryPhone).catch((error) =>
      console.error('Error al guardar el teléfono de recuperación:', error)
    );
  }, [ownerRecoveryPhone, isLoaded]);

  useEffect(() => {
    if (!isLoaded || transactions.length === 0) return;
    const transactionsNeedingPublication = transactions.filter((transaction) =>
      !transaction.publicUrl || (issuer.logoUri && transaction.issuer.logoUri !== issuer.logoUri)
    );
    if (transactionsNeedingPublication.length === 0) return;

    void Promise.all(transactionsNeedingPublication.map(async (transaction) => {
      const publishedTransaction = await registerTransactionDocument({
        ...transaction,
        issuer: issuer.logoUri ? { ...transaction.issuer, logoUri: issuer.logoUri } : transaction.issuer,
      });
      setTransactions((current) => current.map((item) =>
        item.id === publishedTransaction.id ? publishedTransaction : item
      ));
    }));
  }, [issuer.logoUri, isLoaded, transactions.length]);

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
        setTerminalMessage('Listo para cobrar con tarjeta o wallet contactless.');
      } catch (error) {
        setTerminalError(error instanceof Error ? error.message : 'No se pudo iniciar Stripe Terminal.');
      }
    })();
  }, [accessToken, initialize]);

  const currentIvaRate = Number(ivaPercentage) ? Number(ivaPercentage) / 100 : 0.21;
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

  const subscriptionBasePrice = 9;
  const subscriptionAdditionalUserPrice = 2.5;
  const currentSubscriptionTotal = useMemo(() => {
    const additionalUsers = Math.max(0, Number(issuer.additionalUsers || 0));
    return subscriptionBasePrice + (additionalUsers * subscriptionAdditionalUserPrice);
  }, [issuer.additionalUsers]);

  const requireSubscription = (feature: string) => {
    if (hasActiveSubscription) return true;

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
    const buckets: Array<{ label: string; income: number; expenses: number; net: number; start: Date; end: Date }> = [];

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
        ? new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: '2-digit' }).format(bucketDate)
        : chartGranularity === 'week'
          ? `Sem ${index + 1}`
          : new Intl.DateTimeFormat('es-ES', { month: 'short' }).format(bucketDate);

      buckets.push({ label, income, expenses: expensesAmount, net, start, end });
    }

    return buckets;
  }, [chartGranularity, expenses, transactions]);

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
      Alert.alert('Fecha inválida', 'Comprueba el formato DD/MM/YYYY.');
      return;
    }
    if (start > end) {
      Alert.alert('Rango inválido', 'La fecha de inicio no puede ser posterior a la fecha de fin.');
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
      <Text style={styles.cardTitle}>📜 HISTORIAL DE TRANSACCIONES ({transactionHistory.length})</Text>
      <TextInput
        style={styles.input}
        placeholder="Buscar por código o cliente..."
        placeholderTextColor="#94a3b8"
        value={searchQuery}
        onChangeText={setSearchQuery}
      />
      {transactionHistory.length === 0 ? (
        <Text style={styles.emptyText}>No hay transacciones registradas.</Text>
      ) : (
        transactionHistory.map((t) => (
          <Pressable key={t.id} style={styles.listItem} onPress={() => setSelectedTicket(t)}>
            <View>
              <Text style={styles.listItemTitle}>{t.ticketCode} ({t.documentType})</Text>
              <Text style={styles.listItemSubtitle}>{formatDate(t.createdAt)} • {t.client?.name || 'Cliente General'}</Text>
            </View>
            <Text style={[styles.listItemAmount, t.type === 'DEVOLUCIÓN' && { color: '#dc2626' }]}>
              {t.type === 'DEVOLUCIÓN' ? '-' : ''}{formatCurrency(t.amount)}
            </Text>
          </Pressable>
        ))
      )}
    </View>
  );

  async function registerTransactionDocument(transaction: Transaction): Promise<Transaction> {
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

    let lastError: unknown;
    for (const baseUrl of DOCUMENT_API_URL_CANDIDATES) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await fetchWithTimeout(`${baseUrl}/api/documents`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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

  const createTransaction = useCallback((type: TransactionType, documentType: DocumentType, method: string, customAmount?: number, transactionClient?: Client, customItems?: InvoiceItem[], customIvaRate?: number) => {
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
    };

    setTransactions((current) => [transaction, ...current]);
    setSelectedTicket(transaction);
    setDigits('0');
    setIsProcessing(false);

    setTimeout(async () => {
      const publishedTransaction = await registerTransactionDocument(transaction);
      setTransactions((current) => current.map((item) =>
        item.id === publishedTransaction.id ? publishedTransaction : item
      ));
      setSelectedTicket(publishedTransaction);
    }, 0);
  }, [amount, ivaPercentage, issuer]);

  const startPayment = (documentType: DocumentType) => {
    if (!requireSubscription('realizar cobros')) return;
    if (documentType === 'FACTURA COMPLETA' || documentType === 'FACTURA SIMPLIFICADA') {
      setPendingDocumentType(documentType);
      setClientModalVisible(true);
      return;
    }
    if (amount <= 0) {
      Alert.alert('Importe inválido', 'Introduce una cantidad superior a 0,00 €.');
      return;
    }
    setPendingDocumentType(documentType);
    setNfcModalVisible(true);
  };

  const submitClientModal = () => {
    const validClient = Object.fromEntries(Object.entries(client).map(([key, value]) => [key, value.trim()])) as Client;
    if (!validClient.name || !validClient.nif || !validClient.address) {
      Alert.alert('Datos incompletos', 'Indica nombre, NIF/CIF y dirección fiscal.');
      return;
    }

    const validItems = invoiceItems
      .map(i => ({ ...i, description: i.description.trim(), price: i.price.trim() }))
      .filter(i => i.description !== '' && i.price !== '');

    if (validItems.length === 0) {
      Alert.alert('Sin productos', 'Añade al menos un producto con su descripción y precio.');
      return;
    }

    const subtotal = validItems.reduce((acc, item) => acc + (parseFloat(item.price.replace(',', '.')) || 0), 0);
    if (subtotal <= 0) {
      Alert.alert('Importe inválido', 'El total de los productos debe ser superior a 0,00 €.');
      return;
    }

    const parsedIva = parseFloat(invoiceIvaInput.replace(',', '.')) || 21;
    if (parsedIva < 0 || parsedIva > 100) {
      Alert.alert('IVA inválido', 'Introduce un IVA entre 0 y 100.');
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

  const createStripeTerminalPaymentIntent = async (paymentAmount: number, orderId: string): Promise<string> => {
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
    if (!response.ok || !result.clientSecret) {
      throw new Error(result.error || 'Stripe no devolvió un PaymentIntent para cobro presencial.');
    }

    return result.clientSecret;
  };

  const createTransactionFromConfirmedPayment = (method: string, paymentAmount: number) => {
    setNfcModalVisible(false);

    if (pendingInvoice) {
      createTransaction(
        'COBRO',
        pendingInvoice.docType,
        method,
        paymentAmount,
        pendingInvoice.client,
        pendingInvoice.items,
        pendingInvoice.ivaRate,
      );
      setPendingInvoice(null);
      setClient({ name: '', nif: '', address: '' });
      setInvoiceItems([{ id: '1', description: '', price: '' }]);
      setInvoiceIvaInput('21');
    } else {
      createTransaction('COBRO', pendingDocumentType, method);
    }
  };

  const ensureTapToPayReader = async () => {
    if (!STRIPE_TERMINAL_LOCATION_ID) {
      throw new Error('Falta EXPO_PUBLIC_STRIPE_TERMINAL_LOCATION_ID. Añade el ID de ubicación de Stripe Terminal.');
    }

    if (!isStripeTerminalInitialized) {
      setTerminalMessage('Inicializando Stripe Terminal...');
      const { error } = await initialize();
      if (error) throw new Error(error.message || 'No se pudo iniciar Stripe Terminal.');
    }

    if (connectedReader) return connectedReader;

    setTerminalMessage('Conectando lector Tap to Pay...');
    const connectionResult = await easyConnect({
      discoveryMethod: 'tapToPay',
      // Stripe no permite el lector Tap to Pay real en una app depurable.
      // El lector simulado solo se activa durante el desarrollo local.
      simulated: __DEV__,
      locationId: STRIPE_TERMINAL_LOCATION_ID,
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
      Alert.alert('Sesión requerida', 'Inicia sesión para poder cobrar con Stripe.');
      return;
    }

    const paymentAmount = pendingInvoice ? pendingInvoice.total : amount;
    const orderId = `stripe-terminal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setIsProcessing(true);
    setTerminalError('');
    setTerminalMessage('Preparando cobro contactless...');

    try {
      await ensureTapToPayReader();
      const clientSecret = await createStripeTerminalPaymentIntent(paymentAmount, orderId);
      const retrievedResult = await retrievePaymentIntent(clientSecret);
      if (retrievedResult.error || !retrievedResult.paymentIntent) {
        throw new Error(retrievedResult.error?.message || 'No se pudo preparar el cobro presencial.');
      }

      setTerminalMessage('Acerca la tarjeta, Google Pay, Apple Pay o Samsung Pay al móvil.');
      const collectedResult = await collectPaymentMethod({
        paymentIntent: retrievedResult.paymentIntent,
        customerCancellation: 'disableIfAvailable',
      });
      if (collectedResult.error || !collectedResult.paymentIntent) {
        throw new Error(collectedResult.error?.message || 'No se pudo leer la tarjeta o wallet.');
      }

      setTerminalMessage('Procesando pago contactless...');
      const processedResult = await processPaymentIntent({ paymentIntent: collectedResult.paymentIntent });
      if (processedResult.error || !processedResult.paymentIntent) {
        throw new Error(processedResult.error?.message || 'No se pudo confirmar el cobro presencial.');
      }
      if (processedResult.paymentIntent.status !== 'succeeded') {
        throw new Error(`Stripe Terminal devolvió el estado ${processedResult.paymentIntent.status || 'desconocido'}.`);
      }

      setTerminalMessage('Pago aprobado. Generando ticket...');
      createTransactionFromConfirmedPayment('Stripe Terminal - Contactless', paymentAmount);
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
      Alert.alert('Proveedor requerido', 'Indica el nombre del proveedor o establecimiento del gasto.');
      return;
    }
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      Alert.alert('Importe inválido', 'Introduce un importe válido para el gasto.');
      return;
    }
    if (!expenseImageUri) {
      Alert.alert('Imagen requerida', 'Adjunta la fotografía del ticket o factura del gasto.');
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
    Alert.alert('¡Gasto guardado!', 'El ticket de gasto se ha almacenado correctamente.');
  };

  const generateExpensePdfUri = async (expense: Expense): Promise<string> => {
    const expenseImageBase64 = await convertImageToBase64(expense.imageUri);
    if (!expenseImageBase64) {
      throw new Error('No se pudo convertir la foto del gasto para el PDF.');
    }

    const htmlContent = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <style>
            body { font-family: 'Courier New', Courier, monospace; background-color: #ffffff; color: #000000; margin: 0; padding: 20px; display: flex; justify-content: center; }
            .container { width: 100%; max-width: 600px; background: #fff; padding: 20px; border: 1px solid #cbd5e1; }
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
          </div>
        </body>
      </html>
    `;
    const { uri } = await Print.printToFileAsync({ html: htmlContent });
    return uri;
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
      Alert.alert('Datos incompletos', 'Indica nombre, NIF/CIF y dirección fiscal del cliente.');
      return;
    }
    if (!presupuestoClientEmail.trim()) {
      Alert.alert('Correo requerido', `Introduce el correo electrónico del cliente para enviarle la ${presupuestoDocumentType === 'FACTURA' ? 'factura' : 'presupuesto'}.`);
      return;
    }

    const validItems = presupuestoItems
      .map(i => ({ ...i, description: i.description.trim(), price: i.price.trim() }))
      .filter(i => i.description !== '' && i.price !== '');

    if (validItems.length === 0) {
      Alert.alert('Sin productos', 'Añade al menos un producto con su descripción y precio.');
      return;
    }

    const subtotal = validItems.reduce((acc, item) => acc + (parseFloat(item.price.replace(',', '.')) || 0), 0);
    const parsedIva = parseFloat(presupuestoIvaInput.replace(',', '.')) || 21;
    const totalWithIva = subtotal * (1 + (parsedIva / 100));

    try {
      const isAvailable = await MailComposer.isAvailableAsync();
      if (!isAvailable) {
        Alert.alert('Correo no disponible', 'Este dispositivo no tiene configurado un cliente de correo.');
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

      await MailComposer.composeAsync({
        recipients: [presupuestoClientEmail.trim()],
        subject: `${presupuestoDocumentType === 'FACTURA' ? 'Factura' : 'Presupuesto'} de Servicios - Ref: ${publishedDocument.ticketCode} (${issuer.name})`,
        body: `Estimado/a ${validClient.name},\n\nAdjunto le hacemos llegar la ${presupuestoDocumentType === 'FACTURA' ? 'factura' : 'presupuesto'} solicitada con importe total de ${formatCurrency(totalWithIva)}.\n\nAtentamente,\n${issuer.name}`,
        attachments: [pdfUri],
      });

      Alert.alert('¡Enviado!', `La ${presupuestoDocumentType === 'FACTURA' ? 'factura' : 'presupuesto'} se ha enviado correctamente por correo.`);
    } catch {
      Alert.alert('Error', 'No se pudo generar o enviar el presupuesto por correo.');
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
    Alert.alert('Factura cobrada', 'La factura se ha guardado junto con el resto de cobros del TPV.');
  };

  const deleteCashInvoiceDraft = (draft: CashInvoiceDraft) => {
    Alert.alert(
      'Eliminar factura pendiente',
      `¿Quieres eliminar la factura ${draft.ticketCode}? No se marcará como cobrada.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Eliminar', style: 'destructive', onPress: () => setCashInvoiceDrafts((current) => current.filter((item) => item.id !== draft.id)) },
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
      allowsEditing: true,
      aspect: [1, 1],
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
      allowsEditing: true,
      aspect: [1, 1],
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

  const applyRefundToTicket = async (targetTicket: Transaction, refundVal: number, pinAuthorized = false) => {
    if (userRole === 'empleado' && !pinAuthorized) {
      setPendingRefund({ ticket: targetTicket, amount: refundVal });
      setOwnerPinInput('');
      setPinModalVisible(true);
      return;
    }

    if (targetTicket.type !== 'COBRO') {
      Alert.alert('Acción no permitida', 'Solo se pueden realizar devoluciones sobre tickets de cobro originales.');
      return;
    }
    if (targetTicket.isRefunded || targetTicket.amount <= 0) {
      Alert.alert('⚠️ Devolución bloqueada', `El ticket ${targetTicket.ticketCode} ya no tiene saldo disponible.`);
      return;
    }

    if (refundVal > targetTicket.amount) {
      Alert.alert('Importe excedido', `El importe a devolver no puede superar el saldo actual del ticket (${formatCurrency(targetTicket.amount)}).`);
      return;
    }

    const originalAmount = targetTicket.originalAmount ?? targetTicket.amount;
    const refundedAmount = (targetTicket.refundHistory || []).reduce((sum, refund) => sum + refund.amount, 0);
    const newRefundedAmount = refundedAmount + refundVal;
    const newRemainingAmount = originalAmount - newRefundedAmount;
    const isFullyDepleted = newRemainingAmount <= 0.005;
    const updatedSubtotal = newRemainingAmount / (1 + (targetTicket.ivaRateApplied / 100));
    const refundDate = new Date().toISOString();
    const updatedTicket: Transaction = {
      ...targetTicket,
      documentType: 'COMPRA/DEVOLUCIONES',
      amount: newRemainingAmount,
      originalAmount,
      subtotal: updatedSubtotal,
      iva: newRemainingAmount - updatedSubtotal,
      isRefunded: isFullyDepleted,
      refundHistory: [
        ...(targetTicket.refundHistory || []),
        { amount: refundVal, date: refundDate },
      ],
      publicUrl: undefined,
    };

    const publishedTicket = await registerTransactionDocument(updatedTicket);
    setTransactions((current) => current.map((transaction) =>
      transaction.id === targetTicket.id ? publishedTicket : transaction
    ));
    setSelectedTicket(publishedTicket);
  };

  const confirmRefundPin = () => {
    if (!ownerPin) {
      Alert.alert('PIN no configurado', 'El usuario principal debe configurar primero el PIN en Configuración.');
      setPinModalVisible(false);
      return;
    }
    if (ownerPinInput !== ownerPin) {
      Alert.alert('PIN incorrecto', 'El PIN introducido no es válido.');
      setOwnerPinInput('');
      return;
    }
    const refund = pendingRefund;
    setPinModalVisible(false);
    setPendingRefund(null);
    if (refund) void applyRefundToTicket(refund.ticket, refund.amount, true);
  };

  const handleSetupOwnerPin = () => {
    const trimmedNew = ownerPinSetupNew.trim();
    const trimmedConfirm = ownerPinSetupConfirm.trim();

    if (trimmedNew.length < 4 || trimmedNew.length > 6) {
      Alert.alert('PIN inválido', 'El PIN debe tener entre 4 y 6 dígitos.');
      return;
    }

    if (trimmedNew !== trimmedConfirm) {
      Alert.alert('PIN no coincide', 'La confirmación del PIN no coincide.');
      return;
    }

    setOwnerPin(trimmedNew);
    setOwnerPinSetupNew('');
    setOwnerPinSetupConfirm('');
    Alert.alert('PIN guardado', 'Tu PIN principal se ha configurado correctamente.');
  };

  const handleChangeOwnerPin = () => {
    const current = ownerPinChangeCurrent.trim();
    const next = ownerPinChangeNew.trim();
    const confirm = ownerPinChangeConfirm.trim();

    if (current !== ownerPin) {
      Alert.alert('PIN actual incorrecto', 'El PIN actual no coincide.');
      return;
    }

    if (next.length < 4 || next.length > 6) {
      Alert.alert('PIN inválido', 'El nuevo PIN debe tener entre 4 y 6 dígitos.');
      return;
    }

    if (next !== confirm) {
      Alert.alert('PIN no coincide', 'La confirmación del nuevo PIN no coincide.');
      return;
    }

    setOwnerPin(next);
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
    const qrApiUrl = getTransactionQrUrl(transaction, 140);

    let logoHtml = '';
    if (transaction.issuer.logoUri) {
      console.log('🖼️ Procesando logo para PDF...');
      try {
        const base64Logo = await convertImageToBase64(transaction.issuer.logoUri);
        if (base64Logo && base64Logo.length > 50) {
          console.log('✅ Logo convertido correctamente');
          logoHtml = `<div style="text-align: center; margin-bottom: 15px; padding-top: 10px;"><img src="${base64Logo}" style="width: 85px; height: 85px;" /></div>`;
        } else {
          console.log('❌ Logo base64 no válido, longitud:', base64Logo?.length || 0);
        }
      } catch (logoError) {
        console.log('❌ Error procesando logo:', logoError);
      }
    }

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

    const isA4 = transaction.documentType === 'FACTURA COMPLETA' ||
      transaction.documentType === 'FACTURA' ||
      transaction.documentType === 'PRESUPUESTO';
    const containerStyle = isA4
      ? 'width: 100%; max-width: 600px; background: #fff; padding: 20px; border: 1px solid #cbd5e1;'
      : 'width: 280px; background: #fff; padding: 12px; font-size: 11px;';

    const htmlContent = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <style>
            body { font-family: 'Courier New', Courier, monospace; background-color: #ffffff; color: #000000; margin: 0; padding: 20px; display: flex; justify-content: center; }
            .container { ${containerStyle} }
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
            ${logoHtml}
            <div class="center title">${transaction.issuer.name}</div>
            <div class="center subtitle">NIF: ${transaction.issuer.nif}</div>
            <div class="center subtitle">${transaction.issuer.address}</div>
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
          </div>
        </body>
      </html>
    `;

    console.log('📄 HTML generado, Logo HTML incluido?', logoHtml.length > 0);
    if (logoHtml.length > 0) {
      console.log('   Logo HTML (primeros 100 caracteres):', logoHtml.substring(0, 100));
    }
    console.log('📄 Longitud total HTML:', htmlContent.length);

    const { uri } = await Print.printToFileAsync({ html: htmlContent });
    console.log('✅ PDF generado:', uri);
    return uri;
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
    if (!requireSubscription('enviar informes al gestor')) return;
    if (!startDateInput.trim() || !endDateInput.trim()) {
      Alert.alert('Fechas requeridas', 'Introduce la fecha de inicio y de fin (formato YYYY-MM-DD o DD/MM/YYYY).');
      return;
    }

    const start = parseDateInput(startDateInput);
    const end = parseDateInput(endDateInput);

    if (!start || !end) {
      Alert.alert('Fecha inválida', 'Comprueba el formato de las fechas introducidas.');
      return;
    }

    if (start > end) {
      Alert.alert('Rango inválido', 'La fecha de inicio no puede ser posterior a la fecha de fin.');
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
      Alert.alert('Sin registros', 'No hay transacciones ni gastos en el rango de fechas seleccionado.');
      return;
    }

    const totalIncome = filtered.filter(t => t.type === 'COBRO').reduce((acc, t) => acc + (t.originalAmount ?? t.amount), 0);
    const totalRefunds = filtered.reduce((acc, t) => {
      if (t.type === 'DEVOLUCIÓN') return acc + t.amount;
      return acc + (t.refundHistory || []).reduce((sum, refund) => sum + refund.amount, 0);
    }, 0);
    const totalExp = filteredExpenses.reduce((acc, e) => acc + e.amount, 0);
    const netIncome = totalIncome - totalRefunds;

    const reportHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <style>
            body { font-family: Helvetica, Arial, sans-serif; padding: 20px; color: #1e293b; }
            h1 { font-size: 20px; text-align: center; color: #0f172a; }
            h2 { font-size: 14px; border-bottom: 2px solid #cbd5e1; padding-bottom: 4px; margin-top: 20px; }
            .summary { background: #f8fafc; padding: 12px; border-radius: 6px; margin-bottom: 20px; }
            table { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 10px; }
            th, td { border: 1px solid #cbd5e1; padding: 6px 8px; text-align: left; }
            th { background: #e2e8f0; font-weight: bold; }
          </style>
        </head>
        <body>
          <h1>INFORME DE FACTURACIÓN Y GASTOS PARA TU GESTORÍA</h1>
          <p style="text-align: center; font-size: 12px; color: #64748b;">Periodo: ${startDateInput} al ${endDateInput}</p>
          <p style="text-align: center; font-size: 10px; color: #64748b;">Documento preparado para revisión del gestor. Esta aplicación no sustituye a un asesor fiscal ni a una gestoría.</p>
          
          <div class="summary">
            <strong>Emisor:</strong> ${issuer.name} (NIF: ${issuer.nif})<br/>
            <strong>Total Cobros:</strong> ${formatCurrency(totalIncome)}<br/>
            <strong>Total Devoluciones:</strong> ${formatCurrency(totalRefunds)}<br/>
            <strong>Total Gastos:</strong> ${formatCurrency(totalExp)}<br/>
            <strong>Ventas netas tras devoluciones:</strong> ${formatCurrency(netIncome)}<br/>
            <strong>Balance Neto tras gastos:</strong> ${formatCurrency(netIncome - totalExp)}
          </div>

          <h2>TRANSACCIONES (${filtered.length})</h2>
          <table>
            <tr>
              <th>Ref</th>
              <th>Fecha</th>
              <th>Tipo</th>
              <th>Cliente</th>
              <th>Importe</th>
            </tr>
            ${filtered.map(t => `
              <tr>
                <td>${t.ticketCode}</td>
                <td>${formatDate(t.createdAt)}</td>
                <td>${t.type}</td>
                <td>${t.client?.name || 'General'}</td>
                <td>${formatCurrency(t.type === 'COBRO' ? (t.originalAmount ?? t.amount) : t.amount)}</td>
              </tr>
            `).join('')}
          </table>

          <h2>GASTOS (${filteredExpenses.length})</h2>
          <table>
            <tr>
              <th>Ref</th>
              <th>Fecha</th>
              <th>Proveedor</th>
              <th>Importe</th>
            </tr>
            ${filteredExpenses.map(e => `
              <tr>
                <td>${e.expenseCode}</td>
                <td>${formatDate(e.createdAt)}</td>
                <td>${e.provider}</td>
                <td>${formatCurrency(e.amount)}</td>
              </tr>
            `).join('')}
          </table>
        </body>
      </html>
    `;

    try {
      const { uri } = await Print.printToFileAsync({ html: reportHtml });
      const isAvailable = await MailComposer.isAvailableAsync();
      if (!isAvailable) {
        await Sharing.shareAsync(uri);
        return;
      }

      await MailComposer.composeAsync({
        recipients: [issuer.managerEmail || ''],
        subject: `Informe de facturación y gastos (${startDateInput} a ${endDateInput}) - ${issuer.name}`,
        body: `Adjunto el informe de facturación y gastos del periodo ${startDateInput} al ${endDateInput}, preparado para revisión del gestor.\n\nAtentamente,\n${issuer.name}`,
        attachments: [uri],
      });
      setManagerModalVisible(false);
    } catch {
      Alert.alert('Error', 'No se pudo generar o enviar el informe al gestor.');
    }
  };

  const sendCombinedReportByEmail = async () => {
    if (!requireSubscription('enviar informes consolidados')) return;
    if (!transactionStartDateInput.trim() || !transactionEndDateInput.trim()) {
      Alert.alert('Fechas requeridas', 'Introduce la fecha de inicio y de fin (formato YYYY-MM-DD).');
      return;
    }

    const start = parseDateInput(transactionStartDateInput);
    const end = parseDateInput(transactionEndDateInput);

    if (!start || !end) {
      Alert.alert('Fecha inválida', 'Comprueba el formato de las fechas introducidas.');
      return;
    }

    if (start > end) {
      Alert.alert('Rango inválido', 'La fecha de inicio no puede ser posterior a la fecha de fin.');
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
      Alert.alert('Sin registros', 'No hay tickets, facturas ni gastos en el rango indicado.');
      return;
    }

    const reportHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <style>
            body { font-family: Helvetica, Arial, sans-serif; padding: 20px; color: #1e293b; }
            h1 { font-size: 20px; text-align: center; color: #0f172a; }
            h2 { font-size: 14px; border-bottom: 2px solid #cbd5e1; padding-bottom: 4px; margin-top: 20px; }
            .summary { background: #f8fafc; padding: 12px; border-radius: 6px; margin-bottom: 20px; }
            table { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 10px; }
            th, td { border: 1px solid #cbd5e1; padding: 6px 8px; text-align: left; }
            th { background: #e2e8f0; font-weight: bold; }
          </style>
        </head>
        <body>
          <h1>INFORME CONSOLIDADO DE TICKETS, FACTURAS Y GASTOS</h1>
          <p style="text-align: center; font-size: 12px; color: #64748b;">Periodo: ${transactionStartDateInput} al ${transactionEndDateInput}</p>

          <div class="summary">
            <strong>Emisor:</strong> ${issuer.name} (NIF: ${issuer.nif})<br/>
            <strong>Total Cobros:</strong> ${formatCurrency(totalIncome)}<br/>
            <strong>Total Devoluciones:</strong> ${formatCurrency(totalRefunds)}<br/>
            <strong>Total Gastos:</strong> ${formatCurrency(totalExpenses)}<br/>
            <strong>Total con IVA:</strong> ${formatCurrency(netBalance)}
          </div>

          <h2>TICKETS Y FACTURAS (${filteredTransactions.length})</h2>
          <table>
            <tr>
              <th>Ref</th>
              <th>Fecha</th>
              <th>Tipo</th>
              <th>Cliente</th>
              <th>Importe</th>
            </tr>
            ${filteredTransactions.length === 0 ? '<tr><td colspan="5">Sin transacciones</td></tr>' : filteredTransactions.map(t => `
              <tr>
                <td>${t.ticketCode}</td>
                <td>${formatDate(t.createdAt)}</td>
                <td>${t.type}</td>
                <td>${t.client?.name || 'General'}</td>
                <td>${formatCurrency(t.amount)}</td>
              </tr>
            `).join('')}
          </table>

          <h2>GASTOS (${filteredExpenses.length})</h2>
          <table>
            <tr>
              <th>Ref</th>
              <th>Fecha</th>
              <th>Proveedor</th>
              <th>Importe</th>
            </tr>
            ${filteredExpenses.length === 0 ? '<tr><td colspan="4">Sin gastos</td></tr>' : filteredExpenses.map(e => `
              <tr>
                <td>${e.expenseCode}</td>
                <td>${formatDate(e.createdAt)}</td>
                <td>${e.provider}</td>
                <td>${formatCurrency(e.amount)}</td>
              </tr>
            `).join('')}
          </table>
        </body>
      </html>
    `;

    try {
      const { uri } = await Print.printToFileAsync({ html: reportHtml });
      const isAvailable = await MailComposer.isAvailableAsync();
      if (!isAvailable) {
        await Sharing.shareAsync(uri);
        return;
      }

      await MailComposer.composeAsync({
        recipients: [issuer.managerEmail || ''],
        subject: `Informe Consolidado (${transactionStartDateInput} a ${transactionEndDateInput}) - ${issuer.name}`,
        body: `Adjunto informe consolidado con tickets, facturas y gastos del periodo ${transactionStartDateInput} al ${transactionEndDateInput}.\n\nAtentamente,\n${issuer.name}`,
        attachments: [uri],
      });
      setTransactionReportModalVisible(false);
    } catch {
      Alert.alert('Error', 'No se pudo generar o enviar el informe consolidado.');
    }
  };

  // NUEVA FUNCIÓN: Generar y enviar informe específico desde la pestaña Gastos/Facturación
  const sendExpenseSpecificReport = async () => {
    if (!requireSubscription('enviar informes de gastos')) return;
    if (!expenseStartDateInput.trim() || !expenseEndDateInput.trim()) {
      Alert.alert('Fechas requeridas', 'Introduce la fecha de inicio y de fin (formato DD/MM/YYYY).');
      return;
    }

    const start = parseDateInput(expenseStartDateInput);
    const end = parseDateInput(expenseEndDateInput);

    if (!start || !end) {
      Alert.alert('Fecha inválida', 'Usa el formato DD/MM/YYYY, por ejemplo 07/09/2026.');
      return;
    }

    if (start > end) {
      Alert.alert('Rango inválido', 'La fecha de inicio no puede ser posterior a la fecha de fin.');
      return;
    }

    const endExclusive = new Date(end);
    endExclusive.setHours(23, 59, 59, 999);

    const filteredExpenses = expenses.filter(e => {
      const d = new Date(e.createdAt);
      return d >= start && d <= endExclusive;
    });

    if (filteredExpenses.length === 0) {
      Alert.alert('Sin gastos', 'No hay gastos registrados en el rango de fechas seleccionado.');
      return;
    }

    const totalExp = filteredExpenses.reduce((acc, e) => acc + e.amount, 0);

    const reportHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <style>
            body { font-family: Helvetica, Arial, sans-serif; padding: 20px; color: #1e293b; }
            h1 { font-size: 20px; text-align: center; color: #0f172a; }
            h2 { font-size: 14px; border-bottom: 2px solid #cbd5e1; padding-bottom: 4px; margin-top: 20px; }
            .summary { background: #f8fafc; padding: 12px; border-radius: 6px; margin-bottom: 20px; }
            table { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 10px; }
            th, td { border: 1px solid #cbd5e1; padding: 6px 8px; text-align: left; }
            th { background: #e2e8f0; font-weight: bold; }
          </style>
        </head>
        <body>
          <h1>INFORME DE GASTOS Y FACTURACIÓN</h1>
          <p style="text-align: center; font-size: 12px; color: #64748b;">Periodo: ${expenseStartDateInput} al ${expenseEndDateInput}</p>
          
          <div class="summary">
            <strong>Emisor:</strong> ${issuer.name} (NIF: ${issuer.nif})<br/>
            <strong>Total Gastos en Periodo:</strong> ${formatCurrency(totalExp)}<br/>
            <strong>Número de Registros:</strong> ${filteredExpenses.length}
          </div>

          <h2>LISTADO DE GASTOS (${filteredExpenses.length})</h2>
          <table>
            <tr>
              <th>Ref</th>
              <th>Fecha</th>
              <th>Proveedor</th>
              <th>Importe</th>
            </tr>
            ${filteredExpenses.map(e => `
              <tr>
                <td>${e.expenseCode}</td>
                <td>${formatDate(e.createdAt)}</td>
                <td>${e.provider}</td>
                <td>${formatCurrency(e.amount)}</td>
              </tr>
            `).join('')}
          </table>
        </body>
      </html>
    `;

    try {
      const { uri } = await Print.printToFileAsync({ html: reportHtml });
      const isAvailable = await MailComposer.isAvailableAsync();
      if (!isAvailable) {
        await Sharing.shareAsync(uri);
        return;
      }

      await MailComposer.composeAsync({
        recipients: [issuer.managerEmail || ''],
        subject: `Informe de Gastos (${expenseStartDateInput} a ${expenseEndDateInput}) - ${issuer.name}`,
        body: `Adjunto informe detallado de gastos del periodo ${expenseStartDateInput} al ${expenseEndDateInput}.\n\nAtentamente,\n${issuer.name}`,
        attachments: [uri],
      });
      setExpenseReportModalVisible(false);
    } catch {
      Alert.alert('Error', 'No se pudo generar o enviar el informe de gastos.');
    }
  };

  if (authLoading) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 }}>
          <Text style={styles.modalTitle}>Cargando sesión...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!accessToken) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 24 }}>
          <View style={[styles.card, { padding: 20 }]}>
            <Text style={styles.modalTitle}>TPV & GESTIÓN DE NEGOCIO</Text>
            <Text style={[styles.modalSubtitle, { marginBottom: 18 }]}>Accede a tu cuenta para continuar</Text>
            {authMode === 'register' ? (
              <>
                <TextInput style={styles.input} placeholder="Nombre completo" placeholderTextColor="#94a3b8" value={authFullName} onChangeText={setAuthFullName} />
                <View style={styles.rowButtons}>
                  <Pressable style={[styles.secondaryButton, { flex: 1, backgroundColor: authRegistrationRole === 'principal' ? '#dcfce7' : '#f1f5f9' }]} onPress={() => setAuthRegistrationRole('principal')}>
                    <Text style={styles.secondaryButtonText}>Soy principal</Text>
                  </Pressable>
                  <Pressable style={[styles.secondaryButton, { flex: 1, marginLeft: 8, backgroundColor: authRegistrationRole === 'empleado' ? '#dbeafe' : '#f1f5f9' }]} onPress={() => setAuthRegistrationRole('empleado')}>
                    <Text style={styles.secondaryButtonText}>Soy empleado</Text>
                  </Pressable>
                </View>
                {authRegistrationRole === 'principal' ? (
                  <TextInput style={styles.input} placeholder="Nombre de la empresa" placeholderTextColor="#94a3b8" value={authCompanyName} onChangeText={setAuthCompanyName} />
                ) : (
                  <>
                    <Text style={[styles.modalSubtitle, { textAlign: 'left', marginTop: 10 }]}>Introduce el código que te ha dado el usuario principal. Tu cuenta solo tendrá acceso al TPV.</Text>
                    <TextInput style={styles.input} placeholder="Código de empleado" placeholderTextColor="#94a3b8" autoCapitalize="characters" secureTextEntry value={authEmployeeAccessCode} onChangeText={setAuthEmployeeAccessCode} />
                  </>
                )}
              </>
            ) : null}
            <TextInput style={styles.input} placeholder="Email" placeholderTextColor="#94a3b8" keyboardType="email-address" autoCapitalize="none" value={authEmail} onChangeText={setAuthEmail} />
            <TextInput style={styles.input} placeholder="Contraseña (mínimo 8 caracteres)" placeholderTextColor="#94a3b8" secureTextEntry value={authPassword} onChangeText={setAuthPassword} />
            {authError ? <Text style={{ color: '#b91c1c', fontSize: 12, marginTop: 8 }}>{authError}</Text> : null}
            <Pressable style={[styles.primaryButton, { marginTop: 14 }]} onPress={submitAuth}>
              <Text style={styles.primaryButtonText}>{authMode === 'login' ? 'Iniciar sesión' : 'Crear cuenta'}</Text>
            </Pressable>
            <Pressable style={[styles.secondaryButton, { marginTop: 8 }]} onPress={() => { setAuthMode(authMode === 'login' ? 'register' : 'login'); setAuthError(''); }}>
              <Text style={styles.secondaryButtonText}>{authMode === 'login' ? 'Crear una cuenta nueva' : 'Ya tengo una cuenta'}</Text>
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
            <Text style={styles.headerTitle}>TPV & GESTIÓN DE NEGOCIO</Text>
            <Text style={styles.headerSubtitle}>{issuer.name}</Text>
            {!hasActiveSubscription ? (
              <Pressable onPress={() => void startSubscriptionCheckout()}>
                <Text style={{ color: '#b45309', fontSize: 11, marginTop: 4 }}>Suscripción no activa · activar cuando necesites cobrar o enviar</Text>
              </Pressable>
            ) : null}
          </View>
          <Pressable
            style={{ marginLeft: 10, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 6, backgroundColor: userRole === 'principal' ? '#dcfce7' : '#dbeafe' }}
            onPress={() => { if (userRole === 'principal') setUserPermissionsModalVisible(true); }}
          >
            <Text style={{ fontSize: 11, fontWeight: 'bold', color: '#0f172a' }}>
              {userRole === 'principal' ? 'Principal' : 'Empleado'}
            </Text>
          </Pressable>
        </View>
      </View>

      {/* PESTAÑAS DE NAVEGACIÓN */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tabContent}
        style={styles.tabContainer}
      >
        {userRole === 'principal' && (
          <Pressable style={[styles.tabButton, activeTab === 'gastos_facturacion' && styles.tabButtonActive]} onPress={() => setActiveTab('gastos_facturacion')}>
            <Text style={[styles.tabText, activeTab === 'gastos_facturacion' && styles.tabTextActive]}>Gastos/Facturas</Text>
          </Pressable>
        )}
        <Pressable style={[styles.tabButton, activeTab === 'tpv' && styles.tabButtonActive]} onPress={() => setActiveTab('tpv')}>
          <Text style={[styles.tabText, activeTab === 'tpv' && styles.tabTextActive]}>TPV Caja</Text>
        </Pressable>
        {userRole === 'principal' && (
          <>
            <Pressable style={[styles.tabButton, activeTab === 'presupuesto' && styles.tabButtonActive]} onPress={() => setActiveTab('presupuesto')}>
              <Text style={[styles.tabText, activeTab === 'presupuesto' && styles.tabTextActive]}>Presupuesto/Factura</Text>
            </Pressable>
            <Pressable style={[styles.tabButton, activeTab === 'stats' && styles.tabButtonActive]} onPress={() => setActiveTab('stats')}>
              <Text style={[styles.tabText, activeTab === 'stats' && styles.tabTextActive]}>Informes</Text>
            </Pressable>
            <Pressable style={[styles.tabButton, activeTab === 'config' && styles.tabButtonActive]} onPress={() => { if (requireSubscription('abrir Configuración')) setActiveTab('config'); }}>
              <Text style={[styles.tabText, activeTab === 'config' && styles.tabTextActive]}>Config</Text>
            </Pressable>
          </>
        )}
      </ScrollView>

      <View style={styles.content}>
        {/* PESTAÑA: GASTOS Y FACTURACIÓN */}
        {activeTab === 'gastos_facturacion' && (
          <ScrollView contentContainerStyle={styles.scrollContent}>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>📥 REGISTRAR NUEVO GASTO</Text>
              <TextInput
                style={styles.input}
                placeholder="Nombre del Proveedor / Establecimiento"
                placeholderTextColor="#94a3b8"
                value={expenseProvider}
                onChangeText={setExpenseProvider}
              />
              <TextInput
                style={styles.input}
                placeholder="Importe con IVA (€) ej: 45.90"
                placeholderTextColor="#94a3b8"
                keyboardType="numeric"
                value={expenseAmountInput}
                onChangeText={setExpenseAmountInput}
              />
              <View style={styles.rowButtons}>
                <Pressable style={styles.secondaryButton} onPress={() => pickExpenseImage(true)}>
                  <Text style={styles.secondaryButtonText}>📷 Hacer Foto</Text>
                </Pressable>
                <Pressable style={styles.secondaryButton} onPress={() => pickExpenseImage(false)}>
                  <Text style={styles.secondaryButtonText}>🖼️ Galería</Text>
                </Pressable>
              </View>
              {expenseImageUri && (
                <View style={styles.previewContainer}>
                  <Image source={{ uri: expenseImageUri }} style={styles.previewImage} />
                  <Pressable onPress={() => setExpenseImageUri(null)}>
                    <Text style={styles.removePhotoText}>Eliminar foto</Text>
                  </Pressable>
                </View>
              )}
              <Pressable style={styles.primaryButton} onPress={saveExpense}>
                <Text style={styles.primaryButtonText}>Guardar Gasto</Text>
              </Pressable>
            </View>

            <TransactionHistory />

            <View style={{ marginBottom: 16 }}>
              <Pressable style={[styles.primaryButton, { backgroundColor: '#0284c7' }]} onPress={() => setTransactionReportModalVisible(true)}>
                <Text style={styles.primaryButtonText}>📄 Generar Informe Consolidado (Tickets + Gastos)</Text>
              </Pressable>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>📋 LISTADO DE GASTOS REGISTRADOS ({expenses.length})</Text>
              {expenses.length === 0 ? (
                <Text style={styles.emptyText}>No hay gastos registrados todavía.</Text>
              ) : (
                expenses.map((exp) => (
                  <Pressable key={exp.id} style={styles.listItem} onPress={() => setSelectedExpense(exp)}>
                    <View>
                      <Text style={styles.listItemTitle}>{exp.provider}</Text>
                      <Text style={styles.listItemSubtitle}>{formatDate(exp.createdAt)} • Ref: {exp.expenseCode}</Text>
                    </View>
                    <Text style={styles.listItemAmount}>{formatCurrency(exp.amount)}</Text>
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
              <Text style={styles.displayLabel}>IMPORTE A COBRAR / OPERAR</Text>
              <Text style={styles.displayText}>{formatCurrency(amount)}</Text>
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
                <Text style={styles.actionBtnText}>Ticket Venta</Text>
              </Pressable>
              <Pressable style={styles.actionBtnFactura} onPress={() => startPayment('FACTURA SIMPLIFICADA')}>
                <Text style={styles.actionBtnText}>Factura Simplificada</Text>
              </Pressable>
              <Pressable style={styles.actionBtnFacturaCompleta} onPress={() => startPayment('FACTURA COMPLETA')}>
                <Text style={styles.actionBtnText}>Factura Completa</Text>
              </Pressable>
            </View>

            <View style={styles.scanBarRow}>
              <Pressable style={styles.scanBarcodeBtn} onPress={() => setScannerModalVisible(true)}>
                <Text style={styles.scanBarcodeText}>📷 Escanear Ticket / Código QR para Devolución</Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* PESTAÑA: PRESUPUESTO */}
        {activeTab === 'presupuesto' && (
          <ScrollView contentContainerStyle={styles.scrollContent}>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>📑 CREAR Y ENVIAR DOCUMENTO</Text>
              <View style={styles.rowButtons}>
                <Pressable
                  style={[styles.secondaryButton, { flex: 1, backgroundColor: presupuestoDocumentType === 'PRESUPUESTO' ? '#dbeafe' : '#f8fafc' }]}
                  onPress={() => setPresupuestoDocumentType('PRESUPUESTO')}
                >
                  <Text style={styles.secondaryButtonText}>Presupuesto</Text>
                </Pressable>
                <Pressable
                  style={[styles.secondaryButton, { flex: 1, marginLeft: 8, backgroundColor: presupuestoDocumentType === 'FACTURA' ? '#dcfce7' : '#f8fafc' }]}
                  onPress={() => setPresupuestoDocumentType('FACTURA')}
                >
                  <Text style={styles.secondaryButtonText}>Factura</Text>
                </Pressable>
              </View>
              <Text style={[styles.modalSubtitle, { textAlign: 'left', marginTop: 8 }]}>El documento mantendrá el mismo formato; solo cambiará el título entre presupuesto y factura.</Text>
              <TextInput style={styles.input} placeholder="Nombre del Cliente" placeholderTextColor="#94a3b8" value={presupuestoClient.name} onChangeText={(t) => setPresupuestoClient(c => ({ ...c, name: t }))} />
              <TextInput style={styles.input} placeholder="NIF / CIF del Cliente" placeholderTextColor="#94a3b8" value={presupuestoClient.nif} onChangeText={(t) => setPresupuestoClient(c => ({ ...c, nif: t }))} />
              <TextInput style={styles.input} placeholder="Dirección Fiscal del Cliente" placeholderTextColor="#94a3b8" value={presupuestoClient.address} onChangeText={(t) => setPresupuestoClient(c => ({ ...c, address: t }))} />
              <TextInput style={styles.input} placeholder="Correo electrónico del cliente" placeholderTextColor="#94a3b8" keyboardType="email-address" value={presupuestoClientEmail} onChangeText={setPresupuestoClientEmail} />

              <Text style={[styles.cardTitle, { marginTop: 15 }]}>Productos / Servicios</Text>
              {presupuestoItems.map((item, index) => (
                <View key={item.id} style={styles.invoiceItemRow}>
                  <TextInput
                    style={[styles.input, { flex: 2, marginBottom: 0 }]}
                    placeholder={`Descripción ${index + 1}`}
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
                    placeholder="Precio €"
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
              <Pressable style={styles.secondaryButton} onPress={() => setPresupuestoItems(curr => [...curr, { id: `${Date.now()}`, description: '', price: '' }])}>
                <Text style={styles.secondaryButtonText}>+ Añadir otro producto</Text>
              </Pressable>

              <TextInput
                style={[styles.input, { marginTop: 10 }]}
                placeholder="IVA que aplica al cliente (%)"
                placeholderTextColor="#94a3b8"
                keyboardType="numeric"
                value={presupuestoIvaInput}
                onChangeText={setPresupuestoIvaInput}
              />

              <Pressable style={styles.primaryButton} onPress={sendPresupuestoByEmail}>
                <Text style={styles.primaryButtonText}>Enviar {presupuestoDocumentType === 'FACTURA' ? 'Factura' : 'Presupuesto'} por Email</Text>
              </Pressable>
            </View>

            {cashInvoiceDrafts.length > 0 && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>🧾 FACTURAS EN EFECTIVO PENDIENTES ({cashInvoiceDrafts.length})</Text>
                <Text style={[styles.modalSubtitle, { textAlign: 'left', marginBottom: 10 }]}>Estas facturas aún no están cobradas y no aparecen en el historial del TPV.</Text>
                {cashInvoiceDrafts.map((draft) => (
                  <View key={draft.id} style={[styles.listItem, { flexDirection: 'column', alignItems: 'stretch' }]}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <View>
                        <Text style={styles.listItemTitle}>{draft.ticketCode}</Text>
                        <Text style={styles.listItemSubtitle}>{draft.client?.name || 'Cliente'} · {formatDate(draft.createdAt)}</Text>
                      </View>
                      <Text style={styles.listItemAmount}>{formatCurrency(draft.amount)}</Text>
                    </View>
                    <View style={[styles.rowButtons, { marginTop: 8 }]}>
                      <Pressable style={[styles.primaryButton, { flex: 1, marginTop: 0, backgroundColor: '#16a34a' }]} onPress={() => void markCashInvoiceAsPaid(draft)}>
                        <Text style={styles.primaryButtonText}>Marcar cobrada</Text>
                      </Pressable>
                      <Pressable style={[styles.secondaryButton, { flex: 1, marginLeft: 8, marginTop: 0, backgroundColor: '#fee2e2' }]} onPress={() => deleteCashInvoiceDraft(draft)}>
                        <Text style={[styles.secondaryButtonText, { color: '#dc2626' }]}>Eliminar</Text>
                      </Pressable>
                    </View>
                  </View>
                ))}
              </View>
            )}
          </ScrollView>
        )}

        {/* PESTAÑA: INFORMES Y ESTADÍSTICAS */}
        {activeTab === 'stats' && (
          <ScrollView contentContainerStyle={styles.scrollContent}>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>📊 RESUMEN CONTABLE GLOBAL</Text>
              <View style={styles.statRow}>
                <Text style={styles.statLabel}>Total Cobros:</Text>
                <Text style={[styles.statValue, { color: '#16a34a' }]}>{formatCurrency(totals.charges)}</Text>
              </View>
              <View style={styles.statRow}>
                <Text style={styles.statLabel}>Total Devoluciones / Abonos:</Text>
                <Text style={[styles.statValue, { color: '#dc2626' }]}>{formatCurrency(totals.refunds)}</Text>
              </View>
              <View style={styles.statRow}>
                <Text style={styles.statLabel}>Total Gastos Registrados:</Text>
                <Text style={[styles.statValue, { color: '#ca8a04' }]}>{formatCurrency(totalExpensesAmount)}</Text>
              </View>
              <View style={[styles.statRow, { borderTopWidth: 1, borderColor: '#cbd5e1', paddingTop: 8, marginTop: 4 }]}>
                <Text style={[styles.statLabel, { fontWeight: 'bold' }]}>Balance Neto:</Text>
                <Text style={[styles.statValue, { fontWeight: 'bold', color: '#0f172a' }]}>{formatCurrency(totals.charges - totals.refunds - totalExpensesAmount)}</Text>
              </View>

              <View style={{ marginTop: 12 }}>
                <Text style={styles.emptyText}>Resumen orientativo para controlar ingresos, devoluciones y gastos por periodo.</Text>
              </View>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>📈 EVOLUCIÓN DE GASTOS Y BENEFICIO</Text>
              <View style={styles.segmentedControl}>
                {(['day', 'week', 'month'] as const).map((mode) => (
                  <Pressable
                    key={mode}
                    style={[styles.segmentButton, chartGranularity === mode && styles.segmentButtonActive]}
                    onPress={() => setChartGranularity(mode)}
                  >
                    <Text style={[styles.segmentButtonText, chartGranularity === mode && styles.segmentButtonTextActive]}>
                      {mode === 'day' ? 'Día' : mode === 'week' ? 'Semana' : 'Mes'}
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
                    accessibilityLabel={`Abrir informe de ${item.label}`}
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
                  <Text style={styles.legendText}>Beneficio</Text>
                </View>
                <View style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: '#f97316' }]} />
                  <Text style={styles.legendText}>Gastos</Text>
                </View>
              </View>
            </View>

          </ScrollView>
        )}

        {/* PESTAÑA: CONFIGURACIÓN */}
        {activeTab === 'config' && (
          <ScrollView contentContainerStyle={styles.scrollContent}>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>📦 PLAN TPV & GESTOR</Text>
              <Text style={[styles.modalSubtitle, { textAlign: 'left', marginTop: 6 }]}>La aplicación te ayuda a organizar la información de tu negocio y prepararla para revisión profesional. No sustituye a un asesor fiscal ni a una gestoría.</Text>
              <View style={styles.statRow}>
                <Text style={styles.statLabel}>Usuario principal (base):</Text>
                <Text style={[styles.statValue, { color: '#0f172a', fontWeight: 'bold' }]}>9,00 € + 21% IVA ({formatCurrency(9 * 1.21)})</Text>
              </View>
              <View style={styles.statRow}>
                <Text style={styles.statLabel}>Usuario adicional (empleado):</Text>
                <Text style={[styles.statValue, { color: '#0f172a' }]}>2,50 € + 21% IVA ({formatCurrency(2.5 * 1.21)})</Text>
              </View>
              <View style={[styles.statRow, { borderTopWidth: 1, borderColor: '#cbd5e1', paddingTop: 8, marginTop: 4 }]}>
                <Text style={[styles.statLabel, { fontWeight: 'bold' }]}>Total mensual con IVA:</Text>
                <Text style={[styles.statValue, { color: '#16a34a', fontWeight: 'bold' }]}>{formatCurrency(currentSubscriptionTotal * 1.21)}</Text>
              </View>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>⚙️ DATOS DEL NEGOCIO</Text>
              <Text style={[styles.modalSubtitle, { textAlign: 'left', marginTop: 4 }]}>La aplicación organiza tus facturas y gastos para facilitar su revisión por tu gestoría.</Text>
              <TextInput style={styles.input} placeholder="Nombre Comercial / Razón Social" placeholderTextColor="#94a3b8" value={issuer.name} onChangeText={(t) => setIssuer(i => ({ ...i, name: t }))} />
              <TextInput style={styles.input} placeholder="NIF / CIF" placeholderTextColor="#94a3b8" value={issuer.nif} onChangeText={(t) => setIssuer(i => ({ ...i, nif: t }))} />
              <TextInput style={styles.input} placeholder="Dirección del negocio" placeholderTextColor="#94a3b8" value={issuer.address} onChangeText={(t) => setIssuer(i => ({ ...i, address: t }))} />
              <TextInput style={styles.input} placeholder="Correo electrónico del gestor" placeholderTextColor="#94a3b8" keyboardType="email-address" value={issuer.managerEmail || ''} onChangeText={(t) => setIssuer(i => ({ ...i, managerEmail: t }))} />

              <Text style={[styles.cardTitle, { marginTop: 18 }]}>👥 AÑADIR EMPLEADO</Text>
              <Text style={[styles.modalSubtitle, { textAlign: 'left', marginTop: 4 }]}>Añade una plaza, contrátala con la suscripción y crea un código de un solo uso para el nuevo empleado.</Text>
              <TextInput
                style={styles.input}
                placeholder="Número de empleados adicionales"
                placeholderTextColor="#94a3b8"
                keyboardType="numeric"
                value={String(issuer.additionalUsers || 0)}
                onChangeText={(t) => setIssuer(i => ({ ...i, additionalUsers: Number(t.replace(/[^0-9]/g, '')) || 0 }))}
              />
              <Text style={[styles.modalSubtitle, { textAlign: 'left', marginTop: 8 }]}>Después de añadir plazas de empleado, crea un código distinto del PIN. Cada empleado lo usará una sola vez al registrarse en su móvil.</Text>
              <TextInput
                style={styles.input}
                placeholder="Código para empleados (mínimo 8 caracteres)"
                placeholderTextColor="#94a3b8"
                autoCapitalize="characters"
                secureTextEntry
                value={employeeAccessCode}
                onChangeText={setEmployeeAccessCode}
              />
              <Pressable style={[styles.secondaryButton, { marginTop: 2 }]} onPress={() => void saveEmployeeAccessCode()}>
                <Text style={styles.secondaryButtonText}>Guardar código de empleado</Text>
              </Pressable>

              <Text style={[styles.cardTitle, { marginTop: 18 }]}>💳 COBROS CON STRIPE</Text>
              <Text style={[styles.modalSubtitle, { textAlign: 'left', marginTop: 4 }]}>Las tarjetas online y los cobros por QR se gestionan mediante Stripe. Configura la clave secreta y el webhook en el backend de Render.</Text>

              <Text style={[styles.cardTitle, { marginTop: 15 }]}>🎨 LOGOTIPO DE LA EMPRESA</Text>
              {issuer.logoUri && (
                <View style={styles.previewContainer}>
                  <Image source={{ uri: issuer.logoUri }} style={styles.previewImage} />
                  <Text style={styles.emptyText}>Logo actual</Text>
                </View>
              )}
              {!issuer.logoUri && (
                <View style={[styles.previewContainer, { backgroundColor: '#f8fafc', borderRadius: 8, padding: 20 }]}>
                  <Text style={{ fontSize: 40, marginBottom: 8 }}>📷</Text>
                  <Text style={styles.emptyText}>Sin logotipo configurado</Text>
                </View>
              )}
              <View style={styles.rowButtons}>
                <Pressable style={[styles.secondaryButton, { flex: 1 }]} onPress={captureLogoWithCamera}>
                  <Text style={styles.secondaryButtonText}>📸 Tomar Foto</Text>
                </Pressable>
                <Pressable style={[styles.secondaryButton, { flex: 1, marginLeft: 8 }]} onPress={pickLogoImage}>
                  <Text style={styles.secondaryButtonText}>🖼️ Galería</Text>
                </Pressable>
              </View>
              {issuer.logoUri && (
                <Pressable style={[styles.secondaryButton, { backgroundColor: '#fee2e2' }]} onPress={removeLogo}>
                  <Text style={[styles.secondaryButtonText, { color: '#dc2626' }]}>🗑️ Eliminar Logo</Text>
                </Pressable>
              )}

              <TextInput
                style={[styles.input, { marginTop: 15 }]}
                placeholder="IVA por defecto del negocio (%)"
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
          <Text style={styles.modalTitle}>ESCANEAR TICKET / CÓDIGO QR</Text>
          {hasPermission ? (
            <CameraView
              style={StyleSheet.absoluteFillObject}
              facing="back"
              onBarcodeScanned={scanned ? undefined : handleBarCodeScanned}
            />
          ) : (
            <Text style={styles.errorText}>No se concedieron permisos de cámara.</Text>
          )}
          <Pressable style={[styles.primaryButton, { position: 'absolute', bottom: 30, left: 20, right: 20, backgroundColor: '#dc2626' }]} onPress={() => setScannerModalVisible(false)}>
            <Text style={styles.primaryButtonText}>Cerrar Escáner</Text>
          </Pressable>
        </View>
      </Modal>

      {/* MODAL: COBRO CONTACTLESS CON STRIPE TERMINAL */}
      <Modal visible={nfcModalVisible} animationType="fade" transparent={true}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>💳 COBRO CONTACTLESS</Text>
            <Text style={styles.modalSubtitle}>Importe total a cobrar: {formatCurrency(pendingInvoice ? pendingInvoice.total : amount)}</Text>
            <Text style={[styles.modalSubtitle, { marginBottom: 8 }]}>Acepta tarjeta física sin contacto y wallets NFC como Google Pay, Apple Pay o Samsung Pay acercándolos a este móvil.</Text>
            <Text style={[styles.modalSubtitle, { color: terminalError ? '#b91c1c' : '#166534', fontWeight: 'bold' }]}>{terminalMessage}</Text>

            {terminalError ? <Text style={{ color: '#b91c1c', fontSize: 12, marginTop: 10, textAlign: 'center' }}>{terminalError}</Text> : null}

            <Pressable style={[styles.primaryButton, { backgroundColor: '#0f766e', marginTop: 15 }]} onPress={completePayment} disabled={isProcessing}>
              <Text style={styles.primaryButtonText}>{isProcessing ? 'Procesando...' : 'Cobrar acercando tarjeta o móvil'}</Text>
            </Pressable>

            <Pressable style={[styles.secondaryButton, { marginTop: 12 }]} onPress={cancelPayment}>
              <Text style={styles.secondaryButtonText}>Cancelar</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* MODAL: DATOS DE CLIENTE Y PRODUCTOS PARA FACTURA */}
      <Modal visible={clientModalVisible} animationType="slide" transparent={true}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { maxHeight: '85%' }]}>
            <ScrollView>
              <Text style={styles.modalTitle}>DATOS DE FACTURACIÓN</Text>
              <TextInput style={styles.input} placeholder="Razón Social / Nombre Cliente" placeholderTextColor="#94a3b8" value={client.name} onChangeText={(t) => setClient(c => ({ ...c, name: t }))} />
              <TextInput style={styles.input} placeholder="NIF / CIF" placeholderTextColor="#94a3b8" value={client.nif} onChangeText={(t) => setClient(c => ({ ...c, nif: t }))} />
              <TextInput style={styles.input} placeholder="Dirección Fiscal Completa" placeholderTextColor="#94a3b8" value={client.address} onChangeText={(t) => setClient(c => ({ ...c, address: t }))} />

              <Text style={[styles.cardTitle, { marginTop: 10 }]}>PRODUCTOS / SERVICIOS</Text>
              {invoiceItems.map((item, index) => (
                <View key={item.id} style={styles.invoiceItemRow}>
                  <TextInput
                    style={[styles.input, { flex: 2, marginBottom: 0 }]}
                    placeholder={`Descripción ${index + 1}`}
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
                    placeholder="Precio €"
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
                <Text style={styles.secondaryButtonText}>+ Añadir otra línea</Text>
              </Pressable>

              <TextInput
                style={[styles.input, { marginTop: 10 }]}
                placeholder="IVA que aplica al cliente (%)"
                placeholderTextColor="#94a3b8"
                keyboardType="numeric"
                value={invoiceIvaInput}
                onChangeText={setInvoiceIvaInput}
              />

              <Pressable style={styles.primaryButton} onPress={submitClientModal}>
                <Text style={styles.primaryButtonText}>Continuar al Cobro</Text>
              </Pressable>
              <Pressable style={[styles.secondaryButton, { marginTop: 8 }]} onPress={() => setClientModalVisible(false)}>
                <Text style={styles.secondaryButtonText}>Cancelar</Text>
              </Pressable>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* MODAL: DETALLE DE TICKET SELECCIONADO */}
      <Modal visible={selectedTicket !== null} animationType="slide" transparent={true}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { maxHeight: '80%' }]}>
            <ScrollView>
              {selectedTicket && (
                <>
                  <Text style={styles.modalTitle}>DETALLE DE DOCUMENTO</Text>
                  <Text style={styles.modalSubtitle}>Ref: {selectedTicket.ticketCode}</Text>
                  <Text style={styles.modalSubtitle}>Fecha: {formatDate(selectedTicket.createdAt)}</Text>
                  <Text style={styles.modalSubtitle}>Tipo: {selectedTicket.documentType}</Text>
                  {selectedTicket.refundHistory && selectedTicket.refundHistory.length > 0 && (
                    <View style={{ marginVertical: 8, padding: 8, backgroundColor: '#fff7ed', borderRadius: 4 }}>
                      <Text style={{ fontWeight: 'bold', fontSize: 11 }}>COMPRA/DEVOLUCIONES</Text>
                      <Text style={{ fontSize: 10 }}>Importe original: {formatCurrency(selectedTicket.originalAmount ?? selectedTicket.amount)}</Text>
                      {selectedTicket.refundHistory.map((refund, index) => (
                        <Text key={`${refund.date}-${index}`} style={{ fontSize: 10 }}>Devolución {index + 1}: -{formatCurrency(refund.amount)}</Text>
                      ))}
                      <Text style={{ fontWeight: 'bold', fontSize: 11, marginTop: 3 }}>Saldo restante: {formatCurrency(selectedTicket.amount)}</Text>
                    </View>
                  )}
                  {selectedTicket.client && (
                    <View style={{ marginVertical: 8, padding: 8, backgroundColor: '#f1f5f9', borderRadius: 4 }}>
                      <Text style={{ fontWeight: 'bold', fontSize: 11 }}>Cliente: {selectedTicket.client.name}</Text>
                      <Text style={{ fontSize: 10 }}>NIF: {selectedTicket.client.nif}</Text>
                      <Text style={{ fontSize: 10 }}>{selectedTicket.client.address}</Text>
                    </View>
                  )}
                  {selectedTicket.items && selectedTicket.items.length > 0 && (
                    <View style={{ marginVertical: 6 }}>
                      <Text style={{ fontWeight: 'bold', fontSize: 11, marginBottom: 4 }}>Conceptos:</Text>
                      {selectedTicket.items.map(it => (
                        <Text key={it.id} style={{ fontSize: 10, color: '#334155' }}>- {it.description}: {formatCurrency(parseFloat(it.price.replace(',', '.')) || 0)}</Text>
                      ))}
                    </View>
                  )}
                  <View style={{ borderTopWidth: 1, borderColor: '#cbd5e1', marginTop: 10, paddingTop: 10 }}>
                    {selectedTicket.type === 'DEVOLUCIÓN' && selectedTicket.relatedTicketCode ? (
                      <Text style={styles.modalSubtitle}>Ticket original: {selectedTicket.relatedTicketCode}</Text>
                    ) : null}
                    {selectedTicket.type === 'DEVOLUCIÓN' && selectedTicket.originalAmount !== undefined ? (
                      <>
                        <Text style={styles.modalSubtitle}>Importe original del ticket: {formatCurrency(selectedTicket.originalAmount)}</Text>
                        <Text style={styles.modalSubtitle}>Importe devuelto: {formatCurrency(selectedTicket.amount)}</Text>
                        <Text style={styles.modalSubtitle}>Saldo restante del ticket: {formatCurrency(selectedTicket.originalAmount - selectedTicket.amount)}</Text>
                      </>
                    ) : null}
                    <Text style={styles.modalSubtitle}>{selectedTicket.type === 'DEVOLUCIÓN' ? 'Monto devuelto:' : 'Base Imponible:'} {formatCurrency(selectedTicket.subtotal)}</Text>
                    <Text style={styles.modalSubtitle}>IVA ({selectedTicket.ivaRateApplied}%): {formatCurrency(selectedTicket.iva)}</Text>
                    <Text style={[styles.modalSubtitle, { fontWeight: 'bold', fontSize: 13, color: '#0f172a' }]}>
                      {selectedTicket.type === 'DEVOLUCIÓN' ? 'Importe de la devolución:' : 'Total Restante:'} {formatCurrency(selectedTicket.amount)}
                    </Text>
                  </View>

                  <View style={{ alignItems: 'center', marginTop: 16, paddingTop: 12, borderTopWidth: 1, borderColor: '#cbd5e1' }}>
                    <Text style={[styles.modalSubtitle, { fontWeight: 'bold', color: '#0f172a' }]}>QR DEL DOCUMENTO</Text>
                    {selectedTicket.publicUrl ? (
                      <Image
                        source={{ uri: getTransactionQrUrl(selectedTicket)! }}
                        style={{ width: 180, height: 180, marginVertical: 8 }}
                      />
                    ) : (
                      <View style={{ alignItems: 'center', marginVertical: 12 }}>
                        <Text style={[styles.modalSubtitle, { textAlign: 'center', color: terminalError ? '#b91c1c' : '#b45309', fontWeight: 'bold' }]}>
                          {terminalError ? 'No se pudo generar el QR' : 'Generando QR...'}
                        </Text>
                        <Text style={[styles.modalSubtitle, { textAlign: 'center', color: '#64748b', marginTop: 4 }]}>
                          {terminalError ? terminalError : 'Se está publicando el ticket para que el cliente pueda escanearlo.'}
                        </Text>
                        {terminalError ? (
                          <Pressable
                            style={[styles.secondaryButton, { marginTop: 8 }]}
                            onPress={() => void registerTransactionDocument(selectedTicket)}
                          >
                            <Text style={styles.secondaryButtonText}>Reintentar publicación</Text>
                          </Pressable>
                        ) : null}
                      </View>
                    )}
                    <Text style={[styles.modalSubtitle, { textAlign: 'center' }]}>Código: {selectedTicket.ticketCode}</Text>
                    <Text style={[styles.modalSubtitle, { textAlign: 'center', color: '#64748b' }]}>Al escanear el QR se abrirá el ticket completo. También puedes compartir el PDF por WhatsApp o email.</Text>
                  </View>

                  <Pressable style={[styles.primaryButton, { marginTop: 15 }]} onPress={() => generateAndSharePdf(selectedTicket)}>
                    <Text style={styles.primaryButtonText}>📄 Compartir / Imprimir PDF</Text>
                  </Pressable>
                  <Pressable style={[styles.secondaryButton, { marginTop: 8 }]} onPress={() => sendByEmail(selectedTicket)}>
                    <Text style={styles.secondaryButtonText}>✉️ Enviar al Gestor por Email</Text>
                  </Pressable>
                  <Pressable style={[styles.secondaryButton, { marginTop: 8, backgroundColor: '#fee2e2' }]} onPress={() => setSelectedTicket(null)}>
                    <Text style={[styles.secondaryButtonText, { color: '#dc2626' }]}>Cerrar</Text>
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
                  <Text style={styles.modalTitle}>DETALLE DE GASTO</Text>
                  <Text style={styles.modalSubtitle}>Ref: {selectedExpense.expenseCode}</Text>
                  <Text style={styles.modalSubtitle}>Proveedor: {selectedExpense.provider}</Text>
                  <Text style={styles.modalSubtitle}>Fecha: {formatDate(selectedExpense.createdAt)}</Text>
                  <Text style={[styles.modalSubtitle, { fontWeight: 'bold', fontSize: 14, color: '#0f172a', marginVertical: 8 }]}>Importe: {formatCurrency(selectedExpense.amount)}</Text>
                  
                  {selectedExpense.imageUri && (
                    <Image source={{ uri: selectedExpense.imageUri }} style={{ width: '100%', height: 250, resizeMode: 'contain', marginVertical: 10, borderRadius: 6 }} />
                  )}

                  <Pressable style={[styles.primaryButton, { marginTop: 15 }]} onPress={() => generateAndShareExpensePdf(selectedExpense)}>
                    <Text style={styles.primaryButtonText}>📄 Compartir Gasto PDF</Text>
                  </Pressable>
                  <Pressable style={[styles.secondaryButton, { marginTop: 8, backgroundColor: '#fee2e2' }]} onPress={() => setSelectedExpense(null)}>
                    <Text style={[styles.secondaryButtonText, { color: '#dc2626' }]}>Cerrar</Text>
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

            {ownerPin ? <Text style={[styles.emptyText, { textAlign: 'left', marginTop: 10, color: '#166534' }]}>PIN principal configurado y activo. Los empleados se crean desde Configuración con un código de acceso.</Text> : null}

            {!ownerPin ? (
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
            <Text style={styles.modalTitle}>📄 INFORME CONSOLIDADO DE TICKETS + GASTOS</Text>
            <Text style={styles.modalSubtitle}>Periodo seleccionado (DD/MM/YYYY):</Text>
            <TextInput
              style={styles.input}
              placeholder="Fecha Inicio (ej: 07/09/2026)"
              placeholderTextColor="#94a3b8"
              value={transactionStartDateInput}
              onChangeText={setTransactionStartDateInput}
            />
            <TextInput
              style={styles.input}
              placeholder="Fecha Fin (ej: 30/09/2026)"
              placeholderTextColor="#94a3b8"
              value={transactionEndDateInput}
              onChangeText={setTransactionEndDateInput}
            />
            <Pressable style={[styles.primaryButton, { backgroundColor: '#0284c7', marginTop: 10 }]} onPress={sendCombinedReportByEmail}>
              <Text style={styles.primaryButtonText}>Generar y Enviar Informe Consolidado</Text>
            </Pressable>
            <Pressable style={[styles.secondaryButton, { marginTop: 8 }]} onPress={showPeriodDetails}>
              <Text style={styles.secondaryButtonText}>Ver detalles del periodo</Text>
            </Pressable>
            <Pressable style={[styles.secondaryButton, { marginTop: 8 }]} onPress={() => setTransactionReportModalVisible(false)}>
              <Text style={styles.secondaryButtonText}>Cancelar</Text>
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
                  <Text style={styles.modalTitle}>DETALLES DEL PERIODO</Text>
                  <Text style={styles.modalSubtitle}>Desde {periodDetails.startLabel} hasta {periodDetails.endLabel}</Text>
                  <View style={{ marginVertical: 10, padding: 10, backgroundColor: '#f1f5f9', borderRadius: 6 }}>
                    <Text style={styles.modalSubtitle}>Total cobros: {formatCurrency(periodDetails.totalIncome)}</Text>
                    <Text style={styles.modalSubtitle}>Total devoluciones: {formatCurrency(periodDetails.totalRefunds)}</Text>
                    <Text style={styles.modalSubtitle}>Total gastos: {formatCurrency(periodDetails.totalExpenses)}</Text>
                    <Text style={[styles.modalSubtitle, { fontWeight: 'bold' }]}>Total con IVA: {formatCurrency(periodDetails.totalIncome - periodDetails.totalRefunds - periodDetails.totalExpenses)}</Text>
                  </View>
                  <Text style={styles.cardTitle}>TICKETS Y FACTURAS ({periodDetails.transactions.length})</Text>
                  {periodDetails.transactions.length === 0 ? (
                    <Text style={styles.emptyText}>No hay tickets ni facturas en este periodo.</Text>
                  ) : periodDetails.transactions.map((transaction) => (
                    <View key={transaction.id} style={styles.listItem}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.listItemTitle}>{transaction.ticketCode}</Text>
                        <Text style={styles.listItemSubtitle}>{transaction.documentType} · {formatDate(transaction.createdAt)}</Text>
                        {transaction.refundHistory?.map((refund, index) => (
                          <Text key={`${refund.date}-${index}`} style={styles.listItemSubtitle}>Devolución {index + 1}: -{formatCurrency(refund.amount)}</Text>
                        ))}
                      </View>
                      <Text style={styles.listItemAmount}>{formatCurrency(transaction.type === 'COBRO' ? (transaction.originalAmount ?? transaction.amount) : transaction.amount)}</Text>
                    </View>
                  ))}
                  <Text style={[styles.cardTitle, { marginTop: 12 }]}>GASTOS ({periodDetails.expenses.length})</Text>
                  {periodDetails.expenses.length === 0 ? (
                    <Text style={styles.emptyText}>No hay gastos en este periodo.</Text>
                  ) : periodDetails.expenses.map((expense) => (
                    <View key={expense.id} style={styles.listItem}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.listItemTitle}>{expense.expenseCode}</Text>
                        <Text style={styles.listItemSubtitle}>{expense.provider} · {formatDate(expense.createdAt)}</Text>
                      </View>
                      <Text style={styles.listItemAmount}>{formatCurrency(expense.amount)}</Text>
                    </View>
                  ))}
                  <Pressable style={[styles.secondaryButton, { marginTop: 12 }]} onPress={() => setPeriodDetails(null)}>
                    <Text style={styles.secondaryButtonText}>Volver al informe</Text>
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
            <Text style={styles.modalTitle}>📄 INFORME DE GASTOS POR FECHAS</Text>
            <Text style={styles.modalSubtitle}>Selecciona un periodo o escribe las fechas (DD/MM/YYYY):</Text>
            <View style={{ flexDirection: 'row', gap: 6, marginVertical: 10 }}>
              <Pressable style={[styles.secondaryButton, { flex: 1, paddingHorizontal: 6 }]} onPress={() => setExpenseReportPeriod('day')}>
                <Text style={[styles.secondaryButtonText, { fontSize: 12 }]}>Día</Text>
              </Pressable>
              <Pressable style={[styles.secondaryButton, { flex: 1, paddingHorizontal: 6 }]} onPress={() => setExpenseReportPeriod('week')}>
                <Text style={[styles.secondaryButtonText, { fontSize: 12 }]}>Semana</Text>
              </Pressable>
              <Pressable style={[styles.secondaryButton, { flex: 1, paddingHorizontal: 6 }]} onPress={() => setExpenseReportPeriod('month')}>
                <Text style={[styles.secondaryButtonText, { fontSize: 12 }]}>Mes</Text>
              </Pressable>
            </View>
            <TextInput
              style={styles.input}
              placeholder="Fecha inicio (ej: 07/09/2026)"
              placeholderTextColor="#94a3b8"
              value={expenseStartDateInput}
              onChangeText={setExpenseStartDateInput}
            />
            <TextInput
              style={styles.input}
              placeholder="Fecha fin (ej: 07/09/2026)"
              placeholderTextColor="#94a3b8"
              value={expenseEndDateInput}
              onChangeText={setExpenseEndDateInput}
            />
            <Pressable style={[styles.primaryButton, { backgroundColor: '#0284c7', marginTop: 10 }]} onPress={sendExpenseSpecificReport}>
              <Text style={styles.primaryButtonText}>Generar y Enviar Informe de Gastos</Text>
            </Pressable>
            <Pressable style={[styles.secondaryButton, { marginTop: 8 }]} onPress={() => setExpenseReportModalVisible(false)}>
              <Text style={styles.secondaryButtonText}>Cancelar</Text>
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
