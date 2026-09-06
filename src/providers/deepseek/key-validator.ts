import { TransientSecret } from "../../security/secrets.ts";
import {
  deepSeekBaseUrl,
  deepSeekTransport,
  type DeepSeekFetch,
  type DeepSeekTransport,
} from "./network.ts";

export type DeepSeekKeyErrorCode =
  | "invalid_key"
  | "quota_or_permission"
  | "rate_limited"
  | "invalid_request"
  | "timeout"
  | "network_error"
  | "upstream_error";

export type DeepSeekKeyValidationResult =
  | { ok: true; model: string }
  | { ok: false; code: DeepSeekKeyErrorCode; retryable: boolean };

export interface DeepSeekKeyValidatorOptions {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: DeepSeekFetch;
  transport?: DeepSeekTransport;
  onAudit?: (event: DeepSeekKeyValidationAudit) => void;
}

export interface DeepSeekKeyValidationAudit {
  checkedAt: string;
  durationMs: number;
  outcome: "valid" | DeepSeekKeyErrorCode;
  model: string;
}

export const DEFAULT_DEEPSEEK_KEY_VALIDATION_TIMEOUT_MS = 30_000;

/** Server-only tuning knob. Invalid or unsafe values fall back closed to the default. */
export function deepSeekKeyValidationTimeoutMs(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const parsed = Number(environment.DEEPSEEK_KEY_VALIDATION_TIMEOUT_MS);
  return Number.isInteger(parsed) && parsed >= 1_000 && parsed <= 120_000
    ? parsed
    : DEFAULT_DEEPSEEK_KEY_VALIDATION_TIMEOUT_MS;
}

function errorResult(
  status: number,
): Extract<DeepSeekKeyValidationResult, { ok: false }> {
  if (status === 401)
    return { ok: false, code: "invalid_key", retryable: false };
  if (status === 402 || status === 403)
    return { ok: false, code: "quota_or_permission", retryable: false };
  if (status === 429)
    return { ok: false, code: "rate_limited", retryable: true };
  if (status === 408 || status === 504)
    return { ok: false, code: "timeout", retryable: true };
  if (status === 400 || status === 422)
    return { ok: false, code: "invalid_request", retryable: false };
  return { ok: false, code: "upstream_error", retryable: status >= 500 };
}

export async function validateDeepSeekKey(
  secret: TransientSecret,
  options: DeepSeekKeyValidatorOptions = {},
): Promise<DeepSeekKeyValidationResult> {
  const model = options.model ?? "deepseek-v4-pro";
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      controller.abort(new Error("timeout"));
    },
    options.timeoutMs ?? deepSeekKeyValidationTimeoutMs(),
  );
  const startedAt = Date.now();
  let outcome: DeepSeekKeyValidationAudit["outcome"] = "network_error";
  try {
    const transport = options.transport ??
      (options.fetchImpl
        ? {
            baseUrl: deepSeekBaseUrl(),
            proxyConfigured: false,
            fetch: options.fetchImpl,
            close: async () => undefined,
          }
        : deepSeekTransport());
    const fetchImpl = transport.fetch;
    const baseUrl = (options.baseUrl ?? transport.baseUrl).replace(/\/$/, "");
    const response = await secret.use((apiKey) =>
      fetchImpl(`${baseUrl}/responses`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          model,
          input: "Reply with OK.",
          max_output_tokens: 1,
          reasoning: { effort: "none" },
          stream: true,
        }),
      }),
    );
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      const result = errorResult(response.status);
      outcome = result.code;
      return result;
    }
    // Authentication, balance, permission and request-shape checks have
    // succeeded once the streaming response is admitted. The validator does
    // not retain or expose generated content and closes the one-token body.
    void response.body?.cancel().catch(() => undefined);
    outcome = "valid";
    return { ok: true, model };
  } catch {
    outcome = timedOut ? "timeout" : "network_error";
    return { ok: false, code: outcome, retryable: true };
  } finally {
    clearTimeout(timer);
    secret.clear();
    try {
      options.onAudit?.({
        checkedAt: new Date().toISOString(),
        durationMs: Math.max(0, Date.now() - startedAt),
        outcome,
        model,
      });
    } catch {
      // Audit consumers must never change the validation result.
    }
  }
}
