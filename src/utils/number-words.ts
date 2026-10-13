import type { AppLocale } from '../i18n';

// Convierte un porcentaje de IVA (0–100, enteros o con decimales) a palabras según el idioma.

const UNITS_ES = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'];
const TEENS_ES = ['diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve'];
const TENS_ES = ['', '', 'veinte', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];

const UNITS_EN = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const TEENS_EN = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS_EN = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

const UNITS_FR = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf'];
const TEENS_FR = ['dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize', 'dix-sept', 'dix-huit', 'dix-neuf'];
const TENS_FR = ['', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante', 'soixante', 'quatre-vingt', 'quatre-vingt'];

const integerWordsEs = (n: number): string => {
  if (n === 100) return 'cien';
  if (n < 10) return UNITS_ES[n];
  if (n < 20) return TEENS_ES[n - 10];
  if (n < 30) {
    const twenty = ['veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'];
    return twenty[n - 20];
  }
  const tens = Math.floor(n / 10);
  const units = n % 10;
  return units === 0 ? TENS_ES[tens] : `${TENS_ES[tens]} y ${UNITS_ES[units]}`;
};

const integerWordsEn = (n: number): string => {
  if (n === 100) return 'one hundred';
  if (n < 10) return UNITS_EN[n];
  if (n < 20) return TEENS_EN[n - 10];
  const tens = Math.floor(n / 10);
  const units = n % 10;
  return units === 0 ? TENS_EN[tens] : `${TENS_EN[tens]}-${UNITS_EN[units]}`;
};

const integerWordsFr = (n: number): string => {
  if (n === 100) return 'cent';
  if (n < 10) return UNITS_FR[n];
  if (n < 20) return TEENS_FR[n - 10];
  if (n < 70) {
    const tens = Math.floor(n / 10);
    const units = n % 10;
    if (units === 0) return TENS_FR[tens];
    if (units === 1 && tens !== 8) return `${TENS_FR[tens]} et un`;
    return `${TENS_FR[tens]}-${UNITS_FR[units]}`;
  }
  if (n < 80) {
    const rest = n - 60;
    return rest === 1 ? 'soixante et onze' : `soixante-${integerWordsFr(rest)}`;
  }
  if (n < 100) {
    const rest = n - 80;
    return rest === 0 ? 'quatre-vingts' : `quatre-vingt-${integerWordsFr(rest)}`;
  }
  return String(n);
};

const integerWordsDe = (n: number): string => {
  const units = ['null', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun'];
  const teens = ['zehn', 'elf', 'zwölf', 'dreizehn', 'vierzehn', 'fünfzehn', 'sechzehn', 'siebzehn', 'achtzehn', 'neunzehn'];
  const tens = ['', '', 'zwanzig', 'dreißig', 'vierzig', 'fünfzig', 'sechzig', 'siebzig', 'achtzig', 'neunzig'];
  if (n === 100) return 'hundert';
  if (n < 10) return units[n];
  if (n < 20) return teens[n - 10];
  const t = Math.floor(n / 10);
  const u = n % 10;
  if (u === 0) return tens[t];
  const unitWord = u === 1 ? 'ein' : units[u];
  return `${unitWord}und${tens[t]}`;
};

const integerWordsIt = (n: number): string => {
  const units = ['zero', 'uno', 'due', 'tre', 'quattro', 'cinque', 'sei', 'sette', 'otto', 'nove'];
  const teens = ['dieci', 'undici', 'dodici', 'tredici', 'quattordici', 'quindici', 'sedici', 'diciassette', 'diciotto', 'diciannove'];
  const tens = ['', '', 'venti', 'trenta', 'quaranta', 'cinquanta', 'sessanta', 'settanta', 'ottanta', 'novanta'];
  if (n === 100) return 'cento';
  if (n < 10) return units[n];
  if (n < 20) return teens[n - 10];
  const t = Math.floor(n / 10);
  const u = n % 10;
  if (u === 0) return tens[t];
  if (u === 1 || u === 8) return `${tens[t].slice(0, -1)}${units[u]}`;
  return `${tens[t]}${units[u]}`;
};

const integerWordsPt = (n: number): string => {
  const units = ['zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove'];
  const teens = ['dez', 'onze', 'doze', 'treze', 'catorze', 'quinze', 'dezasseis', 'dezassete', 'dezoito', 'dezanove'];
  const tens = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
  if (n === 100) return 'cem';
  if (n < 10) return units[n];
  if (n < 20) return teens[n - 10];
  const t = Math.floor(n / 10);
  const u = n % 10;
  return u === 0 ? tens[t] : `${tens[t]} e ${units[u]}`;
};

const integerWordsNl = (n: number): string => {
  const units = ['nul', 'een', 'twee', 'drie', 'vier', 'vijf', 'zes', 'zeven', 'acht', 'negen'];
  const teens = ['tien', 'elf', 'twaalf', 'dertien', 'veertien', 'vijftien', 'zestien', 'zeventien', 'achttien', 'negentien'];
  const tens = ['', '', 'twintig', 'dertig', 'veertig', 'vijftig', 'zestig', 'zeventig', 'tachtig', 'negentig'];
  if (n === 100) return 'honderd';
  if (n < 10) return units[n];
  if (n < 20) return teens[n - 10];
  const t = Math.floor(n / 10);
  const u = n % 10;
  if (u === 0) return tens[t];
  return `${units[u]}en${tens[t]}`;
};

const integerWordsPl = (n: number): string => {
  const units = ['zero', 'jeden', 'dwa', 'trzy', 'cztery', 'pięć', 'sześć', 'siedem', 'osiem', 'dziewięć'];
  const teens = ['dziesięć', 'jedenaście', 'dwanaście', 'trzynaście', 'czternaście', 'piętnaście', 'szesnaście', 'siedemnaście', 'osiemnaście', 'dziewiętnaście'];
  const tens = ['', '', 'dwadzieścia', 'trzydzieści', 'czterdzieści', 'pięćdziesiąt', 'sześćdziesiąt', 'siedemdziesiąt', 'osiemdziesiąt', 'dziewięćdziesiąt'];
  if (n === 100) return 'sto';
  if (n < 10) return units[n];
  if (n < 20) return teens[n - 10];
  const t = Math.floor(n / 10);
  const u = n % 10;
  return u === 0 ? tens[t] : `${tens[t]} ${units[u]}`;
};

const integerWords = (locale: AppLocale, n: number): string => {
  switch (locale) {
    case 'es': return integerWordsEs(n);
    case 'fr': return integerWordsFr(n);
    case 'de': return integerWordsDe(n);
    case 'it': return integerWordsIt(n);
    case 'pt': return integerWordsPt(n);
    case 'nl': return integerWordsNl(n);
    case 'pl': return integerWordsPl(n);
    default: return integerWordsEn(n);
  }
};

const decimalSeparatorWord = (locale: AppLocale): string => {
  switch (locale) {
    case 'es':
    case 'pt':
      return 'coma';
    case 'fr':
      return 'virgule';
    case 'de':
      return 'komma';
    case 'it':
      return 'virgola';
    case 'nl':
      return 'komma';
    case 'pl':
      return 'przecinek';
    default:
      return 'point';
  }
};

/** Parsea "21" / "21,5" y devuelve palabras (p. ej. "veintiuno"). Si no es válido, cadena vacía. */
export const vatRateInWords = (locale: AppLocale, raw: string): string => {
  const normalized = String(raw || '').trim().replace(',', '.');
  if (!normalized) return '';
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0 || value > 100) return '';
  const rounded = Math.round(value * 100) / 100;
  const whole = Math.trunc(rounded);
  const cents = Math.round((rounded - whole) * 100);
  if (cents === 0) return integerWords(locale, whole);
  const frac = cents % 10 === 0 ? cents / 10 : cents;
  return `${integerWords(locale, whole)} ${decimalSeparatorWord(locale)} ${integerWords(locale, frac)}`;
};
