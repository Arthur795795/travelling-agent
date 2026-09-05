import { z } from "zod";
import { TripSchema, type Trip, type Money } from "../domain/schema.ts";
import { assertNoSensitiveData } from "../security/redaction.ts";
export const AI_LABEL = "AI 辅助生成";
export const DisclosureSchema = z
  .object({
    budget: z.boolean().default(false),
    privateNotes: z.boolean().default(false),
  })
  .strict();
export type Disclosure = z.infer<typeof DisclosureSchema>;
export const statusLabels = {
  draft: "草案：尚未完成校验",
  checked: "已检查：仍有需复核事项",
  executable: "可执行：已通过当前数据硬门槛，出发前仍需复核",
  blocked: "存在阻塞：请先解决关键问题",
};
export const evidenceLabels = {
  verified: "已核验",
  recheck_required: "需复核",
  failed: "查询失败",
};
export function moneyText(money: Money) {
  return money.kind === "unknown"
    ? "费用未知（非零）"
    : money.kind === "exact"
      ? `${money.currency} ${money.amount}`
      : `${money.currency} ${money.min}–${money.max}`;
}
export function safeLink(value?: string): string | undefined {
  try {
    const url = new URL(value ?? "");
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
// Build a new allowlisted projection. Never pass the original object to public rendering.
export function projectTrip(input: Trip, raw: Partial<Disclosure> = {}): Trip {
  const trip = TripSchema.parse(input);
  const fields = DisclosureSchema.parse(raw);
  const hidden = {
    kind: "unknown" as const,
    currency: "CNY",
    reason: "未分享费用",
  };
  const clean = structuredClone(trip);
  if (!fields.privateNotes) {
    clean.brief.preferences = [];
    clean.brief.hardConstraints = [];
    clean.brief.party.mobilityNotes = [];
    clean.assumptions = [];
    clean.alternatives = [];
    clean.days.forEach((d) => {
      d.notes = [];
      d.activities.forEach((a) => {
        a.rationale = "未分享私人说明";
        if (a.reservation) a.reservation.instructions = undefined;
      });
    });
    clean.lockedBookings = [];
    clean.brief.bookedItems = [];
    clean.alerts = clean.alerts.map((a) => ({
      ...a,
      message: "此行程仍有待解决事项，请与创建者核对。",
    }));
  }
  if (!fields.budget) {
    clean.brief.budget = { includes: [], contingencyPercent: 0 };
    clean.budget = { items: [], total: hidden, contingencyPercent: 0 };
    clean.days.forEach((d) => {
      d.activities.forEach((a) => {
        a.cost = hidden;
      });
      d.legs.forEach((l) => {
        l.cost = hidden;
      });
    });
    clean.lockedBookings.forEach((b) => {
      b.paidCost = undefined;
    });
    clean.brief.bookedItems.forEach((b) => {
      b.paidCost = undefined;
    });
  }
  // Free-form excerpts may mix prices and private text; retain only provenance and status.
  if (!fields.budget || !fields.privateNotes) {
    clean.claims = clean.claims
      .filter((c) => fields.budget || !/cost|price|budget/i.test(c.field))
      .map((c) => ({ ...c, value: undefined }));
    clean.evidence = clean.evidence
      .filter((e) =>
        clean.claims.some((c) =>
          [...c.evidenceIds, ...c.conflictEvidenceIds].includes(e.id),
        ),
      )
      .map((e) => ({
        id: e.id,
        sourceType: e.sourceType,
        sourceName: e.sourceName,
        url: safeLink(e.url),
        checkedAt: e.checkedAt,
        status: e.status,
      }));
  }
  assertNoSensitiveData(clean);
  return TripSchema.parse(clean);
}
