import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/persistence/database.ts";
import { ExecutionStore } from "../../src/jobs/execution-store.ts";
import {
  PlanningExecutor,
  type StageHandlers,
} from "../../src/jobs/executor.ts";
import { PLANNING_STAGES } from "../../src/jobs/lifecycle.ts";
import { createJobHttp } from "../../src/jobs/http.ts";
import { TransientSecret } from "../../src/security/secrets.ts";
import { executableTrip } from "../fixtures/executable-trip.ts";
const now = () => new Date("2026-09-05T00:00:00Z");
function handlers(counter: { calls: number }): StageHandlers {
  return Object.fromEntries(
    PLANNING_STAGES.map((stage) => [
      stage,
      {
        requiresKey: stage === "skeleton_planning",
        run: async (ctx: Parameters<StageHandlers[typeof stage]["run"]>[0]) => {
          if (stage === "skeleton_planning")
            await ctx.once(
              "model",
              { task: "skeleton" },
              async () => {
                counter.calls++;
                return { ok: true };
              },
              () => [
                {
                  type: "model",
                  outputTokens: 10,
                  estimatedCostCny: 0.01,
                  payer: "visitor",
                },
              ],
            );
          if (stage === "finalization") return { trip: executableTrip() };
          return {};
        },
      },
    ]),
  ) as StageHandlers;
}
test("executor completes once, records numbered progress and survives a store reconnect", async (t) => {
  const db = openDatabase();
  t.after(() => db.close());
  const store = new ExecutionStore(db, now);
  const counter = { calls: 0 };
  const executor = new PlanningExecutor(store, handlers(counter), now);
  const { job, token } = store.create(executableTrip().brief);
  await Promise.all([
    executor.run(job.id, new TransientSecret("sk-test-0123456789abcdef")),
    executor.run(job.id),
  ]);
  assert.equal(counter.calls, 1);
  assert.equal(store.view(job.id).status, "completed");
  assert.equal(store.view(job.id).usage.visitorModelCostCny, 0.01);
  assert.equal(store.view(job.id).usage.steps, 7);
  const reconnected = new ExecutionStore(db, now);
  assert.equal(reconnected.authorized(job.id, token), true);
  assert.equal(reconnected.authorized(job.id, "wrong"), false);
  assert.equal(reconnected.view(job.id).trip?.brief.destination, "北京");
  const events = store.events(job.id, 0);
  assert.deepEqual(
    events.map((e) => e.sequence),
    Array.from({ length: events.length }, (_, i) => i + 1),
  );
  assert.equal(JSON.stringify(store.state(job.id)).includes("sk-test"), false);
});
test("missing credentials wait, changed call arguments are rejected and cancellation starts no later stage", async (t) => {
  const db = openDatabase();
  t.after(() => db.close());
  const store = new ExecutionStore(db, now);
  const counter = { calls: 0 };
  const stageHandlers = handlers(counter);
  const executor = new PlanningExecutor(store, stageHandlers, now);
  const { job } = store.create(executableTrip().brief);
  await executor.run(job.id);
  assert.equal(store.view(job.id).status, "waiting_for_credentials");
  store.update(job.id, (_j, state) => {
    state.calls["skeleton_planning:model"] = {
      signature: "INVALID",
      status: "completed",
      value: { ok: true },
    };
  });
  // A journal entry with changed arguments must never run a new external call.
  await executor.run(job.id, new TransientSecret("sk-test-0123456789abcdef"));
  assert.equal(counter.calls, 0);
  assert.equal(store.view(job.id).errorCode, "CALL_CONFLICT");
  const next = store.create(executableTrip().brief);
  let began: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  stageHandlers.requirements_check = {
    requiresKey: false,
    run: async (ctx) => {
      began();
      await new Promise<void>((resolve) =>
        ctx.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return {};
    },
  };
  const pending = executor.run(next.job.id);
  await started;
  executor.cancel(next.job.id);
  await pending;
  assert.equal(store.view(next.job.id).status, "cancelled");
  assert.equal(store.view(next.job.id).usage.steps, 0);
  assert.equal(counter.calls, 0);
});

test("disk restart replays confirmed calls without charging and refuses an unconfirmed call", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "travel-restart-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "jobs.sqlite");
  let db = openDatabase(path);
  let store = new ExecutionStore(db, now);
  const counter = { calls: 0 };
  const created = [];
  for (const status of ["completed", "pending"] as const) {
    const { job, token } = store.create(executableTrip().brief);
    await new PlanningExecutor(store, handlers(counter), now).run(job.id);
    store.update(job.id, (_job, state) => {
      state.calls["skeleton_planning:model"] = {
        signature: createHash("sha256")
          .update(JSON.stringify({ task: "skeleton" }))
          .digest("hex"),
        status,
        value: status === "completed" ? { ok: true } : undefined,
      };
      if (status === "completed") state.usage.visitorModelCostCny = 0.01;
    });
    created.push({ id: job.id, token });
  }
  db.close();
  db = openDatabase(path);
  t.after(() => db.close());
  store = new ExecutionStore(db, now);
  const executor = new PlanningExecutor(store, handlers(counter), now);
  assert.equal(store.recover().length, 2);
  for (const { id, token } of created) {
    assert.equal(store.authorized(id, token), true);
    await executor.run(id);
    assert.equal(store.view(id).status, "waiting_for_credentials");
    await executor.run(id, new TransientSecret("sk-test-0123456789abcdef"));
  }
  assert.equal(counter.calls, 0);
  assert.equal(store.view(created[0].id).status, "completed");
  assert.equal(store.view(created[0].id).usage.visitorModelCostCny, 0.01);
  assert.equal(store.view(created[1].id).errorCode, "CALL_INTERRUPTED");
});

test("uncooperative stages time out, cancellation settles promptly, and the cost cap prevents external calls", async (t) => {
  const db = openDatabase();
  t.after(() => db.close());
  const store = new ExecutionStore(db, now);
  const counter = { calls: 0 };
  const stages = handlers(counter);
  stages.requirements_check = {
    requiresKey: false,
    run: () => new Promise(() => {}),
  };
  const executor = new PlanningExecutor(store, stages, now, 20);
  const timed = store.create(executableTrip().brief);
  await executor.run(timed.job.id);
  assert.equal(store.view(timed.job.id).errorCode, "TASK_TIMEOUT");
  const cancelled = store.create(executableTrip().brief);
  const running = executor.run(cancelled.job.id);
  await Promise.resolve();
  executor.cancel(cancelled.job.id);
  await running;
  assert.equal(store.view(cancelled.job.id).status, "cancelled");
  const capped = store.create(executableTrip().brief);
  store.update(capped.job.id, (_job, state) => {
    state.usage.visitorModelCostCny = 5;
  });
  await new PlanningExecutor(store, handlers(counter), now).run(
    capped.job.id,
    new TransientSecret("sk-test-0123456789abcdef"),
  );
  assert.equal(store.view(capped.job.id).errorCode, "VISITOR_COST_HARD_LIMIT");
  assert.equal(counter.calls, 0);
});
test("HTTP authorization, create, polling, SSE cursor, resume and idempotent cancel", async (t) => {
  const db = openDatabase();
  t.after(() => db.close());
  const store = new ExecutionStore(db, now);
  const executor = new PlanningExecutor(store, handlers({ calls: 0 }), now);
  const api = createJobHttp(store, executor, () => true, now);
  const { schemaVersion: _, timeZone: __, ...input } = executableTrip().brief;
  void _;
  void __;
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    token?: string,
  ) =>
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const created = await api.create(
    request("/api/planning-jobs", "POST", {
      input,
      apiKey: "sk-test-0123456789abcdef",
    }),
  );
  assert.equal(created.status, 202);
  const { id, accessToken } = await created.json();
  await executor.run(id);
  assert.equal((await api.get(request("/"), id)).status, 404);
  const poll = await api.get(request("/", "GET", undefined, accessToken), id);
  assert.equal(poll.status, 200);
  const view = await poll.json();
  assert.equal(view.status, "completed");
  const stream = await api.events(
    new Request(`http://localhost/api/planning-jobs/${id}/events`, {
      headers: { Authorization: `Bearer ${accessToken}`, "Last-Event-ID": "1" },
    }),
    id,
  );
  const text = await stream.text();
  assert.doesNotMatch(text, /^id: 1$/m);
  assert.match(text, new RegExp(`id: ${view.sequence}`));
  assert.doesNotMatch(text, /sk-test|reasoning/);
  const waiting = store.create(executableTrip().brief);
  await executor.run(waiting.job.id);
  const resumed = await api.resume(
    request("/", "POST", { apiKey: "sk-test-0123456789abcdef" }, waiting.token),
    waiting.job.id,
  );
  assert.equal(resumed.status, 202);
  await executor.run(waiting.job.id);
  assert.equal(store.view(waiting.job.id).status, "completed");
  const cancelled = store.create(executableTrip().brief);
  await api.cancel(
    request("/", "POST", undefined, cancelled.token),
    cancelled.job.id,
  );
  await api.cancel(
    request("/", "POST", undefined, cancelled.token),
    cancelled.job.id,
  );
  assert.equal(store.view(cancelled.job.id).status, "cancelled");
});
