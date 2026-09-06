import assert from "node:assert/strict";
import test from "node:test";
import {
  clearDeepSeekSession,
  readDeepSeekSession,
  rememberDeepSeekSession,
  type SessionStorageLike,
} from "../../src/security/deepseek-session.ts";

class MemoryStorage implements SessionStorageLike {
  readonly values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

test("a validated DeepSeek Key is scoped to the supplied tab session store", () => {
  const tabSession = new MemoryStorage();
  const durableLocalStorage = new MemoryStorage();
  const credential = {
    apiKey: "sk-session-0123456789abcdef",
    model: "deepseek-v4-pro",
  };

  assert.equal(rememberDeepSeekSession(tabSession, credential), true);
  assert.deepEqual(readDeepSeekSession(tabSession), credential);
  assert.equal(durableLocalStorage.values.size, 0);

  // A newly opened tab has a new sessionStorage and therefore no credential.
  assert.equal(readDeepSeekSession(new MemoryStorage()), undefined);
  clearDeepSeekSession(tabSession);
  assert.equal(readDeepSeekSession(tabSession), undefined);
});

test("invalid, malformed and unavailable session storage fails closed", () => {
  const invalid = new MemoryStorage();
  invalid.setItem("travel-agent:deepseek-credential:v1", "not-json");
  assert.equal(readDeepSeekSession(invalid), undefined);

  const rejected = {
    getItem: () => {
      throw new Error("storage detail");
    },
    setItem: () => {
      throw new Error("storage detail");
    },
    removeItem: () => {
      throw new Error("storage detail");
    },
  } satisfies SessionStorageLike;
  assert.equal(readDeepSeekSession(rejected), undefined);
  assert.equal(
    rememberDeepSeekSession(rejected, {
      apiKey: "sk-session-0123456789abcdef",
      model: "deepseek-v4-pro",
    }),
    false,
  );
  assert.equal(
    rememberDeepSeekSession(invalid, {
      apiKey: "not-a-key",
      model: "deepseek-v4-pro",
    }),
    false,
  );
  assert.doesNotThrow(() => clearDeepSeekSession(rejected));
});
