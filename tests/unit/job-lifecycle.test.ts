import assert from "node:assert/strict";
import test from "node:test";
import type { PlanningJob } from "../../src/domain/schema.ts";
import {
  assertJobTransition,
  InvalidJobTransitionError,
  nextPlanningStage,
  PLANNING_STAGES,
} from "../../src/jobs/lifecycle.ts";
import {
  IncompletePlanningJobError,
  PlanningJobService,
  PlanningJobVersionConflictError,
  type PlanningJobStore,
} from "../../src/jobs/service.ts";
import { VersionConflictError } from "../../src/persistence/repositories.ts";

class MemoryJobStore implements PlanningJobStore {
  jobs = new Map<string, PlanningJob>();
  create(job: PlanningJob) {
    this.jobs.set(job.id, job);
    return job;
  }
  get(id: string) {
    return this.jobs.get(id) ?? null;
  }
  update(job: PlanningJob, expectedVersion: number) {
    const current = this.jobs.get(job.id);
    if (!current || current.version !== expectedVersion)
      throw new VersionConflictError("PlanningJob", job.id);
    const updated = { ...job, version: expectedVersion + 1 };
    this.jobs.set(job.id, updated);
    return updated;
  }
}

const now = () => new Date("2026-09-04T10:00:00+08:00");

test("job lifecycle records stages and enforces transitions", () => {
  const store = new MemoryJobStore();
  const service = new PlanningJobService(store, now, () => "job-1");
  const queued = service.create();
  const running = service.transition(queued.id, 0, "running");
  assert.throws(
    () => service.beginStage(running.id, 1, "finalization"),
    /defined order/,
  );
  const staged = service.beginStage(running.id, 1, "requirements_check");
  assert.throws(
    () => service.beginStage(staged.id, 2, "requirements_check"),
    /must finish/,
  );
  assert.equal(staged.currentStageStartedAt, now().toISOString());
  const recorded = service.completeStage(staged.id, 2, {
    stage: "requirements_check",
    status: "completed",
    startedAt: "2020-01-01T00:00:00Z",
    completedAt: now().toISOString(),
    summary: "complete",
  });
  assert.equal(recorded.stageResults.length, 1);
  assert.equal(
    recorded.stageResults[0].startedAt,
    staged.currentStageStartedAt,
  );
  assert.equal(nextPlanningStage(recorded), "skeleton_planning");
  assert.throws(
    () => service.transition(recorded.id, 3, "completed"),
    IncompletePlanningJobError,
  );

  let current = recorded;
  for (const stage of PLANNING_STAGES.slice(1)) {
    current = service.beginStage(current.id, current.version, stage);
    current = service.completeStage(current.id, current.version, {
      stage,
      status: "completed",
      startedAt: "2020-01-01T00:00:00Z",
      completedAt: now().toISOString(),
      summary: `${stage} complete`,
    });
  }
  const complete = service.transition(current.id, current.version, "completed");
  assert.equal(complete.status, "completed");
  assert.equal(nextPlanningStage(complete), undefined);
  assert.throws(
    () => service.transition(complete.id, complete.version, "running"),
    InvalidJobTransitionError,
  );
  assert.equal(service.transition(complete.id, 0, "completed"), complete);
});

test("transition matrix accepts only documented lifecycle edges", () => {
  const allowed: Record<PlanningJob["status"], PlanningJob["status"][]> = {
    queued: ["running", "waiting_for_credentials", "failed", "cancelled"],
    running: ["waiting_for_credentials", "completed", "failed", "cancelled"],
    waiting_for_credentials: ["queued", "running", "failed", "cancelled"],
    completed: [],
    failed: [],
    cancelled: [],
  };
  const statuses = Object.keys(allowed) as PlanningJob["status"][];
  for (const from of statuses) {
    for (const to of statuses) {
      if (allowed[from].includes(to))
        assert.doesNotThrow(() => assertJobTransition(from, to));
      else
        assert.throws(
          () => assertJobTransition(from, to),
          InvalidJobTransitionError,
        );
    }
  }
});

test("running cancellation is cooperative and stale updates fail", () => {
  const store = new MemoryJobStore();
  const service = new PlanningJobService(store, now, () => "job-2");
  service.create();
  service.transition("job-2", 0, "running");
  const cancelRequested = service.requestCancel("job-2", 1);
  assert.equal(cancelRequested.cancelRequested, true);
  assert.equal(cancelRequested.status, "running");
  assert.equal(service.requestCancel("job-2", 1), cancelRequested);
  assert.throws(
    () => service.transition("job-2", 1, "cancelled"),
    PlanningJobVersionConflictError,
  );
  assert.equal(service.transition("job-2", 2, "cancelled").status, "cancelled");
});

test("interrupted BYOK jobs wait for credentials and other jobs fail explicitly", () => {
  const byokStore = new MemoryJobStore();
  const byok = new PlanningJobService(byokStore, now, () => "byok");
  byok.create();
  byok.transition("byok", 0, "running");
  assert.equal(
    byok.recoverInterrupted("byok", 1, true).status,
    "waiting_for_credentials",
  );

  const productStore = new MemoryJobStore();
  const product = new PlanningJobService(productStore, now, () => "product");
  product.create();
  product.transition("product", 0, "running");
  const queued = product.recoverInterrupted("product", 1, false);
  assert.equal(queued.status, "queued");
});
