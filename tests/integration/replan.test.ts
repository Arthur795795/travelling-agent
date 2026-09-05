import assert from "node:assert/strict";
import test from "node:test";
import { localReplan } from "../../src/trips/replan.ts";
import { changeHttp } from "../../src/trips/http.ts";
import { openDatabase } from "../../src/persistence/database.ts";
import { ExecutionStore } from "../../src/jobs/execution-store.ts";
import {
  PlanningExecutor,
  type StageHandlers,
} from "../../src/jobs/executor.ts";
import { executableTrip } from "../fixtures/executable-trip.ts";
import type { DeepSeekResponseResult } from "../../src/providers/deepseek/responses-client.ts";
const response = (output: unknown): DeepSeekResponseResult => ({
  responseId: "fixed",
  status: "completed",
  model: "deepseek-v4-pro",
  outputText: JSON.stringify(output),
  functionCalls: [],
  webSearchCalls: [],
  citations: [],
  events: [],
  usage: {
    inputTokens: 1,
    cachedInputTokens: 0,
    outputTokens: 1,
    reasoningTokens: 0,
    totalTokens: 2,
  },
  estimatedCostCny: 0,
});
test("local replan changes only affected days and rejects locked or fabricated facts", async () => {
  const base = executableTrip();
  const change = {
    type: "replan" as const,
    date: base.days[0].date,
    instruction: "稍晚出发",
  };
  const success = await localReplan(base, change, async () => {
    const day = structuredClone(base.days[0]);
    day.activities[0].timeWindow.start = "2026-10-01T09:10:00+08:00";
    day.activities[0].timeWindow.end = "2026-10-01T11:10:00+08:00";
    return response({ days: [day] });
  });
  assert.equal(success.trip.version, 2);
  assert.deepEqual(success.trip.days[1], base.days[1]);
  assert.equal(success.choices.length, 0);
  const failed = await localReplan(base, change, async () => {
    const day = structuredClone(base.days[0]);
    day.activities[0].place.name = "编造地点";
    return response({ days: [day] });
  });
  assert.equal(failed.trip.version, 1);
  assert.equal(failed.rounds, 2);
  assert.equal(failed.choices.length, 2);
  base.days[0].activities[0].locked = true;
  const locked = await localReplan(base, change, async () =>
    response({ days: [] }),
  );
  assert.equal(locked.trip.version, 1);
});
test("major change API requires a bound confirmation and creates a waiting job without a Key", async (t) => {
  const db = openDatabase();
  t.after(() => db.close());
  const now = () => new Date("2026-09-05T00:00:00Z");
  const store = new ExecutionStore(db, now);
  const handlers = Object.fromEntries(
    [
      "requirements_check",
      "skeleton_planning",
      "evidence_collection",
      "route_and_budget",
      "hard_validation",
      "repair",
      "finalization",
    ].map((stage) => [
      stage,
      { requiresKey: stage === "repair", run: async () => ({}) },
    ]),
  ) as unknown as StageHandlers;
  const executor = new PlanningExecutor(store, handlers, now);
  const api = changeHttp(store, executor, () => true);
  const trip = executableTrip();
  const change = {
    type: "replan",
    date: trip.days[0].date,
    instruction: "少走路",
  };
  const request = (body: unknown) =>
    new Request("http://local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const preview = await api(request({ trip, change }), trip.id, "preview");
  const data = await preview.json();
  assert.equal(data.major, true);
  assert.equal(
    (
      await api(
        request({ trip, change, confirmation: "wrong" }),
        trip.id,
        "replan",
      )
    ).status,
    409,
  );
  const created = await api(
    request({ trip, change, confirmation: data.confirmation }),
    trip.id,
    "replan",
  );
  assert.equal(created.status, 202);
  const job = await created.json();
  await executor.run(job.id);
  assert.equal(store.view(job.id).status, "waiting_for_credentials");
  assert.equal(store.view(job.id).baseVersion, trip.version);
});
