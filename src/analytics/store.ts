import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../persistence/database.ts";
import { assertNoSensitiveData } from "../security/redaction.ts";
import {
  AnalyticsEventSchema,
  AnalyticsRecordSchema,
  type AnalyticsEvent,
  type AnalyticsRecord,
} from "./events.ts";

/**
 * Appends one whitelisted event to `runtime_metrics`, which the maintenance
 * job already clears after 30 days. Nothing else about the request is stored:
 * no identity, no session, no IP, no trip or chat text.
 */
export function recordAnalyticsEvent(
  db: SqliteDatabase,
  input: AnalyticsEvent,
  at: Date = new Date(),
): AnalyticsRecord {
  const event = AnalyticsEventSchema.parse(input);
  assertNoSensitiveData(event);
  const record = AnalyticsRecordSchema.parse({ ...event, at: at.toISOString() });
  db.prepare(
    "INSERT INTO runtime_metrics (id,payload,created_at) VALUES (?,?,?)",
  ).run(randomUUID(), JSON.stringify(record), record.at);
  return record;
}

/** The public event output: parsed back through the same whitelist. */
export function listAnalyticsEvents(
  db: SqliteDatabase,
  limit = 500,
): AnalyticsRecord[] {
  const rows = db
    .prepare(
      "SELECT payload FROM runtime_metrics ORDER BY created_at ASC, id ASC LIMIT ?",
    )
    .all(Math.max(1, Math.min(limit, 5000))) as Array<{ payload: string }>;
  const records: AnalyticsRecord[] = [];
  for (const { payload } of rows) {
    const parsed = AnalyticsRecordSchema.safeParse(
      JSON.parse(payload) as unknown,
    );
    if (parsed.success) records.push(parsed.data);
  }
  return records;
}
