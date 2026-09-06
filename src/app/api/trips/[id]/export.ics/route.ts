import { exportHttp } from "../../../../../exports/http.ts";
import { loadFeatureFlags } from "../../../../../config/features.ts";
import { observe } from "../../../../../analytics/runtime.ts";
import { withGuard } from "../../../../../security/guard-runtime.ts";
import { decodePathSegment } from "../../../../../routing/path-segment.ts";
export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: encodedId } = await context.params;
  const id = decodePathSegment(encodedId);
  return withGuard("export", request, () =>
    observe(
      "export_created",
      () => exportHttp(() => loadFeatureFlags().export)(request, id, "ics"),
      { format: "ics" },
    ),
  );
}
