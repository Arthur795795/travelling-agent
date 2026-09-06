import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { safeStringify } from "../../src/security/redaction.ts";
import { safeFetchText } from "../../src/security/safe-fetch.ts";

test("secret-shaped values are absent from safe serialized output", () => {
  const secret = "sk-security-0123456789abcdef";
  const output = safeStringify({
    apiKey: secret,
    nested: { message: `request failed for ${secret}` },
  });
  assert.equal(output.includes(secret), false);
});

test("safe fetch refuses common cloud metadata endpoints", async () => {
  await assert.rejects(() =>
    safeFetchText("http://169.254.169.254/latest/meta-data"),
  );
  await assert.rejects(() => safeFetchText("http://127.0.0.1:3000/admin"));
});

test("environment example contains placeholders and no usable credentials", async () => {
  const env = await readFile(
    new URL("../../.env.example", import.meta.url),
    "utf8",
  );
  assert.equal(/(?:sk|ds)-[A-Za-z0-9_-]{12,}/.test(env), false);
  assert.match(env, /^DEEPSEEK_HTTPS_PROXY=$/m);
  assert.doesNotMatch(env, /DEEPSEEK_HTTPS_PROXY=.*(?:@|127\.0\.0\.1)/);
  assert.match(env, /^AMAP_HTTPS_PROXY=$/m);
  assert.doesNotMatch(env, /AMAP_HTTPS_PROXY=.*(?:@|127\.0\.0\.1)/);
  assert.doesNotMatch(env, /NODE_TLS_REJECT_UNAUTHORIZED/);
});
