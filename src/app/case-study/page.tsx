import { basename, join } from "node:path";
import { loadPublicEvaluationReport } from "../../evaluation/public-report.ts";

export const dynamic = "force-dynamic";

export default async function CaseStudyPage() {
  const state = await loadPublicEvaluationReport(
    join(
      process.cwd(),
      "reports",
      basename(process.env.EVAL_PUBLIC_REPORT_FILE ?? "eval-fixtures.json"),
    ),
  );
  return (
    <main className="shell" id="main-content" tabIndex={-1}>
      <h1>案例研究</h1>
      <p>
        目标是把 3–5 天中国城市自由行需求整理成可编辑、可核验、可执行的结构化行程，
        而不是生成一篇攻略文章。
      </p>
      <h2>范围与边界</h2>
      <p>
        首批范围为北京、上海、重庆、西安和杭州。产品不绑定第三方账户、不代订或支付，
        不保证实时余票、房态与价格，也不展示模型思维链。
      </p>
      <h2>Agent 工作流</h2>
      <ol>
        <li>需求完整性检查</li>
        <li>行程骨架规划</li>
        <li>候选地点与证据收集</li>
        <li>路线与分类预算补全</li>
        <li>确定性硬校验</li>
        <li>最多两轮受限修复</li>
        <li>输出可执行、需复核或阻塞状态</li>
      </ol>
      <p>
        模型负责候选与解释；Schema、锁定保护、时间空间、预算和来源规则由确定性代码校验。
      </p>
      <h2>固定响应评测</h2>
      {state.status === "not_completed" ? (
        <p role="status">评测尚未完成：没有可读取的报告，因此不展示成功率。</p>
      ) : (
        <>
          <p>
            模型：{state.report.model} · 日期：{state.report.generatedAt} · 样本数：
            {state.report.sampleCount} · 通过率：
            {(state.report.successRate * 100).toFixed(1)}% · 软评分平均：
            {state.report.averageSoftScore} · 关键失败：
            {state.report.criticalFailureCount}
          </p>
          <p>
            结果门槛：{state.report.gate.passed ? "通过" : "未通过"}。固定响应结果不代表实时网络、
            库存、真实用户或生产性能。
          </p>
          <h3>失败样本</h3>
          {state.failedRuns.length ? (
            <ul>
              {state.failedRuns.map((run) => (
                <li key={`${run.caseId}-${run.repeat}`}>
                  {run.caseId} / 第 {run.repeat} 次：
                  {[...run.criticalFailures, ...run.codes].join("、") || "未满足预期"}
                </li>
              ))}
            </ul>
          ) : (
            <p>本报告没有失败样本。</p>
          )}
        </>
      )}
      <h2>已知限制</h2>
      <p>
        本产品内容由 AI 辅助生成；页面仅展示所用模型名称，也不展示模型推理过程。
      </p>
      <p>
        官方页面可访问性、供应商响应和平台跳转规则会变化；所有关键事实都保留查询时间与状态，
        出发前必须复核。
      </p>
      <p><a href="/demo">打开北京固定案例</a></p>
    </main>
  );
}
