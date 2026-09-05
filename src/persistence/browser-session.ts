export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const SESSION_KEY = "travel-agent:session";
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;

interface StoredSession {
  storageVersion: 1;
  expiresAt: string;
  value: string;
}

export class BrowserSessionStore {
  private readonly storage: StorageLike;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(
    storage: StorageLike,
    now = () => new Date(),
    createId: () => string = () => crypto.randomUUID(),
  ) {
    this.storage = storage;
    this.now = now;
    this.createId = createId;
  }

  getOrCreate(): string {
    const raw = this.storage.getItem(SESSION_KEY);
    if (raw) {
      try {
        const stored = JSON.parse(raw) as Partial<StoredSession>;
        if (
          stored.storageVersion === 1 &&
          typeof stored.expiresAt === "string" &&
          Date.parse(stored.expiresAt) > this.now().getTime() &&
          typeof stored.value === "string" &&
          stored.value.length > 0
        )
          return stored.value;
      } catch {
        // Invalid product storage is replaced below.
      }
      this.storage.removeItem(SESSION_KEY);
    }

    const value = this.createId();
    const stored: StoredSession = {
      storageVersion: 1,
      expiresAt: new Date(this.now().getTime() + THIRTY_DAYS_MS).toISOString(),
      value,
    };
    this.storage.setItem(SESSION_KEY, JSON.stringify(stored));
    return value;
  }
}
