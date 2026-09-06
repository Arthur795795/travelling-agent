import { jobHttp } from "../../../../../jobs/runtime.ts";
import { withGuard } from "../../../../../security/guard-runtime.ts";
export const runtime = "nodejs";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return withGuard("planning_job", request, () => jobHttp().resume(request, id));
}
