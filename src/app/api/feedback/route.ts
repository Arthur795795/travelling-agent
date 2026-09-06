import { feedbackApi } from "../../../analytics/runtime.ts";
import { withGuard } from "../../../security/guard-runtime.ts";
export const runtime = "nodejs";
export function GET() {
  return feedbackApi().purpose();
}
export async function POST(request: Request) {
  return withGuard("feedback", request, () => feedbackApi().create(request));
}
