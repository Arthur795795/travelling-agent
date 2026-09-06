import { ClientAnalyticsEventSchema, type AnalyticsEvent } from "./events.ts";

/**
 * Browser reporter for the two client-side events. Fire-and-forget: analytics
 * must never block or fail an edit, and nothing is sent unless the event
 * matches the whitelist locally first.
 */
export function reportEvent(event: AnalyticsEvent): void {
  const parsed = ClientAnalyticsEventSchema.safeParse(event);
  if (!parsed.success || typeof fetch !== "function") return;
  void fetch("/api/analytics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(parsed.data),
    keepalive: true,
  }).catch(() => {});
}
