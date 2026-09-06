import assert from "node:assert/strict";
import test from "node:test";
import {
  canOpenExperience,
  loadFeatureFlags,
  requireFeature,
} from "../../src/config/features.ts";
import {
  canStartNewGeneration,
  DEFAULT_BUDGET_POLICY,
  evaluateOwnerMonthlyCost,
  evaluateUsage,
  recordUsage,
} from "../../src/domain/usage.ts";

const baseUsage = {
  steps: 0,
  searchCalls: 0,
  repairRounds: 0,
  outputTokens: 0,
  visitorModelCostCny: 0,
  productCostCny: 0,
};

test("features default off and only explicit true enables them", () => {
  const defaults = loadFeatureFlags({});
  assert.equal(
    Object.values(defaults).every((value) => value === false),
    true,
  );
  const enabled = loadFeatureFlags({
    FEATURE_CUSTOM_GENERATION: "TRUE",
    FEATURE_SHARING: "false",
  });
  assert.deepEqual(requireFeature(enabled, "customGeneration"), {
    enabled: true,
  });
  assert.deepEqual(requireFeature(enabled, "sharing"), {
    enabled: false,
    code: "FEATURE_DISABLED",
  });
  assert.deepEqual(canOpenExperience(defaults, "fixed_demo"), {
    allowed: true,
  });
  assert.deepEqual(canOpenExperience(defaults, "existing_trip"), {
    allowed: true,
  });
  assert.deepEqual(canOpenExperience(defaults, "new_generation"), {
    allowed: false,
    code: "FEATURE_DISABLED",
  });
});

test("per-plan limits stop hard overages and warn at the soft model-cost limit", () => {
  assert.equal(DEFAULT_BUDGET_POLICY.maxOutputTokens, 64_000);
  assert.deepEqual(evaluateUsage(baseUsage), { allowed: true });
  assert.deepEqual(evaluateUsage({ ...baseUsage, visitorModelCostCny: 2 }), {
    allowed: true,
    warning: "VISITOR_COST_SOFT_LIMIT",
  });
  assert.deepEqual(evaluateUsage({ ...baseUsage, visitorModelCostCny: 5 }), {
    allowed: false,
    code: "VISITOR_COST_HARD_LIMIT",
  });
  assert.deepEqual(
    evaluateUsage({ ...baseUsage, steps: DEFAULT_BUDGET_POLICY.maxSteps }),
    { allowed: false, code: "STEP_LIMIT" },
  );
  assert.deepEqual(
    evaluateUsage({
      ...baseUsage,
      searchCalls: DEFAULT_BUDGET_POLICY.maxSearchCalls,
    }),
    { allowed: false, code: "SEARCH_LIMIT" },
  );
  assert.deepEqual(
    evaluateUsage({
      ...baseUsage,
      repairRounds: DEFAULT_BUDGET_POLICY.maxRepairRounds,
    }),
    { allowed: false, code: "REPAIR_LIMIT" },
  );
  assert.deepEqual(
    evaluateUsage({
      ...baseUsage,
      outputTokens: DEFAULT_BUDGET_POLICY.maxOutputTokens,
    }),
    { allowed: false, code: "TOKEN_LIMIT" },
  );
});

test("owner product costs use separate 300/500 CNY thresholds", () => {
  assert.equal(evaluateOwnerMonthlyCost(299.99), "normal");
  assert.equal(evaluateOwnerMonthlyCost(300), "warning");
  assert.equal(evaluateOwnerMonthlyCost(500), "stopped");
  assert.deepEqual(evaluateUsage({ ...baseUsage, productCostCny: 999 }), {
    allowed: true,
  });
  const visitorModel = recordUsage(baseUsage, {
    type: "model",
    outputTokens: 100,
    estimatedCostCny: 1.2,
    payer: "visitor",
  });
  assert.equal(visitorModel.visitorModelCostCny, 1.2);
  assert.equal(visitorModel.productCostCny, 0);
  const productSearch = recordUsage(visitorModel, {
    type: "search",
    productCostCny: 0.02,
  });
  assert.equal(productSearch.productCostCny, 0.02);
  assert.deepEqual(canStartNewGeneration(true, 500), {
    allowed: false,
    code: "PRODUCT_BUDGET_STOP",
  });
  assert.deepEqual(canStartNewGeneration(false, 0), {
    allowed: false,
    code: "GENERATION_DISABLED",
  });
  assert.deepEqual(canStartNewGeneration(true, 499.99), { allowed: true });
  assert.throws(
    () => recordUsage(baseUsage, { type: "product_cost", amountCny: -1 }),
    RangeError,
  );
});

test("rejects malformed snapshots, fractional counters, and invalid policies", () => {
  assert.throws(
    () =>
      recordUsage(
        { ...baseUsage, productCostCny: Number.NaN },
        { type: "step" },
      ),
    RangeError,
  );
  assert.throws(
    () => recordUsage(baseUsage, { type: "search", count: 0.5 }),
    RangeError,
  );
  assert.throws(
    () =>
      recordUsage(baseUsage, {
        type: "model",
        outputTokens: 1.5,
        estimatedCostCny: 0,
        payer: "visitor",
      }),
    RangeError,
  );
  assert.throws(() => evaluateUsage({ ...baseUsage, steps: -1 }), RangeError);
  assert.throws(
    () => evaluateOwnerMonthlyCost(Number.POSITIVE_INFINITY),
    RangeError,
  );
  assert.throws(
    () =>
      evaluateUsage(baseUsage, {
        ...DEFAULT_BUDGET_POLICY,
        visitorModelCostSoftCny: 6,
        visitorModelCostHardCny: 5,
      }),
    RangeError,
  );
});
