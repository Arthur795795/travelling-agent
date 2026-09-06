import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/persistence/database.ts";
import { ShareRecordRepository } from "../../src/persistence/repositories.ts";
import { SharingService } from "../../src/sharing/service.ts";
import { sharingHttp } from "../../src/sharing/http.ts";
import { GET as demoRoute } from "../../src/app/api/demo/beijing/route.ts";
import { createRequestGuard } from "../../src/security/guard.ts";
import {
  DEFAULT_RATE_LIMITS,
  RateLimiter,
  recordProductCost,
  SESSION_COOKIE,
} from "../../src/security/index.ts";
import { loadFeatureFlags, type FeatureFlags } from "../../src/config/index.ts";
import { executableTrip } from "../fixtures/executable-trip.ts";

const IP = "203.0.113.42";
const open = (flags: Partial<FeatureFlags> = {}): FeatureFlags => ({
  ...loadFeatureFlags({
    FEATURE_CUSTOM_GENERATION: "true",
    FEATURE_WEB_SEARCH: "true",
    FEATURE_AMAP: "true",
    FEATURE_SHARING: "true",
    FEATURE_EXPORT: "true",
  }),
  ...flags,
});

function harness(t: { after: (fn: () => void) => void }, flags: FeatureFlags) {
  const db = openDatabase();
  t.after(() => db.close());
  let clock = new Date("2026-09-05T02:30:00Z");
  let current = flags;
  const limiter = new RateLimiter(db, () => clock, {
    ...DEFAULT_RATE_LIMITS,
    key_validation: { limit: 2, windowMs: 3_600_000 },
    planning_job: { limit: 2, windowMs: 3_600_000 },
    sharing: { limit: 2, windowMs: 3_600_000 },
    export: { limit: 2, windowMs: 3_600_000 },
    search: { limit: 1, windowMs: 86_400_000 },
  });
  const guard = createRequestGuard({
    db,
    now: () => clock,
    flags: () => current,
    limiter,
  });
  const calls: string[] = [];
  const handler = (name: string) => () => {
    calls.push(name);
    return Response.json({ ok: true });
  };
  const request = (cookie?: string) =>
    new Request("http://local/api/test", {
      method: "POST",
      headers: {
        "x-forwarded-for": `${IP}, 10.0.0.1`,
        ...(cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {}),
      },
    });
  return {
    db,
    guard,
    limiter,
    calls,
    handler,
    request,
    setFlags: (next: FeatureFlags) => (current = next),
    setClock: (next: Date) => (clock = next),
  };
}

test("over-limit requests are refused before the handler runs and report a retry time", async (t) => {
  const { guard, calls, handler, request } = harness(t, open());
  const first = await guard.protect("key_validation", request(), handler("key"));
  assert.equal(first.status, 200);
  const cookie = first.headers.getSetCookie()[0];
  assert.match(cookie, /^anon_session=[0-9a-f-]{36}; HttpOnly/);
  assert.match(cookie, /SameSite=Lax; Path=\/; Max-Age=86400$/);
  assert.equal(first.headers.get("X-RateLimit-Remaining"), "1");

  const session = cookie.split(";")[0].split("=")[1];
  const second = await guard.protect(
    "key_validation",
    request(session),
    handler("key"),
  );
  assert.equal(second.status, 200);
  // A known session is not re-issued a cookie.
  assert.deepEqual(second.headers.getSetCookie(), []);

  const refused = await guard.protect(
    "key_validation",
    request(session),
    handler("key"),
  );
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get("Retry-After"), "1800");
  assert.equal(refused.headers.get("Cache-Control"), "no-store");
  const body = await refused.json();
  assert.equal(body.code, "RATE_LIMITED");
  assert.equal(body.retryAfterSeconds, 1800);
  assert.equal(body.retryAt, "2026-09-05T03:00:00.000Z");
  // No identifier, counter or internal detail leaks into the public error.
  assert.deepEqual(Object.keys(body).sort(), [
    "code",
    "message",
    "retryAfterSeconds",
    "retryAt",
  ]);
  assert.doesNotMatch(
    JSON.stringify(body),
    /203\.0\.113\.42|anon_session|[0-9a-f]{64}/,
  );
  // The refused request never reached the handler, so no external call happened.
  assert.deepEqual(calls, ["key", "key"]);
});

test("quotas, flags and the fixed demo stay independent of each other", async (t) => {
  const h = harness(t, open());
  const session = "session-fixed";
  const spend = (scope: "key_validation" | "planning_job" | "export") =>
    h.guard.protect(scope, h.request(session), h.handler(scope));

  assert.equal((await spend("key_validation")).status, 200);
  assert.equal((await spend("key_validation")).status, 200);
  assert.equal((await spend("key_validation")).status, 429);
  // Exhausting one endpoint leaves the others untouched.
  assert.equal((await spend("planning_job")).status, 200);
  assert.equal((await spend("export")).status, 200);

  // Turning off sharing must not touch export, and must not spend quota.
  h.setFlags(open({ sharing: false }));
  const blocked = await h.guard.protect(
    "sharing",
    h.request(session),
    h.handler("sharing"),
  );
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).code, "FEATURE_DISABLED");
  const identity = h.limiter.identity({ sessionId: session, ip: IP });
  assert.equal(h.limiter.peek("sharing", identity), 0);
  assert.equal((await spend("export")).status, 200);
  assert.deepEqual(h.calls, [
    "key_validation",
    "key_validation",
    "planning_job",
    "export",
    "export",
  ]);

  // The generation hard stop closes new jobs but not the fixed demo.
  h.setFlags(open());
  recordProductCost(h.db, 500, new Date("2026-09-05T02:30:00Z"));
  const stopped = await h.guard.protect(
    "planning_job",
    h.request(session),
    h.handler("planning_job"),
  );
  assert.equal(stopped.status, 403);
  assert.equal((await stopped.json()).code, "PRODUCT_BUDGET_STOP");
  const demo = demoRoute();
  assert.equal(demo.status, 200);
  assert.equal(demo.headers.get("X-Demo-Mode"), "fixed-no-network");
  assert.equal((await demo.json()).trip.brief.destination, "北京");
  // Export still works while generation is stopped.
  assert.equal((await spend("export")).status, 429);
  assert.equal(h.limiter.peek("export", identity), 2);
});

test("a closed feature keeps its read-only view working and stored rows hold no raw IP", async (t) => {
  const h = harness(t, open());
  const service = new SharingService(
    new ShareRecordRepository(h.db, () => new Date("2026-09-05T02:30:00Z")),
    () => new Date("2026-09-05T02:30:00Z"),
  );
  let sharingEnabled = true;
  const api = sharingHttp(service, () => sharingEnabled);
  const created = await h.guard.protect("sharing", h.request("s"), () =>
    api.create(
      new Request("http://local/api/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trip: executableTrip(),
          fields: { budget: false, privateNotes: false },
          confirmed: true,
        }),
      }),
    ),
  );
  assert.equal(created.status, 201);
  const token = (await created.json()).readUrl.split("/").at(-1);

  sharingEnabled = false;
  h.setFlags(open({ sharing: false }));
  const refused = await h.guard.protect("sharing", h.request("s"), () =>
    api.create(new Request("http://local/api/shares", { method: "POST" })),
  );
  assert.equal(refused.status, 403);
  // Reading an existing share is a read-only path and stays available.
  assert.equal(api.read(token).status, 200);

  const tables = h.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;
  for (const { name } of tables) {
    const rows = JSON.stringify(h.db.prepare(`SELECT * FROM "${name}"`).all());
    assert.doesNotMatch(rows, /203\.0\.113\.42|10\.0\.0\.1/);
  }
});

test("the shared product quota closes outbound tool calls without touching visitors", async (t) => {
  const h = harness(t, open());
  assert.equal(h.guard.allowProductCall("search"), true);
  assert.equal(h.guard.allowProductCall("search"), false);
  assert.equal(h.guard.allowProductCall("amap"), true);
  assert.equal(
    (
      await h.guard.protect(
        "planning_job",
        h.request("s"),
        h.handler("planning_job"),
      )
    ).status,
    200,
  );
  h.guard.recordProductCost(0.4);
  assert.equal(h.guard.monthlyProductCostCny(), 0.4);
  // A new day reopens the product quota.
  h.setClock(new Date("2026-09-06T02:30:00Z"));
  assert.equal(h.guard.allowProductCall("search"), true);
});

test("the real shares route refuses over its default quota", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "travel-guard-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  process.env.SQLITE_PATH = join(directory, "guard.sqlite");
  process.env.FEATURE_SHARING = "true";
  t.after(() => {
    delete process.env.SQLITE_PATH;
    delete process.env.FEATURE_SHARING;
  });
  const { POST } = await import("../../src/app/api/shares/route.ts");
  const call = () =>
    POST(
      new Request("http://local/api/shares", {
        method: "POST",
        headers: {
          "x-forwarded-for": IP,
          cookie: `${SESSION_COOKIE}=route-session`,
        },
        body: "{}",
      }),
    );
  const statuses: number[] = [];
  for (let index = 0; index <= DEFAULT_RATE_LIMITS.sharing.limit; index++)
    statuses.push((await call()).status);
  assert.deepEqual(
    new Set(statuses.slice(0, DEFAULT_RATE_LIMITS.sharing.limit)),
    new Set([400]),
  );
  assert.equal(statuses.at(-1), 429);
});
