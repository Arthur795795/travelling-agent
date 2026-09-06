import { z } from "zod";
import { createHash } from "node:crypto";
import type { AgentToolRegistry } from "../agent/tools/registry.ts";
import {
  EntityIdSchema,
  EvidenceSchema,
  type Evidence,
} from "../domain/schema.ts";
import {
  DeepSeekResponseError,
  type DeepSeekResponseResult,
} from "../providers/deepseek/responses-client.ts";
import {
  SafeFetchError,
  safeFetchText,
  type SafeFetchResult,
} from "../security/safe-fetch.ts";

const PublicHttpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "Expected an HTTP or HTTPS URL");

export const SearchResultInputSchema = z
  .object({
    title: z.string().min(1).max(300),
    url: PublicHttpUrlSchema,
    snippet: z.string().max(1_000).default(""),
  })
  .strict();

export const WebSearchToolInputSchema = z
  .object({
    query: z.string().trim().min(1).max(300),
    expectedOfficialHosts: z
      .array(z.string().min(1).max(253))
      .max(20)
      .default([]),
  })
  .strict();

export const OfficialPageToolInputSchema = z
  .object({
    subjectId: EntityIdSchema,
    field: z.string().min(1).max(100),
    candidate: z
      .object({
        title: z.string().min(1).max(300),
        url: PublicHttpUrlSchema,
        snippet: z.string().max(1_000),
        category: z.enum(["official", "carrier", "platform", "web"]),
        sourceType: z.enum(["official", "platform", "web"]),
        status: z.literal("discovery_only"),
      })
      .strict(),
    queryTerms: z.array(z.string().trim().min(1).max(100)).min(1).max(10),
  })
  .strict();

export type SearchResultInput = z.infer<typeof SearchResultInputSchema>;
export type SearchCandidate = z.infer<
  typeof OfficialPageToolInputSchema
>["candidate"];
type SourceType = Evidence["sourceType"];

function stablePageId(value: string): string {
  const digest = createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 24);
  return `page:${digest.match(/.{1,4}/g)!.join("-")}`;
}

const PLATFORM_HOSTS = [
  "ctrip.com",
  "trip.com",
  "fliggy.com",
  "qunar.com",
  "amap.com",
];
const CARRIER_HOSTS = [
  "12306.cn",
  "airchina.com.cn",
  "ceair.com",
  "csair.com",
  "hainanairlines.com",
];

function hostMatches(hostname: string, expected: string): boolean {
  const normalized = expected.toLowerCase().replace(/^www\./, "");
  const host = hostname.toLowerCase().replace(/^www\./, "");
  return host === normalized || host.endsWith(`.${normalized}`);
}

export function classifySearchResult(
  result: SearchResultInput,
  expectedOfficialHosts: string[] = [],
): SearchCandidate {
  const parsed = SearchResultInputSchema.parse(result);
  const hostname = new URL(parsed.url).hostname;
  let category: SearchCandidate["category"] = "web";
  let sourceType: SourceType = "web";
  if (expectedOfficialHosts.some((host) => hostMatches(hostname, host))) {
    category = "official";
    sourceType = "official";
  } else if (CARRIER_HOSTS.some((host) => hostMatches(hostname, host))) {
    category = "carrier";
    sourceType = "official";
  } else if (PLATFORM_HOSTS.some((host) => hostMatches(hostname, host))) {
    category = "platform";
    sourceType = "platform";
  }
  return { ...parsed, category, sourceType, status: "discovery_only" };
}

export function candidatesFromDeepSeek(
  response: DeepSeekResponseResult,
  expectedOfficialHosts: string[] = [],
): SearchCandidate[] {
  const seen = new Set<string>();
  const candidates: SearchCandidate[] = [];
  for (const citation of response.citations) {
    if (seen.has(citation.url)) continue;
    seen.add(citation.url);
    const url = PublicHttpUrlSchema.safeParse(citation.url);
    if (!url.success) continue;
    const snippet =
      citation.startIndex !== undefined && citation.endIndex !== undefined
        ? response.outputText.slice(citation.startIndex, citation.endIndex)
        : "";
    candidates.push(
      classifySearchResult(
        {
          title: citation.title ?? new URL(url.data).hostname,
          url: url.data,
          snippet,
        },
        expectedOfficialHosts,
      ),
    );
  }
  return candidates;
}

function pageText(body: string, contentType: string): string {
  if (contentType === "application/json")
    return body.replace(/\s+/g, " ").trim();
  return body
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function findExcerpt(
  text: string,
  terms: string[],
): { excerpt: string; start: number; end: number } | undefined {
  const normalized = text.toLocaleLowerCase();
  const positions = terms
    .map((term) => normalized.indexOf(term.toLocaleLowerCase()))
    .filter((position) => position >= 0);
  if (!positions.length) return undefined;
  const center = Math.min(...positions);
  const start = Math.max(0, center - 160);
  const end = Math.min(text.length, center + 340);
  return { excerpt: text.slice(start, end), start, end };
}

export interface PageEvidenceResult {
  status: "success" | "failed";
  evidence: Evidence;
  position?: { textStart: number; textEnd: number };
  failureCode?:
    | "unsafe_url"
    | "login_required"
    | "captcha"
    | "unavailable"
    | "fact_not_found";
}

export class OfficialPageEvidenceReader {
  private readonly fetchText: (
    url: string,
    signal?: AbortSignal,
  ) => Promise<SafeFetchResult>;
  private readonly now: () => Date;

  constructor(
    fetchText: (
      url: string,
      signal?: AbortSignal,
    ) => Promise<SafeFetchResult> = (url, signal) =>
      safeFetchText(url, { signal }),
    now = () => new Date(),
  ) {
    this.fetchText = fetchText;
    this.now = now;
  }

  async read(
    input: z.infer<typeof OfficialPageToolInputSchema>,
    signal?: AbortSignal,
  ): Promise<PageEvidenceResult> {
    const query = OfficialPageToolInputSchema.parse(input);
    const evidenceBase = {
      id: stablePageId(
        `${query.subjectId}|${query.field}|${query.candidate.url}|${this.now().toISOString()}`,
      ),
      sourceType: query.candidate.sourceType,
      sourceName: query.candidate.title,
      url: query.candidate.url,
      checkedAt: this.now().toISOString(),
    };
    let response: SafeFetchResult;
    try {
      response = await this.fetchText(query.candidate.url, signal);
    } catch (error) {
      const failureCode =
        error instanceof SafeFetchError &&
        (error.code === "BLOCKED_ADDRESS" || error.code === "INVALID_URL")
          ? "unsafe_url"
          : "unavailable";
      return {
        status: "failed",
        failureCode,
        evidence: EvidenceSchema.parse({
          ...evidenceBase,
          status: "failed",
          excerpt: "页面无法安全读取。",
        }),
      };
    }
    if (response.status < 200 || response.status >= 300) {
      return {
        status: "failed",
        failureCode: "unavailable",
        evidence: EvidenceSchema.parse({
          ...evidenceBase,
          status: "failed",
          excerpt: "页面返回了不可用状态。",
        }),
      };
    }
    const text = pageText(response.body, response.contentType);
    if (/验证码|captcha|robot check|人机验证/i.test(text)) {
      return {
        status: "failed",
        failureCode: "captcha",
        evidence: EvidenceSchema.parse({
          ...evidenceBase,
          status: "failed",
          excerpt: "页面要求验证码，已停止读取。",
        }),
      };
    }
    if (/登录后|请先登录|sign in to continue|login required/i.test(text)) {
      return {
        status: "failed",
        failureCode: "login_required",
        evidence: EvidenceSchema.parse({
          ...evidenceBase,
          status: "failed",
          excerpt: "页面要求登录，已停止读取。",
        }),
      };
    }
    const located = findExcerpt(text, query.queryTerms);
    if (!located) {
      return {
        status: "failed",
        failureCode: "fact_not_found",
        evidence: EvidenceSchema.parse({
          ...evidenceBase,
          status: "recheck_required",
          excerpt: "页面可访问，但未找到目标事实。",
        }),
      };
    }
    const originalHost = new URL(query.candidate.url).hostname;
    const finalHost = new URL(response.url).hostname;
    const sameSourceHost =
      hostMatches(finalHost, originalHost) ||
      hostMatches(originalHost, finalHost);
    const sourceType = sameSourceHost ? query.candidate.sourceType : "web";
    const evidenceStatus =
      sourceType === "official" ? "verified" : "recheck_required";
    return {
      status: "success",
      evidence: EvidenceSchema.parse({
        ...evidenceBase,
        sourceType,
        url: response.url,
        status: evidenceStatus,
        assertedValue: located.excerpt,
        excerpt: located.excerpt,
      }),
      position: { textStart: located.start, textEnd: located.end },
    };
  }
}

export type DeepSeekSearchProvider = (
  query: string,
  signal: AbortSignal,
) => Promise<DeepSeekResponseResult>;

export function registerSearchEvidenceTools(
  registry: AgentToolRegistry,
  search: DeepSeekSearchProvider,
  reader: OfficialPageEvidenceReader,
  isEnabled?: () => boolean,
): void {
  registry.register({
    name: "web_search",
    inputSchema: WebSearchToolInputSchema,
    isEnabled,
    execute: async (input, context) => {
      try {
        const response = await search(input.query, context.signal);
        return {
          status: "success",
          data: {
            candidates: candidatesFromDeepSeek(
              response,
              input.expectedOfficialHosts,
            ),
            status: "discovery_only" as const,
          },
          usageEvents: [
            { type: "search", count: 1 },
            {
              type: "model",
              inputTokens: response.usage.inputTokens,
              outputTokens: response.usage.outputTokens,
              estimatedCostCny: response.estimatedCostCny,
              payer: "visitor",
            },
          ],
        };
      } catch (error) {
        if (error instanceof DeepSeekResponseError) {
          return {
            status: error.retryable ? "retryable_error" : "non_retryable_error",
            code: `WEB_SEARCH_${error.code.toUpperCase()}`,
            message: error.message,
          };
        }
        return {
          status: "retryable_error",
          code: "WEB_SEARCH_FAILED",
          message: "Web search failed",
        };
      }
    },
  });
  registry.register({
    name: "read_official_page",
    inputSchema: OfficialPageToolInputSchema,
    isEnabled,
    execute: async (input, context) => {
      const data = await reader.read(input, context.signal);
      return data.status === "success"
        ? { status: "success", data, evidenceIds: [data.evidence.id] }
        : {
            status: "non_retryable_error",
            code: `PAGE_${data.failureCode?.toUpperCase()}`,
            message: "Page evidence could not be read",
            data,
            evidenceIds: [data.evidence.id],
          };
    },
  });
}
