import { REDACTED, TransientSecret } from "./secrets.ts";

export type SensitiveDataKind =
  | "api_key"
  | "identity"
  | "phone"
  | "passport"
  | "payment"
  | "order"
  | "name"
  | "home_address";

const apiKeyValue = /\b(?:sk|ds)-[A-Za-z0-9_-]{12,}\b/g;
const chineseIdentity = /(?<!\d)\d{17}[\dXx](?!\d)/g;
const chinesePhone = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
// Avoid interpreting UUID segments as cards: accept contiguous digits or common
// card groupings, not arbitrary runs of digits separated by hyphens.
const paymentNumber =
  /(?<![\d-])(?:\d{16,19}|\d{4}(?:[ -]\d{4}){3}|\d{4}[ -]\d{6}[ -]\d{5})(?![\d-])/g;
const passportValue =
  /((?:护照(?:号)?|passport(?:\s*(?:number|no))?)\s*[:：#-]?\s*)([A-Za-z0-9]{6,12})/gi;
const orderValue =
  /((?:订单(?:号)?|order(?:\s*(?:id|number|no))?|票号|booking(?:\s*(?:id|number|no))?)[号\s:：#-]*)([A-Za-z0-9-]{8,})/gi;
const personalName =
  /((?:旅客姓名|联系人姓名|真实姓名|姓名|full\s*name|travell?er\s*name|contact\s*name)\s*[:：]\s*)([^\s,，;；]{2,40})/gi;
const homeAddress =
  /((?:家庭住址|住宅地址|home\s*address)\s*[:：]\s*)([^\n]{6,200})/gi;

function resetAndTest(pattern: RegExp, input: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(input);
}

export function detectSensitiveText(
  input: string,
): SensitiveDataKind | undefined {
  if (resetAndTest(apiKeyValue, input)) return "api_key";
  if (resetAndTest(chineseIdentity, input)) return "identity";
  if (resetAndTest(chinesePhone, input)) return "phone";
  if (resetAndTest(passportValue, input)) return "passport";
  if (resetAndTest(orderValue, input)) return "order";
  if (resetAndTest(paymentNumber, input)) return "payment";
  if (resetAndTest(personalName, input)) return "name";
  if (resetAndTest(homeAddress, input)) return "home_address";
  return undefined;
}

export function redactText(input: string): string {
  return input
    .replace(apiKeyValue, REDACTED)
    .replace(chineseIdentity, REDACTED)
    .replace(chinesePhone, REDACTED)
    .replace(passportValue, `$1${REDACTED}`)
    .replace(orderValue, `$1${REDACTED}`)
    .replace(paymentNumber, REDACTED)
    .replace(personalName, `$1${REDACTED}`)
    .replace(homeAddress, `$1${REDACTED}`);
}

export function containsApiKey(input: string): boolean {
  return resetAndTest(apiKeyValue, input);
}

export class SensitivePersistenceError extends Error {
  readonly code = "SENSITIVE_PERSISTENCE_BLOCKED";
  readonly kind?: SensitiveDataKind;

  constructor(kind?: SensitiveDataKind) {
    super("Sensitive personal or credential data cannot be saved");
    this.name = "SensitivePersistenceError";
    this.kind = kind;
  }
}

const SENSITIVE_KEYS = new Map<string, SensitiveDataKind>([
  ["apikey", "api_key"],
  ["authorization", "api_key"],
  ["cookie", "api_key"],
  ["setcookie", "api_key"],
  ["secret", "api_key"],
  ["password", "api_key"],
  ["credential", "api_key"],
  ["token", "api_key"],
  ["accesstoken", "api_key"],
  ["refreshtoken", "api_key"],
  ["authtoken", "api_key"],
  ["card", "payment"],
  ["cardnumber", "payment"],
  ["paymentnumber", "payment"],
  ["identity", "identity"],
  ["identitynumber", "identity"],
  ["idnumber", "identity"],
  ["passport", "passport"],
  ["passportnumber", "passport"],
  ["phone", "phone"],
  ["phonenumber", "phone"],
  ["mobile", "phone"],
  ["mobilenumber", "phone"],
  ["ordernumber", "order"],
  ["bookingnumber", "order"],
  ["bookingid", "order"],
  ["fullname", "name"],
  ["travelername", "name"],
  ["travellername", "name"],
  ["contactname", "name"],
  ["homeaddress", "home_address"],
  ["residentialaddress", "home_address"],
]);

function sensitiveKey(key: string): SensitiveDataKind | undefined {
  return SENSITIVE_KEYS.get(key.replace(/[-_\s]/g, "").toLowerCase());
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

export function findSensitiveData(
  input: unknown,
  seen = new WeakSet<object>(),
): SensitiveDataKind | undefined {
  if (input instanceof TransientSecret) return "api_key";
  if (typeof input === "string") return detectSensitiveText(input);
  if (!input || typeof input !== "object" || seen.has(input)) return undefined;
  seen.add(input);
  if (Array.isArray(input)) {
    for (const value of input) {
      const kind = findSensitiveData(value, seen);
      if (kind) return kind;
    }
    return undefined;
  }
  for (const [key, value] of Object.entries(input)) {
    const keyKind = sensitiveKey(key);
    if (keyKind && present(value)) return keyKind;
    const valueKind = findSensitiveData(value, seen);
    if (valueKind) return valueKind;
  }
  return undefined;
}

export function assertNoSensitiveData(input: unknown): void {
  const kind = findSensitiveData(input);
  if (kind) throw new SensitivePersistenceError(kind);
}

/** Compatibility helper for credential-only callers. */
export function assertNoApiKey(input: unknown): void {
  if (containsApiKey(JSON.stringify(input)))
    throw new SensitivePersistenceError("api_key");
}

export function redactValue(
  input: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (input instanceof TransientSecret) return REDACTED;
  if (typeof input === "string") return redactText(input);
  if (input instanceof Error)
    return { name: input.name, message: redactText(input.message) };
  if (!input || typeof input !== "object") return input;
  if (seen.has(input)) return "[CIRCULAR]";
  seen.add(input);
  if (Array.isArray(input))
    return input.map((value) => redactValue(value, seen));

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    result[key] = sensitiveKey(key) ? REDACTED : redactValue(value, seen);
  }
  return result;
}

export function safeStringify(input: unknown): string {
  try {
    return JSON.stringify(redactValue(input));
  } catch {
    return JSON.stringify({ error: "Unable to serialize safely" });
  }
}
