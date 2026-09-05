import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseTrip,
  serializeTrip,
  TripBriefSchema,
  TripSchema,
  UnsupportedTripSchemaVersionError,
} from "../../src/domain/schema.ts";
import { buildTripFixture } from "../fixtures/trip.ts";

describe("domain schemas", () => {
  it("round-trips a valid trip", () => {
    const trip = buildTripFixture();
    assert.deepEqual(parseTrip(JSON.parse(serializeTrip(trip))), trip);
  });

  it("uses a version-aware parser and rejects unknown document versions clearly", () => {
    assert.throws(
      () => parseTrip({ ...buildTripFixture(), schemaVersion: 99 }),
      (error: unknown) =>
        error instanceof UnsupportedTripSchemaVersionError &&
        error.schemaVersion === 99,
    );
  });

  it("rejects an invalid money range with a useful path", () => {
    const trip = buildTripFixture();
    trip.budget.total = {
      kind: "range",
      currency: "CNY",
      min: 100,
      max: 50,
      confidence: "medium",
    };
    const result = TripSchema.safeParse(trip);
    assert.equal(result.success, false);
    if (!result.success) {
      assert.deepEqual(result.error.issues[0]?.path.slice(-1), ["max"]);
    }
  });

  it("keeps unknown costs distinct from zero", () => {
    const trip = buildTripFixture();
    trip.budget.total = {
      kind: "unknown",
      currency: "CNY",
      reason: "酒店尚未选择",
    };
    const parsed = parseTrip(trip);
    assert.equal(parsed.budget.total.kind, "unknown");
  });

  it("rejects trips with an end date before the start date", () => {
    const brief = buildTripFixture().brief;
    const result = TripBriefSchema.safeParse({
      ...brief,
      endDate: "2026-09-30",
    });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.deepEqual(result.error.issues[0]?.path, ["endDate"]);
    }
  });

  it("rejects calendar dates that only match the date shape", () => {
    const brief = buildTripFixture().brief;
    const result = TripBriefSchema.safeParse({
      ...brief,
      startDate: "2026-02-30",
    });
    assert.equal(result.success, false);
    if (!result.success)
      assert.deepEqual(result.error.issues[0]?.path, ["startDate"]);
  });

  it("rejects parties larger than six", () => {
    const brief = buildTripFixture().brief;
    const result = TripBriefSchema.safeParse({
      ...brief,
      party: {
        adults: 4,
        seniors: 2,
        childrenAgeBands: ["7-12"],
        mobilityNotes: [],
      },
    });
    assert.equal(result.success, false);
  });

  it("accepts cross-midnight transport windows and locked user bookings", () => {
    const trip = buildTripFixture();
    trip.brief.bookedItems = [
      {
        id: "booked-train",
        type: "train",
        title: "G1",
        start: "2026-10-01T23:30:00+08:00",
        end: "2026-10-02T01:00:00+08:00",
        locked: true,
        source: "user",
      },
    ];
    trip.lockedBookings = trip.brief.bookedItems;
    trip.days[0].legs.push({
      id: "leg-night",
      fromPlaceId: "place-a",
      toPlaceId: "place-b",
      mode: "train",
      departureWindow: {
        start: "2026-10-01T23:30:00+08:00",
        end: "2026-10-02T01:00:00+08:00",
        flexibilityMinutes: 0,
      },
      durationMinutes: { min: 80, max: 90 },
      bufferMinutes: 30,
      cost: { kind: "unknown", currency: "CNY", reason: "尚未查询" },
      locked: true,
      evidenceIds: ["evidence-1"],
    });
    const parsed = parseTrip(trip);
    assert.equal(parsed.lockedBookings[0].locked, true);
    assert.deepEqual(parsed.days[0].legs[0].evidenceIds, ["evidence-1"]);
  });

  it("rejects malformed timestamps and unknown enum values with paths", () => {
    const trip = buildTripFixture() as unknown as Record<string, unknown>;
    const malformed = structuredClone(trip) as ReturnType<
      typeof buildTripFixture
    >;
    malformed.days[0].activities[0].timeWindow.start = "tomorrow morning";
    const timeResult = TripSchema.safeParse(malformed);
    assert.equal(timeResult.success, false);
    if (!timeResult.success)
      assert.deepEqual(timeResult.error.issues[0].path.slice(-2), [
        "timeWindow",
        "start",
      ]);

    const enumResult = TripSchema.safeParse({
      ...trip,
      lifecycleStatus: "published",
    });
    assert.equal(enumResult.success, false);
    if (!enumResult.success)
      assert.deepEqual(enumResult.error.issues[0].path, ["lifecycleStatus"]);
  });
});
