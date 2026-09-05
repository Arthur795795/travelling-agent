import assert from "node:assert/strict";
import test from "node:test";
import {
  DeepSeekResponseError,
  DeepSeekResponsesClient,
  functionCallOutput,
} from "../../src/providers/deepseek/responses-client.ts";
import { TransientSecret } from "../../src/security/secrets.ts";

function sseResponse(payloads: unknown[]): Response {
  const body = payloads
    .map((payload) => `data: ${JSON.stringify(payload)}\n\n`)
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const completed = {
  id: "resp-1",
  status: "completed",
  model: "deepseek-v4-pro",
  output: [
    {
      type: "reasoning",
      content: [{ type: "reasoning_text", text: "private chain of thought" }],
    },
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text: "北京建议",
          annotations: [
            {
              type: "url_citation",
              url: "https://example.org/official",
              title: "官网",
              start_index: 0,
              end_index: 2,
            },
          ],
        },
      ],
    },
    {
      type: "function_call",
      call_id: "call-1",
      name: "search_places",
      arguments: '{"keyword":"故宫"}',
    },
    {
      type: "web_search_call",
      id: "ws-1",
      action: { type: "search", query: "故宫 官网" },
    },
  ],
  usage: {
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 20 },
    output_tokens: 50,
    output_tokens_details: { reasoning_tokens: 30 },
    total_tokens: 150,
  },
};

test("maps DeepSeek SSE to public text/tool/search events without exposing reasoning", async () => {
  let outboundBody = "";
  const visibleEvents: unknown[] = [];
  const client = new DeepSeekResponsesClient({
    pricing: {
      inputPerMillion: 10,
      cachedInputPerMillion: 1,
      outputPerMillion: 20,
    },
    fetchImpl: async (_input, init) => {
      outboundBody = String(init?.body);
      return sseResponse([
        {
          type: "response.reasoning_text.delta",
          delta: "private chain of thought",
        },
        { type: "response.output_text.delta", delta: "北京" },
        { type: "response.output_item.done", item: completed.output[2] },
        { type: "response.output_item.done", item: completed.output[3] },
        { type: "response.completed", response: completed },
      ]);
    },
  });
  const result = await client.createResponse(
    new TransientSecret("sk-test-0123456789abcdef"),
    {
      input: "规划北京",
      tools: [{ type: "web_search" }],
      onEvent: (event) => visibleEvents.push(event),
    },
  );
  assert.equal(JSON.parse(outboundBody).model, "deepseek-v4-pro");
  assert.equal(JSON.parse(outboundBody).stream, true);
  assert.equal(result.outputText, "北京建议");
  assert.equal(result.model, "deepseek-v4-pro");
  assert.equal(result.functionCalls[0].callId, "call-1");
  assert.equal(result.webSearchCalls[0].id, "ws-1");
  assert.equal(result.citations[0].url, "https://example.org/official");
  assert.equal(result.usage.reasoningTokens, 30);
  assert.equal(result.estimatedCostCny, 0.00182);
  assert.equal(
    JSON.stringify(visibleEvents).includes("private chain of thought"),
    false,
  );
  assert.deepEqual(functionCallOutput("call-1", { ok: true }), {
    type: "function_call_output",
    call_id: "call-1",
    output: '{"ok":true}',
  });
});

test("maps status failures, incomplete streams, timeout, and caller cancellation", async () => {
  const statusClient = new DeepSeekResponsesClient({
    fetchImpl: async () => new Response("denied", { status: 429 }),
  });
  await assert.rejects(
    () =>
      statusClient.createResponse(
        new TransientSecret("sk-rate-0123456789abcdef"),
        { input: "x" },
      ),
    (error: unknown) =>
      error instanceof DeepSeekResponseError &&
      error.code === "rate_limited" &&
      error.retryable,
  );

  const incompleteClient = new DeepSeekResponsesClient({
    fetchImpl: async () =>
      sseResponse([{ type: "response.output_text.delta", delta: "partial" }]),
  });
  await assert.rejects(
    () =>
      incompleteClient.createResponse(
        new TransientSecret("sk-partial-0123456789abcdef"),
        { input: "x" },
      ),
    (error: unknown) =>
      error instanceof DeepSeekResponseError &&
      error.code === "incomplete_response",
  );

  const hangingFetch: typeof fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(init.signal?.reason),
      );
    });
  const timeoutClient = new DeepSeekResponsesClient({
    timeoutMs: 5,
    fetchImpl: hangingFetch,
  });
  await assert.rejects(
    () =>
      timeoutClient.createResponse(
        new TransientSecret("sk-timeout-0123456789abcdef"),
        { input: "x" },
      ),
    (error: unknown) =>
      error instanceof DeepSeekResponseError && error.code === "timeout",
  );

  const cancelController = new AbortController();
  const cancelClient = new DeepSeekResponsesClient({
    timeoutMs: 1_000,
    fetchImpl: hangingFetch,
  });
  const promise = cancelClient.createResponse(
    new TransientSecret("sk-cancel-0123456789abcdef"),
    {
      input: "x",
      signal: cancelController.signal,
    },
  );
  cancelController.abort();
  await assert.rejects(
    () => promise,
    (error: unknown) =>
      error instanceof DeepSeekResponseError &&
      error.code === "cancelled" &&
      !error.retryable,
  );
});

test("does not start a pre-cancelled request and stops reading a stalled stream on cancellation or timeout", async () => {
  let fetchCalls = 0;
  const cancelled = new AbortController();
  cancelled.abort();
  const preCancelled = new DeepSeekResponsesClient({
    fetchImpl: async () => {
      fetchCalls += 1;
      return sseResponse([]);
    },
  });
  await assert.rejects(
    () =>
      preCancelled.createResponse(
        new TransientSecret("sk-test-0123456789abcdef"),
        { input: "x", signal: cancelled.signal },
      ),
    (error: unknown) =>
      error instanceof DeepSeekResponseError && error.code === "cancelled",
  );
  assert.equal(fetchCalls, 0);
  for (const mode of ["cancelled", "timeout"] as const) {
    let streamCancelled = false;
    const controller = new AbortController();
    const client = new DeepSeekResponsesClient({
      timeoutMs: 20,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(stream) {
              stream.enqueue(
                new TextEncoder().encode(
                  'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
                ),
              );
            },
            cancel() {
              streamCancelled = true;
            },
          }),
        ),
    });
    await assert.rejects(
      () =>
        client.createResponse(new TransientSecret("sk-test-0123456789abcdef"), {
          input: "x",
          signal: controller.signal,
          onEvent: () => {
            if (mode === "cancelled") controller.abort();
          },
        }),
      (error: unknown) =>
        error instanceof DeepSeekResponseError && error.code === mode,
    );
    assert.equal(streamCancelled, true);
  }
});

test("maps authentication, malformed stream, failed and explicitly incomplete responses", async () => {
  const cases: Array<[() => Response, string]> = [
    [
      () => new Response("sensitive upstream details", { status: 401 }),
      "invalid_key",
    ],
    [() => new Response("data: invalid-json\n\n"), "invalid_stream"],
    [() => sseResponse([{ type: "response.failed" }]), "upstream_error"],
    [
      () => sseResponse([{ type: "response.incomplete" }]),
      "incomplete_response",
    ],
  ];
  for (const [response, code] of cases) {
    const client = new DeepSeekResponsesClient({
      fetchImpl: async () => response(),
    });
    await assert.rejects(
      () =>
        client.createResponse(new TransientSecret("sk-test-0123456789abcdef"), {
          input: "x",
        }),
      (error: unknown) =>
        error instanceof DeepSeekResponseError &&
        error.code === code &&
        !error.message.includes("sensitive upstream"),
    );
  }
});
