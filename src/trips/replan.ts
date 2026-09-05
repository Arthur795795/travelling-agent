import { z } from "zod";
import {
  TripDaySchema,
  TripSchema,
  type Trip,
  type ValidationIssue,
} from "../domain/schema.ts";
import { previewChange, type TripChange } from "./changes.ts";
import { validateTrip, totalBudget, issue } from "../validation/trip.ts";
import type {
  DeepSeekResponseRequest,
  DeepSeekResponseResult,
} from "../providers/deepseek/responses-client.ts";
export type LocalModel = (
  request: DeepSeekResponseRequest,
  round: number,
) => Promise<DeepSeekResponseResult>;
export async function localReplan(
  base: Trip,
  change: TripChange,
  model: LocalModel,
) {
  const preview = previewChange(base, change);
  if (preview.lockConflicts.length) throw new Error("UNLOCK_REQUIRED");
  const proposed = preview.candidate;
  let problems: ValidationIssue[] = preview.issues;
  for (let round = 1; round <= 2; round++) {
    try {
      const response = await model(
        {
          input: JSON.stringify({
            change,
            days: proposed.days.filter((d) =>
              preview.affectedDates.includes(d.date),
            ),
            budget: proposed.brief.budget,
            party: proposed.brief.party,
            hardConstraints: proposed.brief.hardConstraints,
            lockedBookings: proposed.lockedBookings,
            issues: problems,
          }),
          instructions:
            '只返回 {"days": [...]} JSON，包含所给日期。仅调整已有活动时间、可选状态、备注和交通出发窗，不能改变锁定实体、ID、事实、价格、路线时长或硬约束。无法安全调整时保持原状。',
          textFormat: { type: "json_object" },
          maxOutputTokens: 5000,
        },
        round,
      );
      const { days } = z
        .object({ days: z.array(TripDaySchema) })
        .strict()
        .parse(JSON.parse(response.outputText));
      if (
        days.length !== preview.affectedDates.length ||
        new Set(days.map((d) => d.date)).size !== days.length ||
        days.some((d) => !preview.affectedDates.includes(d.date))
      )
        throw new Error("REPLAN_SCOPE");
      const candidate = structuredClone(proposed);
      for (const day of days) {
        const original = proposed.days.find((d) => d.date === day.date)!;
        if (
          day.id !== original.id ||
          day.activities.length !== original.activities.length ||
          day.legs.length !== original.legs.length
        )
          throw new Error("REPLAN_SCOPE");
        for (const a of day.activities) {
          const old = original.activities.find((o) => o.id === a.id);
          if (!old || (old.locked && JSON.stringify(a) !== JSON.stringify(old)))
            throw new Error("LOCK_CHANGED");
          const facts = (value: typeof a) => ({
            ...value,
            timeWindow: undefined,
            importance: undefined,
            rationale: undefined,
          });
          if (JSON.stringify(facts(a)) !== JSON.stringify(facts(old)))
            throw new Error("FACT_CHANGED");
        }
        for (const leg of day.legs) {
          const old = original.legs.find((l) => l.id === leg.id);
          if (
            !old ||
            (old.locked && JSON.stringify(old) !== JSON.stringify(leg)) ||
            JSON.stringify({ ...old, departureWindow: undefined }) !==
              JSON.stringify({ ...leg, departureWindow: undefined })
          )
            throw new Error("LOCK_CHANGED");
        }
        candidate.days[candidate.days.findIndex((d) => d.date === day.date)] =
          day;
      }
      problems = validateTrip(candidate, proposed);
      if (
        JSON.stringify(candidate.days) === JSON.stringify(base.days) &&
        JSON.stringify(candidate.brief) === JSON.stringify(base.brief)
      )
        problems.push(
          issue("REPLAN_NO_CHANGE", "未能产生满足要求的安全修改。", [base.id]),
        );
      if (!problems.some((i) => i.severity === "blocking")) {
        candidate.version = base.version + 1;
        candidate.updatedAt = new Date().toISOString();
        candidate.budget.total = totalBudget(candidate);
        candidate.lifecycleStatus = problems.length ? "checked" : "executable";
        return {
          trip: TripSchema.parse(candidate),
          issues: problems,
          choices: [],
          rounds: round,
        };
      }
    } catch {
      problems = [
        issue("REPLAN_REJECTED", "局部修改越界、格式错误或模型调用失败。", [
          base.id,
        ]),
      ];
    }
  }
  return {
    trip: base,
    issues: problems,
    choices: ["保留原行程并减少修改范围", "补充可核验资料后重新规划"],
    rounds: 2,
  };
}
