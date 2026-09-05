import {
  TripSchema,
  type Trip,
  type ValidationIssue,
} from "../domain/schema.ts";
import { validateTrip, totalBudget, issue } from "../validation/trip.ts";

export type RepairModel = (
  trip: Trip,
  issues: ValidationIssue[],
  round: number,
) => Promise<unknown>;
export interface RepairResult {
  trip: Trip;
  issues: ValidationIssue[];
  rounds: number;
  choices: string[];
}
export async function repairTrip(
  input: Trip,
  model: RepairModel,
  baseline = input,
): Promise<RepairResult> {
  let trip = TripSchema.parse(input);
  let issues = validateTrip(trip, baseline);
  let rounds = 0;
  while (issues.some((i) => i.severity === "blocking") && rounds < 2) {
    rounds++;
    const affected = new Set(
      issues.flatMap((i) =>
        trip.days
          .filter(
            (d) =>
              i.path.includes(d.date) ||
              d.activities.some((a) => i.entityIds.includes(a.id)) ||
              d.legs.some((l) => i.entityIds.includes(l.id)),
          )
          .map((d) => d.date),
      ),
    );
    let candidate: Trip;
    try {
      candidate = TripSchema.parse(await model(trip, issues, rounds));
    } catch {
      issues = [
        ...issues,
        issue("REPAIR_INVALID", "修复返回格式无效。", [trip.id]),
      ];
      continue;
    }
    const changed =
      JSON.stringify(candidate.brief) !== JSON.stringify(baseline.brief) ||
      JSON.stringify(candidate.lockedBookings) !==
        JSON.stringify(baseline.lockedBookings) ||
      JSON.stringify(candidate.evidence) !== JSON.stringify(trip.evidence) ||
      JSON.stringify(candidate.claims) !== JSON.stringify(trip.claims) ||
      trip.days.some(
        (d) =>
          !affected.has(d.date) &&
          JSON.stringify(d) !==
            JSON.stringify(candidate.days.find((n) => n.date === d.date)),
      );
    const candidateIssues = validateTrip(candidate, baseline);
    const costsChanged =
      JSON.stringify(candidate.budget.items) !==
        JSON.stringify(trip.budget.items) ||
      candidate.budget.items.some((item) => {
        const old = trip.budget.items.find((i) => i.id === item.id);
        return !old || JSON.stringify(old) !== JSON.stringify(item);
      }) ||
      candidate.days.some(
        (day) =>
          day.activities.some((a) => {
            const old = trip.days
              .flatMap((d) => d.activities)
              .find((item) => item.id === a.id);
            return (
              !old ||
              JSON.stringify(old.cost) !== JSON.stringify(a.cost) ||
              JSON.stringify(old.place) !== JSON.stringify(a.place) ||
              JSON.stringify(old.availabilityWindows) !==
                JSON.stringify(a.availabilityWindows) ||
              JSON.stringify(old.reservation) !== JSON.stringify(a.reservation)
            );
          }) ||
          day.legs.some((l) => {
            const old = trip.days
              .flatMap((d) => d.legs)
              .find((item) => item.id === l.id);
            return (
              !old ||
              JSON.stringify({ ...old, departureWindow: undefined }) !==
                JSON.stringify({ ...l, departureWindow: undefined })
            );
          }),
      );
    if (
      changed ||
      costsChanged ||
      candidate.id !== trip.id ||
      candidateIssues.some((i) =>
        [
          "LOCK_CHANGED",
          "LOCKED_ACTIVITY_CHANGED",
          "LOCKED_LEG_CHANGED",
        ].includes(i.code),
      )
    ) {
      issues = [
        ...issues,
        issue(
          "REPAIR_UNAUTHORIZED",
          "修复尝试改变锁定项、事实、费用或不受影响的日期。",
          [trip.id],
        ),
      ];
      continue;
    }
    trip = candidate;
    issues = candidateIssues;
  }
  const blocked = issues.some((i) => i.severity === "blocking");
  trip.budget.total = totalBudget(trip);
  trip.lifecycleStatus = blocked
    ? "blocked"
    : issues.length
      ? "checked"
      : "executable";
  return {
    trip,
    issues,
    rounds,
    choices: blocked
      ? ["调整冲突日期或减少活动后重新规划", "补充预订或可靠来源后重新规划"]
      : [],
  };
}
