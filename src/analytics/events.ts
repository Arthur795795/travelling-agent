import { z } from "zod";
import { IsoDateTimeSchema, PlanningStageSchema } from "../domain/schema.ts";

/**
 * Privacy-preserving product analytics (Ticket 042 / Spec F17).
 *
 * Every field is an enum, a bounded integer or a boolean, so a chat message,
 * a trip body, a key or an IP has no field it could be written into. The
 * schema is `.strict()`, so an unknown key is refused instead of stored.
 */
export const ANALYTICS_EVENT_NAMES = [
  "job_started",
  "job_stage",
  "job_finished",
  "trip_edited",
  "share_created",
  "export_created",
  "feedback_submitted",
  "error",
] as const;

/** Events a browser may report; server-side events are recorded in process. */
export const CLIENT_EVENT_NAMES = ["trip_edited", "error"] as const;

export const ANALYTICS_OUTCOMES = [
  "ok",
  "failed",
  "cancelled",
  "blocked",
] as const;

/** Mirrors `TripChange["type"]`: a shape, never the edited text. */
export const ANALYTICS_EDIT_KINDS = [
  "note",
  "activity",
  "lock",
  "move",
  "budget",
  "replan",
] as const;

export const ANALYTICS_FIELDS = [
  "name",
  "stage",
  "outcome",
  "code",
  "kind",
  "format",
  "status",
  "durationMs",
  "major",
  "rating",
] as const;

/** Machine codes only: no message, no punctuation, no user text. */
export const ANALYTICS_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,39}$/;
const CodeSchema = z.string().regex(ANALYTICS_CODE_PATTERN);

/** Longest duration an event may claim, so a clock skew cannot leak as data. */
export const ANALYTICS_MAX_DURATION_MS = 86_400_000;

export const AnalyticsEventSchema = z
  .object({
    name: z.enum(ANALYTICS_EVENT_NAMES),
    stage: PlanningStageSchema.optional(),
    outcome: z.enum(ANALYTICS_OUTCOMES).optional(),
    code: CodeSchema.optional(),
    kind: z.enum(ANALYTICS_EDIT_KINDS).optional(),
    format: z.enum(["pdf", "ics"]).optional(),
    status: z.number().int().min(100).max(599).optional(),
    durationMs: z
      .number()
      .int()
      .nonnegative()
      .max(ANALYTICS_MAX_DURATION_MS)
      .optional(),
    major: z.boolean().optional(),
    rating: z.enum(["up", "down"]).optional(),
  })
  .strict();

/** The browser-facing subset of the same whitelist. */
export const ClientAnalyticsEventSchema = AnalyticsEventSchema.extend({
  name: z.enum(CLIENT_EVENT_NAMES),
});

/** What is stored and published: the event plus the time it happened. */
export const AnalyticsRecordSchema = AnalyticsEventSchema.extend({
  at: IsoDateTimeSchema,
});

export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number];
export type AnalyticsEvent = z.infer<typeof AnalyticsEventSchema>;
export type AnalyticsRecord = z.infer<typeof AnalyticsRecordSchema>;
