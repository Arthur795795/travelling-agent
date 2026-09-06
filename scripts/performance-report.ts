import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performanceReport, type PerformanceSample } from "../src/evaluation/performance.ts";

const source = process.env.PERFORMANCE_INPUT_PATH;
const target = resolve(process.env.PERFORMANCE_REPORT_PATH ?? "reports/performance.json");
await mkdir(dirname(target), { recursive: true });
if (!source) {
  await writeFile(target, `${JSON.stringify({ status: "no-go", reason: "performance_measurements_missing" }, null, 2)}\n`);
  console.error("no-go: PERFORMANCE_INPUT_PATH is required");
  process.exitCode = 2;
} else {
  const input = JSON.parse(await readFile(resolve(source), "utf8")) as { samples: PerformanceSample[]; monthlyProductCostCny: number };
  const report = performanceReport(input.samples, input.monthlyProductCostCny);
  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.gate.passed ? "PASS" : "FAIL"} -> ${target}`);
  process.exitCode = report.gate.passed ? 0 : 1;
}
