import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Type-only, so nothing is loaded before the database path is set below.
import type { StageHandler, StageHandlers } from "../../src/jobs/executor.ts";
import type { PlanningStage } from "../../src/domain/schema.ts";

// The routes memoize one database, so the path is fixed before any import.
const directory = mkdtempSync(join(tmpdir(), "travel-analytics-"));
process.env.SQLITE_PATH = join(directory, "analytics.sqlite");
after(() => {
  delete process.env.SQLITE_PATH;
  rmSync(directory, { recursive: true, force: true });
});

const IP = "203.0.113.55";
const SESSION = "analytics-session";
const post = (path: string, body: unknown) =>
  new Request(`http://local${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": IP,
      cookie: `anon_session=${SESSION}`,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/** Fails if any table holds the request identity or a chat/trip fragment. */
function assertCleanDatabase(db: {
  prepare: (sql: string) => { all: () => unknown[] };
}) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;
  for (const { name } of tables) {
    const dump = JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all());
    assert.doesNotMatch(dump, /203\.0\.113\.55|analytics-session/);
    assert.doesNotMatch(dump, /故宫|第二天太赶了/);
  }
}

test("the ingest route stores only whitelisted browser events", async () => {
  const { POST } = await import("../../src/app/api/analytics/route.ts");
  const { applicationDatabase } = await import(
    "../../src/persistence/runtime.ts"
  );
  const { listAnalyticsEvents } = await import(
    "../../src/analytics/store.ts"
  );

  const accepted = await POST(
    post("/api/analytics", {
      name: "trip_edited",
      kind: "note",
      major: false,
      outcome: "ok",
    }),
  );
  assert.equal(accepted.status, 202);
  assert.equal(await accepted.text(), "");

  for (const body of [
    { name: "job_started", outcome: "ok" },
    { name: "trip_edited", note: "想把故宫换成天坛" },
    { name: "error", code: "失败了" },
    "not json",
  ]) {
    const refused = await POST(post("/api/analytics", body));
    assert.equal(refused.status, 400);
    assert.deepEqual(await refused.json(), { code: "INVALID_EVENT" });
  }

  const events = listAnalyticsEvents(applicationDatabase());
  assert.deepEqual(
    events.map((event) => event.name),
    ["trip_edited"],
  );
  assert.deepEqual(Object.keys(events[0]).sort(), [
    "at",
    "kind",
    "major",
    "name",
    "outcome",
  ]);
  assertCleanDatabase(applicationDatabase());
});

test("a visitor can submit, be refused and delete their own feedback", async () => {
  const { GET, POST } = await import("../../src/app/api/feedback/route.ts");
  const { DELETE } = await import(
    "../../src/app/api/feedback/[token]/route.ts"
  );
  const { applicationDatabase } = await import(
    "../../src/persistence/runtime.ts"
  );
  const { listAnalyticsEvents } = await import(
    "../../src/analytics/store.ts"
  );
  const { FEEDBACK_PURPOSE, FEEDBACK_REASONS } = await import(
    "../../src/analytics/feedback-contract.ts"
  );
  const db = applicationDatabase();
  const count = () =>
    (
      db.prepare("SELECT COUNT(*) AS total FROM feedback_records").get() as {
        total: number;
      }
    ).total;

  // The purpose notice is served before anything is submitted.
  const purpose = await GET();
  assert.equal(purpose.status, 200);
  assert.deepEqual(await purpose.json(), {
    purpose: FEEDBACK_PURPOSE,
    reasons: [...FEEDBACK_REASONS],
  });

  const created = await POST(
    post("/api/feedback", {
      rating: "down",
      context: "generated_trip",
      reasons: ["schedule"],
      comment: "第二天太赶了",
      confirmed: true,
    }),
  );
  assert.equal(created.status, 201);
  const receipt = (await created.json()) as Record<string, string>;
  assert.deepEqual(Object.keys(receipt).sort(), [
    "deleteToken",
    "expiresAt",
    "id",
  ]);
  assert.match(receipt.deleteToken, /^[a-f0-9]{64}$/);
  assert.equal(count(), 1);

  // A comment carrying an identity number is refused, and nothing is kept.
  const sensitive = await POST(
    post("/api/feedback", {
      rating: "up",
      context: "share",
      confirmed: true,
      comment: "我的证件号是 110101199003077771",
    }),
  );
  assert.equal(sensitive.status, 400);
  assert.equal(
    ((await sensitive.json()) as { code: string }).code,
    "SENSITIVE_FEEDBACK",
  );
  // Without the explicit submit flag the request is refused as well.
  const unconfirmed = await POST(
    post("/api/feedback", { rating: "up", context: "share" }),
  );
  assert.equal(unconfirmed.status, 400);
  assert.deepEqual(await unconfirmed.json(), { code: "INVALID_FEEDBACK" });
  assert.equal(count(), 1);

  const params = (token: string) => ({ params: Promise.resolve({ token }) });
  assert.equal(
    (await DELETE(new Request("http://local"), params("nope"))).status,
    404,
  );
  assert.equal(
    (await DELETE(new Request("http://local"), params(receipt.deleteToken)))
      .status,
    204,
  );
  assert.equal(
    (await DELETE(new Request("http://local"), params(receipt.deleteToken)))
      .status,
    404,
  );
  assert.equal(count(), 0);

  // The rating is measured; the comment never reaches the event log.
  const submissions = listAnalyticsEvents(db).filter(
    (event) => event.name === "feedback_submitted",
  );
  assert.deepEqual(
    submissions.map((event) => [event.outcome, event.rating ?? null]),
    [
      ["ok", "down"],
      ["blocked", null],
      ["failed", null],
    ],
  );
  assertCleanDatabase(db);
});

test("job lifecycle reports stages and outcomes without any trip content", async (t) => {
  const { openDatabase } = await import("../../src/persistence/database.ts");
  const { ExecutionStore } = await import(
    "../../src/jobs/execution-store.ts"
  );
  const { PlanningExecutor } = await import("../../src/jobs/executor.ts");
  const { PLANNING_STAGES } = await import("../../src/jobs/lifecycle.ts");
  const { AnalyticsEventSchema } = await import(
    "../../src/analytics/events.ts"
  );
  const { TransientSecret } = await import("../../src/security/secrets.ts");
  const { executableTrip } = await import("../fixtures/executable-trip.ts");

  const db = openDatabase();
  t.after(() => db.close());
  const now = () => new Date("2026-09-05T00:00:00Z");
  const store = new ExecutionStore(db, now);
  const events: unknown[] = [];
  const stages = (failing = false) =>
    Object.fromEntries(
      PLANNING_STAGES.map((stage): [PlanningStage, StageHandler] => [
        stage,
        {
          requiresKey: stage === "skeleton_planning",
          run: async () => {
            if (failing && stage === "evidence_collection")
              throw new Error("SEARCH_UNAVAILABLE");
            return stage === "finalization" ? { trip: executableTrip() } : {};
          },
        },
      ]),
    ) as StageHandlers;
  const executor = (failing = false) =>
    new PlanningExecutor(store, stages(failing), now, 180000, undefined, (e) =>
      events.push(e),
    );
  const key = () => new TransientSecret("sk-test-0123456789abcdef");

  // A run without a key blocks at the first stage that needs one.
  const waiting = store.create(executableTrip().brief);
  await executor().run(waiting.job.id);
  assert.deepEqual(events, [
    {
      name: "job_stage",
      stage: "requirements_check",
      outcome: "ok",
      durationMs: 0,
    },
    {
      name: "job_finished",
      outcome: "blocked",
      code: "KEY_REQUIRED",
      durationMs: 0,
    },
  ]);

  events.length = 0;
  await executor().run(waiting.job.id, key());
  // The resumed run reports the remaining stages, then one finish.
  assert.deepEqual(
    events.slice(0, -1).map((event) => (event as { stage: string }).stage),
    PLANNING_STAGES.slice(1),
  );
  assert.deepEqual(
    new Set(events.slice(0, -1).map((event) => (event as { name: string }).name)),
    new Set(["job_stage"]),
  );
  assert.deepEqual(events.at(-1), {
    name: "job_finished",
    outcome: "ok",
    durationMs: 0,
  });

  events.length = 0;
  const failed = store.create(executableTrip().brief);
  await executor(true).run(failed.job.id, key());
  assert.deepEqual(events.at(-1), {
    name: "job_finished",
    outcome: "failed",
    code: "SEARCH_UNAVAILABLE",
    durationMs: 0,
  });

  events.length = 0;
  const cancelled = store.create(executableTrip().brief);
  const runner = executor();
  runner.cancel(cancelled.job.id);
  // A repeated cancel must not report a second finish.
  runner.cancel(cancelled.job.id);
  assert.deepEqual(events, [
    { name: "job_finished", outcome: "cancelled", durationMs: 0 },
  ]);

  // Everything emitted is inside the whitelist and free of trip text.
  for (const event of events) AnalyticsEventSchema.parse(event);
  assert.doesNotMatch(JSON.stringify(events), /北京|故宫/);
});
