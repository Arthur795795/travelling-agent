import { z } from "zod";
import type { StageContext, StageHandlers } from "../jobs/executor.ts";
import { checkRequirements } from "../requirements/service.ts";
import { SkeletonPlanner } from "./skeleton.ts";
import {
  collectEvidence,
  completeRoutesAndBudget,
  EnrichmentPlanSchema,
  type ToolCaller,
} from "./enrichment.ts";
import { repairTrip } from "./repair.ts";
import { validateTrip } from "../validation/trip.ts";
import { AgentToolRegistry } from "./tools/registry.ts";
import {
  DeepSeekResponsesClient,
  type DeepSeekResponseRequest,
  type DeepSeekResponseResult,
} from "../providers/deepseek/responses-client.ts";
import { AmapClient } from "../providers/amap/client.ts";
import {
  AmapPlacesAdapter,
  registerAmapPlaceTools,
} from "../providers/amap/places.ts";
import {
  AmapRoutesAdapter,
  registerAmapRouteTool,
} from "../providers/amap/routes.ts";
import {
  AmapWeatherAdapter,
  registerAmapWeatherTool,
} from "../providers/amap/weather.ts";
import {
  OfficialPageEvidenceReader,
  registerSearchEvidenceTools,
} from "../search/source-evidence.ts";
import {
  PlatformLinkGenerator,
  registerPlatformLinkTool,
} from "../platform/links.ts";
import { loadFeatureFlags } from "../config/features.ts";
import { allowProductCall } from "../security/guard-runtime.ts";

export function createPipeline(
  client: Pick<
    DeepSeekResponsesClient,
    "createResponse"
  > = new DeepSeekResponsesClient(),
  toolFactory?: (ctx: StageContext) => ToolCaller,
  now = () => new Date(),
): StageHandlers {
  const model = (
    ctx: StageContext,
    key: string,
    request: DeepSeekResponseRequest,
  ) =>
    ctx.once(
      key,
      request,
      () =>
        client.createResponse(ctx.secret(), { ...request, signal: ctx.signal }),
      (r: DeepSeekResponseResult) => [
        {
          type: "model",
          inputTokens: r.usage.inputTokens,
          outputTokens: r.usage.outputTokens,
          estimatedCostCny: r.estimatedCostCny,
          payer: "visitor",
        },
        ...(key.startsWith("repair:") ? [{ type: "repair" as const }] : []),
      ],
    );
  const tools = (ctx: StageContext): ToolCaller => {
    if (toolFactory) return toolFactory(ctx);
    const flags = loadFeatureFlags();
    const registry = new AgentToolRegistry();
    const amap = new AmapClient();
    // Product-paid tools stay behind their feature flag *and* the shared daily
    // product quota; an exhausted quota blocks the tool instead of spending.
    const amapEnabled = () => flags.amap && allowProductCall("amap");
    registerAmapPlaceTools(registry, new AmapPlacesAdapter(amap), amapEnabled);
    registerAmapRouteTool(registry, new AmapRoutesAdapter(amap), amapEnabled);
    registerAmapWeatherTool(registry, new AmapWeatherAdapter(amap), amapEnabled);
    registerPlatformLinkTool(registry, new PlatformLinkGenerator());
    registerSearchEvidenceTools(
      registry,
      async (query, signal) =>
        client.createResponse(ctx.secret(), {
          instructions:
            "只搜索与查询直接相关的公开来源，简短概括并保留引用；不要输出详细推理。",
          input: query,
          tools: [{ type: "web_search" }],
          maxOutputTokens: 2_000,
          reasoningEffort: "low",
          signal,
        }),
      new OfficialPageEvidenceReader(),
      () => flags.webSearch && allowProductCall("search"),
    );
    return (name, args, key, stage) =>
      ctx.once(
        key,
        { name, args },
        () =>
          registry.invoke({
            jobId: ctx.id,
            stage,
            callId: key,
            idempotencyKey: key,
            name,
            arguments: args,
            // DeepSeek's server-side web search regularly needs more than the
            // generic 15s tool deadline; other tools retain the tighter cap.
            timeoutMs: name === "web_search" ? 60_000 : undefined,
            signal: ctx.signal,
          }),
        (r) => r.usageEvents,
      );
  };
  return {
    requirements_check: {
      requiresKey: false,
      run: async (ctx) => {
        const { schemaVersion: _, timeZone: __, ...input } = ctx.state.brief;
        void _;
        void __;
        if (checkRequirements(input, now).state !== "ready")
          throw new Error("REQUIREMENTS_INVALID");
        return {};
      },
    },
    skeleton_planning: {
      requiresKey: true,
      run: async (ctx) => {
        const planner = new SkeletonPlanner(
          {
            createResponse: async (secret, request) => {
              try {
                return await model(ctx, "skeleton", request);
              } finally {
                secret.clear();
              }
            },
          },
          now,
        );
        const result = await planner.plan(ctx.secret(), ctx.state.brief);
        return { skeleton: result.skeleton, model: result.model };
      },
    },
    evidence_collection: {
      requiresKey: true,
      run: async (ctx) => {
        if (!ctx.state.skeleton) throw new Error("SKELETON_MISSING");
        const response = await model(ctx, "enrichment_plan", {
          instructions:
            "把骨架转成候选活动 JSON。严格符合附带 Schema；每天上午和下午最多各一个核心活动，允许留白。仅提出地点查询和时间窗，不虚构证据。考虑锁定预订、儿童、老人和硬约束。" +
            JSON.stringify(z.toJSONSchema(EnrichmentPlanSchema)),
          input: JSON.stringify({
            brief: ctx.state.brief,
            skeleton: ctx.state.skeleton,
          }),
          textFormat: { type: "json_object" },
          maxOutputTokens: 8_000,
          reasoningEffort: "low",
        });
        const plan = EnrichmentPlanSchema.parse(
          JSON.parse(response.outputText),
        );
        return {
          trip: await collectEvidence(
            ctx.state.brief,
            ctx.state.skeleton,
            plan,
            tools(ctx),
            `trip:${ctx.id}`,
            now,
          ),
        };
      },
    },
    route_and_budget: {
      requiresKey: false,
      run: async (ctx) => {
        if (!ctx.state.trip) throw new Error("TRIP_MISSING");
        const trip = await completeRoutesAndBudget(
          ctx.state.trip,
          tools(ctx),
          now,
        );
        return { trip, baseline: trip };
      },
    },
    hard_validation: {
      requiresKey: false,
      run: async (ctx) => {
        if (!ctx.state.trip) throw new Error("TRIP_MISSING");
        return { issues: validateTrip(ctx.state.trip, ctx.state.baseline) };
      },
    },
    repair: {
      requiresKey: true,
      run: async (ctx) => {
        if (!ctx.state.trip) throw new Error("TRIP_MISSING");
        const result = await repairTrip(
          ctx.state.trip,
          async (trip, issues, round) => {
            const response = await model(ctx, `repair:${round}`, {
              instructions:
                "只输出修复后的完整 Trip JSON。仅调整问题涉及的日期；禁止修改 brief、锁定项目、evidence、claims，不得编造价格/库存/营业规则。无法修复时保持原状。",
              input: JSON.stringify({ trip, issues }),
              textFormat: { type: "json_object" },
              maxOutputTokens: 8_000,
              reasoningEffort: "low",
            });
            return JSON.parse(response.outputText);
          },
          ctx.state.baseline,
        );
        return {
          trip: result.trip,
          issues: result.issues,
          choices: result.choices,
        };
      },
    },
    finalization: {
      requiresKey: false,
      run: async (ctx) => {
        if (!ctx.state.trip) throw new Error("TRIP_MISSING");
        const issues = validateTrip(ctx.state.trip, ctx.state.baseline);
        const trip = {
          ...ctx.state.trip,
          alerts: [
            ...ctx.state.trip.alerts,
            ...issues
              .filter(
                (i) =>
                  i.severity === "blocking" &&
                  !ctx.state.trip!.alerts.some(
                    (a) =>
                      a.code === i.code &&
                      JSON.stringify(a.entityIds) ===
                        JSON.stringify(i.entityIds),
                  ),
              )
              .map((i) => ({
                id: `validation:${i.id}`.slice(0, 128),
                severity: "blocking" as const,
                code: i.code,
                message: i.message,
                entityIds: i.entityIds,
              })),
          ],
          lifecycleStatus: issues.some((i) => i.severity === "blocking")
            ? ("blocked" as const)
            : issues.length
              ? ("checked" as const)
              : ("executable" as const),
        };
        return { trip, issues };
      },
    },
  };
}
