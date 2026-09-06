import assert from "node:assert/strict";
import test from "node:test";
import { releaseDecision, scanPublicationText, type ReleaseEvidence } from "../../src/operations/release-gate.ts";

const passing: ReleaseEvidence = {
  commandsPassed: true,
  fixedEvaluation: { sampleCount: 36, successRate: 0.92, averageSoftScore: 82, criticalFailureCount: 0, passed: true },
  liveEvaluationPassed: true,
  performancePassed: true,
  securityPassed: true,
  userStudyPassed: true,
  repositoryScanPassed: true,
  fiveCityLabelsPresent: true,
  aiAndLimitsDisclosurePresent: true,
  deploymentEvidencePresent: true,
  complianceMaterialsPresent: true,
};

test("release gate cannot be softened by a high score or missing external evidence", () => {
  assert.deepEqual(releaseDecision(passing), { decision: "go", reasons: [] });
  const critical = releaseDecision({ ...passing, fixedEvaluation: { ...passing.fixedEvaluation!, averageSoftScore: 100, criticalFailureCount: 1 } });
  assert.equal(critical.decision, "no-go");
  assert.ok(critical.reasons.includes("fixed_evaluation_below_gate"));
  const missing = releaseDecision({ ...passing, liveEvaluationPassed: false, userStudyPassed: false, complianceMaterialsPresent: false });
  assert.equal(missing.decision, "no-go");
  assert.ok(missing.reasons.includes("real_user_study_missing_or_failed"));
});

test("publication scan ignores named synthetic fixtures but catches credential-shaped values", () => {
  assert.equal(scanPublicationText("sk-test-0123456789abcdef").passed, true);
  assert.equal(scanPublicationText(["sk", "livevalue-0123456789abcdef"].join("-")).passed, false);
  assert.equal(scanPublicationText(["真实姓名", "张三"].join("：")).passed, false);
});
