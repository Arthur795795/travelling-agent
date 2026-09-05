import {
  TripSchema,
  type Trip,
  type Money,
  type ValidationIssue,
} from "../domain/schema.ts";
import { FULL_SUPPORT_CITIES } from "../requirements/service.ts";
import { resolveClaim } from "../evidence/resolve.ts";

export function localDate(value: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}
export function tripDates(trip: Pick<Trip, "brief">): string[] {
  const dates: string[] = [];
  for (
    let t = Date.parse(`${trip.brief.startDate}T00:00:00Z`);
    t <= Date.parse(`${trip.brief.endDate}T00:00:00Z`);
    t += 86400000
  )
    dates.push(new Date(t).toISOString().slice(0, 10));
  return dates;
}
export function issue(
  code: string,
  message: string,
  entityIds: string[],
  date?: string,
  severity: ValidationIssue["severity"] = "blocking",
): ValidationIssue {
  return {
    id: `${code}:${entityIds.join(":")}`.slice(0, 128),
    code,
    message,
    entityIds,
    path: date ? ["days", date, code] : [code],
    severity,
  };
}
const ms = (time: string) => Date.parse(time);
export function validateTimeAndScope(input: Trip): ValidationIssue[] {
  const trip = TripSchema.parse(input);
  const issues: ValidationIssue[] = [];
  const dates = tripDates(trip);
  if (
    dates.length < 3 ||
    dates.length > 5 ||
    dates.join() !== trip.days.map((d) => d.date).join()
  )
    issues.push(
      issue("TRIP_DATES", "行程日期必须完整覆盖 3–5 天。", [trip.id]),
    );
  if (
    !(FULL_SUPPORT_CITIES as readonly string[]).includes(
      trip.brief.destination,
    ) ||
    trip.brief.dayTrips.some((d) => d.travelMinutesOneWay > 120)
  )
    issues.push(
      issue("UNSUPPORTED_SCOPE", "城市或周边一日游超出完整支持范围。", [
        trip.id,
      ]),
    );
  const ids = new Set<string>();
  for (const day of trip.days) {
    const activities = [...day.activities].sort(
      (a, b) => ms(a.timeWindow.start) - ms(b.timeWindow.start),
    );
    if (activities.filter((a) => a.importance === "core").length > 2)
      issues.push(
        issue(
          "DENSE_DAY",
          "核心活动超过默认每天两个，请考虑减少。",
          [day.id],
          day.date,
          "warning",
        ),
      );
    for (const [index, activity] of activities.entries()) {
      if (ids.has(activity.id))
        issues.push(
          issue("DUPLICATE_ENTITY", "活动 ID 重复。", [activity.id], day.date),
        );
      ids.add(activity.id);
      const { start, end } = activity.timeWindow;
      if (
        localDate(start) !== day.date ||
        localDate(end) !== day.date ||
        ms(end) - ms(start) < activity.durationMinutes * 60000
      )
        issues.push(
          issue(
            "ACTIVITY_WINDOW",
            "活动时间跨日或不足以完成活动。",
            [activity.id],
            day.date,
          ),
        );
      const city = activity.place.city.replace(/市$/, "");
      if (
        city !== trip.brief.destination.replace(/市$/, "") &&
        !trip.brief.dayTrips.some((d) => d.destination === city)
      )
        issues.push(
          issue(
            "MULTI_CITY",
            "活动超出主城市及确认的周边范围。",
            [activity.id],
            day.date,
          ),
        );
      if (
        activity.availabilityWindows &&
        !activity.availabilityWindows.some(
          (w) => ms(start) >= ms(w.start) && ms(end) <= ms(w.end),
        )
      )
        issues.push(
          issue(
            "OUTSIDE_OPENING_WINDOW",
            "活动不在已提供的营业或预约窗口内。",
            [activity.id],
            day.date,
          ),
        );
      const previous = activities
        .slice(0, index)
        .reverse()
        .find((a) => a.importance !== "fallback");
      if (
        !previous ||
        activity.importance === "fallback" ||
        previous.importance === "fallback"
      )
        continue;
      if (ms(start) < ms(previous.timeWindow.end))
        issues.push(
          issue(
            "TIME_OVERLAP",
            "活动时间重叠。",
            [previous.id, activity.id],
            day.date,
          ),
        );
      if (previous.place.id === activity.place.id) continue;
      const leg = day.legs.find(
        (l) =>
          l.fromPlaceId === previous.place.id &&
          l.toPlaceId === activity.place.id,
      );
      if (!leg) {
        issues.push(
          issue(
            "MISSING_ROUTE",
            "活动之间缺少可用路线。",
            [previous.id, activity.id],
            day.date,
          ),
        );
        continue;
      }
      const arrival =
        Math.max(ms(previous.timeWindow.end), ms(leg.departureWindow.start)) +
        (leg.durationMinutes.max + leg.bufferMinutes) * 60000;
      if (
        ms(previous.timeWindow.end) > ms(leg.departureWindow.end) ||
        arrival > ms(start)
      )
        issues.push(
          issue(
            "UNREACHABLE",
            "路线时长和缓冲不足以按时抵达。",
            [previous.id, leg.id, activity.id],
            day.date,
          ),
        );
    }
    for (const leg of day.legs) {
      if (localDate(leg.departureWindow.start) !== day.date)
        issues.push(
          issue("LEG_DATE", "交通段归属日期不正确。", [leg.id], day.date),
        );
      if (leg.durationMinutes.max === 0 && leg.fromPlaceId !== leg.toPlaceId)
        issues.push(
          issue(
            "ZERO_ROUTE",
            "不同地点之间不能使用零时长路线。",
            [leg.id],
            day.date,
          ),
        );
    }
  }
  return issues;
}

export function totalBudget(trip: Pick<Trip, "budget">): Money {
  const costs = trip.budget.items.map((i) => i.cost);
  if (
    !costs.length ||
    costs.some((c) => c.kind === "unknown" || c.currency !== "CNY")
  )
    return {
      kind: "unknown",
      currency: "CNY",
      reason: "费用不完整，不能确定总预算",
    };
  const factor = 1 + trip.budget.contingencyPercent / 100;
  const min =
    costs.reduce(
      (sum, c) =>
        sum + (c.kind === "exact" ? c.amount : c.kind === "range" ? c.min : 0),
      0,
    ) * factor;
  const max =
    costs.reduce(
      (sum, c) =>
        sum + (c.kind === "exact" ? c.amount : c.kind === "range" ? c.max : 0),
      0,
    ) * factor;
  return {
    kind: "range",
    currency: "CNY",
    min: Math.round(min * 100) / 100,
    max: Math.round(max * 100) / 100,
    confidence: "medium",
  };
}
export function validateConstraints(
  input: Trip,
  baseline: Trip = input,
): ValidationIssue[] {
  const trip = TripSchema.parse(input);
  const issues: ValidationIssue[] = [];
  if (JSON.stringify(trip.brief) !== JSON.stringify(baseline.brief))
    issues.push(
      issue("BRIEF_CHANGED", "已确认旅行简报不能被自动修改。", [trip.id]),
    );
  const expectedBookings = new Map(
    [...baseline.brief.bookedItems, ...baseline.lockedBookings]
      .filter((b) => b.locked)
      .map((b) => [b.id, b]),
  );
  for (const booking of expectedBookings.values()) {
    if (
      JSON.stringify(trip.lockedBookings.find((b) => b.id === booking.id)) !==
      JSON.stringify(booking)
    )
      issues.push(
        issue("LOCK_CHANGED", "锁定预订被删除或修改。", [booking.id]),
      );
    if (!booking.start || booking.type === "hotel") continue;
    const date = localDate(booking.start);
    if (booking.end) {
      for (const activity of trip.days
        .flatMap((d) => d.activities)
        .filter(
          (a) => a.importance !== "fallback" && a.bookingId !== booking.id,
        )) {
        if (
          ms(activity.timeWindow.start) < ms(booking.end) &&
          ms(activity.timeWindow.end) > ms(booking.start)
        )
          issues.push(
            issue(
              "LOCK_OVERLAP",
              "活动与锁定预订占用时间重叠。",
              [activity.id, booking.id],
              localDate(activity.timeWindow.start),
            ),
          );
      }
    }
    const day = trip.days.find((d) => d.date === date);
    const previous = day?.activities
      .filter(
        (a) =>
          a.bookingId !== booking.id &&
          ms(a.timeWindow.start) < ms(booking.start!),
      )
      .sort((a, b) => ms(b.timeWindow.start) - ms(a.timeWindow.start))[0];
    if (!previous) continue;
    const leg = day?.legs.find(
      (l) =>
        l.fromPlaceId === previous.place.id &&
        (l.bookingId === booking.id || l.toPlaceId === booking.id),
    );
    const lead =
      booking.type === "flight" ? 120 : booking.type === "train" ? 60 : 25;
    const extra =
      trip.brief.party.seniors ||
      trip.brief.party.childrenAgeBands.length ||
      trip.brief.party.mobilityNotes.length
        ? 15
        : 0;
    if (
      !leg ||
      Math.max(ms(previous.timeWindow.end), ms(leg.departureWindow.start)) +
        (leg.durationMinutes.max + leg.bufferMinutes + lead + extra) * 60000 >
        ms(booking.start)
    )
      issues.push(
        issue(
          "LOCK_UNREACHABLE",
          "前序活动及交通无法保证提前抵达锁定预订。",
          [previous.id, booking.id],
          date,
        ),
      );
  }
  for (const day of baseline.days)
    for (const item of day.activities.filter((a) => a.locked)) {
      const next = trip.days
        .flatMap((d) => d.activities)
        .find((a) => a.id === item.id);
      if (JSON.stringify(item) !== JSON.stringify(next))
        issues.push(
          issue(
            "LOCKED_ACTIVITY_CHANGED",
            "锁定活动不能修改。",
            [item.id],
            day.date,
          ),
        );
    }
  for (const day of baseline.days)
    for (const item of day.legs.filter((l) => l.locked)) {
      if (
        JSON.stringify(item) !==
        JSON.stringify(
          trip.days.flatMap((d) => d.legs).find((l) => l.id === item.id),
        )
      )
        issues.push(
          issue(
            "LOCKED_LEG_CHANGED",
            "锁定交通不能修改。",
            [item.id],
            day.date,
          ),
        );
    }
  const total = totalBudget(trip);
  if (
    trip.days.some(
      (d) =>
        (trip.brief.budget.includes.includes("tickets") &&
          d.activities.some(
            (a) => a.importance !== "fallback" && a.cost.kind === "unknown",
          )) ||
        (trip.brief.budget.includes.includes("local_transport") &&
          d.legs.some((l) => l.cost.kind === "unknown")),
    )
  )
    issues.push(
      issue(
        "UNKNOWN_ENTITY_COST",
        "活动或交通费用仍未知，不能用已知汇总替代。",
        [trip.id],
      ),
    );
  if (total.kind === "unknown")
    issues.push(
      issue("UNKNOWN_BUDGET", "费用仍有未知项，不能确认低于预算。", [trip.id]),
    );
  const limit = trip.brief.budget.limit;
  if (limit && limit.kind !== "unknown" && total.kind !== "unknown") {
    if (
      limit.currency !== total.currency ||
      (total.kind === "range" ? total.max : total.amount) >
        (limit.kind === "range" ? limit.max : limit.amount)
    )
      issues.push(
        issue("OVER_BUDGET", "含机动金的总预算超过上限。", [trip.id]),
      );
  }
  for (const category of trip.brief.budget.includes)
    if (!trip.budget.items.some((i) => i.category === category))
      issues.push(
        issue("MISSING_BUDGET_CATEGORY", `缺少${category}费用。`, [trip.id]),
      );
  for (const claim of trip.claims) {
    const resolved = resolveClaim(claim, trip.evidence).claim;
    if (
      resolved.status !== "verified" ||
      claim.status !== "verified" ||
      resolved.value !== claim.value
    )
      issues.push(
        issue(
          "UNVERIFIED_CLAIM",
          "事实待核验或来源冲突未解决。",
          [claim.subjectId, claim.id],
          claim.date,
          claim.critical === false ? "warning" : "blocking",
        ),
      );
  }
  for (const day of trip.days) {
    for (const activity of day.activities.filter(
      (a) => a.importance !== "fallback",
    )) {
      for (const field of ["address", "opening_hours", "reservation_rules"]) {
        if (
          !trip.claims.some(
            (c) =>
              (c.subjectId === activity.id ||
                c.subjectId === activity.place.id) &&
              c.field === field &&
              (!c.date || c.date === day.date),
          )
        )
          issues.push(
            issue(
              "MISSING_CRITICAL_EVIDENCE",
              `缺少${field}证据。`,
              [activity.id],
              day.date,
            ),
          );
      }
      if (activity.reservation?.status !== "verified")
        issues.push(
          issue(
            "RESERVATION_UNVERIFIED",
            "预约规则未核验。",
            [activity.id],
            day.date,
          ),
        );
      if (!activity.availabilityWindows?.length)
        issues.push(
          issue(
            "OPENING_UNVERIFIED",
            "尚无可校验的开放时间窗。",
            [activity.id],
            day.date,
          ),
        );
    }
    for (const leg of day.legs)
      if (
        !leg.evidenceIds.length ||
        leg.evidenceIds.some(
          (id) =>
            !trip.evidence.some((e) => e.id === id && e.status === "verified"),
        )
      )
        issues.push(
          issue("ROUTE_UNVERIFIED", "路线缺少可靠证据。", [leg.id], day.date),
        );
  }
  for (const alert of trip.alerts.filter((a) => a.severity === "blocking"))
    issues.push(issue(alert.code, alert.message, alert.entityIds));
  const publicText = JSON.stringify({
    days: trip.days,
    assumptions: trip.assumptions,
    alternatives: trip.alternatives,
  });
  if (
    /(?:实时(?:余票|库存|房态).{0,5}(?:已确认|充足|保证))|(?:已确认.{0,5}(?:库存|余票|房态))|(?:保证(?:有票|有房))/u.test(
      publicText,
    )
  )
    issues.push(
      issue("INVENTORY_PROMISE", "不能承诺实时余票、库存或房态。", [trip.id]),
    );
  return issues;
}
export function validateTrip(trip: Trip, baseline = trip): ValidationIssue[] {
  const parsed = TripSchema.safeParse(trip);
  if (!parsed.success)
    return [
      issue("INVALID_TRIP", "行程结构或输入超出支持范围。", [
        trip.id ?? "trip",
      ]),
    ];
  return [
    ...validateTimeAndScope(parsed.data),
    ...validateConstraints(parsed.data, baseline),
  ];
}
