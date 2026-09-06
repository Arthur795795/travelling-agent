import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measurePerformanceSample, performanceReport } from "../../src/evaluation/performance.ts";
import { observeModel, recordFullRegression, recordSmoke, regressionAllowsCustomGeneration, type RegressionState } from "../../src/evaluation/regression.ts";
import { openDatabase } from "../../src/persistence/database.ts";
import { liveness, readiness } from "../../src/operations/health.ts";
import { createRequestGuard } from "../../src/security/guard.ts";

test("performance thresholds and payer costs remain separate", () => {
  const samples = Array.from({ length: 20 }, (_, index) => ({ id: String(index), provider: "fixture" as const, firstProgressMs: 100 + index, terminalMs: 60_000 + index, terminalStatus: "completed" as const, inputTokens: 10, outputTokens: 20, visitorCostCny: 0.1, productCostCny: 0.01 }));
  const report = performanceReport(samples, 300);
  assert.equal(report.gate.passed, true);
  assert.equal(report.costs.visitorModelCny, 2);
  assert.equal(report.costs.productCny, 0.2);
  assert.equal(report.costs.monthlyStatus, "warning");
  const failed = performanceReport([{ ...samples[0], firstProgressMs: 2001, terminalMs: 181_000, terminalStatus: "completed" }], 500);
  assert.equal(failed.gate.passed, false);
  assert.equal(failed.costs.monthlyStatus, "stopped");
});

test("a fixed-delay provider records first progress and a terminal state", async () => {
  const sample = await measurePerformanceSample("fixed", "fixture", async (progress) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    progress();
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { terminalStatus: "completed", inputTokens: 10, outputTokens: 20, visitorCostCny: 0.1, productCostCny: 0.01 };
  });
  assert.ok(sample.firstProgressMs >= 4);
  assert.ok(sample.terminalMs >= sample.firstProgressMs);
  assert.equal(performanceReport([sample], 0).gate.passed, true);
});

test("model changes require five smoke cases and a passing 36-run restore", () => {
  const baseline: RegressionState = { schemaVersion: 1, lastPassedModel: "model-a", lastPassedAt: "2026-09-01T00:00:00Z", observedModel: "model-a", status: "passed", smokeSampleCount: 5, criticalFailureCount: 0, fullRegressionSampleCount: 36 };
  assert.equal(observeModel(baseline, "model-a"), baseline);
  const changed = observeModel(baseline, "model-b");
  assert.equal(changed.status, "regression_required");
  assert.equal(recordSmoke(changed, { sampleCount: 5, criticalFailureCount: 1 }).status, "smoke_failed");
  const cleanSmoke = recordSmoke(changed, { sampleCount: 5, criticalFailureCount: 0 });
  assert.equal(recordFullRegression(cleanSmoke, { sampleCount: 12, gatePassed: true, completedAt: "2026-09-06T00:00:00Z" }).status, "regression_required");
  assert.equal(recordFullRegression(cleanSmoke, { sampleCount: 36, gatePassed: true, completedAt: "2026-09-06T00:00:00Z" }).status, "passed");
  const dir = mkdtempSync(join(tmpdir(), "regression-state-"));
  const path = join(dir, "state.json");
  writeFileSync(path, JSON.stringify(changed));
  assert.equal(regressionAllowsCustomGeneration(path), false);
  const db = openDatabase();
  const previous = process.env.MODEL_REGRESSION_STATE_PATH;
  process.env.MODEL_REGRESSION_STATE_PATH = path;
  try {
    const guard = createRequestGuard({
      db,
      flags: () => ({ customGeneration: true, webSearch: true, amap: true, sharing: true, export: true, offlineReadonly: true }),
    });
    const decision = guard.check("planning_job", new Request("http://local"));
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.code, "MODEL_REGRESSION_REQUIRED");
    assert.equal(guard.check("sharing", new Request("http://local")).allowed, true);
  } finally {
    db.close();
    if (previous === undefined) delete process.env.MODEL_REGRESSION_STATE_PATH;
    else process.env.MODEL_REGRESSION_STATE_PATH = previous;
  }
  rmSync(dir, { recursive: true, force: true });
});

test("health distinguishes process life from database readiness", () => {
  assert.deepEqual(liveness(), { status: "alive" });
  const db = openDatabase();
  assert.equal(readiness(db).ready, true);
  db.close();
  assert.deepEqual(readiness(db), { ready: false, status: "not_ready", code: "DATABASE_UNAVAILABLE" });
});
