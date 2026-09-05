import { z } from "zod";
import {
  TripSchema,
  type Trip,
  type TripBrief,
  type Evidence,
  type Money,
  type Place,
} from "../domain/schema.ts";
import type { ItinerarySkeleton } from "./skeleton.ts";
import type { ToolInvocationResult } from "./tools/registry.ts";
import {
  normalizeEvidence,
  type EvidenceObservation,
} from "../evidence/normalize.ts";
import { totalBudget } from "../validation/trip.ts";

export const EnrichmentPlanSchema = z
  .object({
    days: z
      .array(
        z
          .object({
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            activities: z
              .array(
                z
                  .object({
                    id: z.string().min(1).max(100),
                    title: z.string().min(1).max(150),
                    keyword: z.string().min(1).max(100),
                    city: z.string().min(1).max(40),
                    start: z.string().datetime({ offset: true }),
                    end: z.string().datetime({ offset: true }),
                    durationMinutes: z.number().int().positive().max(480),
                    importance: z.enum(["core", "optional", "fallback"]),
                    rationale: z.string().min(1).max(500),
                    fallbackKeyword: z.string().min(1).max(100),
                  })
                  .strict(),
              )
              .max(6),
            notes: z.array(z.string().max(300)).max(10),
          })
          .strict(),
      )
      .min(3)
      .max(5),
  })
  .strict();
export type EnrichmentPlan = z.infer<typeof EnrichmentPlanSchema>;
export type ToolCaller = (
  name: string,
  args: unknown,
  key: string,
  stage: "evidence_collection" | "route_and_budget",
) => Promise<ToolInvocationResult>;
const unknownCost = (reason: string): Money => ({
  kind: "unknown",
  currency: "CNY",
  reason,
});
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

export async function collectEvidence(
  brief: TripBrief,
  skeleton: ItinerarySkeleton,
  planInput: EnrichmentPlan,
  call: ToolCaller,
  id: string,
  now = () => new Date(),
): Promise<Trip> {
  const plan = EnrichmentPlanSchema.parse(planInput);
  if (
    plan.days.map((d) => d.date).join() !==
    skeleton.days.map((d) => d.date).join()
  )
    throw new Error("PLAN_DATES_MISMATCH");
  const observations: EvidenceObservation[] = [];
  const alerts: Trip["alerts"] = [];
  const alternatives: Trip["alternatives"] = [];
  const stamp = now().toISOString();
  const days: Trip["days"] = [];
  const add = (
    subjectId: string,
    date: string,
    field: string,
    evidence: Evidence,
    critical = true,
  ) =>
    observations.push({
      id: `obs:${subjectId}:${field}`,
      subjectId,
      date,
      field,
      critical,
      evidence,
    });
  for (const day of plan.days) {
    const activities: Trip["days"][number]["activities"] = [];
    for (const candidate of day.activities) {
      const search = await call(
        "search_places",
        { keyword: candidate.keyword, city: candidate.city, maxResults: 3 },
        `place:${candidate.id}`,
        "evidence_collection",
      );
      const candidates = object(search.data).candidates;
      const list = Array.isArray(candidates) ? candidates : [];
      let detail = object(list.length === 1 ? list[0] : undefined);
      if (detail.amapId) {
        const result = await call(
          "get_place_details",
          { amapId: detail.amapId },
          `detail:${candidate.id}`,
          "evidence_collection",
        );
        if (result.status === "success") detail = object(result.data);
      }
      const resolved = detail.place
        ? {
            ...(detail.place as Place),
            cityCode: detail.cityCode as string | undefined,
          }
        : undefined;
      const place: Place = resolved ?? {
        id: `unresolved:${candidate.id}`,
        name: candidate.keyword,
        city: candidate.city,
        source: "user",
      };
      if (!resolved)
        alerts.push({
          id: `place:${candidate.id}`,
          severity: "blocking",
          code: "PLACE_UNRESOLVED",
          message: "地点无结果或存在歧义，需要确认候选。",
          entityIds: [candidate.id],
        });
      add(candidate.id, day.date, "address", {
        id: `address:${candidate.id}`,
        sourceType: "dedicated_api",
        sourceName: "高德地点",
        checkedAt: String(detail.checkedAt ?? stamp),
        status: resolved ? "verified" : "failed",
        assertedValue: resolved?.address ?? resolved?.name,
      });
      const trustedHosts = (process.env.OFFICIAL_SOURCE_HOSTS ?? "dpm.org.cn")
        .split(",")
        .map((host) => host.trim())
        .filter(Boolean);
      const discovery = await call(
        "web_search",
        {
          query: `${candidate.keyword} 官方 开放时间 预约`,
          expectedOfficialHosts: trustedHosts,
        },
        `search:${candidate.id}`,
        "evidence_collection",
      );
      const sources = object(discovery.data).candidates;
      const source = Array.isArray(sources)
        ? (sources.find((item) => object(item).sourceType === "official") ??
          sources[0])
        : undefined;
      let official: Evidence | undefined;
      if (source) {
        const page = await call(
          "read_official_page",
          {
            subjectId: candidate.id,
            field: "opening_hours",
            candidate: source,
            queryTerms: ["开放", "预约", "闭馆"],
          },
          `page:${candidate.id}`,
          "evidence_collection",
        );
        official = object(page.data).evidence as Evidence | undefined;
        if (official?.status === "verified") {
          const sourceText = `${String(object(source).title ?? "")} ${official.excerpt ?? ""}`;
          const matchesPlace = [candidate.keyword, resolved?.name].some(
            (name) => !!name && sourceText.includes(name),
          );
          // Conditional schedules require date-specific verification, not the first time range on a page.
          if (
            !matchesPlace ||
            /周[一二三四五六日天]|星期|闭馆|节假日|淡季|旺季|暂停|临时/.test(
              official.excerpt ?? "",
            )
          )
            official = { ...official, status: "recheck_required" };
        }
      }
      const pending: Evidence = official ?? {
        id: `rules:${candidate.id}`,
        sourceType: "web",
        sourceName: "待核验规则",
        checkedAt: stamp,
        status: "recheck_required",
      };
      add(candidate.id, day.date, "opening_hours", pending);
      add(candidate.id, day.date, "reservation_rules", pending);
      const window =
        official?.status === "verified"
          ? official.excerpt?.match(/(\d{2}:\d{2})\s*[-–至]\s*(\d{2}:\d{2})/)
          : null;
      const price =
        official?.status === "verified"
          ? official.excerpt?.match(
              /(?:门票|票价)[：:\s]*(\d+(?:\.\d{1,2})?)(?:\s*[-–至]\s*(\d+(?:\.\d{1,2})?))?\s*元/,
            )
          : null;
      const partySize =
        brief.party.adults +
        brief.party.seniors +
        brief.party.childrenAgeBands.length;
      const ticketCost: Money = price
        ? {
            kind: "range",
            currency: "CNY",
            min: Number(price[1]) * partySize,
            max: Number(price[2] ?? price[1]) * partySize,
            confidence: "low",
          }
        : unknownCost("门票费用待核验");
      if (price)
        add(
          candidate.id,
          day.date,
          "cost",
          {
            ...pending,
            id: `cost-evidence:${candidate.id}`,
            assertedValue: `${price[0]}；按全员同价估算，优惠待确认`,
          },
          false,
        );
      activities.push({
        id: candidate.id,
        title: candidate.title,
        place,
        timeWindow: {
          start: candidate.start,
          end: candidate.end,
          flexibilityMinutes: 15,
        },
        durationMinutes: candidate.durationMinutes,
        importance: candidate.importance,
        locked: false,
        cost: ticketCost,
        rationale: candidate.rationale,
        evidenceIds: [`address:${candidate.id}`, pending.id],
        reservation: {
          required: !/(?:无需|不需要)预约/.test(pending.excerpt ?? ""),
          status: pending.status,
          instructions: pending.excerpt,
        },
        availabilityWindows: window
          ? [
              {
                start: `${day.date}T${window[1]}:00+08:00`,
                end: `${day.date}T${window[2]}:00+08:00`,
                flexibilityMinutes: 0,
              },
            ]
          : undefined,
      });
      alternatives.push({
        id: `alternative:${candidate.id}`,
        title: candidate.fallbackKeyword,
        description: "同区域候选，地点及可用性仍需核验。",
        trigger: "预约失败、天气变化或疲劳时考虑",
        affectedEntityIds: [candidate.id],
      });
      if (detail.adcode) {
        const weather = await call(
          "get_weather",
          { subjectId: candidate.id, adcode: detail.adcode, date: day.date },
          `weather:${candidate.id}:${day.date}`,
          "evidence_collection",
        );
        const evidence = object(weather.data).evidence as Evidence | undefined;
        if (evidence) add(candidate.id, day.date, "weather", evidence, false);
      }
    }
    days.push({
      id: `day:${day.date}`,
      date: day.date,
      title: `${brief.destination} · ${day.date}`,
      activities,
      legs: [],
      notes: [...day.notes, "活动之间预留休息和临时调整时间。"],
    });
  }
  const normalized = normalizeEvidence(observations);
  // Canonical IDs can change when a source supports several independent claims.
  for (const day of days)
    for (const activity of day.activities)
      activity.evidenceIds = [
        ...new Set(
          normalized.claims
            .filter((c) => c.subjectId === activity.id)
            .flatMap((c) => c.evidenceIds),
        ),
      ];
  return TripSchema.parse({
    schemaVersion: 1,
    id,
    version: 1,
    brief,
    lockedBookings: brief.bookedItems,
    assumptions: skeleton.disclosedDefaults,
    days,
    budget: {
      items: [],
      contingencyPercent: brief.budget.contingencyPercent,
      total: unknownCost("预算待补全"),
    },
    evidence: normalized.evidence,
    claims: normalized.claims,
    alerts,
    alternatives,
    lifecycleStatus: "draft",
    createdAt: stamp,
    updatedAt: stamp,
  });
}

export async function completeRoutesAndBudget(
  input: Trip,
  call: ToolCaller,
  now = () => new Date(),
): Promise<Trip> {
  const trip = TripSchema.parse(input);
  const items: Trip["budget"]["items"] = [];
  for (const booking of trip.lockedBookings)
    items.push({
      id: `paid:${booking.id}`,
      category:
        booking.type === "hotel"
          ? "lodging"
          : booking.type === "activity"
            ? "tickets"
            : "intercity",
      title: booking.title,
      cost: booking.paidCost ?? unknownCost("已订项目金额未填写"),
      paymentStatus: booking.paidCost ? "paid" : "unknown",
      evidenceIds: [],
    });
  for (const day of trip.days) {
    const activities = [...day.activities]
      .filter((a) => a.importance !== "fallback")
      .sort((a, b) => a.timeWindow.start.localeCompare(b.timeWindow.start));
    for (const [i, activity] of activities.entries()) {
      items.push({
        id: `cost:${activity.id}`,
        category: "tickets",
        title: activity.title,
        cost: activity.cost,
        paymentStatus:
          activity.cost.kind === "unknown" ? "unknown" : "estimated",
        evidenceIds: activity.evidenceIds,
      });
      const previous = activities[i - 1];
      if (!previous || previous.place.id === activity.place.id) continue;
      if (
        [
          previous.place.longitude,
          previous.place.latitude,
          activity.place.longitude,
          activity.place.latitude,
        ].some((n) => n === undefined)
      ) {
        trip.alerts.push({
          id: `route:${activity.id}`,
          severity: "blocking",
          code: "MISSING_ROUTE",
          message: "地点坐标不完整，无法计算路线。",
          entityIds: [previous.id, activity.id],
        });
        continue;
      }
      const mode =
        previous.place.cityCode && activity.place.cityCode
          ? "public_transit"
          : "walk";
      const result = await call(
        "calculate_route",
        {
          legId: `leg:${previous.id}:${activity.id}`,
          fromPlaceId: previous.place.id,
          toPlaceId: activity.place.id,
          origin: {
            longitude: previous.place.longitude,
            latitude: previous.place.latitude,
          },
          destination: {
            longitude: activity.place.longitude,
            latitude: activity.place.latitude,
          },
          mode,
          cityCodeFrom: previous.place.cityCode,
          cityCodeTo: activity.place.cityCode,
          departureWindow: {
            start: previous.timeWindow.end,
            end: activity.timeWindow.start,
            flexibilityMinutes: 0,
          },
        },
        `route:${previous.id}:${activity.id}`,
        "route_and_budget",
      );
      const data = object(result.data);
      if (result.status !== "success" || !data.leg) {
        trip.alerts.push({
          id: `route:${activity.id}`,
          severity: "blocking",
          code: "MISSING_ROUTE",
          message: "未能取得可用路线，请调整地点或时间。",
          entityIds: [previous.id, activity.id],
        });
        continue;
      }
      const leg = data.leg as Trip["days"][number]["legs"][number];
      const extra =
        trip.brief.party.seniors || trip.brief.party.childrenAgeBands.length
          ? 15
          : 0;
      leg.bufferMinutes = Number(data.suggestedBufferMinutes ?? 15) + extra;
      const evidence: Evidence = {
        id: `evidence:${leg.id}`,
        sourceType: "dedicated_api",
        sourceName: "高德路线",
        checkedAt: String(data.checkedAt ?? now().toISOString()),
        status: "verified",
        assertedValue: leg.durationMinutes.max,
      };
      leg.evidenceIds = [evidence.id];
      trip.evidence.push(evidence);
      day.legs.push(leg);
      items.push({
        id: `cost:${leg.id}`,
        category: "local_transport",
        title: "市内交通",
        cost: leg.cost,
        paymentStatus: leg.cost.kind === "unknown" ? "unknown" : "estimated",
        evidenceIds: [evidence.id],
      });
    }
  }
  for (const category of trip.brief.budget.includes)
    if (!items.some((i) => i.category === category))
      items.push({
        id: `cost:${category}`,
        category,
        title: category,
        cost: unknownCost("该类费用尚无可靠报价"),
        paymentStatus: "unknown",
        evidenceIds: [],
      });
  for (const platform of ["ctrip", "fliggy"]) {
    const result = await call(
      "create_platform_link",
      {
        platform,
        type: "hotel",
        city: trip.brief.destination,
        checkIn: trip.brief.startDate,
        checkOut: trip.brief.endDate,
      },
      `link:${platform}`,
      "route_and_budget",
    );
    const data = object(result.data);
    if (result.status === "success")
      trip.evidence.push({
        id: `platform:${platform}`,
        sourceType: "platform",
        sourceName: platform,
        url: String(data.actionUrl),
        checkedAt: String(data.generatedAt),
        status: "recheck_required",
        assertedValue: String(data.querySummary),
        excerpt: String(data.notice),
      });
  }
  trip.budget.items = items;
  trip.budget.total = totalBudget(trip);
  trip.budget.withinLimit = undefined;
  return TripSchema.parse(trip);
}
