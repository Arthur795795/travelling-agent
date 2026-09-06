/**
 * A validated visitor credential may survive navigation and reloads in one
 * browser tab. sessionStorage supplies that lifecycle: it is not shared with
 * the server or persisted as durable application data.
 */
const DEEPSEEK_SESSION_KEY = "travel-agent:deepseek-credential:v1";

export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface DeepSeekSessionCredential {
  apiKey: string;
  model: string;
}

const validCredential = (
  value: unknown,
): value is { version: 1; apiKey: string; model: string } => {
  if (!value || typeof value !== "object") return false;
  const stored = value as Record<string, unknown>;
  return (
    stored.version === 1 &&
    typeof stored.apiKey === "string" &&
    stored.apiKey.length >= 16 &&
    stored.apiKey.length <= 300 &&
    /^sk-[\w-]+$/.test(stored.apiKey) &&
    typeof stored.model === "string" &&
    stored.model.length > 0 &&
    stored.model.length <= 100
  );
};

export function readDeepSeekSession(
  storage: SessionStorageLike,
): DeepSeekSessionCredential | undefined {
  try {
    const raw = storage.getItem(DEEPSEEK_SESSION_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!validCredential(parsed)) {
      storage.removeItem(DEEPSEEK_SESSION_KEY);
      return undefined;
    }
    return { apiKey: parsed.apiKey, model: parsed.model };
  } catch {
    // Browsers may deny storage in hardened/private contexts. Keep the Key in
    // React memory for that page instead of weakening the security boundary.
    return undefined;
  }
}

export function rememberDeepSeekSession(
  storage: SessionStorageLike,
  credential: DeepSeekSessionCredential,
): boolean {
  if (!validCredential({ version: 1, ...credential })) return false;
  try {
    storage.setItem(
      DEEPSEEK_SESSION_KEY,
      JSON.stringify({ version: 1, ...credential }),
    );
    return true;
  } catch {
    return false;
  }
}

export function clearDeepSeekSession(storage: SessionStorageLike): void {
  try {
    storage.removeItem(DEEPSEEK_SESSION_KEY);
  } catch {
    // The in-memory component state is still cleared by the caller.
  }
}
