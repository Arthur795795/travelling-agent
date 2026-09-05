import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type SqliteDatabase = Database.Database;

const migrations = [
  `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS planning_jobs (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      status TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trips (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trip_revisions (
      id TEXT PRIMARY KEY,
      trip_id TEXT NOT NULL,
      base_version INTEGER NOT NULL,
      next_version INTEGER NOT NULL,
      summary TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS trip_revisions_trip_id ON trip_revisions(trip_id, next_version);
    CREATE TABLE IF NOT EXISTS share_records (
      id TEXT PRIMARY KEY,
      read_token_hash TEXT NOT NULL UNIQUE,
      delete_token_hash TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      deleted_at TEXT
    );
  `,
  `
    CREATE TABLE planning_execution (
      job_id TEXT PRIMARY KEY REFERENCES planning_jobs(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      state TEXT NOT NULL
    );
    CREATE TABLE planning_events (
      job_id TEXT NOT NULL REFERENCES planning_jobs(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (job_id,sequence)
    );
  `,
  `
    CREATE TABLE runtime_metrics (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE maintenance_runs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `,
];

export function migrateDatabase(database: SqliteDatabase): void {
  database.pragma("foreign_keys = ON");
  database.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const applied = database
    .prepare("SELECT version FROM schema_migrations")
    .all() as Array<{ version: number }>;
  const appliedVersions = new Set(applied.map(({ version }) => version));

  migrations.forEach((sql, index) => {
    const version = index + 1;
    if (appliedVersions.has(version)) return;
    database.transaction(() => {
      database.exec(sql);
      database
        .prepare(
          "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
        )
        .run(version, new Date().toISOString());
    })();
  });
}

export function openDatabase(
  filename = process.env.SQLITE_PATH ?? ":memory:",
): SqliteDatabase {
  if (filename !== ":memory:")
    mkdirSync(dirname(resolve(filename)), { recursive: true });
  const database = new Database(filename);
  migrateDatabase(database);
  return database;
}
