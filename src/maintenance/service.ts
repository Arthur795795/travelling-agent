import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { openDatabase, type SqliteDatabase } from "../persistence/database.ts";
import { cleanupFeedback } from "../analytics/feedback.ts";
import { redactText } from "../security/redaction.ts";
import { cleanupRateLimits } from "../security/rate-limit.ts";

const MAGIC = Buffer.from("TRIPBAK1");
const DAY = 86_400_000;
export interface MaintenanceResult {
  jobs: number;
  shares: number;
  metrics: number;
  rateLimits: number;
  feedback: number;
}
function record(
  db: SqliteDatabase,
  kind: string,
  status: "completed" | "failed",
  summary: string,
  now: Date,
) {
  db.prepare(
    "INSERT INTO maintenance_runs (id,kind,status,summary,created_at) VALUES (?,?,?,?,?)",
  ).run(
    randomUUID(),
    kind,
    status,
    redactText(summary).slice(0, 500),
    now.toISOString(),
  );
}
export function cleanupExpired(
  db: SqliteDatabase,
  now = new Date(),
): MaintenanceResult {
  return db.transaction(() => {
    const rateLimits = cleanupRateLimits(db, now);
    const result = {
      jobs: db
        .prepare("DELETE FROM planning_jobs WHERE expires_at <= ?")
        .run(now.toISOString()).changes,
      shares: db
        .prepare(
          "DELETE FROM share_records WHERE expires_at <= ? OR deleted_at IS NOT NULL",
        )
        .run(now.toISOString()).changes,
      metrics: db
        .prepare("DELETE FROM runtime_metrics WHERE created_at <= ?")
        .run(new Date(now.getTime() - 30 * DAY).toISOString()).changes,
      rateLimits: rateLimits.counters + rateLimits.salts,
      feedback: cleanupFeedback(db, now),
    };
    record(db, "cleanup", "completed", JSON.stringify(result), now);
    return result;
  })();
}
function key(value: Buffer) {
  if (value.length !== 32) throw new Error("BACKUP_KEY_INVALID");
  return value;
}
export function createEncryptedBackup(
  db: SqliteDatabase,
  directory: string,
  encryptionKey: Buffer,
  now = new Date(),
): string {
  const targetDirectory = resolve(directory);
  mkdirSync(targetDirectory, { recursive: true });
  const destination = join(
      targetDirectory,
      `travel-${now.toISOString().replace(/[:.]/g, "-")}.sqlite.aes`,
    ),
    temporary = `${destination}.tmp`;
  try {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", key(encryptionKey), iv);
    const encrypted = Buffer.concat([
      cipher.update(db.serialize()),
      cipher.final(),
    ]);
    writeFileSync(
      temporary,
      Buffer.concat([MAGIC, iv, cipher.getAuthTag(), encrypted]),
      { mode: 0o600, flag: "wx" },
    );
    renameSync(temporary, destination);
    record(db, "backup", "completed", basename(destination), now);
    return destination;
  } catch {
    try {
      unlinkSync(temporary);
    } catch {}
    try {
      record(
        db,
        "backup",
        "failed",
        "BACKUP_FAILED",
        now,
      );
    } catch {}
    throw new Error("BACKUP_FAILED");
  }
}
export function rotateBackups(
  directory: string,
  now = new Date(),
  retainDays = 7,
): string[] {
  const root = resolve(directory);
  mkdirSync(root, { recursive: true });
  const removed: string[] = [];
  for (const name of readdirSync(root)) {
    if (!/^travel-.*\.sqlite\.aes$/.test(name)) continue;
    const path = join(root, name);
    if (statSync(path).mtimeMs <= now.getTime() - retainDays * DAY) {
      unlinkSync(path);
      removed.push(path);
    }
  }
  return removed;
}
export function restoreEncryptedBackup(
  source: string,
  destination: string,
  encryptionKey: Buffer,
): string {
  const input = readFileSync(resolve(source));
  if (!input.subarray(0, MAGIC.length).equals(MAGIC))
    throw new Error("BACKUP_INVALID");
  const target = resolve(destination);
  mkdirSync(dirname(target), { recursive: true });
  try {
    statSync(target);
    throw new Error("RESTORE_TARGET_EXISTS");
  } catch (error) {
    if (error instanceof Error && error.message === "RESTORE_TARGET_EXISTS")
      throw error;
  }
  const iv = input.subarray(8, 20),
    tag = input.subarray(20, 36),
    encrypted = input.subarray(36);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(encryptionKey), iv);
    decipher.setAuthTag(tag);
    writeFileSync(
      target,
      Buffer.concat([decipher.update(encrypted), decipher.final()]),
      { mode: 0o600, flag: "wx" },
    );
    const probe = openDatabase(target);
    const integrity = probe.pragma("integrity_check", { simple: true });
    probe.close();
    if (integrity !== "ok") throw new Error("BACKUP_INTEGRITY_FAILED");
    return target;
  } catch {
    try {
      unlinkSync(target);
    } catch {}
    throw new Error("BACKUP_DECRYPT_FAILED");
  }
}
