import assert from "node:assert/strict";
import test from "node:test";
import {
  beijingDemo,
  copyDemo,
  DEMO_SCENARIOS,
  demoScenario,
} from "../../src/demo/beijing.ts";
import { validateTrip } from "../../src/validation/trip.ts";
test("four-day Beijing fixture is network-free, schema-valid and transparently fixed", () => {
  const trip = beijingDemo();
  assert.equal(trip.days.length, 4);
  assert.equal(trip.lifecycleStatus, "checked");
  assert.equal(trip.preset?.humanReviewed, false);
  assert.match(trip.preset!.notice, /非实时/);
  assert.deepEqual(validateTrip(trip), []);
  const copy = copyDemo("personal-copy");
  copy.days[0].notes.push("个人修改");
  assert.doesNotMatch(JSON.stringify(beijingDemo()), /个人修改/);
});
test("all three no-key scenarios preserve locks and pass hard validation", () => {
  const base = beijingDemo();
  assert.equal(DEMO_SCENARIOS.length, 3);
  for (const scenario of DEMO_SCENARIOS) {
    const trip = demoScenario(scenario.id);
    assert.deepEqual(trip.lockedBookings, base.lockedBookings);
    assert.equal(
      validateTrip(trip, base).some((i) => i.severity === "blocking"),
      false,
    );
  }
  assert.throws(() => demoScenario("free text"));
});
