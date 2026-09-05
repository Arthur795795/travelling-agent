import { z } from "zod";
import {
  EntityIdSchema,
  PlaceSchema,
  type Place,
} from "../../domain/schema.ts";
import type {
  AgentToolRegistry,
  ToolHandlerResult,
} from "../../agent/tools/registry.ts";
import { AmapClient, AmapError } from "./client.ts";

export const AmapPlaceSearchInputSchema = z
  .object({
    keyword: z.string().trim().min(1).max(100),
    city: z.string().trim().min(1).max(40),
    maxResults: z.number().int().min(1).max(10).default(5),
  })
  .strict();

export const AmapPlaceDetailsInputSchema = z
  .object({
    amapId: EntityIdSchema,
  })
  .strict();

export type AmapPlaceSearchInput = z.infer<typeof AmapPlaceSearchInputSchema>;
export type AmapPlaceDetailsInput = z.infer<typeof AmapPlaceDetailsInputSchema>;

export interface AmapPlaceCandidate {
  place: Place;
  amapId: string;
  adcode?: string;
  cityCode?: string;
  checkedAt: string;
}

export type AmapPlaceSearchResult =
  | {
      status: "success";
      candidates: AmapPlaceCandidate[];
      ambiguous: boolean;
      checkedAt: string;
    }
  | {
      status: "no_results";
      candidates: [];
      ambiguous: false;
      checkedAt: string;
    };

function text(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

function candidateFrom(
  raw: unknown,
  fallbackCity: string,
  checkedAt: string,
): AmapPlaceCandidate | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const item = raw as Record<string, unknown>;
  const amapId = text(item.id);
  const name = text(item.name);
  if (!amapId || !name) return undefined;
  const location = text(item.location)?.split(",").map(Number);
  const coordinates =
    location?.length === 2 && location.every(Number.isFinite)
      ? location
      : undefined;
  const address = text(item.address);
  const place = PlaceSchema.parse({
    id: `amap:${amapId}`,
    name,
    address,
    city: text(item.cityname) ?? fallbackCity,
    longitude: coordinates?.[0],
    latitude: coordinates?.[1],
    category: text(item.type),
    source: "amap",
  });
  return {
    place,
    amapId,
    adcode: text(item.adcode),
    cityCode: text(item.citycode),
    checkedAt,
  };
}

export class AmapPlacesAdapter {
  private readonly client: AmapClient;

  constructor(client: AmapClient) {
    this.client = client;
  }

  async search(
    input: AmapPlaceSearchInput,
    signal?: AbortSignal,
  ): Promise<AmapPlaceSearchResult> {
    const query = AmapPlaceSearchInputSchema.parse(input);
    const response = await this.client.request(
      "/v3/place/text",
      {
        keywords: query.keyword,
        city: query.city,
        citylimit: "true",
        extensions: "base",
        offset: query.maxResults,
        page: 1,
      },
      signal,
    );
    if (!Array.isArray(response.data.pois))
      throw new AmapError(
        "invalid_response",
        true,
        "Amap place response is missing candidates",
      );
    const rawPois = response.data.pois;
    const candidates = rawPois
      .map((item) => candidateFrom(item, query.city, response.checkedAt))
      .filter((item): item is AmapPlaceCandidate => Boolean(item))
      .slice(0, query.maxResults);
    if (rawPois.length && !candidates.length)
      throw new AmapError(
        "invalid_response",
        true,
        "Amap returned invalid place candidates",
      );
    if (candidates.length === 0)
      return {
        status: "no_results",
        candidates: [],
        ambiguous: false,
        checkedAt: response.checkedAt,
      };
    return {
      status: "success",
      candidates,
      ambiguous: candidates.length > 1,
      checkedAt: response.checkedAt,
    };
  }

  async details(
    input: AmapPlaceDetailsInput,
    signal?: AbortSignal,
  ): Promise<AmapPlaceCandidate | null> {
    const query = AmapPlaceDetailsInputSchema.parse(input);
    const response = await this.client.request(
      "/v3/place/detail",
      { id: query.amapId, extensions: "all" },
      signal,
    );
    if (!Array.isArray(response.data.pois))
      throw new AmapError(
        "invalid_response",
        true,
        "Amap place response is missing candidates",
      );
    const rawPois = response.data.pois;
    if (!rawPois.length) return null;
    const candidate = candidateFrom(rawPois[0], "未知城市", response.checkedAt);
    if (!candidate)
      throw new AmapError(
        "invalid_response",
        true,
        "Amap returned invalid place details",
      );
    return candidate;
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
    code: "AMAP_PLACE_INVALID",
    message: "Amap place request is invalid",
  };
}

export function registerAmapPlaceTools(
  registry: AgentToolRegistry,
  adapter: AmapPlacesAdapter,
  isEnabled?: () => boolean,
): void {
  registry.register<AmapPlaceSearchInput, AmapPlaceSearchResult>({
    name: "search_places",
    inputSchema: AmapPlaceSearchInputSchema,
    isEnabled,
    execute: async (input, context) => {
      try {
        return {
          status: "success",
          data: await adapter.search(input, context.signal),
        };
      } catch (error) {
        return toolError(error);
      }
    },
  });
  registry.register<AmapPlaceDetailsInput, AmapPlaceCandidate>({
    name: "get_place_details",
    inputSchema: AmapPlaceDetailsInputSchema,
    isEnabled,
    execute: async (input, context) => {
      try {
        const data = await adapter.details(input, context.signal);
        return data
          ? { status: "success", data }
          : {
              status: "non_retryable_error",
              code: "AMAP_PLACE_NOT_FOUND",
              message: "Amap place was not found",
            };
      } catch (error) {
        return toolError(error);
      }
    },
  });
}
