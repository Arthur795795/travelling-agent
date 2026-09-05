import { randomUUID } from "node:crypto";
import {
  PlanningJobSchema,
  StageResultSchema,
  type JobStatus,
  type PlanningJob,
  type PlanningStage,
} from "../domain/schema.ts";
import type { z } from "zod";
import {
  assertJobTransition,
  isTerminalJobStatus,
  nextPlanningStage,
} from "./lifecycle.ts";

type StageResult = z.infer<typeof StageResultSchema>;

export interface PlanningJobStore {
  create(job: PlanningJob): PlanningJob;
  get(id: string): PlanningJob | null;
  update(job: PlanningJob, expectedVersion: number): PlanningJob;
}

export class PlanningJobNotFoundError extends Error {
  readonly code = "PLANNING_JOB_NOT_FOUND";
}

export class PlanningJobVersionConflictError extends Error {
  readonly code = "VERSION_CONFLICT";

  constructor(id: string) {
    super(`PlanningJob ${id} was updated by another request`);
    this.name = "PlanningJobVersionConflictError";
  }
}

export class IncompletePlanningJobError extends Error {
  readonly code = "INCOMPLETE_PLANNING_JOB";

  constructor() {
    super("PlanningJob cannot complete before every planning stage finishes");
    this.name = "IncompletePlanningJobError";
  }
}

export class PlanningJobService {
  private readonly store: PlanningJobStore;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(
    store: PlanningJobStore,
    now = () => new Date(),
    createId: () => string = () => randomUUID(),
  ) {
    this.store = store;
    this.now = now;
    this.createId = createId;
  }

  create(expiresInMs = 24 * 60 * 60 * 1_000): PlanningJob {
    const createdAt = this.now();
    return this.store.create(
      PlanningJobSchema.parse({
        schemaVersion: 1,
        id: this.createId(),
        version: 0,
        status: "queued",
        stageResults: [],
        cancelRequested: false,
        createdAt: createdAt.toISOString(),
        updatedAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + expiresInMs).toISOString(),
      }),
    );
  }

  transition(
    id: string,
    expectedVersion: number,
    status: JobStatus,
    errorCode?: string,
  ): PlanningJob {
    const job = this.requireJob(id);
    if (job.status === status && isTerminalJobStatus(status)) return job;
    if (job.version !== expectedVersion)
      throw new PlanningJobVersionConflictError(id);
    assertJobTransition(job.status, status);
    if (
      status === "completed" &&
      (job.currentStage ||
        job.cancelRequested ||
        nextPlanningStage(job) !== undefined)
    ) {
      throw new IncompletePlanningJobError();
    }
    return this.store.update(
      PlanningJobSchema.parse({
        ...job,
        status,
        errorCode,
        currentStage: isTerminalJobStatus(status)
          ? undefined
          : job.currentStage,
        currentStageStartedAt: isTerminalJobStatus(status)
          ? undefined
          : job.currentStageStartedAt,
        updatedAt: this.now().toISOString(),
      }),
      expectedVersion,
    );
  }

  beginStage(
    id: string,
    expectedVersion: number,
    stage: PlanningStage,
  ): PlanningJob {
    const job = this.requireJob(id);
    if (job.version !== expectedVersion)
      throw new PlanningJobVersionConflictError(id);
    if (job.status !== "running")
      throw new Error("A stage can only begin while a job is running");
    if (job.currentStage)
      throw new Error(
        "The current stage must finish before another stage begins",
      );
    if (nextPlanningStage(job) !== stage)
      throw new Error("Planning stages must run in their defined order");
    const startedAt = this.now().toISOString();
    return this.store.update(
      PlanningJobSchema.parse({
        ...job,
        currentStage: stage,
        currentStageStartedAt: startedAt,
        updatedAt: startedAt,
      }),
      expectedVersion,
    );
  }

  completeStage(
    id: string,
    expectedVersion: number,
    input: StageResult,
  ): PlanningJob {
    const job = this.requireJob(id);
    if (job.version !== expectedVersion)
      throw new PlanningJobVersionConflictError(id);
    if (
      job.status !== "running" ||
      job.currentStage !== input.stage ||
      !job.currentStageStartedAt
    ) {
      throw new Error("Stage result does not match the running stage");
    }
    const result = StageResultSchema.parse({
      ...input,
      startedAt: job.currentStageStartedAt,
    });
    return this.store.update(
      PlanningJobSchema.parse({
        ...job,
        currentStage: undefined,
        currentStageStartedAt: undefined,
        stageResults: [...job.stageResults, result],
        updatedAt: this.now().toISOString(),
      }),
      expectedVersion,
    );
  }

  requestCancel(id: string, expectedVersion: number): PlanningJob {
    const job = this.requireJob(id);
    if (job.status === "cancelled") return job;
    if (isTerminalJobStatus(job.status)) return job;
    if (job.status === "running") {
      if (job.cancelRequested) return job;
      return this.store.update(
        PlanningJobSchema.parse({
          ...job,
          cancelRequested: true,
          updatedAt: this.now().toISOString(),
        }),
        expectedVersion,
      );
    }
    return this.transition(id, expectedVersion, "cancelled");
  }

  recoverInterrupted(
    id: string,
    expectedVersion: number,
    requiresCredentials: boolean,
  ): PlanningJob {
    const job = this.requireJob(id);
    if (job.status !== "running") return job;
    if (requiresCredentials)
      return this.transition(id, expectedVersion, "waiting_for_credentials");
    if (job.version !== expectedVersion)
      throw new PlanningJobVersionConflictError(id);
    return this.store.update(
      PlanningJobSchema.parse({
        ...job,
        status: "queued",
        currentStage: undefined,
        currentStageStartedAt: undefined,
        updatedAt: this.now().toISOString(),
      }),
      expectedVersion,
    );
  }

  private requireJob(id: string): PlanningJob {
    const job = this.store.get(id);
    if (!job)
      throw new PlanningJobNotFoundError(`PlanningJob ${id} is unavailable`);
    return job;
  }
}
