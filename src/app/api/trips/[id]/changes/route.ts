import { changeHttp } from "../../../../../trips/http.ts";
import { jobRuntime } from "../../../../../jobs/runtime.ts";
export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const r = jobRuntime();
  return changeHttp(r.store, r.executor)(
    request,
    (await context.params).id,
    "changes",
  );
}
