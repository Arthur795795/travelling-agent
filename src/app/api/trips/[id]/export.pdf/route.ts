import { exportHttp } from "../../../../../exports/http.ts";
import { loadFeatureFlags } from "../../../../../config/features.ts";
export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return exportHttp(() => loadFeatureFlags().export)(
    request,
    (await context.params).id,
    "pdf",
  );
}
