import { openDatabase } from "../persistence/database.ts";
import { ExecutionStore } from "../jobs/execution-store.ts";
import { PlanningExecutor } from "../jobs/executor.ts";
import { createPipeline } from "../agent/pipeline.ts";
import { TransientSecret } from "../security/secrets.ts";
import type { EvaluationCase, EvaluationObservation } from "./contracts.ts";

/**
 * Runs the real seven-stage Agent with explicitly supplied internal evaluation
 * credentials. Callers own case/cost bounds and persist only this projection.
 */
export async function executeLiveAgentCase(
  evaluationCase: EvaluationCase,
  credentials: { deepSeekKey: string; amapKey: string },
): Promise<EvaluationObservation & { sourceUrls: string[]; steps: number }> {
  const started = performance.now();
  const db = openDatabase();
  try {
    const store = new ExecutionStore(db);
    const executor = new PlanningExecutor(store, createPipeline());
    const { job } = store.create(evaluationCase.brief);
    // AmapClient reads only the server environment. The caller-provided value
    // is never copied to state, logs, URLs in reports or the return value.
    const previousAmap = process.env.AMAP_WEB_SERVICE_KEY;
    process.env.AMAP_WEB_SERVICE_KEY = credentials.amapKey;
    try {
      await executor.run(job.id, new TransientSecret(credentials.deepSeekKey));
    } finally {
      if (previousAmap === undefined) delete process.env.AMAP_WEB_SERVICE_KEY;
      else process.env.AMAP_WEB_SERVICE_KEY = previousAmap;
    }
    const view = store.view(job.id);
    const trip = view.trip;
    const serialized = JSON.stringify(trip ?? "");
    const originalLocks = new Map(
      evaluationCase.brief.bookedItems.map((item) => [item.id, JSON.stringify(item)]),
    );
    const lockedBookingChanged = trip
      ? [...originalLocks].some(
          ([id, value]) =>
            JSON.stringify(trip.brief.bookedItems.find((item) => item.id === id)) !== value,
        )
      : false;
    const issueCodes = view.issues.map((issue) => issue.code);
    const unreachableSchedule = issueCodes.some((code) =>
      /OVERLAP|ROUTE|TRAVEL|TIME|DURATION/.test(code),
    );
    const hardConstraintViolated = issueCodes.some((code) =>
      /HARD_CONSTRAINT|LOCKED/.test(code),
    );
    const evidenceIds = new Set(trip?.evidence.map((item) => item.id) ?? []);
    const fabricatedEvidence =
      trip?.claims.some((claim) =>
        [...claim.evidenceIds, ...claim.conflictEvidenceIds].some(
          (id) => !evidenceIds.has(id),
        ),
      ) ?? false;
    const realtimeInventoryClaim = /实时(?:库存|余票|房态)|已读取(?:库存|订单)|保证(?:有票|有房)/.test(serialized);
    const hiddenCriticalConflict =
      trip?.claims.some(
        (claim) =>
          claim.critical !== false &&
          claim.conflictEvidenceIds.length > 0 &&
          !trip.alerts.some((alert) => alert.entityIds.includes(claim.id)),
      ) ?? false;
    const verified = trip?.claims.filter((claim) => claim.status === "verified").length ?? 0;
    const claimCount = trip?.claims.length ?? 0;
    const routeOk = !unreachableSchedule;
    const completed = view.status === "completed" && !!trip;
    const blocked = view.status !== "completed" || trip?.lifecycleStatus === "blocked";
    return {
      completed,
      blocked,
      publicStatus: view.message,
      codes: [...new Set([...(view.errorCode ? [view.errorCode] : []), ...issueCodes])],
      lockedBookingChanged,
      unreachableSchedule,
      hardConstraintViolated,
      fabricatedEvidence,
      realtimeInventoryClaim,
      hiddenCriticalConflict,
      scores: {
        personalization: trip?.brief.preferences.length ? 85 : 75,
        routeEfficiency: routeOk ? 85 : 40,
        executableCompleteness: completed ? 90 : blocked ? 70 : 40,
        budgetQuality: trip?.budget.items.length ? 85 : 40,
        explanationAndEvidence: claimCount
          ? Math.round((verified / claimCount) * 100)
          : 40,
      },
      usage: {
        inputTokens: view.metrics?.inputTokens ?? 0,
        outputTokens: view.usage.outputTokens,
        visitorCostCny: view.usage.visitorModelCostCny,
        productCostCny: view.usage.productCostCny,
      },
      durationMs: performance.now() - started,
      sourceUrls: [
        ...new Set(
          trip?.evidence
            .map((evidence) => evidence.url)
            .filter((url): url is string => Boolean(url)) ?? [],
        ),
      ],
      steps: view.usage.steps,
    };
  } finally {
    db.close();
  }
}
