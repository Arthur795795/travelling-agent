import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { executeLiveAgentCase } from "../src/evaluation/live-agent.ts";
import { liveEvaluationConfig, runLiveEvaluation } from "../src/evaluation/live.ts";
import { STANDARD_EVALUATION_CASES } from "../src/evaluation/standard-cases.ts";

const decision = liveEvaluationConfig();
if (!decision.ready) {
  const report = {
    status: "no-go",
    code: decision.code,
    message:
      "受控联网评测未运行；必须显式启用并提供内部 DeepSeek 测试 Key 与产品高德 Key。",
  };
  await mkdir("reports/live", { recursive: true });
  await writeFile(
    join("reports/live", "latest-no-go.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.error(`${report.status}: ${report.code}`);
  process.exitCode = 2;
} else {
  process.env.FEATURE_AMAP = "true";
  process.env.FEATURE_WEB_SEARCH = "true";
  const previousSqlite = process.env.SQLITE_PATH;
  process.env.SQLITE_PATH = ":memory:";
  const result = await runLiveEvaluation({
      config: decision.config,
      cases: STANDARD_EVALUATION_CASES,
      model: "deepseek-v4-pro",
      responseVersion: "live-agent-v1",
      execute: executeLiveAgentCase,
    }).finally(() => {
      if (previousSqlite === undefined) delete process.env.SQLITE_PATH;
      else process.env.SQLITE_PATH = previousSqlite;
    });
  const directory = resolve(decision.config.reportDirectory);
  const stamp = result.queriedAt.replace(/[:.]/g, "-");
  const payload = `${JSON.stringify(result, null, 2)}\n`;
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${stamp}.json`), payload);
  await writeFile(join(directory, "latest.json"), payload);
  console.log(`${result.status.toUpperCase()} ${result.report.sampleCount} samples -> ${directory}`);
  process.exitCode = result.status === "completed" ? 0 : 1;
}
