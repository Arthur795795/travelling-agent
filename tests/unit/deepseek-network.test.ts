import assert from "node:assert/strict";
import test from "node:test";
import type { Dispatcher } from "undici";
import {
  createDeepSeekTransport,
  DeepSeekNetworkConfigurationError,
  type DeepSeekFetch,
} from "../../src/providers/deepseek/network.ts";
import { validateDeepSeekKey } from "../../src/providers/deepseek/key-validator.ts";
import {
  DeepSeekResponseError,
  DeepSeekResponsesClient,
} from "../../src/providers/deepseek/responses-client.ts";
import { TransientSecret } from "../../src/security/secrets.ts";

const completed = {
  type: "response.completed",
  response: {
    id: "resp-proxy",
    status: "completed",
    model: "deepseek-v4-pro",
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: "ok" }],
      },
    ],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
    },
  },
};

const completedResponse = () =>
  new Response(`data: ${JSON.stringify(completed)}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

test("DeepSeek stays direct when its server-only proxy is not configured", async () => {
  let dispatcher: Dispatcher | undefined;
  const transport = createDeepSeekTransport({
    environment: { DEEPSEEK_BASE_URL: "https://api.deepseek.test" },
    fetchImpl: async (_input, init) => {
      dispatcher = init?.dispatcher;
      return new Response(null, { status: 200 });
    },
  });
  assert.equal(transport.proxyConfigured, false);
  assert.equal(transport.baseUrl, "https://api.deepseek.test");
  await transport.fetch(`${transport.baseUrl}/responses`);
  assert.equal(dispatcher, undefined);
});

test("validation and formal Responses reuse one explicit proxy transport", async (t) => {
  const rawKey = "sk-shared-proxy-0123456789abcdef";
  const proxyPassword = "proxy-password-fixture";
  const proxyUrl = `http://proxy-user:${proxyPassword}@127.0.0.1:18080`;
  const fakeDispatcher = {
    close: async () => undefined,
  } as unknown as Dispatcher;
  const seenDispatchers: Array<Dispatcher | undefined> = [];
  const seenUrls: string[] = [];
  let calls = 0;
  const fetchImpl: DeepSeekFetch = async (input, init) => {
    calls += 1;
    seenUrls.push(String(input));
    seenDispatchers.push(init?.dispatcher);
    return calls === 1
      ? new Response(null, { status: 200 })
      : completedResponse();
  };
  const transport = createDeepSeekTransport({
    environment: {
      DEEPSEEK_BASE_URL: "https://api.deepseek.test",
      DEEPSEEK_HTTPS_PROXY: proxyUrl,
    },
    fetchImpl,
    proxyAgentFactory: (configuredUrl) => {
      assert.equal(configuredUrl, `${proxyUrl}/`);
      return fakeDispatcher;
    },
  });
  t.after(() => transport.close());

  const validationSecret = new TransientSecret(rawKey);
  assert.deepEqual(await validateDeepSeekKey(validationSecret, { transport }), {
    ok: true,
    model: "deepseek-v4-pro",
  });
  const generationSecret = new TransientSecret(rawKey);
  const result = await new DeepSeekResponsesClient({ transport }).createResponse(
    generationSecret,
    { input: "plan" },
  );

  assert.equal(transport.proxyConfigured, true);
  assert.deepEqual(seenUrls, [
    "https://api.deepseek.test/responses",
    "https://api.deepseek.test/responses",
  ]);
  assert.deepEqual(seenDispatchers, [fakeDispatcher, fakeDispatcher]);
  assert.equal(result.outputText, "ok");
  assert.equal(validationSecret.use((value) => value), "");
  assert.equal(generationSecret.use((value) => value), "");
  const publicOutput = JSON.stringify({
    validation: { ok: true, model: result.model },
    result,
    transport,
  });
  assert.equal(publicOutput.includes(rawKey), false);
  assert.equal(publicOutput.includes(proxyPassword), false);
});

test("proxy, TLS and timeout failures expose only stable errors", async () => {
  const proxyPassword = "proxy-secret-fixture";
  const key = "sk-network-secret-0123456789abcdef";
  for (const detail of [
    `connect ECONNREFUSED proxy-user:${proxyPassword}`,
    `SELF_SIGNED_CERT_IN_CHAIN ${key}`,
  ]) {
    const transport = createDeepSeekTransport({
      fetchImpl: async () => {
        throw new Error(detail);
      },
    });
    const validation = await validateDeepSeekKey(new TransientSecret(key), {
      transport,
    });
    assert.deepEqual(validation, {
      ok: false,
      code: "network_error",
      retryable: true,
    });
    const client = new DeepSeekResponsesClient({ transport });
    await assert.rejects(
      () => client.createResponse(new TransientSecret(key), { input: "x" }),
      (error: unknown) =>
        error instanceof DeepSeekResponseError &&
        error.code === "network_error" &&
        !error.message.includes(proxyPassword) &&
        !error.message.includes(key) &&
        !error.message.includes("SELF_SIGNED"),
    );
  }

  const hanging: DeepSeekFetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
        once: true,
      });
    });
  const timeoutTransport = createDeepSeekTransport({ fetchImpl: hanging });
  assert.deepEqual(
    await validateDeepSeekKey(new TransientSecret(key), {
      transport: timeoutTransport,
      timeoutMs: 5,
    }),
    { ok: false, code: "timeout", retryable: true },
  );
  await assert.rejects(
    () =>
      new DeepSeekResponsesClient({
        transport: timeoutTransport,
        timeoutMs: 5,
      }).createResponse(new TransientSecret(key), { input: "x" }),
    (error: unknown) =>
      error instanceof DeepSeekResponseError && error.code === "timeout",
  );
});

test("invalid proxy configuration never includes proxy credentials", () => {
  const password = "credential-that-must-not-leak";
  assert.throws(
    () =>
      createDeepSeekTransport({
        environment: {
          DEEPSEEK_HTTPS_PROXY: `http://user:${password}@127.0.0.1:18080/path`,
        },
      }),
    (error: unknown) =>
      error instanceof DeepSeekNetworkConfigurationError &&
      !error.message.includes(password) &&
      !error.stack?.includes(password),
  );
});
