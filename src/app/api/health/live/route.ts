import { liveness } from "../../../../operations/health.ts";

export const dynamic = "force-dynamic";
export function GET() {
  return Response.json(liveness(), { headers: { "Cache-Control": "no-store" } });
}
