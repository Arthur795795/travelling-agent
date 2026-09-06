import type { EvaluationCase, EvaluationObservation } from "./contracts.ts";
import type { EvaluationReport } from "./runner.ts";
import { runEvaluation } from "./runner.ts";

export interface LiveEvaluationConfig {
  enabled: boolean;
  deepSeekKey?: string;
  amapKey?: string;
  maxCases: number;
  maxSteps: number;
  maxCostCny: number;
  reportDirectory: string;
}

export type LiveConfigResult =
  | { ready: true; config: LiveEvaluationConfig }
  | { ready: false; code: "LIVE_EVAL_DISABLED" | "LIVE_EVAL_CREDENTIALS_MISSING" };

export function liveEvaluationConfig(
  env: Record<string, string | undefined> = process.env,
): LiveConfigResult {
  if (env.LIVE_EVAL_ENABLED?.toLowerCase() !== "true")
    return { ready: false, code: "LIVE_EVAL_DISABLED" };
  if (!env.INTERNAL_DEEPSEEK_EVAL_KEY || !env.AMAP_WEB_SERVICE_KEY)
    return { ready: false, code: "LIVE_EVAL_CREDENTIALS_MISSING" };
  const maxCases = Math.min(3, Math.max(1, Number(env.LIVE_EVAL_MAX_CASES ?? 2)));
  const maxSteps = Math.min(20, Math.max(1, Number(env.LIVE_EVAL_MAX_STEPS ?? 12)));
  const maxCostCny = Math.min(20, Math.max(0.01, Number(env.LIVE_EVAL_MAX_COST_CNY ?? 2)));
  if (![maxCases, maxSteps, maxCostCny].every(Number.isFinite))
    throw new RangeError("Live evaluation limits must be finite");
  return {
    ready: true,
    config: {
      enabled: true,
      deepSeekKey: env.INTERNAL_DEEPSEEK_EVAL_KEY,
      amapKey: env.AMAP_WEB_SERVICE_KEY,
      maxCases,
      maxSteps,
      maxCostCny,
      reportDirectory: env.LIVE_EVAL_REPORT_DIR ?? "reports/live",
    },
  };
}

export interface LiveEvaluationResult {
  status: "completed" | "stopped";
  reason?: "step_limit" | "cost_limit";
  sourceUrls: string[];
  queriedAt: string;
  report: EvaluationReport;
}

/** Runs only through an explicitly supplied network adapter, which tests replace locally. */
export async function runLiveEvaluation(options: {
  config: LiveEvaluationConfig;
  cases: EvaluationCase[];
  model: string;
  responseVersion: string;
  now?: () => Date;
  execute: (
    item: EvaluationCase,
    credentials: { deepSeekKey: string; amapKey: string },
  ) => Promise<EvaluationObservation & { sourceUrls: string[]; steps: number }>;
}): Promise<LiveEvaluationResult> {
  const now = options.now ?? (() => new Date());
  const selected = options.cases.slice(0, options.config.maxCases);
  let spent = 0;
  let stopped: LiveEvaluationResult["reason"];
  const sources = new Set<string>();
  const observations = new Map<string, EvaluationObservation>();
  for (const item of selected) {
    if (stopped) break;
    const result = await options.execute(item, {
      deepSeekKey: options.config.deepSeekKey!,
      amapKey: options.config.amapKey!,
    });
    if (result.steps > options.config.maxSteps) stopped = "step_limit";
    spent += result.usage.visitorCostCny + result.usage.productCostCny;
    if (spent > options.config.maxCostCny) stopped = "cost_limit";
    for (const url of result.sourceUrls) {
      const parsed = new URL(url);
      parsed.username = "";
      parsed.password = "";
      for (const key of [...parsed.searchParams.keys()])
        if (/key|token|secret|auth/i.test(key)) parsed.searchParams.delete(key);
      sources.add(parsed.toString());
    }
    const { sourceUrls: _sourceUrls, steps: _steps, ...observation } = result;
    void _sourceUrls;
    void _steps;
    observations.set(item.id, observation);
  }
  const completedCases = selected.filter((item) => observations.has(item.id));
  const report = await runEvaluation({
    cases: completedCases,
    repeats: 1,
    model: options.model,
    responseVersion: options.responseVersion,
    seed: "live-controlled",
    mode: "live",
    now,
    execute: async (item) => observations.get(item.id)!,
  });
  if (stopped) {
    report.gate.passed = false;
    report.gate.reasons.push(stopped);
  }
  return {
    status: stopped ? "stopped" : "completed",
    reason: stopped,
    sourceUrls: [...sources],
    queriedAt: now().toISOString(),
    report,
  };
}
