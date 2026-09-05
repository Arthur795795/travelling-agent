import type {
  JobStatus,
  PlanningStage,
  Trip,
  ValidationIssue,
} from "../domain/schema.ts";
import type { UsageSnapshot } from "../domain/usage.ts";
export const PROGRESS_LABELS: Record<PlanningStage, string> = {
  requirements_check: "确认旅行需求",
  skeleton_planning: "安排每日骨架",
  evidence_collection: "查找地点与核验信息",
  route_and_budget: "计算路线与预算",
  hard_validation: "检查行程可行性",
  repair: "检查行程可行性",
  finalization: "整理最终行程",
};
export interface JobView {
  id: string;
  status: JobStatus;
  stage?: PlanningStage;
  message: string;
  sequence: number;
  usage: UsageSnapshot;
  metrics?: { inputTokens: number; toolCalls: number };
  errorCode?: string;
  trip?: Trip;
  issues: ValidationIssue[];
  choices: string[];
  model: string;
  baseVersion?: number;
}
export interface JobEvent {
  sequence: number;
  view: JobView;
}
