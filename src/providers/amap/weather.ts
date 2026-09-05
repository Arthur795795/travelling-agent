import { z } from "zod";
import {
  EntityIdSchema,
  EvidenceSchema,
  IsoDateSchema,
  type Evidence,
} from "../../domain/schema.ts";
import type { AgentToolRegistry } from "../../agent/tools/registry.ts";
import { AmapClient, AmapError } from "./client.ts";

export const AmapWeatherInputSchema = z
  .object({
    subjectId: EntityIdSchema,
    adcode: z.string().regex(/^\d{6}$/),
    date: IsoDateSchema,
  })
  .strict();

export type AmapWeatherInput = z.infer<typeof AmapWeatherInputSchema>;

export interface WeatherFact {
  date: string;
  dayWeather: string;
  nightWeather: string;
  minTemperatureC: number;
  maxTemperatureC: number;
  precipitationExpected: boolean;
  severeWeather: boolean;
}

export interface WeatherResult {
  status: "verified" | "recheck_required" | "failed";
  fact?: WeatherFact;
  evidence: Evidence;
  reminder?: { type: "weather_recheck"; date: string; message: string };
  failureCode?:
    | "authentication"
    | "quota"
    | "invalid_request"
    | "timeout"
    | "cancelled"
    | "network_error"
    | "invalid_response"
    | "upstream_error"
    | "invalid_input";
}

const SEVERE_WEATHER =
  /暴雨|大暴雨|特大暴雨|雷暴|雷阵雨|冰雹|台风|暴雪|大雪|冻雨|沙尘暴|大风/;
const PRECIPITATION = /雨|雪|冰雹/;

function dateInShanghai(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
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

function reportTime(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.includes("T")
    ? value
    : `${value.replace(" ", "T")}+08:00`;
  return Number.isNaN(Date.parse(normalized)) ? fallback : normalized;
}

function makeEvidence(
  input: AmapWeatherInput,
  checkedAt: string,
  status: Evidence["status"],
  excerpt: string,
): Evidence {
  return EvidenceSchema.parse({
    id: `weather:${input.adcode}:${input.date}`,
    sourceType: "dedicated_api",
    sourceName: "高德天气",
    checkedAt,
    status,
    excerpt,
  });
}

export class AmapWeatherAdapter {
  private readonly client: AmapClient;
  private readonly now: () => Date;

  constructor(client: AmapClient, now = () => new Date()) {
    this.client = client;
    this.now = now;
  }

  async weather(
    input: AmapWeatherInput,
    signal?: AbortSignal,
  ): Promise<WeatherResult> {
    const query = AmapWeatherInputSchema.parse(input);
    const now = this.now();
    const checkedAt = now.toISOString();
    const today = dateInShanghai(now);
    const lastReliableDate = addDays(today, 2);
    if (query.date < today || query.date > lastReliableDate) {
      return {
        status: "recheck_required",
        evidence: makeEvidence(
          query,
          checkedAt,
          "recheck_required",
          "请求日期超出高德三日预报的可靠窗口，未生成具体天气。",
        ),
        reminder: {
          type: "weather_recheck",
          date: query.date > lastReliableDate ? addDays(query.date, -2) : today,
          message: "请在出行日期进入三日预报窗口后重新查询天气。",
        },
      };
    }

    try {
      const response = await this.client.request(
        "/v3/weather/weatherInfo",
        {
          city: query.adcode,
          extensions: "all",
        },
        signal,
      );
      const forecast = Array.isArray(response.data.forecasts)
        ? response.data.forecasts[0]
        : undefined;
      const forecastRecord =
        forecast && typeof forecast === "object"
          ? (forecast as Record<string, unknown>)
          : undefined;
      const casts = Array.isArray(forecastRecord?.casts)
        ? forecastRecord.casts
        : [];
      const cast = casts.find(
        (value) =>
          value &&
          typeof value === "object" &&
          (value as Record<string, unknown>).date === query.date,
      ) as Record<string, unknown> | undefined;
      const sourceCheckedAt = reportTime(
        forecastRecord?.reporttime,
        response.checkedAt,
      );
      const dayWeather =
        typeof cast?.dayweather === "string" ? cast.dayweather.trim() : "";
      const nightWeather =
        typeof cast?.nightweather === "string" ? cast.nightweather.trim() : "";
      const dayTemperature = Number(cast?.daytemp);
      const nightTemperature = Number(cast?.nighttemp);
      const hasTemperature = (value: unknown) =>
        (typeof value === "number" ||
          (typeof value === "string" && value.trim() !== "")) &&
        Number.isFinite(Number(value));
      if (
        !cast ||
        !dayWeather ||
        !nightWeather ||
        !hasTemperature(cast.daytemp) ||
        !hasTemperature(cast.nighttemp)
      ) {
        return {
          status: "recheck_required",
          evidence: makeEvidence(
            query,
            sourceCheckedAt,
            "recheck_required",
            "天气响应缺少完整的日间、夜间或温度字段。",
          ),
          reminder: {
            type: "weather_recheck",
            date: today,
            message: "天气字段不完整，请稍后重新查询。",
          },
        };
      }
      const description = `${dayWeather}转${nightWeather}，${Math.min(dayTemperature, nightTemperature)}–${Math.max(dayTemperature, nightTemperature)}℃`;
      const combinedWeather = `${dayWeather} ${nightWeather}`;
      const fact: WeatherFact = {
        date: query.date,
        dayWeather,
        nightWeather,
        minTemperatureC: Math.min(dayTemperature, nightTemperature),
        maxTemperatureC: Math.max(dayTemperature, nightTemperature),
        precipitationExpected: PRECIPITATION.test(combinedWeather),
        severeWeather: SEVERE_WEATHER.test(combinedWeather),
      };
      return {
        status: "verified",
        fact,
        evidence: EvidenceSchema.parse({
          ...makeEvidence(query, sourceCheckedAt, "verified", description),
          assertedValue: description,
        }),
        reminder: {
          type: "weather_recheck",
          date: query.date,
          message: "出发前请再次确认最新天气和预警。",
        },
      };
    } catch (error) {
      const retryable = error instanceof AmapError ? error.retryable : false;
      return {
        status: retryable ? "recheck_required" : "failed",
        failureCode: error instanceof AmapError ? error.code : "invalid_input",
        evidence: makeEvidence(
          query,
          checkedAt,
          retryable ? "recheck_required" : "failed",
          "天气数据源暂时不可用，未生成具体天气。",
        ),
        reminder: {
          type: "weather_recheck",
          date: today,
          message: "天气查询失败，请稍后重试。",
        },
      };
    }
  }
}

export function registerAmapWeatherTool(
  registry: AgentToolRegistry,
  adapter: AmapWeatherAdapter,
  isEnabled?: () => boolean,
): void {
  registry.register({
    name: "get_weather",
    inputSchema: AmapWeatherInputSchema,
    isEnabled,
    execute: async (input, context) => {
      const data = await adapter.weather(input, context.signal);
      if (data.failureCode === "authentication") {
        return {
          status: "blocked",
          code: "AMAP_AUTHENTICATION",
          message: "Amap server credential is unavailable",
          data,
          evidenceIds: [data.evidence.id],
        };
      }
      return data.status === "failed"
        ? {
            status: "non_retryable_error",
            code: "WEATHER_FAILED",
            message: "Weather source failed",
            data,
            evidenceIds: [data.evidence.id],
          }
        : { status: "success", data, evidenceIds: [data.evidence.id] };
    },
  });
}
