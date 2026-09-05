import { z } from "zod";
import {
  BookedItemSchema,
  BudgetConstraintSchema,
  DayTripConstraintSchema,
  DEFAULT_TIME_ZONE,
  IsoDateSchema,
  SCHEMA_VERSION,
  TripBriefSchema,
  type TripBrief,
} from "../domain/schema.ts";
import { findSensitiveData } from "../security/redaction.ts";

const DraftPartySchema = z
  .object({
    adults: z.number().int().min(0).max(20),
    childrenAgeBands: z
      .array(z.enum(["0-2", "3-6", "7-12", "13-17"]))
      .max(20)
      .default([]),
    seniors: z.number().int().min(0).max(20).default(0),
    mobilityNotes: z.array(z.string().min(1).max(200)).max(10).default([]),
  })
  .strict();

export const RequirementInputSchema = z
  .object({
    origin: z.string().trim().min(1).max(200).optional(),
    destination: z.string().trim().min(1).max(200).optional(),
    destinations: z.array(z.string().trim().min(1).max(100)).max(10).optional(),
    destinationCandidates: z
      .array(z.string().trim().min(1).max(100))
      .min(2)
      .max(3)
      .optional(),
    startDate: IsoDateSchema.optional(),
    endDate: IsoDateSchema.optional(),
    durationDays: z.number().int().min(1).max(30).optional(),
    party: DraftPartySchema.optional(),
    budget: BudgetConstraintSchema.optional(),
    preferences: z.array(z.string().min(1).max(200)).max(30).optional(),
    hardConstraints: z.array(z.string().min(1).max(300)).max(30).optional(),
    bookedItems: z.array(BookedItemSchema).max(30).optional(),
    dayTrips: z.array(DayTripConstraintSchema).max(5).optional(),
  })
  .strict();

export type RequirementInput = z.input<typeof RequirementInputSchema>;

export interface RequirementIssue {
  field: string;
  code: string;
  severity: "warning" | "blocking";
  message: string;
}

export interface ClarifyingQuestion {
  id: string;
  title: string;
  field: string;
  prompt: string;
  recommendedAnswer: string;
  reason: string;
}

export type RequirementResult =
  | {
      state: "ready";
      support: "full";
      brief: TripBrief;
      issues: [];
      questions: [];
    }
  | {
      state: "needs_clarification";
      issues: RequirementIssue[];
      questions: ClarifyingQuestion[];
    }
  | {
      state: "destination_options";
      candidates: Array<{ city: string; support: "full" }>;
      issues: RequirementIssue[];
      questions: ClarifyingQuestion[];
    }
  | {
      state: "out_of_scope";
      support: "experimental" | "unsupported";
      issues: RequirementIssue[];
      options: Array<"shorten" | "split" | "experimental_draft">;
      questions: [];
    }
  | { state: "rejected"; issues: RequirementIssue[]; questions: [] };

export const FULL_SUPPORT_CITIES = [
  "北京",
  "上海",
  "重庆",
  "西安",
  "杭州",
] as const;

function shanghaiDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DEFAULT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function addYear(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCFullYear(value.getUTCFullYear() + 1);
  return value.toISOString().slice(0, 10);
}

function dayCount(start: string, end: string): number {
  return (
    Math.floor(
      (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
        86_400_000,
    ) + 1
  );
}

function normalizedCity(city: string): string {
  return city.trim().replace(/市$/, "");
}

const QUESTIONS: Record<string, Omit<ClarifyingQuestion, "id" | "field">> = {
  origin: {
    title: "出发地",
    prompt: "你从哪个城市出发？",
    recommendedAnswer: "填写实际出发城市",
    reason: "需要确定城际交通边界。",
  },
  destination: {
    title: "目的地",
    prompt: "请选择一个主要住宿城市。",
    recommendedAnswer: "从完整支持城市中选择一个",
    reason: "MVP 只完整支持单主城市行程。",
  },
  dates: {
    title: "旅行日期",
    prompt: "请提供开始日期和结束日期，或开始日期加 3–5 天时长。",
    recommendedAnswer: "提供确定日期",
    reason: "日期决定开放信息、交通和天气的核验范围。",
  },
  party: {
    title: "同行结构",
    prompt: "请填写成人、儿童和老人数量。",
    recommendedAnswer: "按实际同行结构填写",
    reason: "同行结构影响节奏、缓冲和适用活动。",
  },
  budget: {
    title: "预算",
    prompt: "请选择预算档位或填写预算上限。",
    recommendedAnswer: "balanced（适中）",
    reason: "预算是住宿、交通和活动筛选的必要约束。",
  },
  bookedItems: {
    title: "已预订项目",
    prompt: "请列出已订酒店、车次、航班；没有请明确填写空列表。",
    recommendedAnswer: "没有则确认“无”",
    reason: "已预订项目默认锁定，不能被规划覆盖。",
  },
  hardConstraints: {
    title: "硬约束",
    prompt: "请填写不可违反的要求；没有请明确确认。",
    recommendedAnswer: "没有则确认“无”",
    reason: "硬约束会进入确定性校验。",
  },
  preferences: {
    title: "旅行偏好",
    prompt: "请填写偏好；没有特别偏好可以明确确认。",
    recommendedAnswer: "没有则使用适中密度",
    reason: "偏好用于安排主题和节奏。",
  },
};

function question(field: keyof typeof QUESTIONS): ClarifyingQuestion {
  return { id: `question:${field}`, field, ...QUESTIONS[field] };
}

export function checkRequirements(
  input: unknown,
  now = () => new Date(),
): RequirementResult {
  const sensitive = findSensitiveData(input);
  if (sensitive) {
    return {
      state: "rejected",
      questions: [],
      issues: [
        {
          field: "input",
          code: "SENSITIVE_INPUT",
          severity: "blocking",
          message: "请移除个人身份、订单、支付或密钥信息后重试。",
        },
      ],
    };
  }
  const parsed = RequirementInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      state: "needs_clarification",
      questions: [],
      issues: parsed.error.issues.map((issue) => ({
        field: issue.path.join("."),
        code: "INVALID_INPUT",
        severity: "blocking" as const,
        message: issue.message,
      })),
    };
  }
  const value = parsed.data;
  const listedDestinations =
    value.destinations?.map(normalizedCity).filter(Boolean) ?? [];
  const inlineMultiple =
    value.destination
      ?.split(/[、,，\/]|(?:->)|(?:→)/)
      .map(normalizedCity)
      .filter(Boolean) ?? [];
  const destinations = listedDestinations.length
    ? listedDestinations
    : inlineMultiple;
  if (destinations.length > 1) {
    return {
      state: "out_of_scope",
      support: "unsupported",
      questions: [],
      options: ["split", "experimental_draft"],
      issues: [
        {
          field: "destination",
          code: "MULTI_CITY_UNSUPPORTED",
          severity: "blocking",
          message: "完整模式不支持多城连续旅行，请拆分为单主城市行程。",
        },
      ],
    };
  }
  const destination =
    destinations[0] ??
    (value.destination ? normalizedCity(value.destination) : undefined);
  if (!destination) {
    const defaults = FULL_SUPPORT_CITIES.filter(
      (city) => city !== normalizedCity(value.origin ?? ""),
    ).slice(0, 3);
    const requestedCandidates =
      value.destinationCandidates?.map(normalizedCity) ?? [];
    const supportedCandidates = [
      ...new Set([...requestedCandidates, ...defaults]),
    ]
      .filter((city) =>
        (FULL_SUPPORT_CITIES as readonly string[]).includes(city),
      )
      .slice(0, 3);
    const candidates = supportedCandidates.map((city) => ({
      city,
      support: "full" as const,
    }));
    return {
      state: "destination_options",
      candidates,
      issues: [
        {
          field: "destination",
          code: "DESTINATION_UNDECIDED",
          severity: "blocking",
          message: "目的地尚未确定，暂不启动完整规划。",
        },
      ],
      questions: [question("destination")],
    };
  }
  if (!(FULL_SUPPORT_CITIES as readonly string[]).includes(destination)) {
    return {
      state: "out_of_scope",
      support: "experimental",
      questions: [],
      options: ["experimental_draft"],
      issues: [
        {
          field: "destination",
          code: "EXPERIMENTAL_CITY",
          severity: "blocking",
          message: `${destination}当前只能生成实验性草案，不能标记为完整支持。`,
        },
      ],
    };
  }
  if (
    (value.dayTrips?.length ?? 0) > 1 ||
    value.dayTrips?.some(({ travelMinutesOneWay }) => travelMinutesOneWay > 120)
  ) {
    return {
      state: "out_of_scope",
      support: "unsupported",
      questions: [],
      options: ["shorten", "split", "experimental_draft"],
      issues: [
        {
          field: "dayTrips",
          code: "DAY_TRIP_SCOPE",
          severity: "blocking",
          message: "最多支持一个单程约 2 小时以内的周边一日游。",
        },
      ],
    };
  }

  const questions: ClarifyingQuestion[] = [];
  if (!value.origin) questions.push(question("origin"));
  const startDate = value.startDate;
  let endDate = value.endDate;
  if (startDate && !endDate && value.durationDays)
    endDate = addDays(startDate, value.durationDays - 1);
  if (!startDate || !endDate) questions.push(question("dates"));
  if (!value.party) questions.push(question("party"));
  if (!value.budget || (!value.budget.level && !value.budget.limit))
    questions.push(question("budget"));
  if (value.bookedItems === undefined) questions.push(question("bookedItems"));
  if (value.hardConstraints === undefined)
    questions.push(question("hardConstraints"));
  if (value.preferences === undefined) questions.push(question("preferences"));
  if (questions.length) {
    return {
      state: "needs_clarification",
      issues: questions.map(({ field }) => ({
        field,
        code: "REQUIRED_FIELD_MISSING",
        severity: "blocking",
        message: `${field} 尚未明确。`,
      })),
      questions: questions.slice(0, 5),
    };
  }

  const issues: RequirementIssue[] = [];
  const days = dayCount(startDate!, endDate!);
  if (days < 3 || days > 5)
    issues.push({
      field: "dates",
      code: "DURATION_OUT_OF_SCOPE",
      severity: "blocking",
      message: "完整模式仅支持 3–5 天。",
    });
  const today = shanghaiDate(now());
  if (startDate! < today || endDate! > addYear(today))
    issues.push({
      field: "dates",
      code: "DATE_OUT_OF_SCOPE",
      severity: "blocking",
      message: "日期必须在今天至未来 12 个月内。",
    });
  const partySize =
    value.party!.adults +
    value.party!.childrenAgeBands.length +
    value.party!.seniors;
  if (value.party!.adults < 1 || partySize < 1 || partySize > 6)
    issues.push({
      field: "party",
      code: "PARTY_OUT_OF_SCOPE",
      severity: "blocking",
      message: "完整模式仅支持 1–6 人且至少一名成人。",
    });
  if (issues.length) {
    return {
      state: "out_of_scope",
      support: "unsupported",
      issues,
      options: ["shorten", "split", "experimental_draft"],
      questions: [],
    };
  }

  const brief = TripBriefSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    origin: value.origin,
    destination,
    startDate,
    endDate,
    timeZone: DEFAULT_TIME_ZONE,
    party: value.party,
    budget: value.budget,
    preferences: value.preferences,
    hardConstraints: value.hardConstraints,
    bookedItems: value.bookedItems,
    dayTrips: value.dayTrips,
  });
  return { state: "ready", support: "full", brief, issues: [], questions: [] };
}
