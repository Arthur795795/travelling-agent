export interface ReleaseEvidence {
  commandsPassed: boolean;
  fixedEvaluation: {
    sampleCount: number;
    successRate: number;
    averageSoftScore: number;
    criticalFailureCount: number;
    passed: boolean;
  } | null;
  liveEvaluationPassed: boolean;
  performancePassed: boolean;
  securityPassed: boolean;
  userStudyPassed: boolean;
  repositoryScanPassed: boolean;
  fiveCityLabelsPresent: boolean;
  aiAndLimitsDisclosurePresent: boolean;
  deploymentEvidencePresent: boolean;
  complianceMaterialsPresent: boolean;
}

export function releaseDecision(evidence: ReleaseEvidence) {
  const reasons = [
    ...(!evidence.commandsPassed ? ["required_commands_failed"] : []),
    ...(!evidence.fixedEvaluation ? ["fixed_evaluation_missing"] : []),
    ...(evidence.fixedEvaluation &&
    (evidence.fixedEvaluation.sampleCount !== 36 ||
      evidence.fixedEvaluation.criticalFailureCount !== 0 ||
      evidence.fixedEvaluation.successRate < 0.9 ||
      evidence.fixedEvaluation.averageSoftScore < 80 ||
      !evidence.fixedEvaluation.passed)
      ? ["fixed_evaluation_below_gate"]
      : []),
    ...(!evidence.liveEvaluationPassed ? ["controlled_live_evaluation_missing_or_failed"] : []),
    ...(!evidence.performancePassed ? ["performance_evidence_missing_or_failed"] : []),
    ...(!evidence.securityPassed ? ["security_gate_failed"] : []),
    ...(!evidence.userStudyPassed ? ["real_user_study_missing_or_failed"] : []),
    ...(!evidence.repositoryScanPassed ? ["repository_scan_failed"] : []),
    ...(!evidence.fiveCityLabelsPresent ? ["five_city_labels_missing"] : []),
    ...(!evidence.aiAndLimitsDisclosurePresent ? ["ai_or_limit_disclosure_missing"] : []),
    ...(!evidence.deploymentEvidencePresent ? ["deployment_evidence_missing"] : []),
    ...(!evidence.complianceMaterialsPresent ? ["compliance_materials_missing"] : []),
  ];
  return { decision: reasons.length ? ("no-go" as const) : ("go" as const), reasons };
}

const keyPattern = /\b(?:sk|ds)-[A-Za-z0-9_-]{12,}\b/g;
const allowedFixture = /^(?:sk|ds)-(?:test|fixture|security-marker|rate|partial|timeout|cancel|sensitive|key|bad|network|audit|not|good|delayed|security|example|skeleton|accidental)[A-Za-z0-9_-]*$/;
const privatePattern = /(?:旅客姓名|联系人姓名|真实姓名|家庭住址|住宅地址)\s*[:：]\s*[^\s,，;；"'`\]\[(){}]{2,}/g;
const allowedPrivateFixture = new Set(["家庭住址：上海市长宁区某路一号"]);

export function scanPublicationText(text: string) {
  const credentialCandidates = [...text.matchAll(keyPattern)]
    .map((match) => match[0])
    .filter((value) => !allowedFixture.test(value));
  const privateCandidates = [...text.matchAll(privatePattern)]
    .map((match) => match[0])
    .filter((value) => !allowedPrivateFixture.has(value));
  return {
    passed: credentialCandidates.length === 0 && privateCandidates.length === 0,
    credentialCandidateCount: credentialCandidates.length,
    privateCandidateCount: privateCandidates.length,
  };
}
