import { jobHttp } from "../../../jobs/runtime.ts";
import { observe } from "../../../analytics/runtime.ts";
import { withGuard } from "../../../security/guard-runtime.ts";
export const runtime = "nodejs";
export async function POST(request: Request) {
  return withGuard("planning_job", request, () =>
    observe("job_started", () => jobHttp().create(request)),
  );
}
