import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_DEEPSEEK_KEY_VALIDATION_TIMEOUT_MS,
  deepSeekKeyValidationTimeoutMs,
} from "../../src/providers/deepseek/key-validator.ts";
import {
  DEEPSEEK_KEY_FAILURE_MESSAGES,
  describeDeepSeekKeyFailure,
} from "../../src/providers/deepseek/key-validation-public.ts";
import { loadFeatureFlags } from "../../src/config/features.ts";
import { localGenerationReadiness } from "../../src/config/generation-readiness.ts";
import {
  DEFAULT_DEEPSEEK_RESPONSE_TIMEOUT_MS,
  deepSeekResponseTimeoutMs,
} from "../../src/providers/deepseek/responses-client.ts";
import {
  DEFAULT_PLANNING_TASK_TIMEOUT_MS,
  planningErrorCode,
  planningTaskTimeoutMs,
} from "../../src/jobs/executor.ts";
import { DeepSeekResponseError } from "../../src/providers/deepseek/responses-client.ts";
import { SkeletonPlanningError } from "../../src/agent/skeleton.ts";

test("public Key errors distinguish every stable failure without using upstream text", () => {
  const cases = [
    [401, "invalid_key"],
    [402, "quota_or_permission"],
    [403, "quota_or_permission"],
    [429, "rate_limited"],
    [400, "invalid_request"],
    [422, "invalid_request"],
    [504, "timeout"],
    [503, "network_error"],
    [502, "upstream_error"],
  ] as const;
  for (const [status, code] of cases) {
    const result = describeDeepSeekKeyFailure(status, {
      code,
      message: "sensitive upstream detail",
    });
    assert.equal(result.code, code);
    assert.equal(result.message, DEEPSEEK_KEY_FAILURE_MESSAGES[code]);
    assert.doesNotMatch(result.message, /sensitive|upstream detail/i);
  }
  assert.deepEqual(describeDeepSeekKeyFailure(429, { code: "RATE_LIMITED" }), {
    code: "RATE_LIMITED",
    message: DEEPSEEK_KEY_FAILURE_MESSAGES.RATE_LIMITED,
  });
  assert.equal(
    describeDeepSeekKeyFailure(429, { raw: "unknown" }).code,
    "RATE_LIMITED",
  );
});

test("Key validation timeout has a safe configurable server default", () => {
  assert.equal(
    deepSeekKeyValidationTimeoutMs({}),
    DEFAULT_DEEPSEEK_KEY_VALIDATION_TIMEOUT_MS,
  );
  assert.equal(
    deepSeekKeyValidationTimeoutMs({
      DEEPSEEK_KEY_VALIDATION_TIMEOUT_MS: "45000",
    }),
    45_000,
  );
  for (const value of ["999", "120001", "not-a-number", "1.5"])
    assert.equal(
      deepSeekKeyValidationTimeoutMs({
        DEEPSEEK_KEY_VALIDATION_TIMEOUT_MS: value,
      }),
      DEFAULT_DEEPSEEK_KEY_VALIDATION_TIMEOUT_MS,
    );
});

test("formal response and complete planning deadlines are independently bounded", () => {
  assert.equal(
    deepSeekResponseTimeoutMs({}),
    DEFAULT_DEEPSEEK_RESPONSE_TIMEOUT_MS,
  );
  assert.equal(
    deepSeekResponseTimeoutMs({ DEEPSEEK_RESPONSE_TIMEOUT_MS: "240000" }),
    240_000,
  );
  for (const value of ["29999", "600001", "Infinity", "1.5"])
    assert.equal(
      deepSeekResponseTimeoutMs({ DEEPSEEK_RESPONSE_TIMEOUT_MS: value }),
      DEFAULT_DEEPSEEK_RESPONSE_TIMEOUT_MS,
    );

  assert.equal(planningTaskTimeoutMs({}), DEFAULT_PLANNING_TASK_TIMEOUT_MS);
  assert.equal(
    planningTaskTimeoutMs({ PLANNING_TASK_TIMEOUT_MS: "1200000" }),
    1_200_000,
  );
  for (const value of ["59999", "1800001", "NaN", "1.5"])
    assert.equal(
      planningTaskTimeoutMs({ PLANNING_TASK_TIMEOUT_MS: value }),
      DEFAULT_PLANNING_TASK_TIMEOUT_MS,
    );
});

test("planning failures retain safe actionable provider and schema codes", () => {
  assert.equal(
    planningErrorCode(
      new DeepSeekResponseError(
        "incomplete_response",
        true,
        "private provider detail",
      ),
    ),
    "DEEPSEEK_INCOMPLETE_RESPONSE",
  );
  assert.equal(
    planningErrorCode(
      new SkeletonPlanningError("INVALID_SKELETON", "private parse detail"),
    ),
    "INVALID_SKELETON",
  );
  assert.equal(
    planningErrorCode(new Error("private upstream response")),
    "STAGE_FAILED",
  );
});

test("real local generation requires custom generation, Amap, its Key and search", () => {
  const flags = (values: Record<string, string>) => loadFeatureFlags(values);
  const code = (
    result: ReturnType<typeof localGenerationReadiness>,
  ): string | undefined => (result.ready ? undefined : result.code);
  assert.equal(code(localGenerationReadiness(flags({}), {})), "GENERATION_DISABLED");
  assert.equal(
    code(
      localGenerationReadiness(
        flags({ FEATURE_CUSTOM_GENERATION: "true" }),
        {},
      ),
    ),
    "AMAP_DISABLED",
  );
  assert.equal(
    code(
      localGenerationReadiness(
        flags({ FEATURE_CUSTOM_GENERATION: "true", FEATURE_AMAP: "true" }),
        {},
      ),
    ),
    "AMAP_KEY_MISSING",
  );
  assert.equal(
    code(
      localGenerationReadiness(
        flags({ FEATURE_CUSTOM_GENERATION: "true", FEATURE_AMAP: "true" }),
        { AMAP_WEB_SERVICE_KEY: "server-side-only" },
      ),
    ),
    "WEB_SEARCH_DISABLED",
  );
  assert.deepEqual(
    localGenerationReadiness(
      flags({
        FEATURE_CUSTOM_GENERATION: "true",
        FEATURE_AMAP: "true",
        FEATURE_WEB_SEARCH: "true",
      }),
      { AMAP_WEB_SERVICE_KEY: "server-side-only" },
    ),
    { ready: true },
  );
});
