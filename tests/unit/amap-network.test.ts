import assert from "node:assert/strict";
import test from "node:test";
import type { Dispatcher } from "undici";
import {
  AmapNetworkConfigurationError,
  createAmapTransport,
  type AmapFetch,
} from "../../src/providers/amap/network.ts";

test("Amap stays direct when its dedicated server proxy is absent", async () => {
  let dispatcher: Dispatcher | undefined;
  const transport = createAmapTransport({
    environment: {},
    fetchImpl: async (_input, init) => {
      dispatcher = init?.dispatcher;
      return new Response(null, { status: 200 });
    },
  });

  assert.equal(transport.proxyConfigured, false);
  await transport.fetch("https://restapi.amap.com/v3/place/text");
  assert.equal(dispatcher, undefined);
});

test("Amap uses only AMAP_HTTPS_PROXY and attaches its dispatcher", async (t) => {
  const password = "amap-proxy-password-fixture";
  const proxyUrl = `http://proxy-user:${password}@127.0.0.1:18080`;
  const fakeDispatcher = {
    close: async () => undefined,
  } as unknown as Dispatcher;
  let seenDispatcher: Dispatcher | undefined;
  const fetchImpl: AmapFetch = async (_input, init) => {
    seenDispatcher = init?.dispatcher;
    return new Response(null, { status: 200 });
  };
  const transport = createAmapTransport({
    environment: {
      AMAP_HTTPS_PROXY: proxyUrl,
      DEEPSEEK_HTTPS_PROXY: "http://must-not-be-used.invalid:9999",
    },
    fetchImpl,
    proxyAgentFactory: (configuredUrl) => {
      assert.equal(configuredUrl, `${proxyUrl}/`);
      return fakeDispatcher;
    },
  });
  t.after(() => transport.close());

  await transport.fetch("https://restapi.amap.com/v3/place/text");
  assert.equal(transport.proxyConfigured, true);
  assert.equal(seenDispatcher, fakeDispatcher);
  assert.equal(JSON.stringify(transport).includes(password), false);
});

test("invalid Amap proxy configuration never exposes credentials", () => {
  const password = "credential-that-must-not-leak";
  assert.throws(
    () =>
      createAmapTransport({
        environment: {
          AMAP_HTTPS_PROXY: `http://user:${password}@127.0.0.1:18080/path`,
        },
      }),
    (error: unknown) =>
      error instanceof AmapNetworkConfigurationError &&
      !error.message.includes(password) &&
      !error.stack?.includes(password),
  );
});
