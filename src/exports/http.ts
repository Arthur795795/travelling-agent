import { z } from "zod";
import { TripSchema } from "../domain/schema.ts";
import { DisclosureSchema } from "../trips/presentation.ts";
import { exportIcs } from "./ics.ts";
import { exportPdf } from "./pdf.ts";
export function exportHttp(enabled = () => false, pdf = exportPdf) {
  return async (request: Request, id: string, format: "pdf" | "ics") => {
    const headers = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    if (!enabled())
      return Response.json(
        { code: "FEATURE_DISABLED" },
        { status: 403, headers },
      );
    try {
      const body = z
        .object({ trip: TripSchema, fields: DisclosureSchema })
        .strict()
        .parse(await request.json());
      if (body.trip.id !== id)
        return Response.json(
          { code: "TRIP_MISMATCH" },
          { status: 400, headers },
        );
      if (format === "ics") {
        const output = exportIcs(body.trip, body.fields);
        return new Response(output.content, {
          headers: {
            ...headers,
            "Content-Type": "text/calendar; charset=utf-8",
            "Content-Disposition": 'attachment; filename="itinerary.ics"',
            "X-Skipped-Untimed": String(output.skipped),
          },
        });
      }
      const output = await pdf(body.trip, body.fields);
      return new Response(new Uint8Array(output), {
        headers: {
          ...headers,
          "Content-Type": "application/pdf",
          "Content-Disposition": 'attachment; filename="itinerary.pdf"',
        },
      });
    } catch {
      return Response.json(
        {
          code: format === "pdf" ? "PDF_EXPORT_FAILED" : "INVALID_EXPORT",
          message: "导出失败，请检查输入和渲染服务配置后重试。",
        },
        { status: 422, headers },
      );
    }
  };
}
