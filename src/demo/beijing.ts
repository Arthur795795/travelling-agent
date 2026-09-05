import { TripSchema, type Trip, type Money } from "../domain/schema.ts";
import { totalBudget, validateTrip } from "../validation/trip.ts";
export const DEMO_CHECKED_AT = "2026-09-05T00:00:00Z";
export const DEMO_NOTICE =
  "北京四日固定模拟案例，非实时生成；预订、路线和报价是演示条件，不代表真实预约或库存。";
const money = (amount: number): Money => ({
  kind: "exact",
  currency: "CNY",
  amount,
  confidence: "medium",
});
const window = (date: string, start: string, end: string) => ({
  start: `${date}T${start}:00+08:00`,
  end: `${date}T${end}:00+08:00`,
  flexibilityMinutes: 15,
});
export function beijingDemo(): Trip {
  const trip: Trip = {
    schemaVersion: 1,
    id: "demo-beijing-four-days",
    version: 1,
    model: "deepseek-v4-pro",
    preset: {
      id: "beijing-four-days",
      checkedAt: DEMO_CHECKED_AT,
      notice: DEMO_NOTICE,
      humanReviewed: false,
    },
    brief: {
      schemaVersion: 1,
      origin: "上海",
      destination: "北京",
      startDate: "2026-10-06",
      endDate: "2026-10-09",
      timeZone: "Asia/Shanghai",
      party: { adults: 2, childrenAgeBands: [], seniors: 0, mobilityNotes: [] },
      budget: {
        level: "balanced",
        limit: money(8000),
        includes: [
          "intercity",
          "lodging",
          "tickets",
          "meals",
          "local_transport",
        ],
        contingencyPercent: 10,
      },
      preferences: ["历史文化", "适中节奏"],
      hardConstraints: ["不安排凌晨出发"],
      bookedItems: [],
      dayTrips: [],
    },
    assumptions: [
      DEMO_NOTICE,
      "所有时间窗与费用均为固定场景条件；实际出发前需重新核验。",
    ],
    lockedBookings: [
      {
        id: "demo-hotel",
        type: "hotel",
        title: "东城住宿（模拟已订）",
        start: "2026-10-06T14:00:00+08:00",
        end: "2026-10-09T12:00:00+08:00",
        locked: true,
        source: "user",
        paidCost: money(1800),
      },
    ],
    days: [],
    budget: { items: [], total: money(0), contingencyPercent: 10 },
    evidence: [],
    claims: [],
    alerts: [],
    alternatives: [],
    lifecycleStatus: "checked",
    createdAt: DEMO_CHECKED_AT,
    updatedAt: DEMO_CHECKED_AT,
  };
  trip.brief.bookedItems = structuredClone(trip.lockedBookings);
  const names = [
    ["抵达北京与酒店休息", "王府井街区散步"],
    ["故宫博物院", "景山周边休息"],
    ["中国国家博物馆", "前门街区散步"],
    ["东城街区早餐", "前往车站返程"],
  ];
  for (let index = 0; index < 4; index++) {
    const date = `2026-10-0${index + 6}`;
    const activities = names[index].map((title, n) => {
      const id = `demo-a-${index}-${n}`;
      const eid = `demo-e-${index}-${n}`;
      const url =
        title === "故宫博物院"
          ? "https://www.dpm.org.cn/Visit.html"
          : title === "中国国家博物馆"
            ? "https://www.chnmuseum.cn/"
            : undefined;
      trip.evidence.push({
        id: eid,
        sourceType: "web",
        sourceName: "固定案例条件（非实时核验）",
        url,
        checkedAt: DEMO_CHECKED_AT,
        status: "verified",
        assertedValue: "预设场景条件已校验",
        excerpt:
          "本记录仅用于可复现演示。官网链接供重新核对，不证明所选日期已预约成功。",
      });
      for (const field of ["address", "opening_hours", "reservation_rules"])
        trip.claims.push({
          id: `${eid}-${field}`,
          subjectId: id,
          date,
          field,
          value: "预设场景条件已校验",
          status: "verified",
          evidenceIds: [eid],
          conflictEvidenceIds: [],
        });
      return {
        id,
        title,
        place: {
          id: `demo-p-${index}-${n}`,
          name: title,
          city: "北京",
          source: "user" as const,
        },
        timeWindow: window(date, n ? "14:00" : "09:00", n ? "16:00" : "11:00"),
        durationMinutes: 120,
        importance: "core" as const,
        locked: false,
        cost: money(title === "故宫博物院" ? 120 : 0),
        rationale: "固定场景活动，空档用于用餐和休息",
        evidenceIds: [eid],
        reservation: {
          required: title.includes("博物"),
          status: "verified" as const,
          instructions: "模拟预约条件，实际须到官网确认",
        },
        availabilityWindows: [window(date, "08:00", "18:00")],
      };
    });
    const legId = `demo-leg-${index}`;
    trip.evidence.push({
      id: `${legId}-e`,
      sourceType: "web",
      sourceName: "固定模拟交通（非高德实测）",
      checkedAt: DEMO_CHECKED_AT,
      status: "verified",
      assertedValue: 50,
    });
    const leg = {
      id: legId,
      fromPlaceId: activities[0].place.id,
      toPlaceId: activities[1].place.id,
      mode: "public_transit" as const,
      departureWindow: window(date, "11:00", "13:00"),
      durationMinutes: { min: 30, max: 50 },
      bufferMinutes: 20,
      cost: money(20),
      locked: false,
      evidenceIds: [`${legId}-e`],
    };
    trip.days.push({
      id: `demo-day-${index}`,
      date,
      title: `第 ${index + 1} 天`,
      activities,
      legs: [leg],
      notes: ["11:00–14:00 之间含移动、午餐和休息；费用为演示预算。"],
    });
    activities.forEach((a) =>
      trip.budget.items.push({
        id: `cost-${a.id}`,
        title: a.title,
        category: "tickets",
        paymentStatus: "estimated",
        cost: a.cost,
        evidenceIds: a.evidenceIds,
      }),
    );
    trip.budget.items.push({
      id: `cost-${legId}`,
      title: "市内交通模拟预算",
      category: "local_transport",
      paymentStatus: "estimated",
      cost: leg.cost,
      evidenceIds: leg.evidenceIds,
    });
    trip.alternatives.push({
      id: `alt-${index}`,
      title: "缩短活动并休息",
      description: "在原区域留白，不改变已订酒店",
      trigger: "疲劳",
      affectedEntityIds: activities.map((a) => a.id),
    });
  }
  for (const [category, amount] of [
    ["intercity", 1400],
    ["lodging", 1800],
    ["meals", 800],
  ] as const)
    trip.budget.items.push({
      id: `cost-${category}`,
      title: `${category} 固定预算`,
      category,
      cost: money(amount),
      paymentStatus: category === "lodging" ? "paid" : "estimated",
      evidenceIds: [],
    });
  trip.budget.total = totalBudget(trip);
  const result = TripSchema.parse(trip);
  if (validateTrip(result).some((i) => i.severity === "blocking"))
    throw new Error("INVALID_DEMO");
  return result;
}
export const DEMO_SCENARIOS = [
  { id: "rain", title: "下雨：减少户外活动", date: "2026-10-06" },
  {
    id: "reservation",
    title: "未预约成功：取消故宫并留白",
    date: "2026-10-07",
  },
  { id: "fatigue", title: "临时疲劳：缩短下午散步", date: "2026-10-08" },
] as const;
export function demoScenario(id: string): Trip {
  const scenario = DEMO_SCENARIOS.find((s) => s.id === id);
  if (!scenario) throw new Error("UNKNOWN_SCENARIO");
  const trip = beijingDemo();
  const day = trip.days.find((d) => d.date === scenario.date)!;
  if (id === "reservation") {
    day.activities[0].importance = "fallback";
    day.notes = ["故宫未预约成功：不入馆，上午留白；下午按原区域散步。"];
    const item = trip.budget.items.find(
      (i) => i.id === `cost-${day.activities[0].id}`,
    )!;
    item.cost = money(0);
    item.title = "未预约成功，不计入主方案门票";
  } else if (id === "rain") {
    day.activities[1].importance = "fallback";
    day.notes = ["预设下雨情境：下午户外散步移为备选，酒店休息。"];
  } else {
    day.activities[1].durationMinutes = 60;
    day.activities[1].timeWindow.end = `${day.date}T15:00:00+08:00`;
    day.notes = ["预设疲劳情境：缩短散步，增加休息。"];
  }
  trip.budget.total = totalBudget(trip);
  trip.version++;
  if (validateTrip(trip, beijingDemo()).some((i) => i.severity === "blocking"))
    throw new Error("INVALID_SCENARIO");
  return TripSchema.parse(trip);
}
export function copyDemo(id = crypto.randomUUID()) {
  const trip = beijingDemo();
  trip.id = id;
  return trip;
}
