import type {
  JobStatus,
  PlanningJob,
  PlanningStage,
} from "../domain/schema.ts";

export const PLANNING_STAGES: readonly PlanningStage[] = [
  "requirements_check",
  "skeleton_planning",
  "evidence_collection",
  "route_and_budget",
  "hard_validation",
  "repair",
  "finalization",
];

const transitions: Record<JobStatus, ReadonlySet<JobStatus>> = {
  queued: new Set([
    "running",
    "waiting_for_credentials",
    "failed",
    "cancelled",
  ]),
  running: new Set([
    "waiting_for_credentials",
    "completed",
    "failed",
    "cancelled",
  ]),
  waiting_for_credentials: new Set([
    "queued",
    "running",
    "failed",
    "cancelled",
  ]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export class InvalidJobTransitionError extends Error {
  readonly code = "INVALID_JOB_TRANSITION";

  constructor(from: JobStatus, to: JobStatus) {
    super(`Cannot transition PlanningJob from ${from} to ${to}`);
    this.name = "InvalidJobTransitionError";
  }
}

export function assertJobTransition(from: JobStatus, to: JobStatus): void {
  if (!transitions[from].has(to)) throw new InvalidJobTransitionError(from, to);
}

export function isTerminalJobStatus(status: JobStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

export function nextPlanningStage(job: PlanningJob): PlanningStage | undefined {
  if (isTerminalJobStatus(job.status)) return undefined;
  if (job.currentStage) return job.currentStage;
  const completed = new Set(
    job.stageResults
      .filter(({ status }) => status === "completed")
      .map(({ stage }) => stage),
  );
  return PLANNING_STAGES.find((stage) => !completed.has(stage));
}
