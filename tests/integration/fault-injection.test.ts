import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeepSeekResponseError, DeepSeekResponsesClient } from "../../src/providers/deepseek/responses-client.ts";
import { AmapClient, AmapError } from "../../src/providers/amap/client.ts";
import { AmapRoutesAdapter } from "../../src/providers/amap/routes.ts";
import { OfficialPageEvidenceReader, classifySearchResult } from "../../src/search/source-evidence.ts";
import { openDatabase } from "../../src/persistence/database.ts";
import { ExecutionStore } from "../../src/jobs/execution-store.ts";
import { PlanningExecutor, type StageHandlers } from "../../src/jobs/executor.ts";
import { PLANNING_STAGES } from "../../src/jobs/lifecycle.ts";
import { TransientSecret } from "../../src/security/secrets.ts";
import { exportHttp } from "../../src/exports/http.ts";
import { executableTrip } from "../fixtures/executable-trip.ts";
import { resolveClaim } from "../../src/evidence/resolve.ts";

const now = () => new Date("2026-09-06T00:00:00Z");
const sse = (body: string) => new Response(body, { headers: { "content-type": "text/event-stream" } });

test("model, map and official-source failures stay explicit", async () => {
  for (const [response, code] of [
    [new Response("limited", { status: 429 }), "rate_limited"],
    [sse("data: not-json\n\n"), "invalid_stream"],
    [sse('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'), "incomplete_response"],
  ] as const) {
    const client = new DeepSeekResponsesClient({ fetchImpl: async () => response });
    await assert.rejects(
      () => client.createResponse(new TransientSecret("sk-fixture-0123456789abcdef"), { input: "x" }),
      (error: unknown) => error instanceof DeepSeekResponseError && error.code === code,
    );
  }
  const amapTimeout = new AmapClient({
    environment: { AMAP_WEB_SERVICE_KEY: "fixture" },
    timeoutMs: 5,
    fetchImpl: async (_url, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      ),
  });
  await assert.rejects(
    () => amapTimeout.request("/v3/place/text", { keywords: "故宫" }),
    (error: unknown) => error instanceof AmapError && error.code === "timeout",
  );
  const timeout = new DeepSeekResponsesClient({ timeoutMs: 5, fetchImpl: async (_u, init) => new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))) });
  await assert.rejects(
    () => timeout.createResponse(new TransientSecret("sk-fixture-0123456789abcdef"), { input: "x" }),
    (error: unknown) => error instanceof DeepSeekResponseError && error.code === "timeout",
  );

  for (const [response, code] of [
    [new Response("", { status: 429 }), "quota"],
    [new Response("bad", { status: 200, headers: { "content-type": "application/json" } }), "invalid_response"],
  ] as const) {
    const client = new AmapClient({ environment: { AMAP_WEB_SERVICE_KEY: "fixture" }, fetchImpl: async () => response });
    await assert.rejects(
      () => client.request("/v3/place/text", { keywords: "故宫" }),
      (error: unknown) => error instanceof AmapError && error.code === code,
    );
  }
  const noRoute = new AmapRoutesAdapter(new AmapClient({
    environment: { AMAP_WEB_SERVICE_KEY: "fixture" },
    fetchImpl: async () => Response.json({ status: "1", infocode: "10000", route: { paths: [] } }),
    now,
  }), now);
  const route = await noRoute.route({
    legId: "leg", fromPlaceId: "a", toPlaceId: "b",
    origin: { longitude: 116.3, latitude: 39.9 }, destination: { longitude: 116.4, latitude: 39.9 },
    mode: "taxi", departureWindow: { start: "2026-10-15T10:00:00+08:00", end: "2026-10-15T10:30:00+08:00", flexibilityMinutes: 0 },
  });
  assert.equal(route.status, "blocked");
  if (route.status === "blocked") assert.equal(route.code, "no_route");

  const candidate = classifySearchResult({ title: "官网", url: "https://official.example/page", snippet: "" }, ["official.example"]);
  const missing = await new OfficialPageEvidenceReader(async () => ({ url: candidate.url, status: 404, contentType: "text/html", body: "gone" }), now).read({ subjectId: "p", field: "openingHours", candidate, queryTerms: ["开放"] });
  assert.equal(missing.failureCode, "unavailable");
  const changed = await new OfficialPageEvidenceReader(async () => ({ url: candidate.url, status: 200, contentType: "text/html", body: "页面结构已变化" }), now).read({ subjectId: "p", field: "openingHours", candidate, queryTerms: ["开放"] });
  assert.equal(changed.failureCode, "fact_not_found");
  const conflict = resolveClaim(
    { id: "claim", subjectId: "p", field: "openingHours", value: null, evidenceIds: ["a", "b"], status: "recheck_required", conflictEvidenceIds: [] },
    [
      { id: "a", sourceType: "official", sourceName: "官网页面 A", checkedAt: now().toISOString(), status: "verified", assertedValue: "开放" },
      { id: "b", sourceType: "official", sourceName: "官网页面 B", checkedAt: now().toISOString(), status: "verified", assertedValue: "闭馆" },
    ],
  );
  assert.equal(conflict.claim.status, "recheck_required");
  assert.deepEqual(conflict.claim.conflictEvidenceIds.sort(), ["a", "b"]);
});

test("completed calls replay after a recoverable restart without losing locks", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "travel-fault-restart-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.sqlite");
  let db = openDatabase(path);
  const store = new ExecutionStore(db, now);
  const { job } = store.create(executableTrip().brief);
  let externalCalls = 0;
  let failOnce = true;
  const handlers = Object.fromEntries(PLANNING_STAGES.map((stage) => [stage, {
    requiresKey: stage === "skeleton_planning",
    run: async (ctx: Parameters<StageHandlers[typeof stage]["run"]>[0]) => {
      if (stage === "skeleton_planning") {
        await ctx.once("provider", { stable: true }, async () => { externalCalls += 1; return { ok: true }; });
        if (failOnce) { failOnce = false; throw new Error("PROVIDER_TIMEOUT"); }
      }
      if (stage === "finalization") return { trip: executableTrip() };
      return {};
    },
  }])) as StageHandlers;
  await new PlanningExecutor(store, handlers, now).run(job.id, new TransientSecret("sk-fixture-0123456789abcdef"));
  assert.equal(store.view(job.id).errorCode, "PROVIDER_TIMEOUT");
  store.update(job.id, (current) => ({ ...current, status: "queued", errorCode: undefined }));
  db.close();
  db = openDatabase(path);
  t.after(() => db.close());
  const resumed = new ExecutionStore(db, now);
  await new PlanningExecutor(resumed, handlers, now).run(job.id, new TransientSecret("sk-fixture-0123456789abcdef"));
  assert.equal(externalCalls, 1);
  assert.equal(resumed.view(job.id).status, "completed");
  assert.equal(resumed.view(job.id).trip?.brief.bookedItems.every((item) => item.locked), true);
});

test("SQLite rollback, missing Key and export failure preserve public state", async (t) => {
  const db = openDatabase();
  t.after(() => db.close());
  const store = new ExecutionStore(db, now);
  const created = store.create(executableTrip().brief);
  const before = JSON.stringify(store.state(created.job.id));
  db.exec("CREATE TRIGGER fail_execution_write BEFORE UPDATE ON planning_execution BEGIN SELECT RAISE(FAIL, 'injected'); END");
  assert.throws(() => store.update(created.job.id, (_job, state) => { state.choices.push("must rollback"); }));
  db.exec("DROP TRIGGER fail_execution_write");
  assert.equal(JSON.stringify(store.state(created.job.id)), before);
  const stages = Object.fromEntries(PLANNING_STAGES.map((stage) => [stage, { requiresKey: stage === "skeleton_planning", run: async () => ({}) }])) as unknown as StageHandlers;
  await new PlanningExecutor(store, stages, now).run(created.job.id);
  assert.equal(store.view(created.job.id).status, "waiting_for_credentials");
  assert.match(store.view(created.job.id).message, /重新提供 DeepSeek Key/);
  const exportTrip = executableTrip();
  const failed = await exportHttp(() => true, async () => { throw new Error("private renderer path"); })(new Request("http://local", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ trip: exportTrip, fields: { budget: false, privateNotes: false } }) }), exportTrip.id, "pdf");
  assert.equal(failed.status, 422);
  assert.doesNotMatch(await failed.text(), /private renderer path/);
});
