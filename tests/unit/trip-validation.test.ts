import assert from "node:assert/strict";
import test from "node:test";
import { executableTrip } from "../fixtures/executable-trip.ts";
import {
  validateTrip,
  validateTimeAndScope,
  validateConstraints,
  totalBudget,
} from "../../src/validation/trip.ts";

test("a fully evidenced three-day trip passes; unknown budget is never treated as zero", () => {
  const trip = executableTrip();
  assert.deepEqual(validateTrip(trip), []);
  assert.equal(totalBudget(trip).kind, "range");
  trip.budget.items[0].cost = {
    kind: "unknown",
    currency: "CNY",
    reason: "待确认",
  };
  trip.budget.withinLimit = true;
  assert.equal(totalBudget(trip).kind, "unknown");
  assert.ok(validateConstraints(trip).some((i) => i.code === "UNKNOWN_BUDGET"));
});
test("time validator detects overlap, missing routes, date boundaries and density", () => {
  const trip = executableTrip();
  const a = trip.days[0].activities[0];
  trip.days[0].activities.push({
    ...a,
    id: "second",
    place: { ...a.place, id: "second-place" },
    timeWindow: {
      ...a.timeWindow,
      start: "2026-10-01T10:00:00+08:00",
      end: "2026-10-01T12:00:00+08:00",
    },
  });
  const codes = validateTimeAndScope(trip).map((i) => i.code);
  assert.ok(codes.includes("TIME_OVERLAP"));
  assert.ok(codes.includes("MISSING_ROUTE"));
  a.timeWindow.end = "2026-10-02T01:00:00+08:00";
  assert.ok(
    validateTimeAndScope(trip).some((i) => i.code === "ACTIVITY_WINDOW"),
  );
});
test("route buffer is counted once and exact arrival boundary is accepted", () => {
  const trip = executableTrip();
  const day = trip.days[0];
  const a = day.activities[0];
  day.activities.push({
    ...a,
    id: "second",
    place: { ...a.place, id: "second-place" },
    timeWindow: {
      start: "2026-10-01T12:00:00+08:00",
      end: "2026-10-01T14:00:00+08:00",
      flexibilityMinutes: 0,
    },
  });
  day.legs.push({
    id: "leg",
    fromPlaceId: a.place.id,
    toPlaceId: "second-place",
    mode: "public_transit",
    departureWindow: {
      start: a.timeWindow.end,
      end: "2026-10-01T11:05:00+08:00",
      flexibilityMinutes: 0,
    },
    durationMinutes: { min: 40, max: 40 },
    bufferMinutes: 20,
    cost: { kind: "unknown", currency: "CNY", reason: "待确认" },
    locked: false,
    evidenceIds: [],
  });
  assert.deepEqual(validateTimeAndScope(trip), []);
  day.legs[0].bufferMinutes = 21;
  assert.ok(validateTimeAndScope(trip).some((i) => i.code === "UNREACHABLE"));
});
test("locks, opening windows, missing evidence and forbidden inventory promises block execution", () => {
  const base = executableTrip();
  base.brief.bookedItems = [
    {
      id: "flight",
      type: "flight",
      title: "航班",
      start: "2026-10-01T12:00:00+08:00",
      locked: true,
      source: "user",
    },
  ];
  base.lockedBookings = base.brief.bookedItems;
  const trip = structuredClone(base);
  trip.lockedBookings = [];
  trip.days[0].activities[0].rationale = "实时库存已确认";
  trip.claims = [];
  const codes = validateTrip(trip, base).map((i) => i.code);
  for (const code of [
    "LOCK_CHANGED",
    "LOCK_UNREACHABLE",
    "INVENTORY_PROMISE",
    "MISSING_CRITICAL_EVIDENCE",
  ])
    assert.ok(codes.includes(code), code);
  const safe = executableTrip();
  safe.assumptions = ["请到平台确认余票与库存"];
  assert.deepEqual(validateTrip(safe), []);
  safe.days[0].activities[0].availabilityWindows![0].start =
    "2026-10-01T10:00:00+08:00";
  assert.ok(
    validateTrip(safe).some((i) => i.code === "OUTSIDE_OPENING_WINDOW"),
  );
});

test("locked journeys occupy their full interval and unknown activity costs cannot hide behind a known total", () => {
  const trip = executableTrip();
  trip.lockedBookings = [
    {
      id: "train",
      type: "train",
      title: "跨日车次",
      start: "2026-09-30T23:00:00+08:00",
      end: "2026-10-01T10:00:00+08:00",
      locked: true,
      source: "user",
    },
  ];
  assert.ok(validateTrip(trip).some((i) => i.code === "LOCK_OVERLAP"));
  trip.lockedBookings = [];
  trip.days[0].activities[0].cost = {
    kind: "unknown",
    currency: "CNY",
    reason: "待核验",
  };
  assert.ok(validateTrip(trip).some((i) => i.code === "UNKNOWN_ENTITY_COST"));
});

test("a fallback between scheduled activities does not bypass travel validation", () => {
  const trip = executableTrip();
  const first = trip.days[0].activities[0];
  trip.days[0].activities.push({
    ...first,
    id: "fallback",
    importance: "fallback",
    timeWindow: {
      ...first.timeWindow,
      start: "2026-10-01T11:00:00+08:00",
      end: "2026-10-01T13:00:00+08:00",
    },
  });
  trip.days[0].activities.push({
    ...first,
    id: "later",
    place: { ...first.place, id: "later-place" },
    timeWindow: {
      ...first.timeWindow,
      start: "2026-10-01T14:00:00+08:00",
      end: "2026-10-01T16:00:00+08:00",
    },
  });
  assert.ok(
    validateTrip(trip).some(
      (i) => i.code === "MISSING_ROUTE" && i.entityIds.includes("later"),
    ),
  );
});
