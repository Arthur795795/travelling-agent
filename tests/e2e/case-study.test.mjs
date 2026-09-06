import assert from "node:assert/strict";
import test from "node:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { browserHarness, waitFor } from "./helpers/browser.mjs";
import { automatedEnvNames, availableBrowsers } from "./helpers/browsers.mjs";

test("case study shows missing, passing and failed reports without invented metrics", async (t) => {
  const [target] = availableBrowsers();
  if (!target) {
    t.skip(`需要可自动化浏览器：${automatedEnvNames().join(" / ")}`);
    return;
  }
  const reportFile = `case-study-${process.pid}.json`;
  const reportPath = join(process.cwd(), "reports", reportFile);
  t.after(() => rm(reportPath, { force: true }));
  const browser = await browserHarness(t, {
    browser: target,
    env: { EVAL_PUBLIC_REPORT_FILE: reportFile },
  });
  await browser.goto("/case-study");
  await waitFor(() => browser.contains("评测尚未完成"), 60_000);
  assert.equal(await browser.contains("通过率："), false);

  const base = {
    mode: "fixture",
    generatedAt: "2026-09-06T00:00:00Z",
    model: "deepseek-v4-pro",
    responseVersion: "fixtures-v1",
    caseCount: 1,
    sampleCount: 1,
    successRate: 1,
    averageSoftScore: 88,
    criticalFailureCount: 0,
    gate: { passed: true, reasons: [] },
    runs: [{ caseId: "eval-pass", repeat: 1, passed: true, criticalFailures: [], codes: [] }],
  };
  await writeFile(reportPath, JSON.stringify(base));
  await browser.goto("/case-study");
  await waitFor(() => browser.contains("通过率：100.0%"), 60_000);
  assert.ok(await browser.contains("本报告没有失败样本"));

  await writeFile(reportPath, JSON.stringify({
    ...base,
    successRate: 0,
    criticalFailureCount: 1,
    gate: { passed: false, reasons: ["critical"] },
    runs: [{ caseId: "eval-failed", repeat: 1, passed: false, criticalFailures: ["hidden_critical_conflict"], codes: [] }],
  }));
  await browser.goto("/case-study");
  await waitFor(() => browser.contains("eval-failed / 第 1 次"), 60_000);
  assert.ok(await browser.contains("hidden_critical_conflict"));
  assert.equal(await browser.contains("服务提供方"), false);
});
