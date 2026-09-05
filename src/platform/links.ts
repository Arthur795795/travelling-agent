import { z } from "zod";
import type { AgentToolRegistry } from "../agent/tools/registry.ts";
import { IsoDateSchema } from "../domain/schema.ts";
import { assertNoSensitiveData } from "../security/redaction.ts";

export const PlatformLinkInputSchema = z
  .object({
    platform: z.enum(["ctrip", "fliggy"]),
    type: z.enum(["flight", "train", "hotel", "search"]),
    origin: z.string().trim().min(1).max(100).optional(),
    destination: z.string().trim().min(1).max(100).optional(),
    originCode: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    destinationCode: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    departureDate: IsoDateSchema.optional(),
    returnDate: IsoDateSchema.optional(),
    city: z.string().trim().min(1).max(100).optional(),
    checkIn: IsoDateSchema.optional(),
    checkOut: IsoDateSchema.optional(),
    keyword: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .refine(
    (value) =>
      !value.returnDate ||
      !value.departureDate ||
      value.returnDate >= value.departureDate,
    {
      message: "Return date must not precede departure date",
      path: ["returnDate"],
    },
  )
  .refine(
    (value) =>
      !value.checkOut || !value.checkIn || value.checkOut > value.checkIn,
    {
      message: "Check-out must follow check-in",
      path: ["checkOut"],
    },
  );

export type PlatformLinkInput = z.infer<typeof PlatformLinkInputSchema>;

export interface PlatformLinkResult {
  platform: "ctrip" | "fliggy";
  type: PlatformLinkInput["type"];
  actionUrl: string;
  fallbackUrl: string;
  querySummary: string;
  generatedAt: string;
  prefilledFields: string[];
  unfilledFields: string[];
  degraded: boolean;
  requiresReconfirmation: true;
  inventoryChecked: false;
  thirdPartyService: true;
  commissionRelationship: "none";
  notice: string;
}

export type LinkReachabilityChecker = (
  url: string,
  signal?: AbortSignal,
) => Promise<boolean>;

const HOME = {
  ctrip: "https://www.ctrip.com/",
  fliggy: "https://www.fliggy.com/",
} as const;

function value(value: string | undefined, fallback = "未填写"): string {
  return value ?? fallback;
}

function summary(input: PlatformLinkInput): string {
  switch (input.type) {
    case "train":
      return `火车：${value(input.origin)} → ${value(input.destination)}，出发 ${value(input.departureDate)}`;
    case "flight":
      return `航班：${value(input.origin, input.originCode)} → ${value(input.destination, input.destinationCode)}，出发 ${value(input.departureDate)}${input.returnDate ? `，返程 ${input.returnDate}` : ""}`;
    case "hotel":
      return `酒店：${value(input.city)}，入住 ${value(input.checkIn)}，退房 ${value(input.checkOut)}${input.keyword ? `，关键词 ${input.keyword}` : ""}`;
    case "search":
      return `平台搜索：${value(input.keyword)}`;
  }
}

function buildLink(input: PlatformLinkInput): {
  url: string;
  prefilled: string[];
  unfilled: string[];
} {
  const prefilled: string[] = [];
  const unfilled: string[] = [];
  if (
    input.platform === "ctrip" &&
    input.type === "train" &&
    input.origin &&
    input.destination &&
    input.departureDate
  ) {
    const url = new URL(
      "https://trains.ctrip.com/TrainBooking/SearchTrain.aspx",
    );
    url.searchParams.set("from", input.origin);
    url.searchParams.set("to", input.destination);
    url.searchParams.set("day", input.departureDate);
    prefilled.push("origin", "destination", "departureDate");
    return { url: url.toString(), prefilled, unfilled };
  }
  if (
    input.platform === "ctrip" &&
    input.type === "flight" &&
    input.originCode &&
    input.destinationCode &&
    input.departureDate
  ) {
    const url = new URL(
      `https://flights.ctrip.com/online/list/oneway-${input.originCode}-${input.destinationCode}`,
    );
    url.searchParams.set("depdate", input.departureDate);
    prefilled.push("originCode", "destinationCode", "departureDate");
    if (input.returnDate) unfilled.push("returnDate");
    return { url: url.toString(), prefilled, unfilled };
  }
  for (const field of [
    "origin",
    "destination",
    "departureDate",
    "returnDate",
    "city",
    "checkIn",
    "checkOut",
    "keyword",
  ] as const) {
    if (input[field]) unfilled.push(field);
  }
  return { url: HOME[input.platform], prefilled, unfilled };
}

export class PlatformLinkGenerator {
  private readonly now: () => Date;
  private readonly checkReachable: LinkReachabilityChecker | undefined;

  constructor(
    now = () => new Date(),
    checkReachable?: LinkReachabilityChecker,
  ) {
    this.now = now;
    this.checkReachable = checkReachable;
  }

  async create(
    input: PlatformLinkInput,
    signal?: AbortSignal,
  ): Promise<PlatformLinkResult> {
    const query = PlatformLinkInputSchema.parse(input);
    assertNoSensitiveData(query);
    const generated = buildLink(query);
    const fallbackUrl = HOME[query.platform];
    const reachable = this.checkReachable
      ? await this.checkReachable(generated.url, signal).catch(() => false)
      : true;
    const degraded = !reachable;
    const actionUrl = degraded ? fallbackUrl : generated.url;
    const prefilledFields = degraded ? [] : generated.prefilled;
    const unfilledFields = degraded
      ? [...new Set([...generated.prefilled, ...generated.unfilled])]
      : generated.unfilled;
    return {
      platform: query.platform,
      type: query.type,
      actionUrl,
      fallbackUrl,
      querySummary: summary(query),
      generatedAt: this.now().toISOString(),
      prefilledFields,
      unfilledFields,
      degraded,
      requiresReconfirmation: true,
      inventoryChecked: false,
      thirdPartyService: true,
      commissionRelationship: "none",
      notice:
        "链接仅表达搜索条件，未读取实时价格、余票或房态；服务由第三方平台独立提供，本产品无返佣。",
    };
  }
}

export function registerPlatformLinkTool(
  registry: AgentToolRegistry,
  generator: PlatformLinkGenerator,
  isEnabled?: () => boolean,
): void {
  registry.register({
    name: "create_platform_link",
    inputSchema: PlatformLinkInputSchema,
    isEnabled,
    execute: async (input, context) => {
      try {
        return {
          status: "success",
          data: await generator.create(input, context.signal),
        };
      } catch {
        return {
          status: "non_retryable_error",
          code: "PLATFORM_LINK_INVALID",
          message: "Platform link input is invalid",
        };
      }
    },
  });
}
