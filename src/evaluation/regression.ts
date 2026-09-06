import { readFileSync } from "node:fs";
import { z } from "zod";

export const RegressionStateSchema = z.object({
  schemaVersion: z.literal(1),
  lastPassedModel: z.string().min(1),
  lastPassedAt: z.string().datetime(),
  observedModel: z.string().min(1),
  status: z.enum(["passed", "regression_required", "smoke_failed"]),
  smokeSampleCount: z.number().int().nonnegative(),
  criticalFailureCount: z.number().int().nonnegative(),
  fullRegressionSampleCount: z.number().int().nonnegative(),
});
export type RegressionState = z.infer<typeof RegressionStateSchema>;

export function observeModel(
  previous: RegressionState,
  observedModel: string,
): RegressionState {
  if (observedModel === previous.observedModel) return previous;
  return {
    ...previous,
    observedModel,
    status: "regression_required",
    smokeSampleCount: 0,
    criticalFailureCount: 0,
    fullRegressionSampleCount: 0,
  };
}

export function recordSmoke(
  state: RegressionState,
  result: { sampleCount: number; criticalFailureCount: number },
): RegressionState {
  if (result.sampleCount !== 5)
    throw new Error("MODEL_SMOKE_REQUIRES_FIVE_CASES");
  return {
    ...state,
    smokeSampleCount: result.sampleCount,
    criticalFailureCount: result.criticalFailureCount,
    status: result.criticalFailureCount ? "smoke_failed" : "regression_required",
  };
}

export function recordFullRegression(
  state: RegressionState,
  result: { sampleCount: number; gatePassed: boolean; completedAt: string },
): RegressionState {
  if (result.sampleCount !== 36 || !result.gatePassed)
    return { ...state, status: "regression_required", fullRegressionSampleCount: result.sampleCount };
  return {
    ...state,
    lastPassedModel: state.observedModel,
    lastPassedAt: result.completedAt,
    status: "passed",
    fullRegressionSampleCount: 36,
    criticalFailureCount: 0,
  };
}

export function regressionAllowsCustomGeneration(
  path = process.env.MODEL_REGRESSION_STATE_PATH,
): boolean {
  if (!path) return true;
  try {
    return RegressionStateSchema.parse(
      JSON.parse(readFileSync(path, "utf8")),
    ).status === "passed";
  } catch {
    return false;
  }
}
