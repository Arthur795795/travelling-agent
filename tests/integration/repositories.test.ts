import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../../src/persistence/database.ts";
import {
  PlanningJobRepository,
  ShareRecordRepository,
  TripRepository,
  TripRevisionRepository,
  VersionConflictError,
} from "../../src/persistence/repositories.ts";
import { buildTripFixture } from "../fixtures/trip.ts";
import { SensitivePersistenceError } from "../../src/security/redaction.ts";

const now = new Date("2026-09-04T10:00:00+08:00");
const future = "2026-10-04T10:00:00+08:00";

function buildJob() {
  return {
    schemaVersion: 1 as const,
    id: "job-1",
    version: 0,
    status: "queued" as const,
    stageResults: [],
    cancelRequested: false,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: future,
  };
}

test("SQLite repositories survive reconnect and preserve completed stages", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "travel-agent-db-"));
  const filename = join(directory, "test.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  let database = openDatabase(filename);
  const jobs = new PlanningJobRepository(database, () => now);
  jobs.create(buildJob());
  jobs.update(
    {
      ...buildJob(),
      status: "running",
      stageResults: [
        {
          stage: "requirements_check",
          status: "completed",
          startedAt: now.toISOString(),
          completedAt: now.toISOString(),
          summary: "brief complete",
        },
      ],
    },
    0,
  );
  database.close();

  database = openDatabase(filename);
  t.after(() => database.close());
  const restored = new PlanningJobRepository(database, () => now).get("job-1");
  assert.equal(restored?.version, 1);
  assert.equal(restored?.stageResults[0].stage, "requirements_check");
});

test("optimistic updates reject stale job and trip versions", () => {
  const database = openDatabase();
  const jobs = new PlanningJobRepository(database, () => now);
  const trips = new TripRepository(database, () => now);
  jobs.create(buildJob());
  const current = jobs.update({ ...buildJob(), status: "running" }, 0);
  assert.equal(current.version, 1);
  assert.throws(
    () => jobs.update({ ...current, status: "failed" }, 0),
    VersionConflictError,
  );

  const trip = trips.create(buildTripFixture(), future);
  const updated = trips.update(
    {
      ...trip,
      lifecycleStatus: "executable",
      updatedAt: "2026-09-04T11:00:00+08:00",
    },
    1,
    future,
  );
  assert.equal(updated.version, 2);
  assert.throws(() => trips.update(updated, 1, future), VersionConflictError);
  database.close();
});

test("expired records are unavailable and deletes are explicit", () => {
  const database = openDatabase();
  const expiredNow = () => new Date("2027-01-01T00:00:00+08:00");
  const trips = new TripRepository(database, expiredNow);
  trips.create(buildTripFixture(), future);
  assert.equal(trips.get("trip-beijing-001"), null);
  assert.equal(trips.delete("trip-beijing-001"), true);
  assert.equal(trips.delete("trip-beijing-001"), false);
  const jobs = new PlanningJobRepository(database, expiredNow);
  jobs.create(buildJob());
  assert.equal(jobs.get("job-1"), null);
  assert.equal(jobs.delete("job-1"), true);
  const shares = new ShareRecordRepository(database, expiredNow);
  shares.create({
    schemaVersion: 1,
    id: "expired-share",
    readTokenHash: "c".repeat(64),
    deleteTokenHash: "d".repeat(64),
    trip: buildTripFixture(),
    visibleFields: ["days"],
    createdAt: now.toISOString(),
    expiresAt: future,
  });
  assert.equal(shares.getByReadTokenHash("c".repeat(64)), null);
  database.close();
});

test("trip revisions and hashed share credentials expose their public behavior", () => {
  const database = openDatabase();
  const trips = new TripRepository(database, () => now);
  const revisions = new TripRevisionRepository(database);
  const shares = new ShareRecordRepository(database, () => now);
  const trip = trips.create(buildTripFixture(), future);
  revisions.create({
    id: "revision-1",
    tripId: trip.id,
    baseVersion: 1,
    nextVersion: 2,
    summary: "调整上午安排",
    createdAt: now.toISOString(),
  });
  assert.deepEqual(
    revisions.listForTrip(trip.id).map(({ id }) => id),
    ["revision-1"],
  );

  const readHash = "a".repeat(64);
  const deleteHash = "b".repeat(64);
  shares.create({
    schemaVersion: 1,
    id: "share-1",
    readTokenHash: readHash,
    deleteTokenHash: deleteHash,
    trip,
    visibleFields: ["days", "budget"],
    createdAt: now.toISOString(),
    expiresAt: future,
  });
  assert.equal(shares.getByReadTokenHash(readHash)?.id, "share-1");
  assert.equal(shares.deleteByDeleteTokenHash(deleteHash), true);
  assert.equal(shares.getByReadTokenHash(readHash), null);
  database.close();
});

test("database has no DeepSeek key column or supplied raw token", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "travel-agent-secret-db-"));
  const filename = join(directory, "test.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = openDatabase(filename);
  const rawSecret = "sk-not-a-real-key-raw-value";
  const jobs = new PlanningJobRepository(database, () => now);
  jobs.create({
    ...buildJob(),
    status: "running",
    stageResults: [
      {
        stage: "requirements_check",
        status: "completed",
        startedAt: now.toISOString(),
        completedAt: now.toISOString(),
        summary: `accidentally included ${rawSecret}`,
      },
    ],
  });
  assert.equal(
    jobs.get("job-1")?.stageResults[0].summary.includes(rawSecret),
    false,
  );
  const columns = database
    .prepare("PRAGMA table_info(planning_jobs)")
    .all() as Array<{ name: string }>;
  assert.equal(
    columns.some(({ name }) => /key|secret|credential/i.test(name)),
    false,
  );
  database.close();
  const rawDatabase = await readFile(filename, "utf8");
  assert.equal(rawDatabase.includes(rawSecret), false);
});

test("trip updates and revisions commit atomically and roll back together", () => {
  const database = openDatabase();
  const trips = new TripRepository(database, () => now);
  const revisions = new TripRevisionRepository(database);
  const original = trips.create(buildTripFixture(), future);
  const updatedInput = {
    ...original,
    lifecycleStatus: "executable" as const,
    updatedAt: "2026-09-04T11:00:00+08:00",
  };

  const committed = trips.updateWithRevision(updatedInput, 1, future, {
    id: "revision-success",
    tripId: original.id,
    baseVersion: 1,
    nextVersion: 2,
    summary: "通过校验",
    createdAt: "2026-09-04T11:00:00+08:00",
  });
  assert.equal(committed.trip.version, 2);
  assert.deepEqual(
    revisions.listForTrip(original.id).map(({ id }) => id),
    ["revision-success"],
  );

  assert.throws(() =>
    trips.updateWithRevision(
      {
        ...committed.trip,
        lifecycleStatus: "blocked",
        updatedAt: "2026-09-04T12:00:00+08:00",
      },
      2,
      future,
      {
        id: "revision-success",
        tripId: original.id,
        baseVersion: 2,
        nextVersion: 3,
        summary: "本次写入应回滚",
        createdAt: "2026-09-04T12:00:00+08:00",
      },
    ),
  );
  assert.equal(trips.get(original.id)?.version, 2);
  assert.equal(trips.get(original.id)?.lifecycleStatus, "executable");
  assert.equal(revisions.listForTrip(original.id).length, 1);
  database.close();
});

test("server persistence rejects full order and personal identifiers", () => {
  const database = openDatabase();
  const trips = new TripRepository(database, () => now);
  const revisions = new TripRevisionRepository(database);
  const trip = trips.create(buildTripFixture(), future);
  assert.throws(
    () =>
      revisions.create({
        id: "sensitive-revision",
        tripId: trip.id,
        baseVersion: 1,
        nextVersion: 2,
        summary: "订单号 ABCD1234567890",
        createdAt: now.toISOString(),
      }),
    SensitivePersistenceError,
  );
  assert.throws(
    () =>
      trips.update({ ...trip, assumptions: ["手机号 13800138000"] }, 1, future),
    SensitivePersistenceError,
  );
  assert.equal(trips.get(trip.id)?.version, 1);
  database.close();
});
