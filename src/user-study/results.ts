import { z } from "zod";

export const UserStudyResultSchema = z
  .object({
    participantId: z.string().regex(/^participant-[1-5]$/),
    consented: z.literal(true),
    completedWithoutGuidance: z.boolean(),
    acceptablePlanMs: z.number().int().positive().optional(),
    keyEditMs: z.number().int().positive().optional(),
    tasks: z.object({ editDemo: z.boolean(), planOwnTrip: z.boolean() }),
    feedbackDeleted: z.boolean().default(false),
  })
  .strict();
export type UserStudyResult = z.infer<typeof UserStudyResultSchema>;

const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function summarizeUserStudy(input: unknown[]) {
  const results = input.map((item) => UserStudyResultSchema.parse(item));
  const active = results.filter((item) => !item.feedbackDeleted);
  const acceptableMedianMs = median(
    active.flatMap((item) =>
      item.acceptablePlanMs === undefined ? [] : [item.acceptablePlanMs],
    ),
  );
  const keyEditMedianMs = median(
    active.flatMap((item) => (item.keyEditMs === undefined ? [] : [item.keyEditMs])),
  );
  const withoutGuidance = active.filter(
    (item) => item.completedWithoutGuidance,
  ).length;
  const complete = active.length === 5 && active.every(
    (item) => item.acceptablePlanMs !== undefined && item.keyEditMs !== undefined,
  );
  const reasons = [
    ...(!complete ? ["five_complete_participants_required"] : []),
    ...(withoutGuidance < 4 ? ["fewer_than_four_without_guidance"] : []),
    ...(acceptableMedianMs === null || acceptableMedianMs > 8 * 60_000
      ? ["acceptable_plan_median_over_8m_or_missing"]
      : []),
    ...(keyEditMedianMs === null || keyEditMedianMs > 2 * 60_000
      ? ["key_edit_median_over_2m_or_missing"]
      : []),
  ];
  return {
    status: complete ? "complete" : "incomplete",
    participantCount: active.length,
    completedWithoutGuidance: withoutGuidance,
    acceptablePlanMedianMs: acceptableMedianMs,
    keyEditMedianMs,
    gate: { passed: reasons.length === 0, reasons },
  };
}
