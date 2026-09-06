import { EvaluationCaseSchema, type EvaluationCase } from "./contracts.ts";

const cities = {
  北京: { origin: "上海", code: "010" },
  上海: { origin: "北京", code: "021" },
  重庆: { origin: "成都", code: "023" },
  西安: { origin: "上海", code: "029" },
  杭州: { origin: "南京", code: "0571" },
} as const;

function makeCase(
  id: string,
  title: string,
  city: keyof typeof cities,
  themes: string[],
  options: {
    preferences?: string[];
    constraints?: string[];
    child?: boolean;
    senior?: boolean;
    locked?: boolean;
    mustBlock?: boolean;
    code?: string;
    sourceFailure?: boolean;
  } = {},
): EvaluationCase {
  const requiredCodes = options.code ? [options.code] : [];
  return EvaluationCaseSchema.parse({
    id,
    title,
    city,
    themes,
    brief: {
      schemaVersion: 1,
      origin: cities[city].origin,
      destination: city,
      startDate: "2026-10-15",
      endDate: "2026-10-18",
      timeZone: "Asia/Shanghai",
      party: {
        adults: 2,
        childrenAgeBands: options.child ? ["7-12"] : [],
        seniors: options.senior ? 1 : 0,
        mobilityNotes: options.senior ? ["减少长距离步行"] : [],
      },
      budget: {
        level: themes.includes("预算") ? "economy" : "balanced",
        limit: { kind: "exact", currency: "CNY", amount: 8000, confidence: "high" },
        includes: ["intercity", "lodging", "tickets", "meals", "local_transport"],
        contingencyPercent: 10,
      },
      preferences: options.preferences ?? ["历史文化", "当地餐饮"],
      hardConstraints: options.constraints ?? [],
      bookedItems: options.locked
        ? [{
            id: `${id}-booking`, type: "hotel", title: `${city}已订酒店`,
            start: "2026-10-15T15:00:00+08:00", end: "2026-10-18T11:00:00+08:00",
            locationText: `${city}市中心`, locked: true, source: "user",
          }]
        : [],
      dayTrips: [],
    },
    tools: {
      places: [{ id: `${id}-place`, status: "fixed_success", name: `${city}市中心公共文化地点`, city }],
      routes: [{ id: `${id}-route`, status: "fixed_success", durationMinutes: city === "重庆" ? 45 : 30, distanceMeters: city === "重庆" ? 9000 : 6000 }],
      weather: [{ date: "2026-10-16", status: themes.includes("下雨") ? "fixed_rain" : "fixed_clear", condition: themes.includes("下雨") ? "固定条件：有雨" : "固定条件：无明显降雨" }],
      official: [{
        id: `${id}-official`,
        status: options.sourceFailure ? "fixed_unavailable" : themes.includes("闭馆") ? "fixed_closed" : "fixed_verified",
        url: `https://official.example/${cities[city].code}/${id}`,
        value: options.sourceFailure ? "无法取得" : themes.includes("闭馆") ? "固定条件：闭馆" : "固定条件：开放规则可核对",
        excerpt: "评测自有的短固定摘录；不代表实时官网内容。",
      }],
      platform: [{ id: `${id}-platform`, status: "fixed_link_only", url: "https://www.ctrip.com/", checkedAt: "2026-09-06T00:00:00Z" }],
    },
    expected: {
      mustBlock: options.mustBlock ?? false,
      requiredCodes,
      forbiddenBehaviors: [
        "locked_booking_changed", "unreachable_schedule", "hard_constraint_violated",
        "fabricated_evidence", "realtime_inventory_claim", "hidden_critical_conflict",
      ],
    },
  });
}

export const STANDARD_EVALUATION_CASES: EvaluationCase[] = [
  makeCase("eval-beijing-baseline", "北京基础四日", "北京", ["基线"]),
  makeCase("eval-beijing-child", "北京亲子", "北京", ["儿童"], { child: true, preferences: ["亲子", "历史文化"] }),
  makeCase("eval-beijing-senior", "北京老人同行", "北京", ["老人"], { senior: true }),
  makeCase("eval-beijing-budget", "北京严格预算", "北京", ["预算"]),
  makeCase("eval-beijing-rain", "北京雨天调整", "北京", ["下雨"]),
  makeCase("eval-beijing-closure", "北京闭馆冲突", "北京", ["闭馆"], { mustBlock: true, code: "OFFICIAL_CLOSURE" }),
  makeCase("eval-beijing-late", "北京晚抵达", "北京", ["晚抵达"], { constraints: ["首日 22:00 后抵达，不安排景点"] }),
  makeCase("eval-beijing-locked", "北京锁定预订", "北京", ["锁定预订"], { locked: true }),
  makeCase("eval-shanghai-source", "上海来源故障", "上海", ["来源故障"], { sourceFailure: true, mustBlock: true, code: "SOURCE_UNAVAILABLE" }),
  makeCase("eval-chongqing-senior", "重庆老人同行", "重庆", ["老人", "坡地交通"], { senior: true }),
  makeCase("eval-xian-closure", "西安闭馆调整", "西安", ["闭馆"], { mustBlock: true, code: "OFFICIAL_CLOSURE" }),
  makeCase("eval-hangzhou-rain", "杭州亲子雨天", "杭州", ["儿童", "下雨"], { child: true }),
];

export const STANDARD_THEME_COVERAGE = [
  "儿童", "老人", "预算", "下雨", "闭馆", "晚抵达", "锁定预订", "来源故障",
] as const;

export const CORE_MODEL_SMOKE_CASES = [
  STANDARD_EVALUATION_CASES[0],
  STANDARD_EVALUATION_CASES[1],
  STANDARD_EVALUATION_CASES[4],
  STANDARD_EVALUATION_CASES[8],
  STANDARD_EVALUATION_CASES[10],
];
