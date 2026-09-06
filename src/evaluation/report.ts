import type { EvaluationReport } from "./runner.ts";

export function evaluationMarkdown(report: EvaluationReport): string {
  const failed = report.runs.filter((run) => !run.passed);
  return `# Agent 评测报告

- 模式：${report.mode === "fixture" ? "固定响应（非实时联网）" : "受控联网"}
- 生成时间：${report.generatedAt}
- 模型：${report.model}
- 响应版本：${report.responseVersion}
- 案例数：${report.caseCount}
- 样本数：${report.sampleCount}
- 通过率：${(report.successRate * 100).toFixed(1)}%
- 软评分平均：${report.averageSoftScore}
- 关键失败：${report.criticalFailureCount}
- 门槛：${report.gate.passed ? "通过" : "未通过"}

## 失败样本

${
  failed.length
    ? failed
        .map(
          (run) =>
            `- ${run.caseId} / 第 ${run.repeat} 次：${[
              ...run.criticalFailures,
              ...run.codes,
            ].join(", ") || "结果未满足预期"}`,
        )
        .join("\n")
    : "- 无"
}

## 限制

- 固定响应报告只证明确定性回归结果，不代表实时开放、库存、价格、网络性能或真实用户结果。
- 失败样本会完整保留在 JSON 报告的 \`runs\` 中，软分不能抵消关键失败。
`;
}
