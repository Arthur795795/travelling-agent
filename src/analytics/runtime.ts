import { applicationDatabase } from "../persistence/runtime.ts";
import type { AnalyticsEvent } from "./events.ts";
import { FeedbackService } from "./feedback.ts";
import { analyticsHttp, feedbackHttp } from "./http.ts";
import { recordAnalyticsEvent } from "./store.ts";

/**
 * Analytics must never break a request: a failed write is dropped silently.
 */
export function recordEvent(event: AnalyticsEvent): void {
  try {
    recordAnalyticsEvent(applicationDatabase(), event);
  } catch {}
}

/** Measures a handler and records its shape-only outcome. */
export async function observe<T extends Response>(
  name: AnalyticsEvent["name"],
  run: () => T | Promise<T>,
  extra: Omit<AnalyticsEvent, "name" | "status" | "durationMs" | "outcome"> = {},
): Promise<T> {
  const started = Date.now();
  try {
    const response = await run();
    recordEvent({
      ...extra,
      name,
      status: response.status,
      outcome: response.ok ? "ok" : "failed",
      durationMs: Date.now() - started,
    });
    return response;
  } catch (error) {
    recordEvent({
      ...extra,
      name,
      outcome: "failed",
      code: "HANDLER_FAILED",
      durationMs: Date.now() - started,
    });
    throw error;
  }
}

export const feedbackService = () => new FeedbackService(applicationDatabase());
export const feedbackApi = () => feedbackHttp(feedbackService(), recordEvent);
export const analyticsApi = () => analyticsHttp(recordEvent);
