import { z } from "zod";
import { TripBriefSchema } from "../domain/schema.ts";

export const CRITICAL_FAILURES = [
  "locked_booking_changed",
  "unreachable_schedule",
  "hard_constraint_violated",
  "fabricated_evidence",
  "realtime_inventory_claim",
  "hidden_critical_conflict",
] as const;

export const SOFT_SCORE_WEIGHTS = {
  personalization: 0.25,
  routeEfficiency: 0.25,
  executableCompleteness: 0.2,
  budgetQuality: 0.15,
  explanationAndEvidence: 0.15,
} as const;

const ToolFixtureSchema = z
  .object({
    places: z.array(z.object({ id: z.string(), status: z.string(), name: z.string(), city: z.string() })),
    routes: z.array(z.object({ id: z.string(), status: z.string(), durationMinutes: z.number().int().nonnegative(), distanceMeters: z.number().int().nonnegative() })),
    weather: z.array(z.object({ date: z.string(), status: z.string(), condition: z.string() })),
    official: z.array(
      z.object({ id: z.string(), status: z.string(), url: z.string().url(), value: z.string(), excerpt: z.string() }),
    ),
    platform: z.array(z.object({ id: z.string(), status: z.string(), url: z.string().url(), checkedAt: z.string().datetime() })),
  })
  .strict();

export const EvaluationCaseSchema = z
  .object({
    id: z.string().regex(/^eval-[a-z0-9-]+$/),
    title: z.string().min(1),
    city: z.enum(["北京", "上海", "重庆", "西安", "杭州"]),
    themes: z.array(z.string()).min(1),
    brief: TripBriefSchema,
    tools: ToolFixtureSchema,
    expected: z
      .object({
        mustBlock: z.boolean(),
        requiredCodes: z.array(z.string()),
        forbiddenBehaviors: z.array(z.enum(CRITICAL_FAILURES)),
      })
      .strict(),
  })
  .strict();

export const SoftScoresSchema = z
  .object({
    personalization: z.number().min(0).max(100),
    routeEfficiency: z.number().min(0).max(100),
    executableCompleteness: z.number().min(0).max(100),
    budgetQuality: z.number().min(0).max(100),
    explanationAndEvidence: z.number().min(0).max(100),
  })
  .strict();

export const EvaluationObservationSchema = z
  .object({
    completed: z.boolean(),
    blocked: z.boolean(),
    publicStatus: z.string().min(1),
    codes: z.array(z.string()),
    lockedBookingChanged: z.boolean(),
    unreachableSchedule: z.boolean(),
    hardConstraintViolated: z.boolean(),
    fabricatedEvidence: z.boolean(),
    realtimeInventoryClaim: z.boolean(),
    hiddenCriticalConflict: z.boolean(),
    scores: SoftScoresSchema,
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        visitorCostCny: z.number().nonnegative(),
        productCostCny: z.number().nonnegative(),
      })
      .strict(),
    durationMs: z.number().nonnegative(),
  })
  .strict();

export type EvaluationCase = z.infer<typeof EvaluationCaseSchema>;
export type EvaluationObservation = z.infer<
  typeof EvaluationObservationSchema
>;
export type SoftScores = z.infer<typeof SoftScoresSchema>;
export type CriticalFailure = (typeof CRITICAL_FAILURES)[number];
