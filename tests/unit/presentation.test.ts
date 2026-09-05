import assert from "node:assert/strict";
import test from "node:test";
import {
  projectTrip,
  safeLink,
  statusLabels,
} from "../../src/trips/presentation.ts";
import { modelInfo } from "../../src/config/model-info.ts";
import { executableTrip } from "../fixtures/executable-trip.ts";
test("public projection hides budgets, bookings and private notes by default", () => {
  const trip = executableTrip();
  trip.days[0].notes = ["私人备注"];
  trip.brief.hardConstraints = ["隐私约束"];
  const clean = projectTrip(trip);
  assert.equal(clean.budget.items.length, 0);
  assert.equal(clean.budget.total.kind, "unknown");
  assert.deepEqual(clean.lockedBookings, []);
  assert.deepEqual(clean.days[0].notes, []);
  assert.doesNotMatch(JSON.stringify(clean), /私人备注|隐私约束|60/);
  assert.equal(
    projectTrip(trip, { budget: true, privateNotes: true }).budget.items.length,
    trip.budget.items.length,
  );
});
test("lifecycle labels differ, unsafe URLs fail closed, and registration is never guessed", () => {
  assert.notEqual(statusLabels.checked, statusLabels.executable);
  assert.equal(safeLink("javascript:alert(1)"), undefined);
  assert.equal(
    modelInfo({ MODEL_REGISTRATION_ID: "unverified" }).registration,
    "待核实",
  );
  assert.equal(
    modelInfo({
      MODEL_REGISTRATION_VERIFIED: "true",
      MODEL_REGISTRATION_ID: "verified-id",
    }).registration,
    "verified-id",
  );
});
