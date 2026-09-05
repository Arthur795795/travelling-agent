import { createHash, randomBytes, randomUUID } from "node:crypto";
import { TripSchema, type Trip } from "../domain/schema.ts";
import { ShareRecordRepository } from "../persistence/repositories.ts";
import {
  DisclosureSchema,
  projectTrip,
  type Disclosure,
} from "../trips/presentation.ts";
export const tokenHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export class SharingService {
  private readonly repository: ShareRecordRepository;
  private readonly now: () => Date;
  constructor(repository: ShareRecordRepository, now = () => new Date()) {
    this.repository = repository;
    this.now = now;
  }
  create(input: Trip, raw: Partial<Disclosure> = {}) {
    const fields = DisclosureSchema.parse(raw);
    const trip = projectTrip(TripSchema.parse(input), fields);
    const readToken = randomBytes(32).toString("hex"),
      deleteToken = randomBytes(32).toString("hex");
    const record = this.repository.create({
      schemaVersion: 1,
      id: randomUUID(),
      trip,
      readTokenHash: tokenHash(readToken),
      deleteTokenHash: tokenHash(deleteToken),
      visibleFields: [
        "timeline",
        "evidence",
        ...Object.entries(fields)
          .filter(([, enabled]) => enabled)
          .map(([key]) => key),
      ],
      createdAt: this.now().toISOString(),
      expiresAt: new Date(this.now().getTime() + 30 * 86400000).toISOString(),
    });
    return {
      readToken,
      deleteToken,
      expiresAt: record.expiresAt,
      trip,
      fields,
    };
  }
  read(token: string) {
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const record = this.repository.getByReadTokenHash(tokenHash(token));
    return record
      ? {
          trip: record.trip,
          expiresAt: record.expiresAt,
          fields: {
            budget: record.visibleFields.includes("budget"),
            privateNotes: record.visibleFields.includes("privateNotes"),
          },
        }
      : null;
  }
  delete(token: string) {
    return (
      /^[a-f0-9]{64}$/.test(token) &&
      this.repository.deleteByDeleteTokenHash(tokenHash(token))
    );
  }
}
