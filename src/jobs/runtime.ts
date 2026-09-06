import { applicationDatabase } from "../persistence/runtime.ts";
import { replanPipeline } from "../trips/replan-pipeline.ts";
import { PLANNING_STAGES } from "./lifecycle.ts";
import type { StageHandlers } from "./executor.ts";
import { ExecutionStore } from "./execution-store.ts";
import { PlanningExecutor } from "./executor.ts";
import { createPipeline } from "../agent/pipeline.ts";
import { createJobHttp } from "./http.ts";
import { loadFeatureFlags } from "../config/features.ts";
import { localGenerationReadiness } from "../config/generation-readiness.ts";
import { recordEvent } from "../analytics/runtime.ts";
import { recordProductSpend } from "../security/guard-runtime.ts";
function initialize() {
  const store = new ExecutionStore(applicationDatabase());
  const normal = createPipeline(),
    local = replanPipeline();
  const handlers = Object.fromEntries(
    PLANNING_STAGES.map((stage) => [
      stage,
      {
        requiresKey: stage === "repair" || normal[stage].requiresKey,
        run: (ctx: Parameters<StageHandlers[typeof stage]["run"]>[0]) =>
          (ctx.state.replan ? local : normal)[stage].run(ctx),
      },
    ]),
  ) as StageHandlers;
  const executor = new PlanningExecutor(
    store,
    handlers,
    undefined,
    undefined,
    (amountCny) => recordProductSpend(amountCny),
    (event) => recordEvent(event),
  );
  for (const id of store.recover()) void executor.run(id);
  const http = createJobHttp(
    store,
    executor,
    () => loadFeatureFlags().customGeneration,
    undefined,
    () => localGenerationReadiness(loadFeatureFlags()),
  );
  return { store, executor, http };
}
const globals = globalThis as typeof globalThis & {
  travelJobHttp?: ReturnType<typeof initialize>;
};
export function jobHttp() {
  return jobRuntime().http;
}
export function jobRuntime() {
  return (globals.travelJobHttp ??= initialize());
}
