export const CONNECT_EU_COUNTRIES = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU',
  'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'] as const;
export type ConnectCountry = typeof CONNECT_EU_COUNTRIES[number];

export const normalizeConnectCountry = (value: unknown): ConnectCountry | null => {
  if (typeof value !== 'string') return null;
  const country = value.trim().toUpperCase();
  return CONNECT_EU_COUNTRIES.includes(country as ConnectCountry) ? country as ConnectCountry : null;
};

export const connectCountryLabel = (country: ConnectCountry, locale: string): string => {
  try {
    const runtime = Intl as typeof Intl & { DisplayNames?: new (locales: string[], options: { type: 'region' }) =>
      { of: (code: string) => string | undefined } };
    return runtime.DisplayNames ? new runtime.DisplayNames([locale], { type: 'region' }).of(country) || country : country;
  } catch {
    return country;
  }
};

export const connectErrorKey = (value: unknown): string => {
  if (typeof value !== 'object' || value === null || !('code' in value)) return 'connect.failed';
  switch (value.code) {
    case 'connect_country_requires_supported_onboarding': return 'connect.countryRequiresSupport';
    case 'connect_country_not_approved': return 'connect.countryNotApproved';
    case 'connect_country_mismatch': return 'connect.countryMismatch';
    case 'connect_not_connected': return 'connect.notConnected';
    case 'connect_charges_not_enabled': return 'connect.chargesNotEnabled';
    case 'connect_terminal_location_invalid': return 'connect.terminalLocationInvalid';
    case 'connect_disabled':
    case 'connect_test_disabled': return 'connect.tpvRequiresConnect';
    case 'connect_link_invalid': return 'connect.linkInvalid';
    case 'connect_session_unbound': return 'connect.sessionRequired';
    case 'connect_upstream_unavailable': return 'connect.upstream';
    default: return 'connect.failed';
  }
};

/** Hosts de Account Link / hosted onboarding de Stripe. */
export const isStripeOnboardingHost = (hostname: string): boolean =>
  /^(accounts|onboarding|connect|checkout|billing)\.stripe\.com$/i.test(hostname);

export type ConnectStatusResult = {
  ok: true;
  enabled: boolean;
  livemode: false;
  connected: boolean;
  accountId: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  requirementsPending: boolean;
  directCharges?: boolean;
  phase: 'onboarding_only';
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isTestPhase = (value: Record<string, unknown>) =>
  value.ok === true && value.livemode === false && value.phase === 'onboarding_only';

const isAccountId = (value: unknown): value is string =>
  typeof value === 'string' && /^acct_[A-Za-z0-9]+$/.test(value);

export const parseConnectStatus = (value: unknown): ConnectStatusResult | null => {
  if (!isRecord(value) || !isTestPhase(value) ||
    !['enabled', 'connected', 'chargesEnabled', 'payoutsEnabled', 'requirementsPending']
      .every((key) => typeof value[key] === 'boolean')) return null;
  if (value.connected ? !value.enabled || !isAccountId(value.accountId)
    : value.accountId !== null || value.chargesEnabled || value.payoutsEnabled || value.requirementsPending) return null;
  return value as ConnectStatusResult;
};

export const connectStatusKey = (status: ConnectStatusResult): string => {
  if (!status.enabled) return 'connect.disabled';
  if (!status.connected) return 'connect.notConnected';
  return status.chargesEnabled && status.payoutsEnabled && !status.requirementsPending
    ? 'connect.ready' : 'connect.pending';
};

export const parseConnectOnboardingUrl = (value: unknown, expectedAccountId: string | null, now = Date.now()): string | null => {
  if (!isRecord(value) || !isTestPhase(value) || !isAccountId(value.accountId) ||
    (expectedAccountId !== null && value.accountId !== expectedAccountId) || typeof value.url !== 'string') return null;
  // expiresAt opcional: el backend ya validó el link; si llega, debe ser futuro.
  if (value.expiresAt !== undefined && value.expiresAt !== null) {
    const expires = typeof value.expiresAt === 'number' ? value.expiresAt * 1000
      : typeof value.expiresAt === 'string' ? Date.parse(value.expiresAt) : NaN;
    if (!Number.isFinite(expires) || expires <= now) return null;
  }
  try {
    const url = new URL(value.url);
    // Stripe v2 usa accounts.stripe.com (+ hash). Aceptar cualquier *.stripe.com de un label.
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !isStripeOnboardingHost(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
};