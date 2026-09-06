import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../../src/persistence/database.ts";
import { ExecutionStore } from "../../src/jobs/execution-store.ts";
import { PlanningExecutor, type StageHandlers } from "../../src/jobs/executor.ts";
import { createJobHttp } from "../../src/jobs/http.ts";
import { PLANNING_STAGES } from "../../src/jobs/lifecycle.ts";
import { SharingService } from "../../src/sharing/service.ts";
import { ShareRecordRepository } from "../../src/persistence/repositories.ts";
import { sharingHttp } from "../../src/sharing/http.ts";
import { safeFetchText } from "../../src/security/safe-fetch.ts";
import { AgentToolRegistry } from "../../src/agent/tools/registry.ts";
import { createRequestGuard } from "../../src/security/guard.ts";
import { executableTrip } from "../fixtures/executable-trip.ts";

const MARKER = "sk-security-marker-0123456789abcdef";
const now = () => new Date("2026-09-06T00:00:00Z");

test("a marker Key crosses the job boundary but reaches no persistent or public output", async (t) => {
  const db = openDatabase();
  t.after(() => db.close());
  const store = new ExecutionStore(db, now);
  const handlers = Object.fromEntries(PLANNING_STAGES.map((stage) => [stage, {
    requiresKey: stage === "skeleton_planning",
    run: async () => stage === "finalization" ? { trip: executableTrip() } : {},
  }])) as unknown as StageHandlers;
  const executor = new PlanningExecutor(store, handlers, now);
  const http = createJobHttp(store, executor, () => true, now);
  const { schemaVersion: _, timeZone: __, ...input } = executableTrip().brief;
  void _; void __;
  const created = await http.create(new Request("http://local/api/planning-jobs", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ input, apiKey: MARKER }),
  }));
  assert.equal(created.status, 202);
  const publicResult = await created.json();
  const publicBody = JSON.stringify(publicResult);
  await executor.run(publicResult.id);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  const persisted = tables.flatMap(({ name }) => {
    if (!/^[a-z_]+$/.test(name)) return [];
    return db.prepare(`SELECT * FROM ${name}`).all();
  });
  const forbidden = JSON.stringify({ publicBody, persisted });
  assert.doesNotMatch(forbidden, new RegExp(MARKER));
  assert.doesNotMatch(forbidden, /reasoning|chain.of.thought/i);
});

test("share tokens cannot be enumerated or substituted and the page is noindex", async (t) => {
  const db = openDatabase();
  t.after(() => db.close());
  const api = sharingHttp(new SharingService(new ShareRecordRepository(db, now), now), () => true);
  const created = await api.create(new Request("http://local", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ trip: executableTrip(), fields: { budget: false, privateNotes: false }, confirmed: true }) }));
  const tokens = await created.json();
  const readToken = tokens.readUrl.split("/").at(-1);
  assert.equal(api.read("0".repeat(64)).status, 404);
  assert.equal(api.delete(readToken).status, 404);
  const read = api.read(readToken);
  assert.match(read.headers.get("x-robots-tag") ?? "", /noindex/);
  assert.equal(api.delete(tokens.deleteToken).status, 204);
  assert.equal(api.read(readToken).status, 404);
});

test("hostile URLs, long tool inputs, feature flags and monthly stop fail before effects", async () => {
  let requests = 0;
  await assert.rejects(() => safeFetchText("http://169.254.169.254/latest/meta-data", {}, { requestImpl: async () => { requests += 1; return new Response("secret"); } }));
  assert.equal(requests, 0);
  await assert.rejects(
    () => safeFetchText(
      "https://public.example/start",
      {},
      {
        resolveHostname: async (hostname) =>
          hostname === "public.example" ? ["93.184.216.34"] : ["127.0.0.1"],
        fetchImpl: async () => {
          requests += 1;
          return new Response(null, {
            status: 302,
            headers: { location: "http://127.0.0.1/private" },
          });
        },
      },
    ),
  );
  assert.equal(requests, 1);
  const registry = new AgentToolRegistry();
  let toolCalls = 0;
  const { z } = await import("zod");
  registry.register({ name: "web_search", inputSchema: z.object({ query: z.string().max(20) }), isEnabled: () => true, execute: async () => { toolCalls += 1; return { status: "success", data: {} }; } });
  const result = await registry.invoke({ jobId: "j", stage: "evidence_collection", callId: "c", idempotencyKey: "i", name: "web_search", arguments: { query: "x".repeat(1000) } });
  assert.equal(result.code, "INVALID_ARGUMENTS");
  assert.equal(toolCalls, 0);
  const db = openDatabase();
  const guard = createRequestGuard({ db, now, flags: () => ({ customGeneration: true, webSearch: false, amap: false, sharing: false, export: false, offlineReadonly: false }) });
  for (let i = 0; i < 500; i += 1) guard.recordProductCost(1);
  const blocked = guard.check("planning_job", new Request("http://local", { headers: { "x-forwarded-for": "203.0.113.2" } }));
  assert.equal(blocked.allowed, false);
  if (!blocked.allowed) assert.equal(blocked.code, "PRODUCT_BUDGET_STOP");
  db.close();
});
