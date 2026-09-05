import { requireServerEnvironment } from "../../config/environment.ts";

export type AmapErrorCode =
  | "authentication"
  | "quota"
  | "invalid_request"
  | "timeout"
  | "cancelled"
  | "network_error"
  | "invalid_response"
  | "upstream_error";

export class AmapError extends Error {
  readonly code: AmapErrorCode;
  readonly retryable: boolean;

  constructor(code: AmapErrorCode, retryable: boolean, message: string) {
    super(message);
    this.name = "AmapError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface AmapClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  environment?: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
}

const AUTH_CODES = new Set([
  "10001",
  "10005",
  "10006",
  "10007",
  "10008",
  "10009",
]);
const QUOTA_CODES = new Set([
  "10003",
  "10004",
  "10010",
  "10020",
  "10021",
  "10044",
]);

function errorFromInfocode(infocode: string): AmapError {
  if (AUTH_CODES.has(infocode))
    return new AmapError("authentication", false, "Amap authentication failed");
  if (QUOTA_CODES.has(infocode))
    return new AmapError("quota", true, "Amap quota or rate limit was reached");
  if (infocode === "10002")
    return new AmapError("upstream_error", true, "Amap service is unavailable");
  if (infocode.startsWith("2"))
    return new AmapError("invalid_request", false, "Amap rejected the request");
  return new AmapError("upstream_error", true, "Amap request failed");
}

export interface AmapResponse {
  data: Record<string, unknown>;
  checkedAt: string;
}

export class AmapClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly now: () => Date;

  constructor(options: AmapClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://restapi.amap.com").replace(
      /\/$/,
      "",
    );
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.environment = options.environment ?? process.env;
    this.now = options.now ?? (() => new Date());
  }

  async request(
    path: string,
    parameters: Record<string, string | number | undefined>,
    signal?: AbortSignal,
  ): Promise<AmapResponse> {
    if (!path.startsWith("/") || path.includes(".."))
      throw new AmapError("invalid_request", false, "Amap path is invalid");
    let apiKey: string;
    try {
      apiKey = requireServerEnvironment(
        "AMAP_WEB_SERVICE_KEY",
        this.environment,
      );
    } catch {
      throw new AmapError(
        "authentication",
        false,
        "Amap server credential is unavailable",
      );
    }
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(parameters))
      if (value !== undefined) url.searchParams.set(key, String(value));
    url.searchParams.set("key", apiKey);
    url.searchParams.set("output", "JSON");

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("timeout")),
      this.timeoutMs,
    );
    const onAbort = () =>
      controller.abort(signal?.reason ?? new Error("cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      const response = await this.fetchImpl(url, {
        method: "GET",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (response.status === 401 || response.status === 403)
        throw new AmapError(
          "authentication",
          false,
          "Amap authentication failed",
        );
      if (response.status === 429)
        throw new AmapError(
          "quota",
          true,
          "Amap quota or rate limit was reached",
        );
      if (response.status === 400 || response.status === 422)
        throw new AmapError(
          "invalid_request",
          false,
          "Amap rejected the request",
        );
      if (!response.ok)
        throw new AmapError(
          "upstream_error",
          response.status >= 500,
          "Amap HTTP request failed",
        );
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new AmapError(
          "invalid_response",
          true,
          "Amap returned invalid JSON",
        );
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new AmapError(
          "invalid_response",
          true,
          "Amap returned an invalid response",
        );
      }
      const data = body as Record<string, unknown>;
      if (data.status !== "1" || data.infocode !== "10000") {
        throw errorFromInfocode(
          typeof data.infocode === "string" ? data.infocode : "unknown",
        );
      }
      return { data, checkedAt: this.now().toISOString() };
    } catch (error) {
      if (error instanceof AmapError) throw error;
      if (signal?.aborted)
        throw new AmapError("cancelled", false, "Amap request was cancelled");
      if (controller.signal.aborted)
        throw new AmapError("timeout", true, "Amap request timed out");
      throw new AmapError("network_error", true, "Amap network request failed");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
