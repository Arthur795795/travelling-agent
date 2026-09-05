import { z } from "zod";
import { TransientSecret } from "../../security/secrets.ts";

export type DeepSeekResponseErrorCode =
  | "invalid_key"
  | "quota_or_permission"
  | "rate_limited"
  | "invalid_request"
  | "timeout"
  | "cancelled"
  | "incomplete_response"
  | "invalid_stream"
  | "network_error"
  | "upstream_error";

export class DeepSeekResponseError extends Error {
  readonly code: DeepSeekResponseErrorCode;
  readonly retryable: boolean;

  constructor(
    code: DeepSeekResponseErrorCode,
    retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "DeepSeekResponseError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface DeepSeekFunctionTool {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

export interface DeepSeekWebSearchTool {
  type: "web_search";
}

export type DeepSeekTool = DeepSeekFunctionTool | DeepSeekWebSearchTool;

export interface DeepSeekFunctionCallOutput {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export function functionCallOutput(
  callId: string,
  output: unknown,
): DeepSeekFunctionCallOutput {
  return {
    type: "function_call_output",
    call_id: callId,
    output: typeof output === "string" ? output : JSON.stringify(output),
  };
}

export interface DeepSeekResponseRequest {
  input: string | unknown[];
  instructions?: string;
  tools?: DeepSeekTool[];
  toolChoice?: "none" | "auto" | "required" | Record<string, unknown>;
  maxOutputTokens?: number;
  reasoningEffort?:
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max";
  textFormat?:
    | { type: "text" | "json_object" }
    | { type: "json_schema"; name: string; schema: Record<string, unknown> };
  signal?: AbortSignal;
  onEvent?: (event: DeepSeekPublicEvent) => void;
}

export type DeepSeekPublicEvent =
  | { type: "text_delta"; delta: string }
  | { type: "function_call"; callId: string; name: string; arguments: string }
  | { type: "web_search"; id: string; action: Record<string, unknown> };

export interface DeepSeekCitation {
  title?: string;
  url: string;
  startIndex?: number;
  endIndex?: number;
}

export interface DeepSeekUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface DeepSeekResponseResult {
  responseId: string;
  status: "completed";
  model: string;
  outputText: string;
  functionCalls: Array<{ callId: string; name: string; arguments: string }>;
  webSearchCalls: Array<{ id: string; action: Record<string, unknown> }>;
  citations: DeepSeekCitation[];
  events: DeepSeekPublicEvent[];
  usage: DeepSeekUsage;
  estimatedCostCny: number;
}

export interface DeepSeekPricingCny {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
}

export const DEFAULT_DEEPSEEK_PRICING_CNY: DeepSeekPricingCny = {
  inputPerMillion: 3.132,
  cachedInputPerMillion: 0.0261,
  outputPerMillion: 6.264,
};

export interface DeepSeekResponsesClientOptions {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  pricing?: DeepSeekPricingCny;
}

const UsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  input_tokens_details: z
    .object({ cached_tokens: z.number().int().nonnegative().default(0) })
    .optional(),
  output_tokens: z.number().int().nonnegative(),
  output_tokens_details: z
    .object({ reasoning_tokens: z.number().int().nonnegative().default(0) })
    .optional(),
  total_tokens: z.number().int().nonnegative(),
});

const CompletedResponseSchema = z.object({
  id: z.string().min(1),
  status: z.literal("completed"),
  model: z.string().min(1),
  output: z.array(z.record(z.string(), z.unknown())).default([]),
  usage: UsageSchema,
});

function errorForStatus(status: number): DeepSeekResponseError {
  if (status === 401)
    return new DeepSeekResponseError(
      "invalid_key",
      false,
      "DeepSeek authentication failed",
    );
  if (status === 402 || status === 403)
    return new DeepSeekResponseError(
      "quota_or_permission",
      false,
      "DeepSeek quota or permission failed",
    );
  if (status === 429)
    return new DeepSeekResponseError(
      "rate_limited",
      true,
      "DeepSeek request was rate limited",
    );
  if (status === 408)
    return new DeepSeekResponseError(
      "timeout",
      true,
      "DeepSeek request timed out",
    );
  if (status === 400 || status === 422)
    return new DeepSeekResponseError(
      "invalid_request",
      false,
      "DeepSeek rejected the request",
    );
  return new DeepSeekResponseError(
    "upstream_error",
    status >= 500,
    "DeepSeek request failed",
  );
}

function estimateCost(
  usage: DeepSeekUsage,
  pricing: DeepSeekPricingCny,
): number {
  const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return Number(
    (
      (uncached * pricing.inputPerMillion +
        usage.cachedInputTokens * pricing.cachedInputPerMillion +
        usage.outputTokens * pricing.outputPerMillion) /
      1_000_000
    ).toFixed(6),
  );
}

function extractOutput(response: z.infer<typeof CompletedResponseSchema>): {
  text: string;
  calls: DeepSeekResponseResult["functionCalls"];
  searches: DeepSeekResponseResult["webSearchCalls"];
  citations: DeepSeekCitation[];
} {
  let text = "";
  const calls: DeepSeekResponseResult["functionCalls"] = [];
  const searches: DeepSeekResponseResult["webSearchCalls"] = [];
  const citations: DeepSeekCitation[] = [];
  for (const item of response.output) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content as Array<Record<string, unknown>>) {
        if (part.type === "output_text" && typeof part.text === "string")
          text += part.text;
        if (Array.isArray(part.annotations)) {
          for (const annotation of part.annotations as Array<
            Record<string, unknown>
          >) {
            if (typeof annotation.url !== "string") continue;
            citations.push({
              url: annotation.url,
              title:
                typeof annotation.title === "string"
                  ? annotation.title
                  : undefined,
              startIndex:
                typeof annotation.start_index === "number"
                  ? annotation.start_index
                  : undefined,
              endIndex:
                typeof annotation.end_index === "number"
                  ? annotation.end_index
                  : undefined,
            });
          }
        }
      }
    } else if (
      item.type === "function_call" &&
      typeof item.call_id === "string" &&
      typeof item.name === "string"
    ) {
      calls.push({
        callId: item.call_id,
        name: item.name,
        arguments: typeof item.arguments === "string" ? item.arguments : "",
      });
    } else if (item.type === "web_search_call" && typeof item.id === "string") {
      searches.push({
        id: item.id,
        action:
          item.action && typeof item.action === "object"
            ? (item.action as Record<string, unknown>)
            : {},
      });
    }
  }
  return { text, calls, searches, citations };
}

async function* ssePayloads(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason;
      buffer = (buffer + decoder.decode(value, { stream: !done })).replace(
        /\r\n/g,
        "\n",
      );
      if (done && buffer) buffer += "\n\n";
      if (buffer.length > 2_000_000)
        throw new DeepSeekResponseError(
          "invalid_stream",
          false,
          "DeepSeek stream event is too large",
        );
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        if (signal.aborted) throw signal.reason;
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data || data === "[DONE]") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          throw new DeepSeekResponseError(
            "invalid_stream",
            false,
            "DeepSeek returned malformed stream data",
          );
        }
        if (parsed && typeof parsed === "object")
          yield parsed as Record<string, unknown>;
      }
      if (done) break;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class DeepSeekResponsesClient {
  private readonly options: Required<
    Omit<DeepSeekResponsesClientOptions, "fetchImpl">
  > & { fetchImpl: typeof fetch };

  constructor(options: DeepSeekResponsesClientOptions = {}) {
    this.options = {
      baseUrl: (
        options.baseUrl ??
        process.env.DEEPSEEK_BASE_URL ??
        "https://api.deepseek.com"
      ).replace(/\/$/, ""),
      model: options.model ?? "deepseek-v4-pro",
      timeoutMs: options.timeoutMs ?? 150_000,
      fetchImpl: options.fetchImpl ?? fetch,
      pricing: options.pricing ?? DEFAULT_DEEPSEEK_PRICING_CNY,
    };
  }

  async createResponse(
    secret: TransientSecret,
    request: DeepSeekResponseRequest,
  ): Promise<DeepSeekResponseResult> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("timeout")),
      this.options.timeoutMs,
    );
    const onExternalAbort = () =>
      controller.abort(request.signal?.reason ?? new Error("cancelled"));
    request.signal?.addEventListener("abort", onExternalAbort, { once: true });
    if (request.signal?.aborted) onExternalAbort();
    const events: DeepSeekPublicEvent[] = [];
    let completedPayload: unknown;
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      const response = await secret.use((apiKey) =>
        this.options.fetchImpl(`${this.options.baseUrl}/responses`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify({
            model: this.options.model,
            input: request.input,
            instructions: request.instructions,
            stream: true,
            tools: request.tools,
            tool_choice: request.toolChoice,
            max_output_tokens: request.maxOutputTokens ?? 16_000,
            reasoning: request.reasoningEffort
              ? { effort: request.reasoningEffort }
              : undefined,
            text: request.textFormat
              ? { format: request.textFormat }
              : undefined,
          }),
        }),
      );
      if (!response.ok) throw errorForStatus(response.status);
      if (!response.body)
        throw new DeepSeekResponseError(
          "invalid_stream",
          true,
          "DeepSeek returned no stream body",
        );

      for await (const payload of ssePayloads(
        response.body,
        controller.signal,
      )) {
        const type = typeof payload.type === "string" ? payload.type : "";
        let event: DeepSeekPublicEvent | undefined;
        if (
          type === "response.output_text.delta" &&
          typeof payload.delta === "string"
        ) {
          event = { type: "text_delta", delta: payload.delta };
        } else if (
          type === "response.output_item.done" &&
          payload.item &&
          typeof payload.item === "object"
        ) {
          const item = payload.item as Record<string, unknown>;
          if (
            item.type === "function_call" &&
            typeof item.call_id === "string" &&
            typeof item.name === "string"
          ) {
            event = {
              type: "function_call",
              callId: item.call_id,
              name: item.name,
              arguments:
                typeof item.arguments === "string" ? item.arguments : "",
            };
          } else if (
            item.type === "web_search_call" &&
            typeof item.id === "string"
          ) {
            event = {
              type: "web_search",
              id: item.id,
              action:
                item.action && typeof item.action === "object"
                  ? (item.action as Record<string, unknown>)
                  : {},
            };
          }
        } else if (type === "response.completed") {
          completedPayload = payload.response;
          break;
        } else if (type === "response.incomplete") {
          throw new DeepSeekResponseError(
            "incomplete_response",
            true,
            "DeepSeek response was incomplete",
          );
        } else if (type === "response.failed") {
          throw new DeepSeekResponseError(
            "upstream_error",
            true,
            "DeepSeek response failed",
          );
        }
        if (event) {
          events.push(event);
          request.onEvent?.(event);
        }
        // Reasoning events are intentionally ignored and never exposed.
      }

      const parsed = CompletedResponseSchema.safeParse(completedPayload);
      if (!parsed.success)
        throw new DeepSeekResponseError(
          "incomplete_response",
          true,
          "DeepSeek stream ended without a completed response",
        );
      const output = extractOutput(parsed.data);
      const usage: DeepSeekUsage = {
        inputTokens: parsed.data.usage.input_tokens,
        cachedInputTokens:
          parsed.data.usage.input_tokens_details?.cached_tokens ?? 0,
        outputTokens: parsed.data.usage.output_tokens,
        reasoningTokens:
          parsed.data.usage.output_tokens_details?.reasoning_tokens ?? 0,
        totalTokens: parsed.data.usage.total_tokens,
      };
      return {
        responseId: parsed.data.id,
        status: "completed",
        model: parsed.data.model,
        outputText: output.text,
        functionCalls: output.calls,
        webSearchCalls: output.searches,
        citations: output.citations,
        events,
        usage,
        estimatedCostCny: estimateCost(usage, this.options.pricing),
      };
    } catch (error) {
      if (error instanceof DeepSeekResponseError) throw error;
      if (request.signal?.aborted)
        throw new DeepSeekResponseError(
          "cancelled",
          false,
          "DeepSeek request was cancelled",
        );
      if (controller.signal.aborted)
        throw new DeepSeekResponseError(
          "timeout",
          true,
          "DeepSeek request timed out",
        );
      throw new DeepSeekResponseError(
        "network_error",
        true,
        "DeepSeek network request failed",
      );
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onExternalAbort);
      secret.clear();
    }
  }
}
