import { analyticsApi } from "../../../analytics/runtime.ts";
import { withGuard } from "../../../security/guard-runtime.ts";
export const runtime = "nodejs";
export async function POST(request: Request) {
  return withGuard("analytics", request, () => analyticsApi().ingest(request));
}
