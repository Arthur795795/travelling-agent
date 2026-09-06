import { changeHttp } from "../../../../../trips/http.ts";
import { jobRuntime } from "../../../../../jobs/runtime.ts";
import { loadFeatureFlags } from "../../../../../config/features.ts";
import { withGuard } from "../../../../../security/guard-runtime.ts";
import { decodePathSegment } from "../../../../../routing/path-segment.ts";
export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: encodedId } = await context.params;
  const id = decodePathSegment(encodedId);
  return withGuard("planning_job", request, () => {
    const r = jobRuntime();
    return changeHttp(
      r.store,
      r.executor,
      () => loadFeatureFlags().customGeneration,
    )(request, id, "replan");
  });
}
