import { createHash } from "node:crypto";
import { ExecutionStore, type ExecutionState } from "./execution-store.ts";
import { nextPlanningStage, isTerminalJobStatus } from "./lifecycle.ts";
import { TripSchema, type PlanningStage } from "../domain/schema.ts";
import {
  ANALYTICS_CODE_PATTERN,
  ANALYTICS_MAX_DURATION_MS,
  type AnalyticsEvent,
} from "../analytics/events.ts";
import {
  recordUsage,
  evaluateUsage,
  type UsageEvent,
} from "../domain/usage.ts";
import { TransientSecret } from "../security/secrets.ts";

export const DEFAULT_PLANNING_TASK_TIMEOUT_MS = 900_000;

/** Server-only task deadline. Invalid values retain a finite safe default. */
export function planningTaskTimeoutMs(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const parsed = Number(environment.PLANNING_TASK_TIMEOUT_MS);
  return Number.isInteger(parsed) && parsed >= 60_000 && parsed <= 1_800_000
    ? parsed
    : DEFAULT_PLANNING_TASK_TIMEOUT_MS;
}

const DEEPSEEK_ERROR_CODES = new Set([
  "invalid_key",
  "quota_or_permission",
  "rate_limited",
  "invalid_request",
  "timeout",
  "cancelled",
  "incomplete_response",
  "invalid_stream",
  "network_error",
  "upstream_error",
]);

/** Reduce internal/provider failures to a stable public-safe job code. */
export function planningErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "STAGE_FAILED";
  if (/^[A-Z_]+$/.test(error.message)) return error.message;
  const code = (error as Error & { code?: unknown }).code;
  if (
    error.name === "DeepSeekResponseError" &&
    typeof code === "string" &&
    DEEPSEEK_ERROR_CODES.has(code)
  )
    return `DEEPSEEK_${code.toUpperCase()}`;
  if (
    error.name === "SkeletonPlanningError" &&
    typeof code === "string" &&
    /^[A-Z_]+$/.test(code)
  )
    return code;
  if (
    error.name === "SensitivePersistenceError" &&
    code === "SENSITIVE_PERSISTENCE_BLOCKED"
  )
    return code;
  return "STAGE_FAILED";
}

/** Bounded elapsed time, so a resumed or skewed clock cannot produce data. */
const elapsedMs = (fromIso: string, at: Date): number =>
  Math.min(
    ANALYTICS_MAX_DURATION_MS,
    Math.max(0, at.getTime() - new Date(fromIso).getTime()),
  );

export interface StageContext {
  id: string;
  state: ExecutionState;
  signal: AbortSignal;
  secret: () => TransientSecret;
  once: <T>(
    key: string,
    input: unknown,
    run: () => Promise<T>,
    usage?: (value: T) => UsageEvent[],
  ) => Promise<T>;
}
export interface StageHandler {
  requiresKey: boolean;
  run: (context: StageContext) => Promise<Partial<ExecutionState>>;
}
export type StageHandlers = Record<PlanningStage, StageHandler>;
export class PlanningExecutor {
  private readonly active = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  readonly store: ExecutionStore;
  private readonly handlers: StageHandlers;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  /** Receives product-paid spend so the owner monthly stop can be evaluated. */
  private readonly onProductCost?: (amountCny: number) => void;
  /** Receives shape-only lifecycle events; never trip or chat content. */
  private readonly onAnalytics?: (event: AnalyticsEvent) => void;
  constructor(
    store: ExecutionStore,
    handlers: StageHandlers,
    now = () => new Date(),
    timeoutMs = planningTaskTimeoutMs(),
    onProductCost?: (amountCny: number) => void,
    onAnalytics?: (event: AnalyticsEvent) => void,
  ) {
    this.store = store;
    this.handlers = handlers;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.onProductCost = onProductCost;
    this.onAnalytics = onAnalytics;
  }
  run(id: string, key?: TransientSecret): Promise<void> {
    const active = this.active.get(id);
    if (active) {
      key?.clear();
      return active.promise;
    }
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(() => this.execute(id, key, controller))
      .finally(() => {
        key?.clear();
        this.active.delete(id);
      });
    this.active.set(id, { controller, promise });
    return promise;
  }
  cancel(id: string): void {
    this.active.get(id)?.controller.abort();
    const before = this.store.jobs.get(id);
    this.store.update(id, (job) =>
      isTerminalJobStatus(job.status)
        ? undefined
        : {
            ...job,
            status: "cancelled",
            cancelRequested: true,
            currentStage: undefined,
            currentStageStartedAt: undefined,
            updatedAt: this.now().toISOString(),
          },
    );
    // Only the transition reports, so a repeated cancel stays one event.
    if (before && !isTerminalJobStatus(before.status))
      this.finished(id, "cancelled");
  }
  /** Emits one end-of-run event, timed from when the job was created. */
  private finished(
    id: string,
    outcome: "ok" | "failed" | "cancelled" | "blocked",
    code?: string,
  ): void {
    if (!this.onAnalytics) return;
    const job = this.store.jobs.get(id);
    this.onAnalytics({
      name: "job_finished",
      outcome,
      ...(code && ANALYTICS_CODE_PATTERN.test(code) ? { code } : {}),
      ...(job ? { durationMs: elapsedMs(job.createdAt, this.now()) } : {}),
    });
  }
  private async execute(
    id: string,
    key: TransientSecret | undefined,
    controller: AbortController,
  ): Promise<void> {
    const timer = setTimeout(
      () => controller.abort(new Error("TASK_TIMEOUT")),
      this.timeoutMs,
    );
    try {
      while (true) {
        let job = this.store.jobs.get(id);
        if (!job || isTerminalJobStatus(job.status)) return;
        if (job.cancelRequested) {
          this.cancel(id);
          return;
        }
        if (controller.signal.aborted) throw new Error("TASK_TIMEOUT");
        const stage = nextPlanningStage(job);
        if (!stage) {
          this.store.update(id, (j) => ({
            ...j,
            status: "completed",
            updatedAt: this.now().toISOString(),
          }));
          this.finished(id, "ok");
          return;
        }
        const handler = this.handlers[stage];
        const needsKey =
          handler.requiresKey &&
          !(
            stage === "repair" &&
            !this.store.state(id).issues.some((i) => i.severity === "blocking")
          );
        if (needsKey && !key) {
          this.store.update(id, (j) => ({
            ...j,
            status: "waiting_for_credentials",
            currentStage: undefined,
            currentStageStartedAt: undefined,
          }));
          this.finished(id, "blocked", "KEY_REQUIRED");
          return;
        }
        const startedAt = this.now().toISOString();
        this.store.update(id, (j) => ({
          ...j,
          status: "running",
          currentStage: stage,
          currentStageStartedAt: startedAt,
          updatedAt: startedAt,
        }));
        const before = this.store.state(id);
        const once = async <T>(
          callKey: string,
          input: unknown,
          run: () => Promise<T>,
          usage?: (value: T) => UsageEvent[],
        ): Promise<T> => {
          if (
            controller.signal.aborted ||
            this.store.jobs.get(id)?.status === "cancelled"
          )
            throw new Error("TASK_CANCELLED");
          const name = `${stage}:${callKey}`;
          const signature = createHash("sha256")
            .update(JSON.stringify(input))
            .digest("hex");
          const state = this.store.state(id);
          const prior = state.calls[name];
          if (prior) {
            if (prior.signature !== signature) throw new Error("CALL_CONFLICT");
            if (prior.status === "completed") return prior.value as T;
            throw new Error("CALL_INTERRUPTED");
          }
          const decision = evaluateUsage(state.usage);
          if (!decision.allowed) throw new Error(decision.code);
          this.store.update(id, (_j, s) => {
            s.calls[name] = { signature, status: "pending" };
          });
          const value = await run();
          if (controller.signal.aborted) throw new Error("TASK_CANCELLED");
          const productBefore = this.store.state(id).usage.productCostCny;
          this.store.update(id, (_j, s) => {
            s.calls[name] = { signature, status: "completed", value };
            s.metrics ??= { inputTokens: 0, toolCalls: 0 };
            if (input && typeof input === "object" && "name" in input)
              s.metrics.toolCalls++;
            for (const event of usage?.(value) ?? []) {
              s.usage = recordUsage(s.usage, event);
              if (event.type === "model")
                s.metrics.inputTokens += event.inputTokens ?? 0;
            }
          });
          const productDelta =
            this.store.state(id).usage.productCostCny - productBefore;
          if (productDelta > 0) this.onProductCost?.(productDelta);
          if (controller.signal.aborted) throw new Error("TASK_CANCELLED");
          return value;
        };
        const stageWork = handler.run({
          id,
          state: before,
          signal: controller.signal,
          secret: () => {
            if (!key) throw new Error("KEY_REQUIRED");
            return key.use((value) => new TransientSecret(value));
          },
          once,
        });
        const patch = await new Promise<Partial<ExecutionState>>(
          (resolve, reject) => {
            const abort = () =>
              reject(
                controller.signal.reason instanceof Error
                  ? controller.signal.reason
                  : new Error("TASK_CANCELLED"),
              );
            controller.signal.addEventListener("abort", abort, { once: true });
            if (controller.signal.aborted) abort();
            stageWork
              .then(resolve, reject)
              .finally(() =>
                controller.signal.removeEventListener("abort", abort),
              );
          },
        );
        job = this.store.jobs.get(id);
        if (!job || job.status === "cancelled") return;
        if (controller.signal.aborted) throw new Error("TASK_TIMEOUT");
        this.store.update(id, (j, state) => {
          const calls = state.calls;
          const usage = state.usage;
          const metrics = state.metrics;
          Object.assign(state, patch, { calls, usage, metrics });
          state.usage = recordUsage(state.usage, { type: "step" });
          if (state.trip) state.trip = TripSchema.parse(state.trip);
          return {
            ...j,
            currentStage: undefined,
            currentStageStartedAt: undefined,
            updatedAt: this.now().toISOString(),
            stageResults: [
              ...j.stageResults,
              {
                stage,
                status: "completed",
                startedAt,
                completedAt: this.now().toISOString(),
                summary: `${stage} 已完成`,
                estimatedCostCny:
                  state.usage.visitorModelCostCny -
                  before.usage.visitorModelCostCny,
                tokenUsage: {
                  input:
                    (state.metrics?.inputTokens ?? 0) -
                    (before.metrics?.inputTokens ?? 0),
                  output: state.usage.outputTokens - before.usage.outputTokens,
                },
              },
            ],
          };
        });
        this.onAnalytics?.({
          name: "job_stage",
          stage,
          outcome: "ok",
          durationMs: elapsedMs(startedAt, this.now()),
        });
      }
    } catch (error) {
      const job = this.store.jobs.get(id);
      if (job && !isTerminalJobStatus(job.status)) {
        const code = planningErrorCode(error);
        this.store.update(id, (j) => ({
          ...j,
          status: "failed",
          errorCode: code,
          currentStage: undefined,
          currentStageStartedAt: undefined,
          updatedAt: this.now().toISOString(),
        }));
        this.finished(id, "failed", code);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
