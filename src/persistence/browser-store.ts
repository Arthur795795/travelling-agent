import {
  TripRevisionSchema,
  TripSchema,
  type Trip,
  type TripRevision,
} from "../domain/schema.ts";
import { assertNoSensitiveData } from "../security/redaction.ts";
import { BrowserSessionStore, type StorageLike } from "./browser-session.ts";
export type { StorageLike } from "./browser-session.ts";

interface Envelope<T> {
  storageVersion: 1;
  expiresAt: string;
  value: T;
}

const PREFIX = "travel-agent:";
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;

export class BrowserTripStore {
  private readonly storage: StorageLike;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(
    storage: StorageLike,
    now = () => new Date(),
    createId: () => string = () => crypto.randomUUID(),
  ) {
    this.storage = storage;
    this.now = now;
    this.createId = createId;
  }

  getOrCreateSession(): string {
    return new BrowserSessionStore(
      this.storage,
      this.now,
      this.createId,
    ).getOrCreate();
  }

  saveTrip(input: Trip): Trip {
    const trip = TripSchema.parse(input);
    assertNoSensitiveData(trip);
    this.writeEnvelope(`${PREFIX}trip:${trip.id}`, trip);
    return trip;
  }

  loadTrip(id: string): Trip | null {
    return this.readEnvelope(
      `${PREFIX}trip:${id}`,
      (value): value is Trip => TripSchema.safeParse(value).success,
    );
  }

  saveRevision(input: TripRevision): TripRevision {
    const revision = TripRevisionSchema.parse(input);
    assertNoSensitiveData(revision);
    this.writeEnvelope(
      `${PREFIX}revision:${revision.tripId}:${revision.id}`,
      revision,
    );
    return revision;
  }

  listRevisions(tripId: string): TripRevision[] {
    const result: TripRevision[] = [];
    const prefix = `${PREFIX}revision:${tripId}:`;
    const keys = Array.from({ length: this.storage.length }, (_, index) =>
      this.storage.key(index),
    );
    for (const key of keys) {
      if (!key?.startsWith(prefix)) continue;
      const revision = this.readEnvelope(
        key,
        (value): value is TripRevision =>
          TripRevisionSchema.safeParse(value).success,
      );
      if (revision) result.push(revision);
    }
    try {
      const envelope = JSON.parse(
        this.storage.getItem(`${PREFIX}trip:${tripId}`) ?? "{}",
      );
      if (this.loadTrip(tripId))
        for (const value of envelope.history ?? []) {
          const parsed = TripRevisionSchema.safeParse(value);
          if (parsed.success) result.push(parsed.data);
        }
    } catch {}
    return result.sort((a, b) => a.nextVersion - b.nextVersion);
  }

  commitEdit(
    input: Trip,
    revision: TripRevision,
    expectedVersion: number,
  ): Trip {
    const trip = TripSchema.parse(input);
    const current = this.loadTrip(trip.id);
    if (
      !current ||
      current.version !== expectedVersion ||
      trip.version !== expectedVersion + 1
    )
      throw new Error("VERSION_CONFLICT");
    TripRevisionSchema.parse(revision);
    if (
      revision.tripId !== trip.id ||
      revision.baseVersion !== expectedVersion ||
      revision.nextVersion !== trip.version
    )
      throw new Error("INVALID_REVISION");
    assertNoSensitiveData(trip);
    assertNoSensitiveData(revision);
    const history = [...this.listRevisions(trip.id), revision].slice(-20);
    this.storage.setItem(
      `${PREFIX}trip:${trip.id}`,
      JSON.stringify({
        storageVersion: 1,
        expiresAt: new Date(
          this.now().getTime() + THIRTY_DAYS_MS,
        ).toISOString(),
        value: trip,
        previous: current,
        history,
      }),
    );
    return trip;
  }

  undoLast(id: string): Trip {
    const current = this.loadTrip(id);
    const envelope = JSON.parse(
      this.storage.getItem(`${PREFIX}trip:${id}`) ?? "{}",
    );
    if (!current || !envelope.previous) throw new Error("NOTHING_TO_UNDO");
    const trip = TripSchema.parse({
      ...envelope.previous,
      version: current.version + 1,
      updatedAt: this.now().toISOString(),
    });
    assertNoSensitiveData(trip);
    const revision = {
      id: this.createId(),
      tripId: id,
      baseVersion: current.version,
      nextVersion: trip.version,
      summary: "撤销最近修改",
      createdAt: trip.updatedAt,
    };
    this.storage.setItem(
      `${PREFIX}trip:${id}`,
      JSON.stringify({
        storageVersion: 1,
        expiresAt: envelope.expiresAt,
        value: trip,
        history: [...(envelope.history ?? []), revision].slice(-20),
      }),
    );
    return trip;
  }

  listTrips(): Trip[] {
    const result: Trip[] = [];
    const keys = Array.from({ length: this.storage.length }, (_, index) =>
      this.storage.key(index),
    );
    for (const key of keys) {
      if (!key?.startsWith(`${PREFIX}trip:`)) continue;
      const trip = this.loadTrip(key.slice(`${PREFIX}trip:`.length));
      if (trip) result.push(trip);
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  clearTrip(id: string): void {
    this.storage.removeItem(`${PREFIX}trip:${id}`);
    const revisionPrefix = `${PREFIX}revision:${id}:`;
    const keys = Array.from({ length: this.storage.length }, (_, index) =>
      this.storage.key(index),
    );
    for (const key of keys)
      if (key?.startsWith(revisionPrefix)) this.storage.removeItem(key);
  }

  clearAll(): void {
    const keys = Array.from({ length: this.storage.length }, (_, index) =>
      this.storage.key(index),
    );
    for (const key of keys)
      if (key?.startsWith(PREFIX)) this.storage.removeItem(key);
  }

  private writeEnvelope<T>(key: string, value: T): void {
    const envelope: Envelope<T> = {
      storageVersion: 1,
      expiresAt: new Date(this.now().getTime() + THIRTY_DAYS_MS).toISOString(),
      value,
    };
    this.storage.setItem(key, JSON.stringify(envelope));
  }

  private readEnvelope<T>(
    key: string,
    validate: (value: unknown) => value is T,
  ): T | null {
    const raw = this.storage.getItem(key);
    if (!raw) return null;
    try {
      const envelope = JSON.parse(raw) as Partial<Envelope<unknown>>;
      if (
        envelope.storageVersion !== 1 ||
        typeof envelope.expiresAt !== "string" ||
        Date.parse(envelope.expiresAt) <= this.now().getTime() ||
        !validate(envelope.value)
      ) {
        this.storage.removeItem(key);
        return null;
      }
      return envelope.value as T;
    } catch {
      this.storage.removeItem(key);
      return null;
    }
  }
}
