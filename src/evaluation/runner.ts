import {
  EvaluationCaseSchema,
  EvaluationObservationSchema,
  SOFT_SCORE_WEIGHTS,
  type CriticalFailure,
  type EvaluationCase,
  type EvaluationObservation,
  type SoftScores,
} from "./contracts.ts";

export interface EvaluationRun {
  caseId: string;
  title: string;
  city: string;
  repeat: number;
  seed: string;
  responseVersion: string;
  passed: boolean;
  softScore: number;
  criticalFailures: CriticalFailure[];
  publicStatus: string;
  codes: string[];
  durationMs: number;
  usage: EvaluationObservation["usage"];
}

export interface EvaluationReport {
  schemaVersion: 1;
  mode: "fixture" | "live";
  generatedAt: string;
  model: string;
  responseVersion: string;
  caseCount: number;
  sampleCount: number;
  passedSamples: number;
  successRate: number;
  averageSoftScore: number;
  criticalFailureCount: number;
  gate: { passed: boolean; reasons: string[] };
  runs: EvaluationRun[];
}

const flagMap: Array<[
  keyof EvaluationObservation,
  CriticalFailure,
]> = [
  ["lockedBookingChanged", "locked_booking_changed"],
  ["unreachableSchedule", "unreachable_schedule"],
  ["hardConstraintViolated", "hard_constraint_violated"],
  ["fabricatedEvidence", "fabricated_evidence"],
  ["realtimeInventoryClaim", "realtime_inventory_claim"],
  ["hiddenCriticalConflict", "hidden_critical_conflict"],
];

export function criticalFailures(
  observation: EvaluationObservation,
): CriticalFailure[] {
  return flagMap
    .filter(([field]) => observation[field] === true)
    .map(([, failure]) => failure);
}

export function weightedSoftScore(scores: SoftScores): number {
  return Number(
    Object.entries(SOFT_SCORE_WEIGHTS)
      .reduce(
        (sum, [field, weight]) =>
          sum + scores[field as keyof SoftScores] * weight,
        0,
      )
      .toFixed(2),
  );
}

export async function runEvaluation(options: {
  cases: EvaluationCase[];
  repeats: number;
  model: string;
  responseVersion: string;
  seed: string;
  mode?: "fixture" | "live";
  now?: () => Date;
  execute: (
    evaluationCase: EvaluationCase,
    context: { repeat: number; seed: string; responseVersion: string },
  ) => Promise<EvaluationObservation>;
}): Promise<EvaluationReport> {
  if (!Number.isSafeInteger(options.repeats) || options.repeats < 1)
    throw new RangeError("repeats must be a positive integer");
  const cases = options.cases.map((item) => EvaluationCaseSchema.parse(item));
  const runs: EvaluationRun[] = [];
  for (const [caseIndex, evaluationCase] of cases.entries()) {
    for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
      const seed = `${options.seed}:${caseIndex + 1}:${repeat}`;
      const observation = EvaluationObservationSchema.parse(
        await options.execute(evaluationCase, {
          repeat,
          seed,
          responseVersion: options.responseVersion,
        }),
      );
      const failures = criticalFailures(observation);
      const requiredCodesPresent = evaluationCase.expected.requiredCodes.every(
        (code) => observation.codes.includes(code),
      );
      const expectedOutcome = evaluationCase.expected.mustBlock
        ? observation.blocked
        : observation.completed && !observation.blocked;
      runs.push({
        caseId: evaluationCase.id,
        title: evaluationCase.title,
        city: evaluationCase.city,
        repeat,
        seed,
        responseVersion: options.responseVersion,
        passed:
          failures.length === 0 && expectedOutcome && requiredCodesPresent,
        softScore: weightedSoftScore(observation.scores),
        criticalFailures: failures,
        publicStatus: observation.publicStatus,
        codes: observation.codes,
        durationMs: observation.durationMs,
        usage: observation.usage,
      });
    }
  }
  const passedSamples = runs.filter((run) => run.passed).length;
  const successRate = runs.length ? passedSamples / runs.length : 0;
  const averageSoftScore = runs.length
    ? Number(
        (
          runs.reduce((sum, run) => sum + run.softScore, 0) / runs.length
        ).toFixed(2),
      )
    : 0;
  const criticalFailureCount = runs.reduce(
    (sum, run) => sum + run.criticalFailures.length,
    0,
  );
  const reasons = [
    ...(criticalFailureCount ? ["critical_failures_present"] : []),
    ...(successRate < 0.9 ? ["success_rate_below_90_percent"] : []),
    ...(averageSoftScore < 80 ? ["soft_score_below_80"] : []),
  ];
  return {
    schemaVersion: 1,
    mode: options.mode ?? "fixture",
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    model: options.model,
    responseVersion: options.responseVersion,
    caseCount: cases.length,
    sampleCount: runs.length,
    passedSamples,
    successRate: Number(successRate.toFixed(4)),
    averageSoftScore,
    criticalFailureCount,
    gate: { passed: reasons.length === 0, reasons },
    runs,
  };
}
