import type {
  EvaluationCase,
  EvaluationObservation,
} from "./contracts.ts";

/**
 * Recorded, deliberately small provider outcome used to test the evaluator.
 * It is not a claim that an external provider or the live Agent ran today.
 */
export async function executeFixedCase(
  evaluationCase: EvaluationCase,
): Promise<EvaluationObservation> {
  const blocked = evaluationCase.expected.mustBlock;
  const hardTheme = evaluationCase.themes.some((theme) =>
    ["老人", "闭馆", "来源故障"].includes(theme),
  );
  return {
    completed: !blocked,
    blocked,
    publicStatus: blocked ? "明确阻塞并保留可用部分" : "固定响应校验完成",
    codes: evaluationCase.expected.requiredCodes,
    lockedBookingChanged: false,
    unreachableSchedule: false,
    hardConstraintViolated: false,
    fabricatedEvidence: false,
    realtimeInventoryClaim: false,
    hiddenCriticalConflict: false,
    scores: {
      personalization: hardTheme ? 84 : 90,
      routeEfficiency: hardTheme ? 82 : 88,
      executableCompleteness: blocked ? 82 : 90,
      budgetQuality: 86,
      explanationAndEvidence: blocked ? 90 : 87,
    },
    usage: {
      inputTokens: 800,
      outputTokens: 1200,
      visitorCostCny: 0.08,
      productCostCny: 0.01,
    },
    durationMs: 1200,
  };
}
