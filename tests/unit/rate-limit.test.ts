import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../../src/persistence/database.ts";
import {
  DEFAULT_RATE_LIMITS,
  RateLimiter,
  cleanupRateLimits,
  localDay,
  localMonth,
  monthlyProductCost,
  recordProductCost,
} from "../../src/security/rate-limit.ts";

const IP = "203.0.113.77";

test("identity hashing rotates daily, never persists the raw IP and drops the previous salt", (t) => {
  const db = openDatabase();
  t.after(() => db.close());
  let clock = new Date("2026-09-05T02:00:00Z");
  const limiter = new RateLimiter(db, () => clock);

  const first = limiter.identity({ sessionId: "session-a", ip: IP });
  assert.equal(limiter.identity({ sessionId: "session-a", ip: IP }), first);
  // Both inputs take part: changing either one changes the bucket.
  assert.notEqual(limiter.identity({ sessionId: "session-b", ip: IP }), first);
  assert.notEqual(
    limiter.identity({ sessionId: "session-a", ip: "198.51.100.9" }),
    first,
  );

  limiter.consume("planning_job", first);
  clock = new Date("2026-09-06T02:00:00Z");
  const next = limiter.identity({ sessionId: "session-a", ip: IP });
  assert.notEqual(next, first);
  // Yesterday's salt is destroyed, so yesterday's stored hash cannot be
  // recomputed from today's inputs.
  const days = db
    .prepare("SELECT day FROM rate_limit_salts")
    .all() as Array<{ day: string }>;
  assert.deepEqual(
    days.map((row) => row.day),
    [localDay(clock)],
  );

  const dump = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;
  for (const { name } of dump) {
    const rows = db.prepare(`SELECT * FROM "${name}"`).all();
    assert.doesNotMatch(JSON.stringify(rows), /203\.0\.113\.77|session-a/);
  }
});

test("each scope keeps an independent quota with a predictable retry time", (t) => {
  const db = openDatabase();
  t.after(() => db.close());
  let clock = new Date("2026-09-05T02:30:00Z");
  const limits = {
    ...DEFAULT_RATE_LIMITS,
    planning_job: { limit: 2, windowMs: 3_600_000 },
    export: { limit: 1, windowMs: 3_600_000 },
  };
  const limiter = new RateLimiter(db, () => clock, limits);
  const id = limiter.identity({ sessionId: "s", ip: IP });

  assert.equal(limiter.consume("planning_job", id).allowed, true);
  const second = limiter.consume("planning_job", id);
  assert.deepEqual(second.allowed && second.remaining, 0);
  const refused = limiter.consume("planning_job", id);
  assert.equal(refused.allowed, false);
  if (!refused.allowed) {
    assert.equal(refused.code, "RATE_LIMITED");
    // Window started 02:00, so 30 minutes remain.
    assert.equal(refused.retryAfterSeconds, 1800);
    assert.equal(refused.resetAt, "2026-09-05T03:00:00.000Z");
  }
  // A different scope is untouched by the exhausted one.
  assert.equal(limiter.consume("export", id).allowed, true);
  assert.equal(limiter.consume("export", id).allowed, false);
  // Counters never exceed the limit even when calls interleave.
  assert.equal(limiter.peek("planning_job", id), 2);

  clock = new Date("2026-09-05T03:00:00Z");
  assert.equal(limiter.consume("planning_job", id).allowed, true);
});

test("concurrent consumption never oversells a window", async (t) => {
  const db = openDatabase();
  t.after(() => db.close());
  const at = new Date("2026-09-05T02:00:00Z");
  const limiter = new RateLimiter(db, () => at, {
    ...DEFAULT_RATE_LIMITS,
    sharing: { limit: 3, windowMs: 3_600_000 },
  });
  const id = limiter.identity({ sessionId: "s", ip: IP });
  const results = await Promise.all(
    Array.from({ length: 10 }, async () => limiter.consume("sharing", id)),
  );
  assert.equal(results.filter((r) => r.allowed).length, 3);
  assert.equal(limiter.peek("sharing", id), 3);
});

test("the product quota is shared, and product spend aggregates by local month", (t) => {
  const db = openDatabase();
  t.after(() => db.close());
  const at = new Date("2026-09-05T02:00:00Z");
  const limiter = new RateLimiter(db, () => at, {
    ...DEFAULT_RATE_LIMITS,
    amap: { limit: 2, windowMs: 86_400_000 },
  });
  assert.equal(limiter.consumeProduct("amap").allowed, true);
  assert.equal(limiter.consumeProduct("amap").allowed, true);
  assert.equal(limiter.consumeProduct("amap").allowed, false);
  // Visitor buckets are not affected by the exhausted product bucket.
  assert.equal(
    limiter.consume("planning_job", limiter.identity({ sessionId: "s" }))
      .allowed,
    true,
  );

  recordProductCost(db, 1.5, at);
  recordProductCost(db, 0, at);
  recordProductCost(db, -3, at);
  recordProductCost(db, 2, new Date("2026-08-20T00:00:00Z"));
  assert.equal(monthlyProductCost(db, at), 1.5);
  assert.equal(localMonth(at), "2026-09");
  // 2026-08-31T16:30Z is already 2026-09-01 in Asia/Shanghai.
  assert.equal(localMonth(new Date("2026-08-31T16:30:00Z")), "2026-09");

  assert.deepEqual(cleanupRateLimits(db, new Date("2026-09-07T02:00:00Z")), {
    counters: 2,
    salts: 1,
  });
});
