import { beijingDemo, DEMO_SCENARIOS } from "../../../../demo/beijing.ts";
export const dynamic = "force-static";
export function GET() {
  return Response.json(
    { trip: beijingDemo(), scenarios: DEMO_SCENARIOS },
    {
      headers: {
        "Cache-Control": "public, max-age=3600",
        "X-Demo-Mode": "fixed-no-network",
      },
    },
  );
}
