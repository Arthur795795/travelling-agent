import { readFile } from "node:fs/promises";
import { z } from "zod";

const PublicRunSchema = z.object({
  caseId: z.string(),
  repeat: z.number().int(),
  passed: z.boolean(),
  criticalFailures: z.array(z.string()),
  codes: z.array(z.string()),
});
const PublicReportSchema = z.object({
  mode: z.enum(["fixture", "live"]),
  generatedAt: z.string(),
  model: z.string(),
  responseVersion: z.string(),
  caseCount: z.number().int(),
  sampleCount: z.number().int(),
  successRate: z.number(),
  averageSoftScore: z.number(),
  criticalFailureCount: z.number().int(),
  gate: z.object({ passed: z.boolean(), reasons: z.array(z.string()) }),
  runs: z.array(PublicRunSchema),
});

export type PublicEvaluationState =
  | { status: "not_completed"; reason: string }
  | {
      status: "available";
      report: z.infer<typeof PublicReportSchema>;
      failedRuns: z.infer<typeof PublicRunSchema>[];
    };

export async function loadPublicEvaluationReport(
  path: string,
): Promise<PublicEvaluationState> {
  try {
    const report = PublicReportSchema.parse(JSON.parse(await readFile(path, "utf8")));
    return {
      status: "available",
      report,
      failedRuns: report.runs.filter((run) => !run.passed),
    };
  } catch {
    return { status: "not_completed", reason: "评测尚未完成或报告不可用" };
  }
}
