import { openDatabase, type SqliteDatabase } from "./database.ts";
const globals = globalThis as typeof globalThis & {
  travelDatabase?: SqliteDatabase;
};
export function applicationDatabase() {
  return (globals.travelDatabase ??= openDatabase(
    process.env.SQLITE_PATH ?? "./data/travel-agent.sqlite",
  ));
}
