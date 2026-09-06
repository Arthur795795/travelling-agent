export interface BudgetPolicy {
  maxSteps: number;
  maxSearchCalls: number;
  maxRepairRounds: number;
  maxOutputTokens: number;
  visitorModelCostSoftCny: number;
  visitorModelCostHardCny: number;
  ownerMonthlyWarnCny: number;
  ownerMonthlyStopCny: number;
}

export const DEFAULT_BUDGET_POLICY: BudgetPolicy = {
  maxSteps: 12,
  maxSearchCalls: 10,
  maxRepairRounds: 2,
  // V4 Pro counts hidden reasoning inside output usage. The bounded calls in
  // the seven-stage pipeline can total up to 56k without exceeding this cap.
  maxOutputTokens: 64_000,
  visitorModelCostSoftCny: 2,
  visitorModelCostHardCny: 5,
  ownerMonthlyWarnCny: 300,
  ownerMonthlyStopCny: 500,
};

export interface UsageSnapshot {
  steps: number;
  searchCalls: number;
  repairRounds: number;
  outputTokens: number;
  visitorModelCostCny: number;
  productCostCny: number;
}

export type UsageEvent =
  | { type: "step"; count?: number }
  | { type: "search"; count?: number; productCostCny?: number }
  | { type: "repair"; count?: number }
  | {
      type: "model";
      inputTokens?: number;
      outputTokens: number;
      estimatedCostCny: number;
      payer: "visitor" | "product";
    }
  | { type: "product_cost"; amountCny: number };

function assertNonNegativeFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError(`${field} must be a non-negative finite number`);
}

function assertNonNegativeInteger(value: number, field: string): void {
  assertNonNegativeFinite(value, field);
  if (!Number.isSafeInteger(value))
    throw new RangeError(`${field} must be a non-negative safe integer`);
}

function assertUsageSnapshot(usage: UsageSnapshot): void {
  assertNonNegativeInteger(usage.steps, "usage steps");
  assertNonNegativeInteger(usage.searchCalls, "usage search calls");
  assertNonNegativeInteger(usage.repairRounds, "usage repair rounds");
  assertNonNegativeInteger(usage.outputTokens, "usage output tokens");
  assertNonNegativeFinite(
    usage.visitorModelCostCny,
    "usage visitor model cost",
  );
  assertNonNegativeFinite(usage.productCostCny, "usage product cost");
}

function assertBudgetPolicy(policy: BudgetPolicy): void {
  assertNonNegativeInteger(policy.maxSteps, "policy max steps");
  assertNonNegativeInteger(policy.maxSearchCalls, "policy max search calls");
  assertNonNegativeInteger(policy.maxRepairRounds, "policy max repair rounds");
  assertNonNegativeInteger(policy.maxOutputTokens, "policy max output tokens");
  assertNonNegativeFinite(
    policy.visitorModelCostSoftCny,
    "policy visitor soft cost",
  );
  assertNonNegativeFinite(
    policy.visitorModelCostHardCny,
    "policy visitor hard cost",
  );
  assertNonNegativeFinite(
    policy.ownerMonthlyWarnCny,
    "policy owner warning cost",
  );
  assertNonNegativeFinite(policy.ownerMonthlyStopCny, "policy owner stop cost");
  if (policy.visitorModelCostSoftCny > policy.visitorModelCostHardCny)
    throw new RangeError("Visitor soft limit must not exceed hard limit");
  if (policy.ownerMonthlyWarnCny > policy.ownerMonthlyStopCny)
    throw new RangeError("Owner warning limit must not exceed stop limit");
}

export function recordUsage(
  current: UsageSnapshot,
  event: UsageEvent,
): UsageSnapshot {
  assertUsageSnapshot(current);
  const next = { ...current };
  switch (event.type) {
    case "step":
      assertNonNegativeInteger(event.count ?? 1, "step count");
      next.steps += event.count ?? 1;
      break;
    case "search":
      assertNonNegativeInteger(event.count ?? 1, "search count");
      assertNonNegativeFinite(event.productCostCny ?? 0, "search product cost");
      next.searchCalls += event.count ?? 1;
      next.productCostCny += event.productCostCny ?? 0;
      break;
    case "repair":
      assertNonNegativeInteger(event.count ?? 1, "repair count");
      next.repairRounds += event.count ?? 1;
      break;
    case "model":
      assertNonNegativeInteger(event.inputTokens ?? 0, "model input tokens");
      assertNonNegativeInteger(event.outputTokens, "model output tokens");
      assertNonNegativeFinite(event.estimatedCostCny, "model estimated cost");
      next.outputTokens += event.outputTokens;
      if (event.payer === "visitor")
        next.visitorModelCostCny += event.estimatedCostCny;
      else next.productCostCny += event.estimatedCostCny;
      break;
    case "product_cost":
      assertNonNegativeFinite(event.amountCny, "product cost");
      next.productCostCny += event.amountCny;
      break;
  }
  assertUsageSnapshot(next);
  return next;
}

export type UsageDecision =
  | { allowed: true; warning?: "VISITOR_COST_SOFT_LIMIT" }
  | {
      allowed: false;
      code:
        | "STEP_LIMIT"
        | "SEARCH_LIMIT"
        | "REPAIR_LIMIT"
        | "TOKEN_LIMIT"
        | "VISITOR_COST_HARD_LIMIT";
    };

export function evaluateUsage(
  usage: UsageSnapshot,
  policy = DEFAULT_BUDGET_POLICY,
): UsageDecision {
  assertUsageSnapshot(usage);
  assertBudgetPolicy(policy);
  if (usage.steps >= policy.maxSteps)
    return { allowed: false, code: "STEP_LIMIT" };
  if (usage.searchCalls >= policy.maxSearchCalls)
    return { allowed: false, code: "SEARCH_LIMIT" };
  if (usage.repairRounds >= policy.maxRepairRounds)
    return { allowed: false, code: "REPAIR_LIMIT" };
  if (usage.outputTokens >= policy.maxOutputTokens)
    return { allowed: false, code: "TOKEN_LIMIT" };
  if (usage.visitorModelCostCny >= policy.visitorModelCostHardCny)
    return { allowed: false, code: "VISITOR_COST_HARD_LIMIT" };
  if (usage.visitorModelCostCny >= policy.visitorModelCostSoftCny)
    return { allowed: true, warning: "VISITOR_COST_SOFT_LIMIT" };
  return { allowed: true };
}

export function evaluateOwnerMonthlyCost(
  productCostCny: number,
  policy = DEFAULT_BUDGET_POLICY,
): "normal" | "warning" | "stopped" {
  assertNonNegativeFinite(productCostCny, "owner monthly product cost");
  assertBudgetPolicy(policy);
  if (productCostCny >= policy.ownerMonthlyStopCny) return "stopped";
  if (productCostCny >= policy.ownerMonthlyWarnCny) return "warning";
  return "normal";
}

export function canStartNewGeneration(
  customGenerationEnabled: boolean,
  ownerMonthlyProductCostCny: number,
  policy = DEFAULT_BUDGET_POLICY,
):
  | { allowed: true }
  | { allowed: false; code: "GENERATION_DISABLED" | "PRODUCT_BUDGET_STOP" } {
  if (!customGenerationEnabled)
    return { allowed: false, code: "GENERATION_DISABLED" };
  if (
    evaluateOwnerMonthlyCost(ownerMonthlyProductCostCny, policy) === "stopped"
  ) {
    return { allowed: false, code: "PRODUCT_BUDGET_STOP" };
  }
  return { allowed: true };
}
