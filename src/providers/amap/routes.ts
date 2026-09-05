import { z } from "zod";
import {
  EntityIdSchema,
  TimeWindowSchema,
  TransportLegSchema,
  type Money,
} from "../../domain/schema.ts";
import type {
  AgentToolRegistry,
  ToolHandlerResult,
} from "../../agent/tools/registry.ts";
import { AmapClient, AmapError } from "./client.ts";

const CoordinateSchema = z
  .object({
    longitude: z.number().min(-180).max(180),
    latitude: z.number().min(-90).max(90),
  })
  .strict();

export const AmapRouteInputSchema = z
  .object({
    legId: EntityIdSchema,
    fromPlaceId: EntityIdSchema,
    toPlaceId: EntityIdSchema,
    origin: CoordinateSchema,
    destination: CoordinateSchema,
    mode: z.enum(["walk", "public_transit", "drive", "taxi"]),
    departureWindow: TimeWindowSchema,
    cityCodeFrom: z.string().min(1).max(20).optional(),
    cityCodeTo: z.string().min(1).max(20).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.mode === "public_transit" &&
      (!value.cityCodeFrom || !value.cityCodeTo)
    ) {
      context.addIssue({
        code: "custom",
        message: "Transit routes require both city codes",
        path: ["cityCodeFrom"],
      });
    }
  });

export type AmapRouteInput = z.infer<typeof AmapRouteInputSchema>;

export type AmapRouteResult =
  | {
      status: "success";
      leg: z.infer<typeof TransportLegSchema>;
      distanceMeters: number;
      theoreticalDurationMinutes: number;
      suggestedBufferMinutes: number;
      transferSummary?: string;
      checkedAt: string;
    }
  | {
      status: "blocked";
      code: "no_route" | "cross_city_unsupported" | "abnormal_route";
      checkedAt: string;
    };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function firstRecord(value: unknown): Record<string, unknown> | undefined {
  return Array.isArray(value) ? record(value[0]) : undefined;
}

function transferText(transit: Record<string, unknown>): string | undefined {
  if (!Array.isArray(transit.segments)) return undefined;
  const names: string[] = [];
  for (const segmentValue of transit.segments) {
    const segment = record(segmentValue);
    const bus = record(segment?.bus);
    if (!Array.isArray(bus?.buslines)) continue;
    for (const lineValue of bus.buslines) {
      const name = record(lineValue)?.name;
      if (typeof name === "string" && name.trim()) names.push(name.trim());
    }
  }
  return names.length ? [...new Set(names)].join(" → ") : undefined;
}

function routeCost(
  mode: AmapRouteInput["mode"],
  route: Record<string, unknown>,
  path: Record<string, unknown>,
): Money {
  if (mode === "walk")
    return { kind: "exact", currency: "CNY", amount: 0, confidence: "high" };
  if (mode === "taxi") {
    const estimate =
      finiteNumber(route.taxi_cost) ?? finiteNumber(record(path.cost)?.taxi);
    if (estimate !== undefined) {
      return {
        kind: "range",
        currency: "CNY",
        min: Number((estimate * 0.85).toFixed(2)),
        max: Number((estimate * 1.15).toFixed(2)),
        confidence: "low",
      };
    }
  }
  if (mode === "public_transit") {
    const fare =
      finiteNumber(record(path.cost)?.transit_fee) ?? finiteNumber(path.cost);
    if (fare !== undefined)
      return {
        kind: "exact",
        currency: "CNY",
        amount: fare,
        confidence: "medium",
      };
  }
  return {
    kind: "unknown",
    currency: "CNY",
    reason: "高德路线结果未提供完整出行费用",
  };
}

export class AmapRoutesAdapter {
  private readonly client: AmapClient;
  private readonly now: () => Date;

  constructor(client: AmapClient, now = () => new Date()) {
    this.client = client;
    this.now = now;
  }

  async route(
    input: AmapRouteInput,
    signal?: AbortSignal,
  ): Promise<AmapRouteResult> {
    const query = AmapRouteInputSchema.parse(input);
    if (
      query.mode !== "public_transit" &&
      query.cityCodeFrom &&
      query.cityCodeTo &&
      query.cityCodeFrom !== query.cityCodeTo
    ) {
      return {
        status: "blocked",
        code: "cross_city_unsupported",
        checkedAt: this.now().toISOString(),
      };
    }
    const endpoint =
      query.mode === "public_transit"
        ? "/v5/direction/transit/integrated"
        : query.mode === "walk"
          ? "/v5/direction/walking"
          : "/v5/direction/driving";
    const coordinate = (point: z.infer<typeof CoordinateSchema>) =>
      `${point.longitude.toFixed(6)},${point.latitude.toFixed(6)}`;
    const response = await this.client.request(
      endpoint,
      {
        origin: coordinate(query.origin),
        destination: coordinate(query.destination),
        city1: query.mode === "public_transit" ? query.cityCodeFrom : undefined,
        city2: query.mode === "public_transit" ? query.cityCodeTo : undefined,
        strategy: query.mode === "public_transit" ? 0 : 32,
        show_fields: "cost",
        AlternativeRoute: query.mode === "public_transit" ? 1 : undefined,
      },
      signal,
    );
    const route = record(response.data.route) ?? {};
    const path =
      query.mode === "public_transit"
        ? firstRecord(route.transits)
        : firstRecord(route.paths);
    if (!path)
      return {
        status: "blocked",
        code: "no_route",
        checkedAt: response.checkedAt,
      };
    const costData = record(path.cost);
    const durationSeconds =
      finiteNumber(costData?.duration) ?? finiteNumber(path.duration);
    const distanceMeters = finiteNumber(path.distance);
    if (
      durationSeconds === undefined ||
      distanceMeters === undefined ||
      (distanceMeters > 0 && durationSeconds === 0) ||
      durationSeconds > 12 * 60 * 60
    ) {
      return {
        status: "blocked",
        code: "abnormal_route",
        checkedAt: response.checkedAt,
      };
    }
    const durationMinutes = Math.ceil(durationSeconds / 60);
    const transportMode = query.mode === "taxi" ? "taxi" : query.mode;
    const leg = TransportLegSchema.parse({
      id: query.legId,
      fromPlaceId: query.fromPlaceId,
      toPlaceId: query.toPlaceId,
      mode: transportMode,
      departureWindow: query.departureWindow,
      durationMinutes: { min: durationMinutes, max: durationMinutes },
      bufferMinutes: 0,
      cost: routeCost(query.mode, route, path),
      locked: false,
      evidenceIds: [],
    });
    return {
      status: "success",
      leg,
      distanceMeters,
      theoreticalDurationMinutes: durationMinutes,
      suggestedBufferMinutes: query.mode === "public_transit" ? 20 : 15,
      transferSummary:
        query.mode === "public_transit" ? transferText(path) : undefined,
      checkedAt: response.checkedAt,
    };
  }
}

function toolError(error: unknown): ToolHandlerResult<never> {
  if (error instanceof AmapError) {
    if (error.code === "authentication")
      return {
        status: "blocked",
        code: "AMAP_AUTHENTICATION",
        message: error.message,
      };
    return {
      status: error.retryable ? "retryable_error" : "non_retryable_error",
      code: `AMAP_${error.code.toUpperCase()}`,
      message: error.message,
    };
  }
  return {
    status: "non_retryable_error",
    code: "AMAP_ROUTE_INVALID",
    message: "Amap route request is invalid",
  };
}

export function registerAmapRouteTool(
  registry: AgentToolRegistry,
  adapter: AmapRoutesAdapter,
  isEnabled?: () => boolean,
): void {
  registry.register<
    AmapRouteInput,
    Extract<AmapRouteResult, { status: "success" }>
  >({
    name: "calculate_route",
    inputSchema: AmapRouteInputSchema,
    isEnabled,
    execute: async (input, context) => {
      try {
        const data = await adapter.route(input, context.signal);
        return data.status === "success"
          ? { status: "success", data }
          : {
              status: "blocked",
              code: `AMAP_${data.code.toUpperCase()}`,
              message: "Amap could not provide a usable route",
            };
      } catch (error) {
        return toolError(error);
      }
    },
  });
}
