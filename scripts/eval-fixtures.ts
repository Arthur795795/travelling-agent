import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { executeFixedCase } from "../src/evaluation/fixture-executor.ts";
import { evaluationMarkdown } from "../src/evaluation/report.ts";
import { runEvaluation } from "../src/evaluation/runner.ts";
import { CORE_MODEL_SMOKE_CASES, STANDARD_EVALUATION_CASES } from "../src/evaluation/standard-cases.ts";

const target = resolve(process.env.EVAL_REPORT_PATH ?? "reports/eval-fixtures.json");
const smoke = process.env.EVAL_SUITE === "model-smoke";
const report = await runEvaluation({
  cases: smoke ? CORE_MODEL_SMOKE_CASES : STANDARD_EVALUATION_CASES,
  repeats: Number(process.env.EVAL_REPEATS ?? (smoke ? 1 : 3)),
  model: "deepseek-v4-pro",
  responseVersion: smoke ? "model-smoke-v1" : "fixtures-v1",
  seed: process.env.EVAL_SEED ?? "travel-agent-fixed",
  mode: "fixture",
  execute: executeFixedCase,
});
await mkdir(dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeFile(target.replace(/\.json$/, ".md"), evaluationMarkdown(report), "utf8");
console.log(`${report.gate.passed ? "PASS" : "FAIL"} ${report.sampleCount} samples -> ${target}`);
process.exitCode = report.gate.passed ? 0 : 1;
