import { applicationDatabase } from "../src/persistence/runtime.ts";
import {
  cleanupExpired,
  createEncryptedBackup,
  rotateBackups,
  restoreEncryptedBackup,
} from "../src/maintenance/service.ts";
const [command, target] = process.argv.slice(2);
const encryptionKey = () => {
  const secret = process.env.BACKUP_ENCRYPTION_KEY_BASE64;
  if (!secret) throw new Error("BACKUP_ENCRYPTION_KEY_BASE64 is required");
  return Buffer.from(secret, "base64");
};
if (command === "backup") {
  cleanupExpired(applicationDatabase());
  const directory = target ?? "./backups";
  const path = createEncryptedBackup(
    applicationDatabase(),
    directory,
    encryptionKey(),
  );
  rotateBackups(directory);
  console.log(path);
} else if (command === "restore-verify") {
  if (!target) throw new Error("Backup path is required");
  console.log(
    restoreEncryptedBackup(target, `${target}.verified.sqlite`, encryptionKey()),
  );
} else if (command === "cleanup")
  console.log(JSON.stringify(cleanupExpired(applicationDatabase())));
else throw new Error("Use backup, cleanup, or restore-verify");
