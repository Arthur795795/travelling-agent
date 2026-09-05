import { changeHttp } from "../../../../../trips/http.ts";
import { jobRuntime } from "../../../../../jobs/runtime.ts";
import { loadFeatureFlags } from "../../../../../config/features.ts";
export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const r = jobRuntime();
  return changeHttp(
    r.store,
    r.executor,
    () => loadFeatureFlags().customGeneration,
  )(request, (await context.params).id, "replan");
}
