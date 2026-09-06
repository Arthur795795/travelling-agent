import assert from "node:assert/strict";
import test from "node:test";
import { executeFixedCase } from "../../../src/evaluation/fixture-executor.ts";
import {
  liveEvaluationConfig,
  runLiveEvaluation,
} from "../../../src/evaluation/live.ts";
import { STANDARD_EVALUATION_CASES } from "../../../src/evaluation/standard-cases.ts";

test("live evaluation is off by default and needs both internal credentials", () => {
  assert.deepEqual(liveEvaluationConfig({}), {
    ready: false,
    code: "LIVE_EVAL_DISABLED",
  });
  assert.deepEqual(liveEvaluationConfig({ LIVE_EVAL_ENABLED: "true" }), {
    ready: false,
    code: "LIVE_EVAL_CREDENTIALS_MISSING",
  });
});

test("local simulated network enforces budget and strips URL credentials", async () => {
  const decision = liveEvaluationConfig({
    LIVE_EVAL_ENABLED: "true",
    INTERNAL_DEEPSEEK_EVAL_KEY: "internal-only-marker",
    AMAP_WEB_SERVICE_KEY: "product-only-marker",
    LIVE_EVAL_MAX_CASES: "2",
    LIVE_EVAL_MAX_COST_CNY: "0.05",
  });
  assert.equal(decision.ready, true);
  if (!decision.ready) return;
  let calls = 0;
  const result = await runLiveEvaluation({
    config: decision.config,
    cases: STANDARD_EVALUATION_CASES,
    model: "deepseek-v4-pro",
    responseVersion: "simulated-network-v1",
    now: () => new Date("2026-09-06T01:00:00Z"),
    execute: async (item, credentials) => {
      calls += 1;
      assert.equal(credentials.deepSeekKey, "internal-only-marker");
      const observation = await executeFixedCase(item);
      return {
        ...observation,
        steps: 2,
        sourceUrls: ["https://official.example/info?token=do-not-store&lang=zh"],
      };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "stopped");
  assert.equal(result.reason, "cost_limit");
  assert.doesNotMatch(JSON.stringify(result), /do-not-store|internal-only-marker|product-only-marker/);
  assert.match(result.sourceUrls[0], /lang=zh/);
});
