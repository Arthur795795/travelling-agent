import { DeepSeekResponsesClient } from "../providers/deepseek/responses-client.ts";
import type { StageHandlers } from "../jobs/executor.ts";
import { PLANNING_STAGES } from "../jobs/lifecycle.ts";
import { localReplan } from "./replan.ts";
export function replanPipeline(
  client = new DeepSeekResponsesClient(),
): StageHandlers {
  return Object.fromEntries(
    PLANNING_STAGES.map((stage) => [
      stage,
      {
        requiresKey: stage === "repair",
        run: async (ctx: Parameters<StageHandlers[typeof stage]["run"]>[0]) => {
          if (stage !== "repair") return {};
          if (!ctx.state.replan) throw new Error("REPLAN_MISSING");
          const result = await localReplan(
            ctx.state.replan.base,
            ctx.state.replan.change,
            (request, round) =>
              ctx.once(
                `local:${round}`,
                request,
                () =>
                  client.createResponse(ctx.secret(), {
                    ...request,
                    signal: ctx.signal,
                  }),
                (response) => [
                  {
                    type: "model",
                    payer: "visitor",
                    estimatedCostCny: response.estimatedCostCny,
                    inputTokens: response.usage.inputTokens,
                    outputTokens: response.usage.outputTokens,
                  },
                  { type: "repair" },
                ],
              ),
          );
          return {
            trip: result.trip,
            issues: result.issues,
            choices: result.choices,
          };
        },
      },
    ]),
  ) as StageHandlers;
}
