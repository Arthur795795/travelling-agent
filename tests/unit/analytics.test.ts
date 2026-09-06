import assert from "node:assert/strict";
import test from "node:test";
import {
  ANALYTICS_FIELDS,
  AnalyticsEventSchema,
  ClientAnalyticsEventSchema,
} from "../../src/analytics/events.ts";
import {
  listAnalyticsEvents,
  recordAnalyticsEvent,
} from "../../src/analytics/store.ts";
import {
  cleanupFeedback,
  FeedbackService,
  SensitiveFeedbackError,
} from "../../src/analytics/feedback.ts";
import { FEEDBACK_COMMENT_MAX } from "../../src/analytics/feedback-contract.ts";
import { openDatabase } from "../../src/persistence/database.ts";
import { SensitivePersistenceError } from "../../src/security/redaction.ts";

const AT = new Date("2026-09-05T02:30:00Z");

test("the event whitelist has no field a message or a trip could go into", () => {
  assert.equal(
    AnalyticsEventSchema.safeParse({
      name: "job_stage",
      stage: "evidence_collection",
      outcome: "ok",
      durationMs: 1200,
    }).success,
    true,
  );
  // An unknown key is refused instead of being stored alongside the event.
  for (const event of [
    { name: "error", message: "用户说想去故宫" },
    { name: "trip_edited", note: "行程第二天全部改掉" },
    { name: "job_finished", ip: "203.0.113.42" },
    { name: "job_finished", sessionId: "abc" },
  ])
    assert.equal(AnalyticsEventSchema.safeParse(event).success, false);
  // `code` is a machine code, so a sentence or punctuation cannot pass.
  for (const code of ["boom!", "请求失败", "lowercase", "A", "X".repeat(41)])
    assert.equal(
      AnalyticsEventSchema.safeParse({ name: "error", code }).success,
      false,
    );
  assert.equal(
    AnalyticsEventSchema.safeParse({ name: "error", code: "HANDLER_FAILED" })
      .success,
    true,
  );
  for (const bad of [-1, 1.5, 86_400_001])
    assert.equal(
      AnalyticsEventSchema.safeParse({ name: "job_stage", durationMs: bad })
        .success,
      false,
    );
  // A browser may only report the two events it can observe itself.
  assert.equal(
    ClientAnalyticsEventSchema.safeParse({
      name: "trip_edited",
      kind: "note",
      major: false,
    }).success,
    true,
  );
  for (const name of ["job_started", "job_stage", "share_created"])
    assert.equal(ClientAnalyticsEventSchema.safeParse({ name }).success, false);
});

test("the public event output stays inside the whitelist and blocks sensitive codes", (t) => {
  const db = openDatabase();
  t.after(() => db.close());
  recordAnalyticsEvent(
    db,
    { name: "job_started", outcome: "ok", status: 202 },
    AT,
  );
  recordAnalyticsEvent(
    db,
    { name: "export_created", format: "pdf", outcome: "ok", durationMs: 800 },
    new Date(AT.getTime() + 1000),
  );
  const events = listAnalyticsEvents(db);
  assert.equal(events.length, 2);
  const allowed = new Set<string>([...ANALYTICS_FIELDS, "at"]);
  for (const event of events)
    for (const field of Object.keys(event))
      assert.equal(allowed.has(field), true, `unexpected field ${field}`);
  assert.deepEqual(
    events.map((event) => event.name),
    ["job_started", "export_created"],
  );
  assert.equal(events[0].at, AT.toISOString());

  // Second line of defence: a code that would still smuggle an identity
  // number is refused by the persistence guard, and nothing is written.
  assert.throws(
    () =>
      recordAnalyticsEvent(
        db,
        { name: "error", code: "A110101199003077771" },
        AT,
      ),
    SensitivePersistenceError,
  );
  assert.equal(listAnalyticsEvents(db).length, 2);
});

test("feedback keeps a closed reason list, needs an explicit submit and hides its token", (t) => {
  const db = openDatabase();
  t.after(() => db.close());
  const service = new FeedbackService(db, () => AT);

  const receipt = service.create({
    rating: "down",
    context: "generated_trip",
    reasons: ["schedule", "schedule", "budget"],
    comment: "  第二天太赶了  ",
    confirmed: true,
  });
  assert.match(receipt.deleteToken, /^[a-f0-9]{64}$/);
  assert.equal(receipt.expiresAt, "2026-10-05T02:30:00.000Z");
  const row = db.prepare("SELECT * FROM feedback_records").get() as {
    delete_token_hash: string;
    rating: string;
    reasons: string;
    comment: string;
    context: string;
  };
  // Only a hash is stored, so the record cannot be traced back to its token.
  assert.match(row.delete_token_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(row.delete_token_hash, receipt.deleteToken);
  assert.deepEqual(JSON.parse(row.reasons), ["schedule", "budget"]);
  assert.equal(row.comment, "第二天太赶了");
  // No column exists for an owner, a session or an address.
  assert.deepEqual(
    (
      db.prepare("SELECT name FROM pragma_table_info('feedback_records')").all() as Array<{
        name: string;
      }>
    ).map(({ name }) => name),
    [
      "id",
      "delete_token_hash",
      "rating",
      "reasons",
      "comment",
      "context",
      "created_at",
      "expires_at",
    ],
  );

  for (const input of [
    { rating: "up", context: "fixed_demo", reasons: [] },
    { rating: "up", context: "fixed_demo", confirmed: false },
    { rating: "maybe", context: "fixed_demo", confirmed: true },
    { rating: "up", context: "unknown_screen", confirmed: true },
    { rating: "up", context: "fixed_demo", reasons: ["price"], confirmed: true },
    {
      rating: "up",
      context: "fixed_demo",
      confirmed: true,
      comment: "x".repeat(FEEDBACK_COMMENT_MAX + 1),
    },
    { rating: "up", context: "fixed_demo", confirmed: true, extra: "行程正文" },
  ])
    assert.throws(() => service.create(input));

  // A comment carrying personal data is refused before it is stored.
  assert.throws(
    () =>
      service.create({
        rating: "up",
        context: "fixed_demo",
        confirmed: true,
        comment: "有问题请打 13800138000",
      }),
    (error: unknown) =>
      error instanceof SensitiveFeedbackError && error.kind === "phone",
  );
  assert.equal(
    (
      db.prepare("SELECT COUNT(*) AS total FROM feedback_records").get() as {
        total: number;
      }
    ).total,
    1,
  );

  assert.equal(service.delete("not-a-token"), false);
  assert.equal(service.delete("f".repeat(64)), false);
  assert.equal(service.delete(receipt.deleteToken), true);
  assert.equal(service.delete(receipt.deleteToken), false);
});

test("feedback is dropped once its 30-day window closes", (t) => {
  const db = openDatabase();
  t.after(() => db.close());
  const service = new FeedbackService(db, () => AT);
  service.create({ rating: "up", context: "share", confirmed: true });
  assert.equal(cleanupFeedback(db, new Date("2026-10-04T02:30:00Z")), 0);
  assert.equal(cleanupFeedback(db, new Date("2026-10-05T02:30:00Z")), 1);
  assert.equal(cleanupFeedback(db, new Date("2026-10-05T02:30:00Z")), 0);
});
