import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/persistence/database.ts";
import {
  cleanupExpired,
  createEncryptedBackup,
  restoreEncryptedBackup,
  rotateBackups,
} from "../../src/maintenance/service.ts";
test("cleanup, encrypted backup, seven-day rotation and non-destructive restore work", (t) => {
  const root = mkdtempSync(join(tmpdir(), "travel-maintenance-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(join(root, "main.sqlite"));
  t.after(() => db.close());
  const now = new Date("2026-09-05T00:00:00Z");
  db.prepare("INSERT INTO planning_jobs VALUES (?,?,?,?,?,?,?)").run(
    "expired",
    1,
    "queued",
    JSON.stringify({}),
    "2026-09-03T00:00:00Z",
    "2026-09-03T00:00:00Z",
    "2026-09-04T00:00:00Z",
  );
  db.prepare("INSERT INTO runtime_metrics VALUES (?,?,?)").run(
    "old",
    "{}",
    "2026-08-01T00:00:00Z",
  );
  // Ticket 041: closed rate-limit windows and previous days' salts expire too.
  db.prepare("INSERT INTO rate_limit_counters VALUES (?,?,?,?,?)").run(
    "planning_job",
    "hash",
    "2026-09-03T00:00:00Z",
    3,
    "2026-09-03T01:00:00Z",
  );
  db.prepare("INSERT INTO rate_limit_salts VALUES (?,?)").run(
    "2026-09-03",
    "stale",
  );
  assert.deepEqual(cleanupExpired(db, now), {
    jobs: 1,
    shares: 0,
    metrics: 1,
    rateLimits: 2,
    feedback: 0,
  });
  const key = Buffer.alloc(32, 7);
  assert.throws(
    () => createEncryptedBackup(db, join(root, "failed"), Buffer.alloc(8), now),
    /BACKUP_FAILED/,
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT status,summary FROM maintenance_runs WHERE kind = 'backup' ORDER BY created_at DESC LIMIT 1",
      )
      .get(),
    { status: "failed", summary: "BACKUP_FAILED" },
  );
  const backup = createEncryptedBackup(db, join(root, "backups"), key, now);
  const bytes = readFileSync(backup);
  assert.equal(bytes.subarray(0, 16).includes(Buffer.from("SQLite")), false);
  assert.doesNotMatch(bytes.toString(), /sk-secret/);
  const restored = restoreEncryptedBackup(
    backup,
    join(root, "verify", "restored.sqlite"),
    key,
  );
  const copy = openDatabase(restored);
  assert.equal(copy.pragma("integrity_check", { simple: true }), "ok");
  copy.close();
  assert.throws(
    () => restoreEncryptedBackup(backup, restored, key),
    /RESTORE_TARGET_EXISTS/,
  );
  assert.throws(
    () =>
      restoreEncryptedBackup(
        backup,
        join(root, "bad.sqlite"),
        Buffer.alloc(32, 8),
      ),
    /BACKUP_DECRYPT_FAILED/,
  );
  const old = join(root, "backups", "travel-old.sqlite.aes");
  writeFileSync(old, "old");
  const oldDate = new Date(now.getTime() - 8 * 86400000);
  utimesSync(old, oldDate, oldDate);
  assert.deepEqual(rotateBackups(join(root, "backups"), now), [old]);
  assert.equal(readFileSync(backup).length > 0, true);
});
