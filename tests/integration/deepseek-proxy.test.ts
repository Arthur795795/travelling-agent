import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import test from "node:test";
import { once } from "node:events";
import { createDeepSeekTransport } from "../../src/providers/deepseek/network.ts";
import type { DeepSeekTransport } from "../../src/providers/deepseek/network.ts";
import { validateDeepSeekKey } from "../../src/providers/deepseek/key-validator.ts";
import { TransientSecret } from "../../src/security/secrets.ts";

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("NO_PORT");
  return address.port;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

test("the real ProxyAgent tunnels DeepSeek traffic while an empty setting stays direct", async (t) => {
  let targetCalls = 0;
  const target = createServer((_request, response) => {
    targetCalls += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"type":"response.completed"}\n\n');
  });
  const targetPort = await listen(target);
  let proxyConnects = 0;
  const proxy = createServer();
  proxy.on("connect", (request, downstream, head) => {
    proxyConnects += 1;
    const [host, rawPort] = (request.url ?? "").split(":");
    const upstream = connect(Number(rawPort), host, () => {
      downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(downstream);
      downstream.pipe(upstream);
    });
    upstream.on("error", () => downstream.destroy());
  });
  const proxyPort = await listen(proxy);
  const resources: { proxied?: DeepSeekTransport } = {};
  t.after(async () => {
    await resources.proxied?.close();
    await close(proxy);
    await close(target);
  });

  const baseUrl = `http://127.0.0.1:${targetPort}`;
  const direct = createDeepSeekTransport({
    environment: { DEEPSEEK_BASE_URL: baseUrl },
  });
  assert.deepEqual(
    await validateDeepSeekKey(
      new TransientSecret("sk-direct-0123456789abcdef"),
      { transport: direct },
    ),
    { ok: true, model: "deepseek-v4-pro" },
  );
  assert.equal(proxyConnects, 0);

  const proxied = createDeepSeekTransport({
    environment: {
      DEEPSEEK_BASE_URL: baseUrl,
      DEEPSEEK_HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
    },
  });
  resources.proxied = proxied;
  assert.deepEqual(
    await validateDeepSeekKey(
      new TransientSecret("sk-proxied-0123456789abcdef"),
      { transport: proxied },
    ),
    { ok: true, model: "deepseek-v4-pro" },
  );
  assert.equal(proxyConnects, 1);
  assert.equal(targetCalls, 2);
});

test("an unreachable configured proxy becomes a stable network failure", async () => {
  const closedProxy = createServer();
  const port = await listen(closedProxy);
  await close(closedProxy);
  const transport = createDeepSeekTransport({
    environment: {
      DEEPSEEK_BASE_URL: "https://api.deepseek.test",
      DEEPSEEK_HTTPS_PROXY: `http://127.0.0.1:${port}`,
    },
  });
  try {
    assert.deepEqual(
      await validateDeepSeekKey(
        new TransientSecret("sk-unreachable-0123456789abcdef"),
        { transport, timeoutMs: 500 },
      ),
      { ok: false, code: "network_error", retryable: true },
    );
  } finally {
    await transport.close();
  }
});
