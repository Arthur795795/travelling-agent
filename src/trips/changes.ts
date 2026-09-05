import { z } from "zod";
import {
  TripSchema,
  TimeWindowSchema,
  MoneySchema,
  type Trip,
  type TripRevision,
} from "../domain/schema.ts";
import { validateTrip, totalBudget } from "../validation/trip.ts";
import { assertNoSensitiveData } from "../security/redaction.ts";

export const ChangeSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("note"),
      date: z.string(),
      text: z.string().max(500),
    })
    .strict(),
  z
    .object({
      type: z.literal("activity"),
      id: z.string(),
      timeWindow: TimeWindowSchema.optional(),
      importance: z.enum(["core", "optional", "fallback"]).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("lock"),
      entity: z.enum(["activity", "leg", "booking"]),
      id: z.string(),
      locked: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("move"),
      id: z.string(),
      date: z.string(),
      timeWindow: TimeWindowSchema,
    })
    .strict(),
  z.object({ type: z.literal("budget"), limit: MoneySchema }).strict(),
  z
    .object({
      type: z.literal("replan"),
      date: z.string(),
      instruction: z.string().min(1).max(500),
    })
    .strict(),
]);
export type TripChange = z.infer<typeof ChangeSchema>;
export function previewChange(input: Trip, raw: TripChange) {
  const base = TripSchema.parse(input);
  const change = ChangeSchema.parse(raw);
  assertNoSensitiveData(change);
  const candidate = structuredClone(base);
  const dates = new Set<string>();
  const conflicts: string[] = [];
  let major = false;
  if (change.type === "note" || change.type === "replan") {
    const day = candidate.days.find((d) => d.date === change.date);
    if (!day) throw new Error("DATE_NOT_FOUND");
    dates.add(day.date);
    if (change.type === "note") day.notes = change.text ? [change.text] : [];
    else major = true;
  } else if (change.type === "budget") {
    candidate.brief.budget.limit = change.limit;
    candidate.days.forEach((d) => dates.add(d.date));
    major = true;
  } else if (change.type === "lock") {
    const item =
      change.entity === "booking"
        ? candidate.lockedBookings.find((b) => b.id === change.id)
        : change.entity === "leg"
          ? candidate.days
              .flatMap((d) => d.legs)
              .find((l) => l.id === change.id)
          : candidate.days
              .flatMap((d) => d.activities)
              .find((a) => a.id === change.id);
    if (!item) throw new Error("ENTITY_NOT_FOUND");
    item.locked = change.locked;
    candidate.brief.bookedItems
      .filter((b) => b.id === change.id)
      .forEach((b) => {
        b.locked = change.locked;
      });
  } else {
    const day = candidate.days.find((d) =>
      d.activities.some((a) => a.id === change.id),
    );
    const activity = day?.activities.find((a) => a.id === change.id);
    if (!day || !activity) throw new Error("ENTITY_NOT_FOUND");
    dates.add(day.date);
    if (activity.locked) conflicts.push(activity.id);
    if (change.type === "move") {
      const destination = candidate.days.find((d) => d.date === change.date);
      if (!destination) throw new Error("DATE_NOT_FOUND");
      day.activities = day.activities.filter((a) => a.id !== change.id);
      destination.activities.push(activity);
      dates.add(destination.date);
      major = true;
    }
    if (change.timeWindow) {
      const delta =
        Math.abs(
          Date.parse(change.timeWindow.start) -
            Date.parse(activity.timeWindow.start),
        ) / 60000;
      major ||= delta > activity.timeWindow.flexibilityMinutes;
      activity.timeWindow = change.timeWindow;
    }
    if (change.type === "activity" && change.importance) {
      activity.importance = change.importance;
      major = true;
    }
  }
  TripSchema.parse(candidate);
  const issues = validateTrip(
    candidate,
    change.type === "lock" || change.type === "budget" ? candidate : base,
  );
  const prior = new Set(validateTrip(base).map((i) => i.id));
  major ||=
    conflicts.length > 0 ||
    issues.some((i) => i.severity === "blocking" && !prior.has(i.id));
  return {
    candidate,
    change,
    major,
    affectedDates: [...dates],
    lockConflicts: conflicts,
    issues,
    budgetBefore: totalBudget(base),
    budgetAfter: totalBudget(candidate),
    baseVersion: base.version,
  };
}
export function commitChange(
  base: Trip,
  change: TripChange,
  confirmed = false,
  now = () => new Date(),
) {
  const preview = previewChange(base, change);
  if (preview.major && !confirmed) throw new Error("CONFIRMATION_REQUIRED");
  if (preview.lockConflicts.length) throw new Error("UNLOCK_REQUIRED");
  const trip = preview.candidate;
  trip.version = base.version + 1;
  trip.updatedAt = now().toISOString();
  trip.budget.total = totalBudget(trip);
  trip.lifecycleStatus = preview.issues.some((i) => i.severity === "blocking")
    ? "blocked"
    : preview.issues.length
      ? "checked"
      : "executable";
  const revision: TripRevision = {
    id: crypto.randomUUID(),
    tripId: trip.id,
    baseVersion: base.version,
    nextVersion: trip.version,
    summary: `${change.type}：${preview.affectedDates.join("、") || "锁定状态"}`,
    createdAt: trip.updatedAt,
  };
  return { trip: TripSchema.parse(trip), revision, issues: preview.issues };
}
