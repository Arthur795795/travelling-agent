import { TransientSecret } from "../../security/secrets.ts";

export type DeepSeekKeyErrorCode =
  | "invalid_key"
  | "quota_or_permission"
  | "rate_limited"
  | "invalid_request"
  | "network_error"
  | "upstream_error";

export type DeepSeekKeyValidationResult =
  | { ok: true; model: string }
  | { ok: false; code: DeepSeekKeyErrorCode; retryable: boolean };

export interface DeepSeekKeyValidatorOptions {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  onAudit?: (event: DeepSeekKeyValidationAudit) => void;
}

export interface DeepSeekKeyValidationAudit {
  checkedAt: string;
  durationMs: number;
  outcome: "valid" | DeepSeekKeyErrorCode;
  model: string;
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
  if (status === 400 || status === 422)
    return { ok: false, code: "invalid_request", retryable: false };
  return { ok: false, code: "upstream_error", retryable: status >= 500 };
}

export async function validateDeepSeekKey(
  secret: TransientSecret,
  options: DeepSeekKeyValidatorOptions = {},
): Promise<DeepSeekKeyValidationResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const model = options.model ?? "deepseek-v4-pro";
  const baseUrl = (
    options.baseUrl ??
    process.env.DEEPSEEK_BASE_URL ??
    "https://api.deepseek.com"
  ).replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 6_000,
  );
  const startedAt = Date.now();
  let outcome: DeepSeekKeyValidationAudit["outcome"] = "network_error";
  try {
    const response = await secret.use((apiKey) =>
      fetchImpl(`${baseUrl}/responses`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: "Reply with OK.",
          max_output_tokens: 1,
          temperature: 0,
        }),
      }),
    );
    if (!response.ok) {
      const result = errorResult(response.status);
      outcome = result.code;
      return result;
    }
    outcome = "valid";
    return { ok: true, model };
  } catch {
    outcome = "network_error";
    return { ok: false, code: "network_error", retryable: true };
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
