import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  TripBrief,
  PlanningJob,
  Trip,
  ValidationIssue,
} from "../domain/schema.ts";
import { PlanningJobRepository } from "../persistence/repositories.ts";
import { PlanningJobService } from "./service.ts";
import type { SqliteDatabase } from "../persistence/database.ts";
import type { UsageSnapshot } from "../domain/usage.ts";
import type { ItinerarySkeleton } from "../agent/skeleton.ts";
import type { JobEvent, JobView } from "./protocol.ts";
import { PROGRESS_LABELS } from "./protocol.ts";
import { assertNoSensitiveData } from "../security/redaction.ts";

export interface ExecutionState {
  replan?: { base: Trip; change: import("../trips/changes.ts").TripChange };
  brief: TripBrief;
  skeleton?: ItinerarySkeleton;
  trip?: Trip;
  baseline?: Trip;
  issues: ValidationIssue[];
  choices: string[];
  usage: UsageSnapshot;
  metrics?: { inputTokens: number; toolCalls: number };
  calls: Record<
    string,
    { signature: string; status: "pending" | "completed"; value?: unknown }
  >;
  model: string;
}
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export class ExecutionStore {
  readonly jobs: PlanningJobRepository;
  readonly service: PlanningJobService;
  readonly database: SqliteDatabase;
  constructor(database: SqliteDatabase, now = () => new Date()) {
    this.database = database;
    this.jobs = new PlanningJobRepository(database, now);
    this.service = new PlanningJobService(this.jobs, now);
  }
  create(brief: TripBrief): { job: PlanningJob; token: string } {
    assertNoSensitiveData(brief);
    return this.database.transaction(() => {
      const job = this.service.create();
      const token = randomBytes(32).toString("hex");
      const state: ExecutionState = {
        brief,
        issues: [],
        choices: [],
        calls: {},
        model: "deepseek-v4-pro",
        usage: {
          steps: 0,
          searchCalls: 0,
          repairRounds: 0,
          outputTokens: 0,
          visitorModelCostCny: 0,
          productCostCny: 0,
        },
      };
      this.database
        .prepare(
          "INSERT INTO planning_execution (job_id,token_hash,state) VALUES (?,?,?)",
        )
        .run(job.id, hash(token), JSON.stringify(state));
      this.event(job.id);
      return { job, token };
    })();
  }
  authorized(id: string, token: string): boolean {
    if (!this.jobs.get(id)) return false;
    const row = this.database
      .prepare("SELECT token_hash FROM planning_execution WHERE job_id=?")
      .get(id) as { token_hash: string } | undefined;
    return (
      !!row &&
      timingSafeEqual(
        Buffer.from(row.token_hash, "hex"),
        Buffer.from(hash(token), "hex"),
      )
    );
  }
  state(id: string): ExecutionState {
    if (!this.jobs.get(id)) throw new Error("JOB_UNAVAILABLE");
    const row = this.database
      .prepare("SELECT state FROM planning_execution WHERE job_id=?")
      .get(id) as { state: string } | undefined;
    if (!row) throw new Error("JOB_UNAVAILABLE");
    return JSON.parse(row.state) as ExecutionState;
  }
  update(
    id: string,
    mutate: (job: PlanningJob, state: ExecutionState) => PlanningJob | void,
  ): void {
    this.database.transaction(() => {
      const job = this.jobs.get(id);
      if (!job) throw new Error("JOB_UNAVAILABLE");
      const state = this.state(id);
      const next = mutate(job, state);
      assertNoSensitiveData(state);
      if (next) this.jobs.update(next, job.version);
      this.database
        .prepare("UPDATE planning_execution SET state=? WHERE job_id=?")
        .run(JSON.stringify(state), id);
      this.event(id);
    })();
  }
  view(id: string): JobView {
    const job = this.jobs.get(id);
    if (!job) throw new Error("JOB_UNAVAILABLE");
    const state = this.state(id);
    const row = this.database
      .prepare(
        "SELECT COALESCE(MAX(sequence),0) AS sequence FROM planning_events WHERE job_id=?",
      )
      .get(id) as { sequence: number };
    return {
      id,
      status: job.status,
      stage: job.currentStage,
      message:
        job.status === "waiting_for_credentials"
          ? "请重新提供 DeepSeek Key 继续"
          : job.status === "completed"
            ? "行程整理完成"
            : job.status === "cancelled"
              ? "任务已取消"
              : job.status === "failed"
                ? "任务未完成，请查看原因并重试"
                : job.currentStage
                  ? PROGRESS_LABELS[job.currentStage]
                  : "任务已创建，等待开始",
      sequence: row.sequence,
      usage: state.usage,
      metrics: state.metrics ?? { inputTokens: 0, toolCalls: 0 },
      errorCode: job.errorCode,
      trip: job.status === "completed" ? state.trip : undefined,
      issues: state.issues,
      choices: state.choices,
      model: state.model,
      baseVersion: state.replan?.base.version,
    };
  }
  events(id: string, after: number): JobEvent[] {
    if (!this.jobs.get(id)) throw new Error("JOB_UNAVAILABLE");
    const rows = this.database
      .prepare(
        "SELECT sequence,payload FROM planning_events WHERE job_id=? AND sequence>? ORDER BY sequence",
      )
      .all(id, after) as { sequence: number; payload: string }[];
    return rows.map((r) => ({
      sequence: r.sequence,
      view: JSON.parse(r.payload),
    }));
  }
  recover(): string[] {
    const rows = this.database
      .prepare(
        "SELECT id FROM planning_jobs WHERE status IN ('running','queued','waiting_for_credentials')",
      )
      .all() as { id: string }[];
    const ids: string[] = [];
    for (const { id } of rows)
      if (this.jobs.get(id)) {
        this.update(id, (job) => ({
          ...job,
          status: "queued",
          currentStage: undefined,
          currentStageStartedAt: undefined,
        }));
        ids.push(id);
      }
    return ids;
  }
  private event(id: string): void {
    const view = this.view(id);
    view.sequence++;
    this.database
      .prepare(
        "INSERT INTO planning_events (job_id,sequence,payload) VALUES (?,?,?)",
      )
      .run(id, view.sequence, JSON.stringify(view));
  }
}
