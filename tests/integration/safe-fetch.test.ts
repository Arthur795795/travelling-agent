import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import {
  isBlockedAddress,
  SafeFetchError,
  safeFetchText,
} from "../../src/security/safe-fetch.ts";

const publicDns = async () => ["93.184.216.34"];

test("reads bounded content from a controlled HTTP fixture through the validated transport seam", async (t) => {
  const fixture = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/plain",
      "content-length": "7",
    });
    response.end("fixture");
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  t.after(
    () =>
      new Promise<void>((resolve) => {
        fixture.close(() => resolve());
        fixture.closeAllConnections();
      }),
  );
  const address = fixture.address();
  assert(address && typeof address === "object");

  const result = await safeFetchText(
    "https://public.example/page",
    {},
    {
      resolveHostname: async () => ["8.8.8.8"],
      requestImpl: async (_url, validatedAddress, signal) => {
        assert.equal(validatedAddress, "8.8.8.8");
        return fetch(`http://127.0.0.1:${address.port}/fixture`, { signal });
      },
    },
  );
  assert.equal(result.body, "fixture");
  assert.equal(result.url, "https://public.example/page");
});

test("reads a bounded public text response without forwarding credentials", async () => {
  let requestInit: RequestInit | undefined;
  const result = await safeFetchText(
    "https://example.com/page",
    {},
    {
      resolveHostname: publicDns,
      fetchImpl: async (_input, init) => {
        requestInit = init;
        return new Response("hello", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    },
  );
  assert.equal(result.body, "hello");
  assert.equal(result.url, "https://example.com/page");
  assert.equal(new Headers(requestInit?.headers).has("authorization"), false);
  assert.equal(requestInit?.redirect, "manual");
});

test("blocks unsafe protocols, URL credentials, private DNS, and private literals", async () => {
  const inputs = [
    "file:///etc/passwd",
    "https://user:pass@example.com/",
    "http://127.0.0.1/",
    "http://[::1]/",
  ];
  for (const input of inputs) {
    await assert.rejects(
      () =>
        safeFetchText(
          input,
          {},
          { resolveHostname: publicDns, fetchImpl: fetch },
        ),
      SafeFetchError,
    );
  }
  await assert.rejects(
    () =>
      safeFetchText(
        "https://rebinding.example/",
        {},
        { resolveHostname: async () => ["169.254.169.254"], fetchImpl: fetch },
      ),
    (error: unknown) =>
      error instanceof SafeFetchError && error.code === "BLOCKED_ADDRESS",
  );
  await assert.rejects(
    () =>
      safeFetchText(
        "http://[::1]/",
        {},
        {
          resolveHostname: async () => {
            throw new Error("an IP literal must not use DNS");
          },
          fetchImpl: async () =>
            new Response("unsafe", {
              headers: { "content-type": "text/plain" },
            }),
        },
      ),
    (error: unknown) =>
      error instanceof SafeFetchError && error.code === "BLOCKED_ADDRESS",
  );
  for (const address of [
    "::ffff:7f00:1",
    "ff02::1",
    "2001:db8::1",
    "198.51.100.1",
    "203.0.113.1",
  ]) {
    assert.equal(isBlockedAddress(address), true, `${address} must be blocked`);
  }
  assert.equal(isBlockedAddress("2606:4700:4700::1111"), false);
  assert.equal(isBlockedAddress("8.8.8.8"), false);
  await assert.rejects(
    () =>
      safeFetchText(
        "http://[::ffff:127.0.0.1]/",
        {},
        {
          fetchImpl: async () =>
            new Response("unsafe", {
              headers: { "content-type": "text/plain" },
            }),
        },
      ),
    (error: unknown) =>
      error instanceof SafeFetchError && error.code === "BLOCKED_ADDRESS",
  );
});

test("binds the production-style request seam to the address that passed DNS validation", async () => {
  const requestedAddresses: string[] = [];
  const result = await safeFetchText(
    "https://public.example/path",
    {},
    {
      resolveHostname: async () => ["8.8.8.8"],
      requestImpl: async (_url, address) => {
        requestedAddresses.push(address);
        return new Response("bound", {
          headers: { "content-type": "text/plain" },
        });
      },
    },
  );
  assert.equal(result.body, "bound");
  assert.deepEqual(requestedAddresses, ["8.8.8.8"]);
});

test("revalidates every redirect target and stops private redirects", async () => {
  const calls: string[] = [];
  await assert.rejects(
    () =>
      safeFetchText(
        "https://public.example/",
        {},
        {
          resolveHostname: async (hostname) =>
            hostname === "public.example" ? ["93.184.216.34"] : ["10.0.0.2"],
          fetchImpl: async (input) => {
            calls.push(String(input));
            return new Response(null, {
              status: 302,
              headers: { location: "http://internal.example/admin" },
            });
          },
        },
      ),
    (error: unknown) =>
      error instanceof SafeFetchError && error.code === "BLOCKED_ADDRESS",
  );
  assert.deepEqual(calls, ["https://public.example/"]);
});

test("rejects unsupported or oversized response bodies", async () => {
  await assert.rejects(
    () =>
      safeFetchText(
        "https://example.com/file",
        {},
        {
          resolveHostname: publicDns,
          fetchImpl: async () =>
            new Response("binary", {
              headers: { "content-type": "application/octet-stream" },
            }),
        },
      ),
    (error: unknown) =>
      error instanceof SafeFetchError &&
      error.code === "UNSUPPORTED_CONTENT_TYPE",
  );
  await assert.rejects(
    () =>
      safeFetchText(
        "https://example.com/large",
        { maxBytes: 4 },
        {
          resolveHostname: publicDns,
          fetchImpl: async () =>
            new Response("12345", {
              headers: { "content-type": "text/plain" },
            }),
        },
      ),
    (error: unknown) =>
      error instanceof SafeFetchError && error.code === "RESPONSE_TOO_LARGE",
  );
});

test("maps timeouts to a stable public error", async () => {
  await assert.rejects(
    () =>
      safeFetchText(
        "https://example.com/slow",
        { timeoutMs: 5 },
        {
          resolveHostname: publicDns,
          fetchImpl: async (_input, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () =>
                reject(new DOMException("aborted", "AbortError")),
              );
            }),
        },
      ),
    (error: unknown) =>
      error instanceof SafeFetchError && error.code === "TIMEOUT",
  );
});

test("uses one timeout budget for DNS, redirects, and response reading", async () => {
  await assert.rejects(
    () =>
      safeFetchText(
        "https://example.com/slow-dns",
        { timeoutMs: 10 },
        {
          resolveHostname: async () => new Promise<string[]>(() => undefined),
          fetchImpl: async () =>
            new Response("never", {
              headers: { "content-type": "text/plain" },
            }),
        },
      ),
    (error: unknown) =>
      error instanceof SafeFetchError && error.code === "TIMEOUT",
  );

  let calls = 0;
  await assert.rejects(
    () =>
      safeFetchText(
        "https://example.com/redirect",
        { timeoutMs: 25 },
        {
          resolveHostname: publicDns,
          fetchImpl: async () => {
            calls += 1;
            await new Promise((resolve) => setTimeout(resolve, 15));
            return calls === 1
              ? new Response(null, {
                  status: 302,
                  headers: { location: "/final" },
                })
              : new Response("late", {
                  headers: { "content-type": "text/plain" },
                });
          },
        },
      ),
    (error: unknown) =>
      error instanceof SafeFetchError && error.code === "TIMEOUT",
  );
  assert.equal(calls, 2);
});
