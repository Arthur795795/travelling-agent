import { ClientAnalyticsEventSchema, type AnalyticsEvent } from "./events.ts";
import {
  FEEDBACK_PURPOSE,
  FEEDBACK_REASONS,
} from "./feedback-contract.ts";
import {
  FeedbackService,
  SensitiveFeedbackError,
  type FeedbackSubmission,
} from "./feedback.ts";

const headers = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
};

export function analyticsHttp(record: (event: AnalyticsEvent) => void) {
  return {
    /** Accepts one whitelisted browser event; refuses anything else. */
    async ingest(request: Request) {
      const parsed = ClientAnalyticsEventSchema.safeParse(
        await request.json().catch(() => null),
      );
      if (!parsed.success)
        return Response.json({ code: "INVALID_EVENT" }, { status: 400, headers });
      record(parsed.data);
      return new Response(null, { status: 202, headers });
    },
  };
}

export function feedbackHttp(
  service: FeedbackService,
  record: (event: AnalyticsEvent) => void = () => {},
) {
  return {
    purpose() {
      return Response.json(
        { purpose: FEEDBACK_PURPOSE, reasons: FEEDBACK_REASONS },
        { headers },
      );
    },
    async create(request: Request) {
      try {
        const body = (await request.json()) as unknown;
        const receipt = service.create(body);
        // `create` succeeded, so the body satisfies the submission schema.
        const { rating } = body as FeedbackSubmission;
        record({ name: "feedback_submitted", outcome: "ok", rating });
        return Response.json(receipt, { status: 201, headers });
      } catch (error) {
        if (error instanceof SensitiveFeedbackError) {
          record({
            name: "feedback_submitted",
            outcome: "blocked",
            code: error.code,
          });
          return Response.json(
            { code: error.code, message: error.message },
            { status: 400, headers },
          );
        }
        record({
          name: "feedback_submitted",
          outcome: "failed",
          code: "INVALID_FEEDBACK",
        });
        return Response.json(
          { code: "INVALID_FEEDBACK" },
          { status: 400, headers },
        );
      }
    },
    remove(token: string) {
      return new Response(null, {
        status: service.delete(token) ? 204 : 404,
        headers,
      });
    },
  };
}
