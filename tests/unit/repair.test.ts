import assert from "node:assert/strict";
import test from "node:test";
import { repairTrip } from "../../src/agent/repair.ts";
import { executableTrip } from "../fixtures/executable-trip.ts";
test("repairs once, revalidates and leaves unaffected dates unchanged", async () => {
  const trip = executableTrip();
  trip.days[0].activities[0].timeWindow.start = "2026-10-01T07:00:00+08:00";
  const result = await repairTrip(trip, async (candidate) => {
    candidate = structuredClone(candidate);
    candidate.days[0].activities[0].timeWindow.start =
      "2026-10-01T09:00:00+08:00";
    return candidate;
  });
  assert.equal(result.rounds, 1);
  assert.equal(result.trip.lifecycleStatus, "executable");
  assert.deepEqual(result.trip.days[1], trip.days[1]);
});
test("unchanged and unauthorized responses stop after two rounds with blocked choices", async () => {
  for (const unauthorized of [false, true]) {
    const trip = executableTrip();
    trip.days[0].activities[0].timeWindow.start = "2026-10-01T07:00:00+08:00";
    let calls = 0;
    const result = await repairTrip(trip, async (candidate) => {
      calls++;
      candidate = structuredClone(candidate);
      if (unauthorized) {
        candidate.brief.hardConstraints = [];
        candidate.days[1].title = "改动";
      }
      return candidate;
    });
    assert.equal(calls, 2);
    assert.equal(result.trip.lifecycleStatus, "blocked");
    assert.equal(result.choices.length, 2);
    assert.deepEqual(result.trip.brief, trip.brief);
    assert.deepEqual(result.trip.days[1], trip.days[1]);
  }
});

test("repair cannot hide unknown prices by removing budget items", async () => {
  const trip = executableTrip();
  trip.budget.items[0].cost = {
    kind: "unknown",
    currency: "CNY",
    reason: "待核验",
  };
  const result = await repairTrip(trip, async (candidate) => {
    const changed = structuredClone(candidate);
    changed.budget.items.shift();
    return changed;
  });
  assert.equal(result.rounds, 2);
  assert.equal(result.trip.lifecycleStatus, "blocked");
  assert.deepEqual(result.trip.budget.items, trip.budget.items);
  assert.ok(result.issues.some((i) => i.code === "REPAIR_UNAUTHORIZED"));
});
