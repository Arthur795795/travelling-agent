import { applicationDatabase } from "../../../../persistence/runtime.ts";
import { readiness } from "../../../../operations/health.ts";

export const dynamic = "force-dynamic";
export function GET() {
  const result = readiness(applicationDatabase());
  return Response.json(result, {
    status: result.ready ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
