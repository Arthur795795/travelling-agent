import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPublicEvaluationReport } from "../../src/evaluation/public-report.ts";

test("public report handles missing, passing and failed evidence without inventing metrics", async () => {
  const dir = mkdtempSync(join(tmpdir(), "public-eval-"));
  try {
    assert.equal((await loadPublicEvaluationReport(join(dir, "missing.json"))).status, "not_completed");
    const base = { mode: "fixture", generatedAt: "2026-09-06T00:00:00Z", model: "deepseek-v4-pro", responseVersion: "v1", caseCount: 1, sampleCount: 1, successRate: 1, averageSoftScore: 90, criticalFailureCount: 0, gate: { passed: true, reasons: [] }, runs: [{ caseId: "eval-a", repeat: 1, passed: true, criticalFailures: [], codes: [] }] };
    const path = join(dir, "report.json");
    writeFileSync(path, JSON.stringify(base));
    const passing = await loadPublicEvaluationReport(path);
    assert.equal(passing.status, "available");
    if (passing.status === "available") assert.equal(passing.failedRuns.length, 0);
    writeFileSync(path, JSON.stringify({ ...base, successRate: 0, criticalFailureCount: 1, gate: { passed: false, reasons: ["critical"] }, runs: [{ ...base.runs[0], passed: false, criticalFailures: ["fabricated_evidence"] }] }));
    const failed = await loadPublicEvaluationReport(path);
    assert.equal(failed.status, "available");
    if (failed.status === "available") assert.equal(failed.failedRuns.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
