import { createHash } from "node:crypto";
import { z } from "zod";
import {
  BookedItemSchema,
  EntityIdSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  SCHEMA_VERSION,
  StageResultSchema,
  TimeWindowSchema,
  TripBriefSchema,
  type TripBrief,
} from "../domain/schema.ts";
import type {
  DeepSeekResponseRequest,
  DeepSeekResponseResult,
} from "../providers/deepseek/responses-client.ts";
import { TransientSecret } from "../security/secrets.ts";

const SkeletonBlockSchema = z
  .object({
    theme: z.string().min(1).max(200),
    candidateAreas: z.array(z.string().min(1).max(100)).min(1).max(4),
    rationale: z.string().min(1).max(500),
  })
  .strict();

const TransportWindowSchema = z
  .object({
    purpose: z.string().min(1).max(200),
    window: TimeWindowSchema,
  })
  .strict();

const EvidenceRequestSchema = z
  .object({
    id: z.string().min(1).max(128),
    subjectRef: z.string().min(1).max(128),
    date: IsoDateSchema.optional(),
    field: z.enum([
      "place_details",
      "opening_hours",
      "reservation_rules",
      "route",
      "weather",
      "cost",
    ]),
    query: z.string().min(1).max(300),
    critical: z.boolean(),
    status: z.literal("pending"),
  })
  .strict();

const ModelSkeletonDaySchema = z
  .object({
    date: IsoDateSchema,
    morning: SkeletonBlockSchema.nullable(),
    afternoon: SkeletonBlockSchema.nullable(),
    transportWindows: z.array(TransportWindowSchema).max(6),
  })
  .strict();

const ModelSkeletonSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    days: z.array(ModelSkeletonDaySchema).min(3).max(5),
    evidenceRequests: z.array(EvidenceRequestSchema).min(1).max(100),
    assumptions: z.array(z.string().min(1).max(300)).max(20),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    value.evidenceRequests.forEach((request, index) => {
      if (seen.has(request.id)) {
        context.addIssue({
          code: "custom",
          path: ["evidenceRequests", index, "id"],
          message: "Evidence request IDs must be unique",
        });
      }
      seen.add(request.id);
    });
  });

const LockedSkeletonItemSchema = z
  .object({
    id: EntityIdSchema,
    type: z.enum(["hotel", "train", "flight", "activity", "other"]),
    title: z.string().min(1).max(200),
    start: IsoDateTimeSchema.optional(),
    end: IsoDateTimeSchema.optional(),
    locked: z.boolean(),
  })
  .strict();

export const ItinerarySkeletonSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    days: z
      .array(
        ModelSkeletonDaySchema.extend({
          lockedBookings: z.array(LockedSkeletonItemSchema),
        }),
      )
      .min(3)
      .max(5),
    unplacedLockedBookings: z.array(LockedSkeletonItemSchema),
    evidenceRequests: z.array(EvidenceRequestSchema).min(1).max(100),
    assumptions: z.array(z.string().min(1).max(300)).max(20),
    disclosedDefaults: z.array(z.string().min(1).max(300)).max(20),
  })
  .strict();

export type ItinerarySkeleton = z.infer<typeof ItinerarySkeletonSchema>;

export interface SkeletonStageOutput {
  skeleton: ItinerarySkeleton;
  stageResult: z.infer<typeof StageResultSchema>;
  model: string;
}

export class SkeletonPlanningError extends Error {
  readonly code:
    | "INVALID_MODEL_JSON"
    | "INVALID_SKELETON"
    | "UNSAFE_FACT_CLAIM";

  constructor(code: SkeletonPlanningError["code"], message: string) {
    super(message);
    this.name = "SkeletonPlanningError";
    this.code = code;
  }
}

export interface SkeletonModelClient {
  createResponse(
    secret: TransientSecret,
    request: DeepSeekResponseRequest,
  ): Promise<DeepSeekResponseResult>;
}

export const SKELETON_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "days", "evidenceRequests", "assumptions"],
  properties: {
    schemaVersion: { const: 1 },
    days: {
      type: "array",
      minItems: 3,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["date", "morning", "afternoon", "transportWindows"],
        properties: {
          date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          morning: { anyOf: [{ $ref: "#/$defs/block" }, { type: "null" }] },
          afternoon: { anyOf: [{ $ref: "#/$defs/block" }, { type: "null" }] },
          transportWindows: {
            type: "array",
            maxItems: 6,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["purpose", "window"],
              properties: {
                purpose: { type: "string", minLength: 1, maxLength: 200 },
                window: {
                  type: "object",
                  additionalProperties: false,
                  required: ["start", "end", "flexibilityMinutes"],
                  properties: {
                    start: { type: "string", format: "date-time" },
                    end: { type: "string", format: "date-time" },
                    flexibilityMinutes: { type: "integer", minimum: 0 },
                  },
                },
              },
            },
          },
        },
      },
    },
    evidenceRequests: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "subjectRef", "field", "query", "critical", "status"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 128 },
          subjectRef: { type: "string", minLength: 1, maxLength: 128 },
          date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          field: {
            enum: [
              "place_details",
              "opening_hours",
              "reservation_rules",
              "route",
              "weather",
              "cost",
            ],
          },
          query: { type: "string", minLength: 1, maxLength: 300 },
          critical: { type: "boolean" },
          status: { const: "pending" },
        },
      },
    },
    assumptions: {
      type: "array",
      maxItems: 20,
      items: { type: "string", minLength: 1, maxLength: 300 },
    },
  },
  $defs: {
    block: {
      type: "object",
      additionalProperties: false,
      required: ["theme", "candidateAreas", "rationale"],
      properties: {
        theme: { type: "string", minLength: 1, maxLength: 200 },
        candidateAreas: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: { type: "string", minLength: 1, maxLength: 100 },
        },
        rationale: { type: "string", minLength: 1, maxLength: 500 },
      },
    },
  },
};

const DisclosedDefaultsSchema = z.array(z.string().min(1).max(300)).max(20);

function dateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = Date.parse(`${end}T00:00:00Z`);
  while (cursor.getTime() <= last) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function localDate(timestamp: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

function bookingDates(
  booking: z.infer<typeof BookedItemSchema>,
  tripDates: string[],
): string[] {
  if (!booking.start) return [];
  const start = localDate(booking.start);
  if (booking.type !== "hotel" || !booking.end)
    return tripDates.includes(start) ? [start] : [];
  const end = localDate(booking.end);
  return tripDates.filter((date) => date >= start && date <= end);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const UNSAFE_FACT_CLAIM =
  /实时(?:余票|库存|房态|价格)|(?:确认|保证)(?:有票|有房|可预订)|已核验|已确认开放|开放时间为/;

export class SkeletonPlanner {
  private readonly model: SkeletonModelClient;
  private readonly now: () => Date;

  constructor(model: SkeletonModelClient, now = () => new Date()) {
    this.model = model;
    this.now = now;
  }

  async plan(
    secret: TransientSecret,
    briefInput: TripBrief,
    disclosedDefaults: string[] = [
      "默认适中密度：上午、下午各一个核心主题",
      "普通市内移动将在后续阶段单独增加缓冲",
    ],
  ): Promise<SkeletonStageOutput> {
    const brief = TripBriefSchema.parse(briefInput);
    const defaults = DisclosedDefaultsSchema.safeParse(disclosedDefaults);
    if (!defaults.success)
      throw new SkeletonPlanningError(
        "INVALID_SKELETON",
        "Disclosed defaults are invalid",
      );
    const expectedDates = dateRange(brief.startDate, brief.endDate);
    if (expectedDates.length < 3 || expectedDates.length > 5) {
      throw new SkeletonPlanningError(
        "INVALID_SKELETON",
        "Skeleton planning requires a 3–5 day brief",
      );
    }
    const startedAt = this.now().toISOString();
    const requestContext = {
      brief,
      lockedBookings: brief.bookedItems,
      disclosedDefaults: defaults.data,
    };
    const response = await this.model.createResponse(secret, {
      instructions: [
        "你是旅行行程骨架规划器。只输出符合 JSON Schema 的 JSON。",
        "每天只规划上午/下午主题、候选区域和必要交通时间窗。",
        "不要声称任何实时价格、库存、余票、房态、开放时间或事实已经核验。",
        "把地点详情、开放/预约规则、路线、天气和费用全部列为 pending evidenceRequests。",
        "锁定预订由系统确定性合并，不要修改。",
      ].join("\n"),
      input: JSON.stringify(requestContext),
      // Real V4 Pro runs have reached ~7.7k total output tokens because
      // reasoning shares this budget. Leave room for the structured answer
      // while using light reasoning for this constrained transformation.
      maxOutputTokens: 12_000,
      textFormat: {
        type: "json_schema",
        name: "itinerary_skeleton",
        schema: SKELETON_JSON_SCHEMA,
      },
      reasoningEffort: "low",
    });
    if (UNSAFE_FACT_CLAIM.test(response.outputText)) {
      throw new SkeletonPlanningError(
        "UNSAFE_FACT_CLAIM",
        "Skeleton contains a fact or inventory claim that requires evidence",
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(response.outputText);
    } catch {
      throw new SkeletonPlanningError(
        "INVALID_MODEL_JSON",
        "Skeleton model output is not valid JSON",
      );
    }
    const parsed = ModelSkeletonSchema.safeParse(raw);
    if (!parsed.success)
      throw new SkeletonPlanningError(
        "INVALID_SKELETON",
        "Skeleton model output does not match the runtime schema",
      );
    if (
      parsed.data.days.map(({ date }) => date).join("|") !==
      expectedDates.join("|")
    ) {
      throw new SkeletonPlanningError(
        "INVALID_SKELETON",
        "Skeleton dates do not match the TripBrief",
      );
    }
    const evidenceFields = new Set(
      parsed.data.evidenceRequests.map(({ field }) => field),
    );
    const hasRules =
      evidenceFields.has("opening_hours") ||
      evidenceFields.has("reservation_rules");
    if (
      !evidenceFields.has("place_details") ||
      !hasRules ||
      !evidenceFields.has("route") ||
      !evidenceFields.has("weather") ||
      !evidenceFields.has("cost")
    ) {
      throw new SkeletonPlanningError(
        "INVALID_SKELETON",
        "Skeleton evidence requests must cover places, rules, routes, weather, and cost",
      );
    }

    const placed = new Set<string>();
    const days = parsed.data.days.map((day) => {
      const lockedBookings = brief.bookedItems
        .filter((booking) => {
          const matches = bookingDates(booking, expectedDates).includes(
            day.date,
          );
          if (matches) placed.add(booking.id);
          return matches;
        })
        .map(({ id, type, title, start, end, locked }) => ({
          id,
          type,
          title,
          start,
          end,
          locked,
        }));
      if (!day.morning && !day.afternoon && lockedBookings.length === 0) {
        throw new SkeletonPlanningError(
          "INVALID_SKELETON",
          `Skeleton day ${day.date} has no theme or locked booking`,
        );
      }
      return { ...day, lockedBookings };
    });
    const unplacedLockedBookings = brief.bookedItems
      .filter(({ id }) => !placed.has(id))
      .map(({ id, type, title, start, end, locked }) => ({
        id,
        type,
        title,
        start,
        end,
        locked,
      }));
    const skeleton = ItinerarySkeletonSchema.parse({
      ...parsed.data,
      days,
      unplacedLockedBookings,
      disclosedDefaults: defaults.data,
    });
    const completedAt = this.now().toISOString();
    return {
      skeleton,
      model: response.model,
      stageResult: StageResultSchema.parse({
        stage: "skeleton_planning",
        status: "completed",
        startedAt,
        completedAt,
        summary: `已生成 ${skeleton.days.length} 天行程骨架和 ${skeleton.evidenceRequests.length} 项待取证清单。`,
        inputDigest: digest(requestContext),
        outputDigest: digest(skeleton),
        tokenUsage: {
          input: response.usage.inputTokens,
          output: response.usage.outputTokens,
        },
        estimatedCostCny: response.estimatedCostCny,
      }),
    };
  }
}
