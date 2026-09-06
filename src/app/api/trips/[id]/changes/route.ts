import { changeHttp } from "../../../../../trips/http.ts";
import { jobRuntime } from "../../../../../jobs/runtime.ts";
import { decodePathSegment } from "../../../../../routing/path-segment.ts";
export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const r = jobRuntime();
  return changeHttp(r.store, r.executor)(
    request,
    decodePathSegment((await context.params).id),
    "changes",
  );
}
