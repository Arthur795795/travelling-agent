import assert from "node:assert/strict";
import test from "node:test";
import { executeFixedCase } from "../../../src/evaluation/fixture-executor.ts";
import { evaluationMarkdown } from "../../../src/evaluation/report.ts";
import { runEvaluation } from "../../../src/evaluation/runner.ts";
import {
  STANDARD_EVALUATION_CASES,
  STANDARD_THEME_COVERAGE,
  CORE_MODEL_SMOKE_CASES,
} from "../../../src/evaluation/standard-cases.ts";

const fixed = () => new Date("2026-09-06T00:00:00Z");

test("fixed evaluator is deterministic and critical failures override soft scores", async () => {
  const options = {
    cases: [STANDARD_EVALUATION_CASES[0]],
    repeats: 2,
    model: "deepseek-v4-pro",
    responseVersion: "fixture-v1",
    seed: "fixed",
    now: fixed,
    execute: executeFixedCase,
  };
  assert.deepEqual(await runEvaluation(options), await runEvaluation(options));
  const failed = await runEvaluation({
    ...options,
    repeats: 1,
    execute: async (item) => ({
      ...(await executeFixedCase(item)),
      completed: true,
      fabricatedEvidence: true,
      scores: {
        personalization: 100,
        routeEfficiency: 100,
        executableCompleteness: 100,
        budgetQuality: 100,
        explanationAndEvidence: 100,
      },
    }),
  });
  assert.equal(failed.gate.passed, false);
  assert.equal(failed.criticalFailureCount, 1);
  assert.match(evaluationMarkdown(failed), /fabricated_evidence/);
});

test("twelve offline cases have complete tool references and theme coverage", async () => {
  assert.equal(STANDARD_EVALUATION_CASES.length, 12);
  assert.equal(CORE_MODEL_SMOKE_CASES.length, 5);
  assert.equal(
    STANDARD_EVALUATION_CASES.filter((item) => item.city === "北京").length,
    8,
  );
  const themes = new Set(STANDARD_EVALUATION_CASES.flatMap((item) => item.themes));
  for (const theme of STANDARD_THEME_COVERAGE) assert.ok(themes.has(theme));
  for (const item of STANDARD_EVALUATION_CASES) {
    assert.ok(item.tools.places.length);
    assert.ok(item.tools.routes.length);
    assert.ok(item.tools.weather.length);
    assert.ok(item.tools.official.length);
    assert.ok(item.tools.platform.length);
    assert.doesNotMatch(JSON.stringify(item), /1[3-9]\d{9}|身份证|旅客姓名/);
  }
  const smoke = await runEvaluation({
    cases: STANDARD_EVALUATION_CASES,
    repeats: 1,
    model: "deepseek-v4-pro",
    responseVersion: "fixtures-v1",
    seed: "smoke",
    now: fixed,
    execute: executeFixedCase,
  });
  assert.equal(smoke.sampleCount, 12);
  assert.equal(smoke.gate.passed, true);
});
