import assert from "node:assert/strict";
import test from "node:test";
import {
  BrowserTripStore,
  type StorageLike,
} from "../../src/persistence/browser-store.ts";
import { SensitivePersistenceError } from "../../src/security/redaction.ts";
import { buildTripFixture } from "../fixtures/trip.ts";

class MemoryStorage implements StorageLike {
  data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

test("anonymous session and trips survive a store instance refresh", () => {
  const storage = new MemoryStorage();
  const now = () => new Date("2026-09-04T00:00:00Z");
  const first = new BrowserTripStore(storage, now, () => "anonymous-session-1");
  assert.equal(first.getOrCreateSession(), "anonymous-session-1");
  first.saveTrip(buildTripFixture());
  first.saveRevision({
    id: "revision-1",
    tripId: "trip-beijing-001",
    baseVersion: 1,
    nextVersion: 2,
    summary: "调整上午安排",
    createdAt: "2026-09-04T10:00:00+08:00",
  });

  const refreshed = new BrowserTripStore(
    storage,
    now,
    () => "should-not-be-created",
  );
  assert.equal(refreshed.getOrCreateSession(), "anonymous-session-1");
  assert.equal(
    refreshed.loadTrip("trip-beijing-001")?.brief.destination,
    "北京",
  );
  assert.deepEqual(
    refreshed.listTrips().map(({ id }) => id),
    ["trip-beijing-001"],
  );
  assert.deepEqual(
    refreshed.listRevisions("trip-beijing-001").map(({ summary }) => summary),
    ["调整上午安排"],
  );
});

test("expired, corrupt, and old-version data is removed without throwing", () => {
  const storage = new MemoryStorage();
  storage.setItem("travel-agent:trip:corrupt", "not json");
  storage.setItem(
    "travel-agent:trip:old",
    JSON.stringify({
      storageVersion: 0,
      expiresAt: "2099-01-01T00:00:00Z",
      value: {},
    }),
  );
  const store = new BrowserTripStore(
    storage,
    () => new Date("2027-11-01T00:00:00Z"),
  );
  assert.equal(store.loadTrip("corrupt"), null);
  assert.equal(store.loadTrip("old"), null);

  const active = new BrowserTripStore(
    storage,
    () => new Date("2026-09-04T00:00:00Z"),
  );
  active.saveTrip(buildTripFixture());
  const expired = new BrowserTripStore(
    storage,
    () => new Date("2026-10-05T00:00:01Z"),
  );
  assert.equal(expired.loadTrip("trip-beijing-001"), null);
});

test("clearAll removes only product data and persisted content contains no key", () => {
  const storage = new MemoryStorage();
  storage.setItem("another-product", "keep");
  const store = new BrowserTripStore(
    storage,
    () => new Date("2026-09-04T00:00:00Z"),
    () => "session",
  );
  store.getOrCreateSession();
  store.saveTrip(buildTripFixture());
  assert.equal(
    [...storage.data.values()].some((value) => value.includes("apiKey")),
    false,
  );
  store.clearAll();
  assert.deepEqual([...storage.data.entries()], [["another-product", "keep"]]);
});

test("a key accidentally copied into a trip is rejected before persistence", () => {
  const storage = new MemoryStorage();
  const store = new BrowserTripStore(storage);
  const trip = buildTripFixture({
    assumptions: ["sk-accidental-0123456789abcdef"],
  });
  assert.throws(() => store.saveTrip(trip), SensitivePersistenceError);
  assert.equal(storage.length, 0);
});

test("persistence rejects personal data and clearTrip removes its revision history", () => {
  const storage = new MemoryStorage();
  const store = new BrowserTripStore(storage);
  assert.throws(
    () =>
      store.saveTrip(
        buildTripFixture({ assumptions: ["联系人手机号 13800138000"] }),
      ),
    SensitivePersistenceError,
  );
  store.saveTrip(buildTripFixture());
  store.saveRevision({
    id: "revision-1",
    tripId: "trip-beijing-001",
    baseVersion: 1,
    nextVersion: 2,
    summary: "调整上午安排",
    createdAt: "2026-09-04T10:00:00+08:00",
  });
  store.clearTrip("trip-beijing-001");
  assert.equal(store.loadTrip("trip-beijing-001"), null);
  assert.deepEqual(store.listRevisions("trip-beijing-001"), []);
});

test("atomic local edits enforce versions and support one-step undo", () => {
  const storage = new MemoryStorage();
  const store = new BrowserTripStore(
    storage,
    () => new Date("2026-09-04T00:00:00Z"),
    () => "revision-id",
  );
  const trip = buildTripFixture();
  store.saveTrip(trip);
  const edited = {
    ...trip,
    version: 2,
    updatedAt: "2026-09-04T01:00:00Z",
    assumptions: [...trip.assumptions, "edit"],
  };
  const revision = {
    id: "revision-edit",
    tripId: trip.id,
    baseVersion: 1,
    nextVersion: 2,
    summary: "edit",
    createdAt: edited.updatedAt,
  };
  store.commitEdit(edited, revision, 1);
  assert.equal(store.loadTrip(trip.id)?.version, 2);
  assert.equal(store.listRevisions(trip.id).at(-1)?.summary, "edit");
  assert.throws(
    () =>
      store.commitEdit(
        { ...edited, version: 3 },
        { ...revision, nextVersion: 3 },
        1,
      ),
    /VERSION_CONFLICT/,
  );
  const undone = store.undoLast(trip.id);
  assert.equal(undone.version, 3);
  assert.deepEqual(undone.assumptions, trip.assumptions);
});
