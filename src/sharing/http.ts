import { z } from "zod";
import { TripSchema } from "../domain/schema.ts";
import { DisclosureSchema } from "../trips/presentation.ts";
import type { SharingService } from "./service.ts";
export const privateHeaders = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
};
export function sharingHttp(service: SharingService, enabled = () => false) {
  return {
    async create(request: Request) {
      if (!enabled())
        return Response.json(
          { code: "FEATURE_DISABLED" },
          { status: 403, headers: privateHeaders },
        );
      try {
        const body = z
          .object({
            trip: TripSchema,
            fields: DisclosureSchema,
            confirmed: z.literal(true),
          })
          .strict()
          .parse(await request.json());
        const result = service.create(body.trip, body.fields);
        return Response.json(
          {
            readUrl: `/share/${result.readToken}`,
            deleteToken: result.deleteToken,
            expiresAt: result.expiresAt,
          },
          { status: 201, headers: privateHeaders },
        );
      } catch {
        return Response.json(
          { code: "INVALID_SHARE" },
          { status: 400, headers: privateHeaders },
        );
      }
    },
    read(token: string) {
      const record = service.read(token);
      return Response.json(record ?? { code: "SHARE_UNAVAILABLE" }, {
        status: record ? 200 : 404,
        headers: privateHeaders,
      });
    },
    delete(token: string) {
      return new Response(null, {
        status: service.delete(token) ? 204 : 404,
        headers: privateHeaders,
      });
    },
  };
}
