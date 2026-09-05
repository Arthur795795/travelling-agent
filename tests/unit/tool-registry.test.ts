import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { AgentToolRegistry } from "../../src/agent/tools/registry.ts";

function invocation(
  overrides: Partial<Parameters<AgentToolRegistry["invoke"]>[0]> = {},
) {
  return {
    jobId: "job-1",
    stage: "evidence_collection" as const,
    callId: "call-1",
    idempotencyKey: "idem-1",
    name: "search_places",
    arguments: { keyword: "故宫" },
    ...overrides,
  };
}

test("executes an allowed validated tool once and replays duplicate idempotency keys", async () => {
  let executions = 0;
  const registry = new AgentToolRegistry(
    undefined,
    () => new Date("2026-09-05T10:00:00+08:00"),
  );
  registry.register({
    name: "search_places",
    inputSchema: z.object({ keyword: z.string().min(1) }).strict(),
    execute: async (_input, context) => {
      executions += 1;
      assert.equal(context.stage, "evidence_collection");
      return {
        status: "success",
        data: { candidates: 2 },
        evidenceIds: ["evidence-1"],
        productCostCny: 0.01,
      };
    },
  });
  const first = await registry.invoke(invocation());
  const replay = await registry.invoke(invocation({ callId: "call-2" }));
  const conflict = await registry.invoke(
    invocation({ callId: "call-3", arguments: { keyword: "天坛" } }),
  );
  assert.equal(first.status, "success");
  assert.deepEqual(first.evidenceIds, ["evidence-1"]);
  assert.deepEqual(first.usageEvents, [
    { type: "product_cost", amountCny: 0.01 },
  ]);
  assert.equal(replay.replayed, true);
  assert.equal(replay.callId, "call-2");
  assert.deepEqual(replay.usageEvents, []);
  assert.equal(conflict.code, "IDEMPOTENCY_CONFLICT");
  assert.equal(executions, 1);
});

test("unknown, unauthorized, disabled, and invalid calls have no side effects", async () => {
  let executions = 0;
  const registry = new AgentToolRegistry();
  registry.register({
    name: "search_places",
    inputSchema: z.object({ keyword: z.string() }).strict(),
    execute: async () => {
      executions += 1;
      return { status: "success", data: {} };
    },
  });
  registry.register({
    name: "get_weather",
    inputSchema: z.object({ city: z.string() }).strict(),
    isEnabled: () => false,
    execute: async () => {
      executions += 1;
      return { status: "success", data: {} };
    },
  });
  assert.equal(
    (await registry.invoke(invocation({ name: "shell" }))).code,
    "UNKNOWN_TOOL",
  );
  assert.equal(
    (await registry.invoke(invocation({ stage: "hard_validation" }))).code,
    "TOOL_NOT_ALLOWED",
  );
  assert.equal(
    (
      await registry.invoke(
        invocation({ arguments: { keyword: "故宫", extra: true } }),
      )
    ).code,
    "INVALID_ARGUMENTS",
  );
  assert.equal(
    (await registry.invoke(invocation({ arguments: "not-json" }))).code,
    "INVALID_ARGUMENTS",
  );
  assert.equal(
    (
      await registry.invoke(
        invocation({ name: "get_weather", arguments: { city: "北京" } }),
      )
    ).status,
    "blocked",
  );
  assert.equal(executions, 0);
});

test("normalizes timeout and execution failures without leaking exceptions", async () => {
  const registry = new AgentToolRegistry();
  registry.register({
    name: "search_places",
    inputSchema: z.object({ keyword: z.string() }).strict(),
    execute: async (_input, context) =>
      new Promise((resolve) => {
        context.signal.addEventListener("abort", () =>
          resolve({
            status: "retryable_error",
            code: "ABORTED",
            message: "aborted",
          }),
        );
      }),
  });
  const timeout = await registry.invoke(invocation({ timeoutMs: 5 }));
  assert.equal(timeout.status, "retryable_error");
  assert.equal(timeout.code, "TOOL_TIMEOUT");
});
