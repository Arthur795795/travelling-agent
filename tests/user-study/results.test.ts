import assert from "node:assert/strict";
import test from "node:test";
import { summarizeUserStudy } from "../../src/user-study/results.ts";

const participant = (number: number, overrides = {}) => ({ participantId: `participant-${number}`, consented: true, completedWithoutGuidance: number !== 5, acceptablePlanMs: 6 * 60_000 + number, keyEditMs: 60_000 + number, tasks: { editDemo: true, planOwnTrip: true }, feedbackDeleted: false, ...overrides });

test("five anonymous participants produce the declared gate and deletion removes a result", () => {
  const passed = summarizeUserStudy(Array.from({ length: 5 }, (_, index) => participant(index + 1)));
  assert.equal(passed.gate.passed, true);
  assert.equal(passed.completedWithoutGuidance, 4);
  assert.ok((passed.acceptablePlanMedianMs ?? Infinity) <= 8 * 60_000);
  const incomplete = summarizeUserStudy(Array.from({ length: 5 }, (_, index) => participant(index + 1, index === 4 ? { feedbackDeleted: true } : {})));
  assert.equal(incomplete.status, "incomplete");
  assert.equal(incomplete.gate.passed, false);
});
