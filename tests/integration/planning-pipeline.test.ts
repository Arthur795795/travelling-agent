import assert from "node:assert/strict";
import test from "node:test";
import { createPipeline } from "../../src/agent/pipeline.ts";
import { PlanningExecutor } from "../../src/jobs/executor.ts";
import { ExecutionStore } from "../../src/jobs/execution-store.ts";
import { openDatabase } from "../../src/persistence/database.ts";
import { TransientSecret } from "../../src/security/secrets.ts";
import { executableTrip } from "../fixtures/executable-trip.ts";

test("fixed providers complete the real seven-stage pipeline with bounded repairs and honest missing facts", async (t) => {
  const now = () => new Date("2026-09-05T00:00:00Z");
  const db = openDatabase();
  t.after(() => db.close());
  const store = new ExecutionStore(db, now);
  const brief = executableTrip().brief;
  const dates = ["2026-10-01", "2026-10-02", "2026-10-03"];
  const requests: string[] = [];
  const pipeline = createPipeline(
    {
      createResponse: async (secret, request) => {
        secret.clear();
        const context = JSON.parse(String(request.input));
        const isSkeleton = request.textFormat?.type === "json_schema";
        const output = isSkeleton
          ? {
              schemaVersion: 1,
              days: dates.map((date) => ({
                date,
                morning: {
                  theme: "历史文化",
                  candidateAreas: ["中心城区"],
                  rationale: "适中密度",
                },
                afternoon: null,
                transportWindows: [],
              })),
              evidenceRequests: [
                "place_details",
                "opening_hours",
                "route",
                "weather",
                "cost",
              ].map((field) => ({
                id: field,
                subjectRef: "center",
                field,
                query: "待取证",
                critical: true,
                status: "pending",
              })),
              assumptions: [],
            }
          : (context.trip ?? {
              days: dates.map((date, i) => ({
                date,
                notes: ["下午留白"],
                activities: [
                  {
                    id: `a-${i}`,
                    title: "候选景点",
                    keyword: "景点",
                    city: "北京",
                    start: `${date}T09:00:00+08:00`,
                    end: `${date}T11:00:00+08:00`,
                    durationMinutes: 120,
                    importance: "core",
                    rationale: "区域内活动",
                    fallbackKeyword: "附近公园",
                  },
                ],
              })),
            });
        requests.push(
          isSkeleton ? "skeleton" : context.trip ? "repair" : "enrichment",
        );
        return {
          responseId: `response-${requests.length}`,
          status: "completed",
          model: "deepseek-v4-pro",
          outputText: JSON.stringify(output),
          functionCalls: [],
          webSearchCalls: [],
          citations: [],
          events: [],
          usage: {
            inputTokens: 20,
            cachedInputTokens: 0,
            outputTokens: 50,
            reasoningTokens: 0,
            totalTokens: 70,
          },
          estimatedCostCny: 0.01,
        };
      },
    },
    (ctx) => (name, args, key, stage) =>
      ctx.once(key, { name, args }, async () => ({
        jobId: ctx.id,
        name,
        stage,
        callId: key,
        idempotencyKey: key,
        status: "blocked" as const,
        evidenceIds: [],
        durationMs: 0,
        usageEvents: [],
      })),
    now,
  );
  const executor = new PlanningExecutor(store, pipeline, now);
  const { job } = store.create(brief);
  await executor.run(job.id, new TransientSecret("sk-test-0123456789abcdef"));
  const view = store.view(job.id);
  assert.equal(
    view.status,
    "completed",
    view.errorCode ?? "pipeline should finish",
  );
  assert.equal(view.trip?.days.length, 3);
  assert.equal(view.trip?.lifecycleStatus, "blocked");
  assert.equal(view.trip?.budget.total.kind, "unknown");
  assert.equal(view.usage.steps, 7);
  assert.equal(view.usage.repairRounds, 2);
  assert.equal(view.usage.visitorModelCostCny, 0.04);
  assert.equal(view.metrics?.inputTokens, 80);
  assert.ok((view.metrics?.toolCalls ?? 0) > 0);
  assert.equal(view.choices.length, 2);
  assert.deepEqual(requests, ["skeleton", "enrichment", "repair", "repair"]);
  assert.ok(view.issues.some((i) => i.code === "PLACE_UNRESOLVED"));
  assert.doesNotMatch(JSON.stringify(store.state(job.id)), /sk-test/);
});
