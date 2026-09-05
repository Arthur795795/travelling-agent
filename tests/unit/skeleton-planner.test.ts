import assert from "node:assert/strict";
import test from "node:test";
import {
  SKELETON_JSON_SCHEMA,
  SkeletonPlanner,
  SkeletonPlanningError,
  type SkeletonModelClient,
} from "../../src/agent/skeleton.ts";
import type {
  DeepSeekResponseRequest,
  DeepSeekResponseResult,
} from "../../src/providers/deepseek/responses-client.ts";
import { TransientSecret } from "../../src/security/secrets.ts";
import { buildTripFixture } from "../fixtures/trip.ts";

const now = () => new Date("2026-09-05T10:00:00+08:00");

function skeletonText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    days: ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"].map(
      (date, index) => ({
        date,
        morning:
          index === 0
            ? null
            : {
                theme: "历史文化",
                candidateAreas: ["中轴线区域"],
                rationale: "按区域组织候选，具体地点待核验。",
              },
        afternoon:
          index === 3
            ? null
            : {
                theme: "城市漫步",
                candidateAreas: ["核心城区"],
                rationale: "保持适中密度和留白。",
              },
        transportWindows: [],
      }),
    ),
    evidenceRequests: [
      {
        id: "req-place",
        subjectRef: "day-1",
        date: "2026-10-01",
        field: "place_details",
        query: "候选地点详情",
        critical: true,
        status: "pending",
      },
      {
        id: "req-rules",
        subjectRef: "day-1",
        date: "2026-10-01",
        field: "reservation_rules",
        query: "预约规则",
        critical: true,
        status: "pending",
      },
      {
        id: "req-route",
        subjectRef: "day-2",
        date: "2026-10-02",
        field: "route",
        query: "区域间路线",
        critical: true,
        status: "pending",
      },
      {
        id: "req-weather",
        subjectRef: "trip",
        date: "2026-10-01",
        field: "weather",
        query: "北京天气",
        critical: false,
        status: "pending",
      },
      {
        id: "req-cost",
        subjectRef: "trip",
        field: "cost",
        query: "活动与交通费用",
        critical: false,
        status: "pending",
      },
    ],
    assumptions: ["候选区域尚未完成事实核验"],
    ...overrides,
  });
}

function model(
  outputText: string,
  inspect?: (request: DeepSeekResponseRequest) => void,
): SkeletonModelClient {
  return {
    async createResponse(_secret, request) {
      inspect?.(request);
      return {
        responseId: "response-1",
        status: "completed",
        model: "deepseek-v4-pro",
        outputText,
        functionCalls: [],
        webSearchCalls: [],
        citations: [],
        events: [],
        usage: {
          inputTokens: 100,
          cachedInputTokens: 0,
          outputTokens: 200,
          reasoningTokens: 50,
          totalTokens: 300,
        },
        estimatedCostCny: 0.02,
      } satisfies DeepSeekResponseResult;
    },
  };
}

test("produces a four-day pending-evidence skeleton and deterministically places locked bookings", async () => {
  const trip = buildTripFixture();
  trip.brief.party = {
    adults: 2,
    childrenAgeBands: ["7-12"],
    seniors: 0,
    mobilityNotes: [],
  };
  trip.brief.bookedItems = [
    {
      id: "hotel-1",
      type: "hotel",
      title: "已订酒店",
      start: "2026-10-01T15:00:00+08:00",
      end: "2026-10-04T12:00:00+08:00",
      locked: true,
      source: "user",
    },
    {
      id: "flight-late",
      type: "flight",
      title: "晚间抵达航班",
      start: "2026-10-01T21:30:00+08:00",
      end: "2026-10-01T23:30:00+08:00",
      locked: true,
      source: "user",
    },
  ];
  const lateArrivalSkeleton = JSON.parse(skeletonText()) as {
    days: Array<Record<string, unknown>>;
  };
  lateArrivalSkeleton.days[0] = {
    ...lateArrivalSkeleton.days[0],
    morning: null,
    afternoon: null,
  };
  let requestInput = "";
  const result = await new SkeletonPlanner(
    model(JSON.stringify(lateArrivalSkeleton), (request) => {
      requestInput = String(request.input);
    }),
    now,
  ).plan(new TransientSecret("sk-skeleton-0123456789abcdef"), trip.brief);
  assert.equal(result.skeleton.days.length, 4);
  assert.equal(result.model, "deepseek-v4-pro");
  assert.equal(result.stageResult.stage, "skeleton_planning");
  assert.equal(result.stageResult.estimatedCostCny, 0.02);
  assert.match(requestInput, /7-12/);
  assert.deepEqual(
    result.skeleton.days[0].lockedBookings.map(({ id }) => id).sort(),
    ["flight-late", "hotel-1"],
  );
  assert.equal(
    result.skeleton.days[1].lockedBookings.some(({ id }) => id === "hotel-1"),
    true,
  );
  assert.equal(
    result.skeleton.days[1].lockedBookings.some(
      ({ id }) => id === "flight-late",
    ),
    false,
  );
  assert.equal(result.skeleton.days[0].morning, null);
  assert.equal(result.skeleton.days[0].afternoon, null);
  assert.equal(
    result.skeleton.evidenceRequests.every(
      ({ status }) => status === "pending",
    ),
    true,
  );
  assert.equal(
    result.skeleton.evidenceRequests.some(({ field }) => field === "cost"),
    true,
  );
  assert.equal(JSON.stringify(result.skeleton).includes("amount"), false);
});

test("rejects malformed dates, model JSON, and claims of verified inventory", async () => {
  const brief = buildTripFixture().brief;
  const cases: Array<[string, SkeletonPlanningError["code"]]> = [
    ["not-json", "INVALID_MODEL_JSON"],
    [
      skeletonText({ days: JSON.parse(skeletonText()).days.slice(0, 3) }),
      "INVALID_SKELETON",
    ],
    [
      skeletonText({ assumptions: ["已核验实时余票充足"] }),
      "UNSAFE_FACT_CLAIM",
    ],
    [
      skeletonText({
        evidenceRequests: [JSON.parse(skeletonText()).evidenceRequests[0]],
      }),
      "INVALID_SKELETON",
    ],
  ];
  for (const [output, code] of cases) {
    await assert.rejects(
      () =>
        new SkeletonPlanner(model(output), now).plan(
          new TransientSecret("sk-skeleton-0123456789abcdef"),
          brief,
        ),
      (error: unknown) =>
        error instanceof SkeletonPlanningError && error.code === code,
    );
  }
});

test("publishes a complete structured-output schema for model-side validation", () => {
  const days = SKELETON_JSON_SCHEMA.properties as Record<
    string,
    Record<string, unknown>
  >;
  assert.ok(days.days.items);
  assert.ok(days.evidenceRequests.items);
  assert.ok(SKELETON_JSON_SCHEMA.$defs);
});
