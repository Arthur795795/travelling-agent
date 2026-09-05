import assert from "node:assert/strict";
import test from "node:test";
import { commitChange, previewChange } from "../../src/trips/changes.ts";
import { executableTrip } from "../fixtures/executable-trip.ts";
test("minor notes and in-flex activity time edits create a version without changing unrelated ids", () => {
  const base = executableTrip();
  const first = commitChange(
    base,
    { type: "note", date: base.days[0].date, text: "早点休息" },
    false,
    () => new Date("2026-09-05T01:00:00Z"),
  );
  assert.equal(first.trip.version, 2);
  assert.equal(first.revision.baseVersion, 1);
  assert.equal(first.trip.days[0].notes[0], "早点休息");
  assert.equal(first.trip.days[1].id, base.days[1].id);
  const activity = base.days[0].activities[0];
  activity.timeWindow.flexibilityMinutes = 15;
  const result = previewChange(base, {
    type: "activity",
    id: activity.id,
    timeWindow: {
      start: "2026-10-01T09:10:00+08:00",
      end: "2026-10-01T11:10:00+08:00",
      flexibilityMinutes: 15,
    },
  });
  assert.equal(result.major, false);
});
test("cross-day, budget, status and locked edits require preview or explicit unlock", () => {
  const base = executableTrip();
  const activity = base.days[0].activities[0];
  activity.locked = true;
  const locked = previewChange(base, {
    type: "move",
    id: activity.id,
    date: base.days[1].date,
    timeWindow: {
      start: "2026-10-02T14:00:00+08:00",
      end: "2026-10-02T16:00:00+08:00",
      flexibilityMinutes: 15,
    },
  });
  assert.equal(locked.major, true);
  assert.deepEqual(locked.lockConflicts, [activity.id]);
  assert.throws(
    () => commitChange(base, locked.change, true),
    /UNLOCK_REQUIRED/,
  );
  assert.equal(
    previewChange(executableTrip(), {
      type: "budget",
      limit: {
        kind: "exact",
        currency: "CNY",
        amount: 100,
        confidence: "high",
      },
    }).major,
    true,
  );
  assert.throws(
    () =>
      commitChange(executableTrip(), {
        type: "replan",
        date: "2026-10-01",
        instruction: "少走路",
      }),
    /CONFIRMATION_REQUIRED/,
  );
});
