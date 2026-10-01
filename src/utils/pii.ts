// Logs are full of numbers that are not PII: epoch timestamps, decimals,
// durations, IPs, hostnames, AWS account ids, ARNs and hex ids. Every numeric
// pattern below therefore refuses to start right after a word character or a
// decimal point, and refuses to end right before one.
const START = String.raw`(?<![\w.])`;
const END = String.raw`(?!\w|\.\d)`;

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// Quoted values of secret-looking keys, in plain or escaped JSON
// (`"password":"x"` or `\"password\":\"x\"`) and in key=value form.
const SECRET_JSON =
  /(\\?"[\w-]*(?:password|passwd|secret|token|api[_-]?key|authorization|private[_-]?key|access[_-]?key)[\w-]*\\?"\s*:\s*\\?")((?:[^"\\]|\\(?!"))*)(\\?")/gi;
const SECRET_PAIR =
  /\b([\w-]*(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key)[\w-]*=)([^\s&"',;]+)/gi;

// The end user's IP address, found only under client IP keys. Infrastructure
// IPs (hosts, _sourcehost, service URLs) are kept for debugging.
const CLIENT_IP_KEYS =
  'http_remote_address|remote_ip|remote_addr|client_ip|x[-_]forwarded[-_]for|ip';
const IP = String.raw`(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]*:[0-9a-f:]+)`;
const CLIENT_IP_JSON = new RegExp(
  `(\\\\?"(?:${CLIENT_IP_KEYS})\\\\?"\\s*:\\s*\\\\?")([^"\\\\]+)(\\\\?")`,
  'gi',
);
const CLIENT_IP_PAIR = new RegExp(
  `\\b((?:${CLIENT_IP_KEYS})\\s*[:=]\\s*)${IP}(?:\\s*,\\s*${IP})*`,
  'gi',
);

// Twilio account SID: half of a Twilio credential pair. Call and conference
// SIDs are kept because they are how calls are traced across systems.
const TWILIO_ACCOUNT_SID = /\bAC[0-9a-f]{32}\b/g;

// 13 to 19 digits, optionally split by single spaces or hyphens. Matches are
// only redacted when they start like a real card and pass the Luhn check.
const CARD = new RegExp(`${START}\\d(?:[ -]?\\d){12,18}${END}`, 'g');

const SSN = /(?<![\w.-])\d{3}-\d{2}-\d{4}(?![\w-])/g;

const PHONE_PATTERNS = [
  // E.164, e.g. +15551234567. Matched on its own first so a following number
  // ("+15551234567 123") is not pulled into the match.
  new RegExp(`(?<![\\w.])\\+\\d{8,15}${END}`, 'g'),
  // International with separators, e.g. +44 20 7946 0958, +1 (555) 123-4567.
  new RegExp(`(?<![\\w.])\\+\\d{1,3}(?:[ .-]\\(?\\d{1,4}\\)?){2,5}${END}`, 'g'),
  // North American with separators, e.g. (555) 123-4567, 555-123-4567,
  // 1-555-123-4567. Bare digit runs are not matched: they are almost always
  // timestamps or ids.
  new RegExp(
    `${START}(?:1[ .-]?)?(?:\\(\\d{3}\\)\\s?|\\d{3}[ .-])\\d{3}[ .-]\\d{4}${END}`,
    'g',
  ),
];

const STREET_SUFFIX =
  'Avenue|Ave|Street|St|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Plaza|Plz|Square|Sq|Way|Place|Pl|Parkway|Pkwy|Highway|Hwy';

const ADDRESS_PATTERNS = [
  // A house number, one to four capitalized words, then a street suffix that
  // is its own word, e.g. "123 Main St" or "42 North Oak Avenue".
  new RegExp(
    `${START}\\d{1,6}(?:\\s+[A-Z][A-Za-z'-]*){1,4}?\\s+(?:${STREET_SUFFIX})\\b\\.?`,
    'g',
  ),
  /\bP\.?O\.?\s*Box\s+\d+\b/gi,
  // UK postcode, e.g. SW1A 1AA.
  /\b[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}\b/g,
  // US ZIP+4 only. A bare 5 digit number is far more often a count or an id.
  new RegExp(`${START}\\d{5}-\\d{4}${END}`, 'g'),
];

const digitsOf = (text: string) => text.replace(/\D/g, '');

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = Number(digits[i]);
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

// Visa, Mastercard, Amex, Discover, Diners, JCB.
const CARD_PREFIX = /^(?:4|5[1-5]|2[2-7]|3[47]|3[068]|35|6(?:011|5|4[4-9]))/;

function isLikelyCard(match: string): boolean {
  const digits = digitsOf(match);
  return (
    digits.length >= 13 &&
    digits.length <= 19 &&
    CARD_PREFIX.test(digits) &&
    passesLuhn(digits)
  );
}

/**
 * Masks sensitive information in a string
 * @param text The text to mask sensitive information in
 * @returns The text with sensitive information masked
 */
export function maskSensitiveInfo(text: string): string {
  if (typeof text !== 'string') return text;

  let masked = text
    .replace(
      SECRET_JSON,
      (_m, open, _value, close) => `${open}[SECRET REDACTED]${close}`,
    )
    .replace(SECRET_PAIR, (_m, key) => `${key}[SECRET REDACTED]`)
    .replace(
      CLIENT_IP_JSON,
      (_m, open, _value, close) => `${open}[IP REDACTED]${close}`,
    )
    .replace(CLIENT_IP_PAIR, (_m, key) => `${key}[IP REDACTED]`)
    .replace(TWILIO_ACCOUNT_SID, '[TWILIO ACCOUNT SID REDACTED]')
    .replace(EMAIL, '[EMAIL REDACTED]')
    .replace(CARD, (m) => (isLikelyCard(m) ? '[CARD NUMBER REDACTED]' : m))
    .replace(SSN, '[SSN REDACTED]');

  for (const pattern of PHONE_PATTERNS) {
    masked = masked.replace(pattern, (m) => {
      const digits = digitsOf(m).length;
      return digits >= 8 && digits <= 15 ? '[PHONE REDACTED]' : m;
    });
  }

  for (const pattern of ADDRESS_PATTERNS) {
    masked = masked.replace(pattern, '[ADDRESS REDACTED]');
  }

  return masked;
}
