import type { SqliteDatabase } from "../persistence/database.ts";

export function liveness() {
  return { status: "alive" as const };
}

export function readiness(database: SqliteDatabase) {
  try {
    database.prepare("SELECT 1 AS ok").get();
    database.prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").get();
    return { ready: true as const, status: "ready" as const };
  } catch {
    return { ready: false as const, status: "not_ready" as const, code: "DATABASE_UNAVAILABLE" as const };
  }
}
