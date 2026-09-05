import { z } from "zod";

export const SCHEMA_VERSION = 1 as const;
export const DEFAULT_TIME_ZONE = "Asia/Shanghai" as const;

export const EntityIdSchema = z.string().min(1).max(128);
export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
    );
  }, "Expected a valid calendar date");
export const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const EvidenceStatusSchema = z.enum([
  "verified",
  "recheck_required",
  "failed",
]);
export const TripLifecycleSchema = z.enum([
  "draft",
  "checked",
  "executable",
  "blocked",
]);
export const JobStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_for_credentials",
  "completed",
  "failed",
  "cancelled",
]);
export const SeveritySchema = z.enum(["info", "warning", "blocking"]);
export const PlanningStageSchema = z.enum([
  "requirements_check",
  "skeleton_planning",
  "evidence_collection",
  "route_and_budget",
  "hard_validation",
  "repair",
  "finalization",
]);

export const MoneySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("exact"),
    currency: z.string().length(3).default("CNY"),
    amount: z.number().finite().nonnegative(),
    confidence: z.enum(["high", "medium", "low"]).default("medium"),
  }),
  z
    .object({
      kind: z.literal("range"),
      currency: z.string().length(3).default("CNY"),
      min: z.number().finite().nonnegative(),
      max: z.number().finite().nonnegative(),
      confidence: z.enum(["high", "medium", "low"]).default("medium"),
    })
    .refine((value) => value.max >= value.min, {
      message: "Money range max must be greater than or equal to min",
      path: ["max"],
    }),
  z.object({
    kind: z.literal("unknown"),
    currency: z.string().length(3).default("CNY"),
    reason: z.string().min(1),
  }),
]);

export const TimeWindowSchema = z
  .object({
    start: IsoDateTimeSchema,
    end: IsoDateTimeSchema,
    flexibilityMinutes: z.number().int().nonnegative().default(0),
  })
  .refine((value) => Date.parse(value.end) > Date.parse(value.start), {
    message: "Time window end must be after start",
    path: ["end"],
  });

export const PartySchema = z
  .object({
    adults: z.number().int().min(1).max(6),
    childrenAgeBands: z
      .array(z.enum(["0-2", "3-6", "7-12", "13-17"]))
      .max(5)
      .default([]),
    seniors: z.number().int().min(0).max(5).default(0),
    mobilityNotes: z.array(z.string().min(1).max(200)).max(10).default([]),
  })
  .refine(
    (value) =>
      value.adults + value.childrenAgeBands.length + value.seniors <= 6,
    { message: "Total party size must not exceed 6" },
  );

export const BudgetConstraintSchema = z.object({
  level: z.enum(["economy", "balanced", "comfort", "premium"]).optional(),
  limit: MoneySchema.optional(),
  includes: z
    .array(
      z.enum(["intercity", "lodging", "tickets", "meals", "local_transport"]),
    )
    .default(["intercity", "lodging", "tickets", "meals", "local_transport"]),
  contingencyPercent: z.number().min(0).max(100).default(10),
});

export const BookedItemSchema = z
  .object({
    id: EntityIdSchema,
    type: z.enum(["hotel", "train", "flight", "activity", "other"]),
    title: z.string().min(1).max(200),
    start: IsoDateTimeSchema.optional(),
    end: IsoDateTimeSchema.optional(),
    locationText: z.string().min(1).max(300).optional(),
    paidCost: MoneySchema.optional(),
    locked: z.boolean().default(true),
    source: z.literal("user"),
  })
  .refine(
    (value) =>
      !value.start ||
      !value.end ||
      Date.parse(value.end) > Date.parse(value.start),
    {
      message: "Booked item end must be after start",
      path: ["end"],
    },
  );

export const DayTripConstraintSchema = z
  .object({
    destination: z.string().trim().min(1).max(100),
    travelMinutesOneWay: z
      .number()
      .int()
      .positive()
      .max(24 * 60),
  })
  .strict();

export const TripBriefSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    origin: z.string().min(1).max(200),
    destination: z.string().min(1).max(200),
    startDate: IsoDateSchema,
    endDate: IsoDateSchema,
    timeZone: z.literal(DEFAULT_TIME_ZONE).default(DEFAULT_TIME_ZONE),
    party: PartySchema,
    budget: BudgetConstraintSchema,
    preferences: z.array(z.string().min(1).max(200)).max(30).default([]),
    hardConstraints: z.array(z.string().min(1).max(300)).max(30).default([]),
    bookedItems: z.array(BookedItemSchema).max(30).default([]),
    dayTrips: z.array(DayTripConstraintSchema).max(1).default([]),
  })
  .refine((value) => value.endDate >= value.startDate, {
    message: "Trip endDate must be on or after startDate",
    path: ["endDate"],
  });

export const PlaceSchema = z.object({
  id: EntityIdSchema,
  name: z.string().min(1).max(200),
  address: z.string().max(500).optional(),
  city: z.string().min(1).max(100),
  cityCode: z.string().max(20).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  category: z.string().max(100).optional(),
  source: z.enum(["user", "amap", "official", "platform", "web"]),
});

export const SourceTypeSchema = z.enum([
  "official",
  "dedicated_api",
  "platform",
  "web",
]);
export const ClaimValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const EvidenceSchema = z.object({
  id: EntityIdSchema,
  sourceType: SourceTypeSchema,
  sourceName: z.string().min(1).max(200),
  url: z.string().url().optional(),
  checkedAt: IsoDateTimeSchema,
  status: EvidenceStatusSchema,
  assertedValue: ClaimValueSchema.optional(),
  excerpt: z.string().max(1_000).optional(),
});

export const ClaimSchema = z.object({
  id: EntityIdSchema,
  subjectId: EntityIdSchema,
  placeId: EntityIdSchema.optional(),
  date: IsoDateSchema.optional(),
  critical: z.boolean().optional(),
  field: z.string().min(1).max(100),
  value: ClaimValueSchema.optional(),
  evidenceIds: z.array(EntityIdSchema).default([]),
  status: EvidenceStatusSchema,
  checkedAt: IsoDateTimeSchema.optional(),
  conflictEvidenceIds: z.array(EntityIdSchema).default([]),
});

export const ReservationSchema = z.object({
  required: z.boolean(),
  instructions: z.string().max(500).optional(),
  actionUrl: z.string().url().optional(),
  status: EvidenceStatusSchema,
});

export const ActivitySchema = z.object({
  id: EntityIdSchema,
  title: z.string().min(1).max(200),
  timeWindow: TimeWindowSchema,
  durationMinutes: z
    .number()
    .int()
    .positive()
    .max(24 * 60),
  place: PlaceSchema,
  importance: z.enum(["core", "optional", "fallback"]),
  locked: z.boolean().default(false),
  cost: MoneySchema,
  reservation: ReservationSchema.optional(),
  rationale: z.string().min(1).max(1_000),
  evidenceIds: z.array(EntityIdSchema).default([]),
  fallbackActivityId: EntityIdSchema.optional(),
  bookingId: EntityIdSchema.optional(),
  availabilityWindows: z.array(TimeWindowSchema).optional(),
});

export const TransportLegSchema = z.object({
  id: EntityIdSchema,
  fromPlaceId: EntityIdSchema,
  toPlaceId: EntityIdSchema,
  mode: z.enum([
    "walk",
    "public_transit",
    "taxi",
    "drive",
    "train",
    "flight",
    "other",
  ]),
  departureWindow: TimeWindowSchema,
  durationMinutes: z
    .object({
      min: z.number().int().nonnegative(),
      max: z.number().int().nonnegative(),
    })
    .refine((value) => value.max >= value.min, {
      message: "Duration max must be >= min",
      path: ["max"],
    }),
  bufferMinutes: z.number().int().nonnegative(),
  cost: MoneySchema,
  locked: z.boolean().default(false),
  evidenceIds: z.array(EntityIdSchema).default([]),
  externalActionUrl: z.string().url().optional(),
  bookingId: EntityIdSchema.optional(),
});

export const TripDaySchema = z.object({
  id: EntityIdSchema,
  date: IsoDateSchema,
  title: z.string().min(1).max(200),
  activities: z.array(ActivitySchema),
  legs: z.array(TransportLegSchema),
  notes: z.array(z.string().max(500)).default([]),
});

export const CostItemSchema = z.object({
  id: EntityIdSchema,
  category: z.enum([
    "intercity",
    "lodging",
    "tickets",
    "meals",
    "local_transport",
    "other",
  ]),
  title: z.string().min(1).max(200),
  cost: MoneySchema,
  paymentStatus: z.enum(["paid", "estimated", "unknown"]),
  evidenceIds: z.array(EntityIdSchema).default([]),
});

export const TripBudgetSchema = z.object({
  items: z.array(CostItemSchema),
  contingencyPercent: z.number().min(0).max(100),
  total: MoneySchema,
  withinLimit: z.boolean().optional(),
});

export const AlertSchema = z.object({
  id: EntityIdSchema,
  severity: SeveritySchema,
  code: z.string().min(1).max(100),
  message: z.string().min(1).max(1_000),
  entityIds: z.array(EntityIdSchema).default([]),
});

export const AlternativeSchema = z.object({
  id: EntityIdSchema,
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(1_000),
  trigger: z.string().min(1).max(500),
  affectedEntityIds: z.array(EntityIdSchema).default([]),
});

export const TripSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: EntityIdSchema,
  version: z.number().int().positive(),
  brief: TripBriefSchema,
  model: z.string().min(1).max(100).optional(),
  preset: z
    .object({
      id: EntityIdSchema,
      checkedAt: IsoDateTimeSchema,
      notice: z.string().min(1).max(500),
      humanReviewed: z.boolean(),
    })
    .strict()
    .optional(),
  assumptions: z.array(z.string().min(1).max(500)).default([]),
  lockedBookings: z.array(BookedItemSchema).default([]),
  days: z.array(TripDaySchema).min(1).max(5),
  budget: TripBudgetSchema,
  evidence: z.array(EvidenceSchema).default([]),
  claims: z.array(ClaimSchema).default([]),
  alerts: z.array(AlertSchema).default([]),
  alternatives: z.array(AlternativeSchema).default([]),
  lifecycleStatus: TripLifecycleSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export const ValidationIssueSchema = z.object({
  id: EntityIdSchema,
  severity: SeveritySchema,
  code: z.string().min(1).max(100),
  message: z.string().min(1).max(1_000),
  entityIds: z.array(EntityIdSchema).default([]),
  path: z.array(z.union([z.string(), z.number()])).default([]),
});

export const TripRevisionSchema = z
  .object({
    id: EntityIdSchema,
    tripId: EntityIdSchema,
    baseVersion: z.number().int().positive(),
    nextVersion: z.number().int().positive(),
    summary: z.string().min(1).max(1_000),
    createdAt: IsoDateTimeSchema,
  })
  .refine((value) => value.nextVersion > value.baseVersion, {
    message: "Revision nextVersion must be greater than baseVersion",
    path: ["nextVersion"],
  });

export const StageResultSchema = z
  .object({
    stage: PlanningStageSchema,
    status: z.enum(["completed", "failed", "cancelled"]),
    startedAt: IsoDateTimeSchema,
    completedAt: IsoDateTimeSchema,
    summary: z.string().max(1_000),
    inputDigest: z.string().max(256).optional(),
    outputDigest: z.string().max(256).optional(),
    tokenUsage: z
      .object({
        input: z.number().int().nonnegative(),
        output: z.number().int().nonnegative(),
      })
      .optional(),
    estimatedCostCny: z.number().nonnegative().optional(),
  })
  .refine(
    (value) => Date.parse(value.completedAt) >= Date.parse(value.startedAt),
    {
      message: "Stage completion must not precede its start",
      path: ["completedAt"],
    },
  );

export const PlanningJobSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    id: EntityIdSchema,
    version: z.number().int().nonnegative(),
    status: JobStatusSchema,
    currentStage: PlanningStageSchema.optional(),
    currentStageStartedAt: IsoDateTimeSchema.optional(),
    tripId: EntityIdSchema.optional(),
    stageResults: z.array(StageResultSchema).default([]),
    cancelRequested: z.boolean().default(false),
    errorCode: z.string().max(100).optional(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
  })
  .refine(
    (value) =>
      Boolean(value.currentStage) === Boolean(value.currentStageStartedAt),
    {
      message: "Current stage and its start time must be present together",
      path: ["currentStageStartedAt"],
    },
  );

export const ShareRecordSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: EntityIdSchema,
  readTokenHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/i, "Expected a SHA-256 token hash"),
  deleteTokenHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/i, "Expected a SHA-256 token hash"),
  trip: TripSchema,
  visibleFields: z.array(z.string().min(1).max(100)),
  createdAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
  deletedAt: IsoDateTimeSchema.optional(),
});

export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>;
export type TripLifecycle = z.infer<typeof TripLifecycleSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
export type PlanningStage = z.infer<typeof PlanningStageSchema>;
export type StageResult = z.infer<typeof StageResultSchema>;
export type Money = z.infer<typeof MoneySchema>;
export type TripBrief = z.infer<typeof TripBriefSchema>;
export type Place = z.infer<typeof PlaceSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type Trip = z.infer<typeof TripSchema>;
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;
export type TripRevision = z.infer<typeof TripRevisionSchema>;
export type PlanningJob = z.infer<typeof PlanningJobSchema>;
export type ShareRecord = z.infer<typeof ShareRecordSchema>;

export class UnsupportedTripSchemaVersionError extends Error {
  readonly code = "UNSUPPORTED_TRIP_SCHEMA_VERSION";
  readonly schemaVersion: unknown;

  constructor(schemaVersion: unknown) {
    super(`Unsupported Trip schema version: ${String(schemaVersion)}`);
    this.name = "UnsupportedTripSchemaVersionError";
    this.schemaVersion = schemaVersion;
  }
}

/**
 * Version-aware parsing entry point. Future legacy migrations belong here,
 * before validation with the current schema.
 */
export function parseTripDocument(input: unknown): Trip {
  if (input && typeof input === "object" && "schemaVersion" in input) {
    const schemaVersion = (input as { schemaVersion?: unknown }).schemaVersion;
    if (schemaVersion !== SCHEMA_VERSION)
      throw new UnsupportedTripSchemaVersionError(schemaVersion);
  }
  return TripSchema.parse(input);
}

export function parseTrip(input: unknown): Trip {
  return parseTripDocument(input);
}

export function parseTripBrief(input: unknown): TripBrief {
  return TripBriefSchema.parse(input);
}

export function serializeTrip(input: unknown): string {
  return JSON.stringify(parseTrip(input));
}
