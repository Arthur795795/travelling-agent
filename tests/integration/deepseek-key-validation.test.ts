import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../../src/app/api/keys/deepseek/validate/route.ts";
import {
  validateDeepSeekKey,
  type DeepSeekKeyValidationAudit,
} from "../../src/providers/deepseek/key-validator.ts";
import { TransientSecret } from "../../src/security/secrets.ts";

const endpoint = "http://localhost/api/keys/deepseek/validate";

async function callRoute(apiKey: string, upstreamStatus = 200) {
  const originalFetch = globalThis.fetch;
  let outboundHeaders = new Headers();
  let outboundBody = "";
  globalThis.fetch = async (_input, init) => {
    outboundHeaders = new Headers(init?.headers);
    outboundBody = String(init?.body ?? "");
    return new Response(
      upstreamStatus === 200 ? '{"choices":[]}' : '{"error":"upstream detail"}',
      {
        status: upstreamStatus,
        headers: { "content-type": "application/json" },
      },
    );
  };
  try {
    const response = await POST(
      new Request(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey }),
      }),
    );
    return {
      response,
      body: await response.text(),
      outboundHeaders,
      outboundBody,
    };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("validates a key with a minimal DeepSeek request and returns only model name", async () => {
  const apiKey = "sk-test-0123456789abcdef";
  const result = await callRoute(apiKey);
  assert.equal(result.response.status, 200);
  assert.deepEqual(JSON.parse(result.body), {
    ok: true,
    model: "deepseek-v4-pro",
  });
  assert.equal(result.outboundHeaders.get("authorization"), `Bearer ${apiKey}`);
  assert.equal(JSON.parse(result.outboundBody).max_output_tokens, 1);
  assert.equal(result.body.includes(apiKey), false);
  assert.equal(result.body.includes("provider"), false);
  assert.equal(result.body.includes("备案"), false);
});

test("maps upstream errors to stable responses without leaking key or details", async () => {
  const expectations = [
    [401, "invalid_key", false],
    [403, "quota_or_permission", false],
    [429, "rate_limited", true],
    [500, "upstream_error", true],
  ] as const;
  for (const [status, code, retryable] of expectations) {
    const apiKey = `sk-test-${status}-0123456789`;
    const result = await callRoute(apiKey, status);
    assert.deepEqual(JSON.parse(result.body), { ok: false, code, retryable });
    assert.equal(result.body.includes(apiKey), false);
    assert.equal(result.body.includes("upstream detail"), false);
  }
});

test("invalid request payload is rejected before any upstream call", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response();
  };
  try {
    const response = await POST(
      new Request(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "short" }),
      }),
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      ok: false,
      code: "invalid_request",
      retryable: false,
    });
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("network exceptions are reduced to a stable error without exception text", async () => {
  const originalFetch = globalThis.fetch;
  const apiKey = "sk-network-0123456789abcdef";
  globalThis.fetch = async () => {
    throw new Error(`socket failed for ${apiKey}`);
  };
  try {
    const response = await POST(
      new Request(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey }),
      }),
    );
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.deepEqual(JSON.parse(body), {
      ok: false,
      code: "network_error",
      retryable: true,
    });
    assert.equal(body.includes(apiKey), false);
    assert.equal(body.includes("socket failed"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("emits key-free audit metadata without exposing provider details in the route response", async () => {
  const rawKey = "sk-audit-0123456789abcdef";
  let audit: DeepSeekKeyValidationAudit | undefined;
  const result = await validateDeepSeekKey(new TransientSecret(rawKey), {
    fetchImpl: async () => new Response("{}", { status: 200 }),
    onAudit: (event) => {
      audit = event;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(audit?.outcome, "valid");
  assert.equal(audit?.model, "deepseek-v4-pro");
  assert.equal(JSON.stringify(audit).includes(rawKey), false);
  assert.equal("provider" in (audit ?? {}), false);
});
