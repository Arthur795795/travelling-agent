import {
  PlanningJobSchema,
  ShareRecordSchema,
  TripRevisionSchema,
  TripSchema,
  IsoDateTimeSchema,
  type PlanningJob,
  type ShareRecord,
  type Trip,
  type TripRevision,
} from "../domain/schema.ts";
import { assertNoSensitiveData, redactText } from "../security/redaction.ts";
import type { SqliteDatabase } from "./database.ts";

export class VersionConflictError extends Error {
  readonly code = "VERSION_CONFLICT";

  constructor(entity: string, id: string) {
    super(`${entity} ${id} was updated by another request`);
    this.name = "VersionConflictError";
  }
}

function isAvailable(expiresAt: string, now: Date): boolean {
  return Date.parse(expiresAt) > now.getTime();
}

function sanitizeJob(input: PlanningJob): PlanningJob {
  const job = PlanningJobSchema.parse({
    ...input,
    errorCode: input.errorCode ? redactText(input.errorCode) : undefined,
    stageResults: input.stageResults.map((result) => ({
      ...result,
      summary: redactText(result.summary),
    })),
  });
  assertNoSensitiveData(job);
  return job;
}

function insertRevision(
  database: SqliteDatabase,
  revision: TripRevision,
): void {
  database
    .prepare(
      `
    INSERT INTO trip_revisions (id, trip_id, base_version, next_version, summary, payload, created_at)
    VALUES (@id, @tripId, @baseVersion, @nextVersion, @summary, @payload, @createdAt)
  `,
    )
    .run({ ...revision, payload: JSON.stringify(revision) });
}

export class PlanningJobRepository {
  private readonly database: SqliteDatabase;
  private readonly now: () => Date;

  constructor(database: SqliteDatabase, now = () => new Date()) {
    this.database = database;
    this.now = now;
  }

  create(input: PlanningJob): PlanningJob {
    const job = sanitizeJob(PlanningJobSchema.parse(input));
    this.database
      .prepare(
        `
      INSERT INTO planning_jobs (id, version, status, payload, created_at, updated_at, expires_at)
      VALUES (@id, @version, @status, @payload, @createdAt, @updatedAt, @expiresAt)
    `,
      )
      .run({ ...job, payload: JSON.stringify(job) });
    return job;
  }

  get(id: string): PlanningJob | null {
    const row = this.database
      .prepare("SELECT payload, expires_at FROM planning_jobs WHERE id = ?")
      .get(id) as { payload: string; expires_at: string } | undefined;
    if (!row || !isAvailable(row.expires_at, this.now())) return null;
    return PlanningJobSchema.parse(JSON.parse(row.payload));
  }

  update(input: PlanningJob, expectedVersion: number): PlanningJob {
    const job = sanitizeJob(
      PlanningJobSchema.parse({ ...input, version: expectedVersion + 1 }),
    );
    const result = this.database
      .prepare(
        `
      UPDATE planning_jobs
      SET version = @version, status = @status, payload = @payload,
          updated_at = @updatedAt, expires_at = @expiresAt
      WHERE id = @id AND version = @expectedVersion
    `,
      )
      .run({ ...job, expectedVersion, payload: JSON.stringify(job) });
    if (result.changes !== 1)
      throw new VersionConflictError("PlanningJob", job.id);
    return job;
  }

  delete(id: string): boolean {
    return (
      this.database.prepare("DELETE FROM planning_jobs WHERE id = ?").run(id)
        .changes === 1
    );
  }
}

export class TripRepository {
  private readonly database: SqliteDatabase;
  private readonly now: () => Date;

  constructor(database: SqliteDatabase, now = () => new Date()) {
    this.database = database;
    this.now = now;
  }

  create(input: Trip, expiresAt: string): Trip {
    const trip = TripSchema.parse(input);
    IsoDateTimeSchema.parse(expiresAt);
    assertNoSensitiveData(trip);
    this.database
      .prepare(
        `
      INSERT INTO trips (id, version, payload, created_at, updated_at, expires_at)
      VALUES (@id, @version, @payload, @createdAt, @updatedAt, @expiresAt)
    `,
      )
      .run({ ...trip, payload: JSON.stringify(trip), expiresAt });
    return trip;
  }

  get(id: string): Trip | null {
    const row = this.database
      .prepare("SELECT payload, expires_at FROM trips WHERE id = ?")
      .get(id) as { payload: string; expires_at: string } | undefined;
    if (!row || !isAvailable(row.expires_at, this.now())) return null;
    return TripSchema.parse(JSON.parse(row.payload));
  }

  update(input: Trip, expectedVersion: number, expiresAt: string): Trip {
    const trip = TripSchema.parse({ ...input, version: expectedVersion + 1 });
    IsoDateTimeSchema.parse(expiresAt);
    assertNoSensitiveData(trip);
    const result = this.database
      .prepare(
        `
      UPDATE trips SET version = @version, payload = @payload, updated_at = @updatedAt, expires_at = @expiresAt
      WHERE id = @id AND version = @expectedVersion
    `,
      )
      .run({
        ...trip,
        expectedVersion,
        expiresAt,
        payload: JSON.stringify(trip),
      });
    if (result.changes !== 1) throw new VersionConflictError("Trip", trip.id);
    return trip;
  }

  updateWithRevision(
    input: Trip,
    expectedVersion: number,
    expiresAt: string,
    revisionInput: TripRevision,
  ): { trip: Trip; revision: TripRevision } {
    const trip = TripSchema.parse({ ...input, version: expectedVersion + 1 });
    const revision = TripRevisionSchema.parse(revisionInput);
    IsoDateTimeSchema.parse(expiresAt);
    assertNoSensitiveData(trip);
    assertNoSensitiveData(revision);
    if (
      revision.tripId !== trip.id ||
      revision.baseVersion !== expectedVersion ||
      revision.nextVersion !== trip.version
    ) {
      throw new RangeError(
        "Trip revision versions must match the atomic trip update",
      );
    }

    return this.database.transaction(() => {
      const result = this.database
        .prepare(
          `
        UPDATE trips SET version = @version, payload = @payload, updated_at = @updatedAt, expires_at = @expiresAt
        WHERE id = @id AND version = @expectedVersion
      `,
        )
        .run({
          ...trip,
          expectedVersion,
          expiresAt,
          payload: JSON.stringify(trip),
        });
      if (result.changes !== 1) throw new VersionConflictError("Trip", trip.id);
      insertRevision(this.database, revision);
      return { trip, revision };
    })();
  }

  delete(id: string): boolean {
    return (
      this.database.prepare("DELETE FROM trips WHERE id = ?").run(id)
        .changes === 1
    );
  }
}

export class TripRevisionRepository {
  private readonly database: SqliteDatabase;

  constructor(database: SqliteDatabase) {
    this.database = database;
  }

  create(input: TripRevision): TripRevision {
    const revision = TripRevisionSchema.parse(input);
    assertNoSensitiveData(revision);
    insertRevision(this.database, revision);
    return revision;
  }

  listForTrip(tripId: string): TripRevision[] {
    const rows = this.database
      .prepare(
        "SELECT payload FROM trip_revisions WHERE trip_id = ? ORDER BY next_version ASC",
      )
      .all(tripId) as Array<{ payload: string }>;
    return rows.map(({ payload }) =>
      TripRevisionSchema.parse(JSON.parse(payload)),
    );
  }
}

export class ShareRecordRepository {
  private readonly database: SqliteDatabase;
  private readonly now: () => Date;

  constructor(database: SqliteDatabase, now = () => new Date()) {
    this.database = database;
    this.now = now;
  }

  create(input: ShareRecord): ShareRecord {
    const record = ShareRecordSchema.parse(input);
    assertNoSensitiveData(record);
    this.database
      .prepare(
        `
      INSERT INTO share_records
        (id, read_token_hash, delete_token_hash, payload, created_at, expires_at, deleted_at)
      VALUES (@id, @readTokenHash, @deleteTokenHash, @payload, @createdAt, @expiresAt, @deletedAt)
    `,
      )
      .run({
        ...record,
        deletedAt: record.deletedAt ?? null,
        payload: JSON.stringify(record),
      });
    return record;
  }

  getByReadTokenHash(hash: string): ShareRecord | null {
    const row = this.database
      .prepare(
        `
      SELECT payload, expires_at FROM share_records
      WHERE read_token_hash = ? AND deleted_at IS NULL
    `,
      )
      .get(hash) as { payload: string; expires_at: string } | undefined;
    if (!row || !isAvailable(row.expires_at, this.now())) return null;
    return ShareRecordSchema.parse(JSON.parse(row.payload));
  }

  deleteByDeleteTokenHash(
    hash: string,
    deletedAt = this.now().toISOString(),
  ): boolean {
    void deletedAt;
    return (
      this.database
        .prepare("DELETE FROM share_records WHERE delete_token_hash = ?")
        .run(hash).changes === 1
    );
  }
}
