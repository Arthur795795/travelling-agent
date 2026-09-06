import { randomUUID } from "node:crypto";
import {
  loadFeatureFlags,
  type FeatureFlags,
  type FeatureName,
} from "../config/features.ts";
import {
  canStartNewGeneration,
  DEFAULT_BUDGET_POLICY,
  type BudgetPolicy,
} from "../domain/usage.ts";
import type { SqliteDatabase } from "../persistence/database.ts";
import { regressionAllowsCustomGeneration } from "../evaluation/regression.ts";
import {
  monthlyProductCost,
  RateLimiter,
  recordProductCost,
  type ProductScope,
  type RateLimitDecision,
  type VisitorScope,
} from "./rate-limit.ts";

/** Anonymous, day-scoped session cookie. Never linked to an account. */
export const SESSION_COOKIE = "anon_session";
const SESSION_MAX_AGE_SECONDS = 86_400;

export type GuardCode =
  | "RATE_LIMITED"
  | "GENERATION_DISABLED"
  | "MODEL_REGRESSION_REQUIRED"
  | "PRODUCT_BUDGET_STOP"
  | "FEATURE_DISABLED";

/** Public messages: no thresholds, counters or identifiers are disclosed. */
const MESSAGES: Record<GuardCode, string> = {
  RATE_LIMITED: "请求过于频繁，请稍后再试。",
  GENERATION_DISABLED: "自定义生成尚未开放，请稍后再试。",
  MODEL_REGRESSION_REQUIRED: "模型更新回归尚未通过，自定义生成已暂停。",
  PRODUCT_BUDGET_STOP: "本月生成额度已用完，已保存的行程仍可查看。",
  FEATURE_DISABLED: "该功能暂未开放。",
};

const FEATURE_BY_SCOPE: Record<VisitorScope, FeatureName | undefined> = {
  key_validation: undefined,
  planning_job: "customGeneration",
  sharing: "sharing",
  export: "export",
  analytics: undefined,
  feedback: undefined,
};

const baseHeaders = { "Cache-Control": "no-store" };

function readCookie(request: Request, name: string): string | undefined {
  const value = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  return value && value.length > 0 ? value : undefined;
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0];
  return (forwarded ?? request.headers.get("x-real-ip") ?? "").trim();
}

function withHeaders(response: Response, extra: [string, string][]): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of extra) headers.append(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export interface GuardDeps {
  db: SqliteDatabase;
  now?: () => Date;
  flags?: () => FeatureFlags;
  limiter?: RateLimiter;
  policy?: BudgetPolicy;
}

export type GuardCheck =
  | {
      allowed: true;
      identityHash: string;
      remaining: number;
      decorate: (response: Response) => Response;
    }
  | {
      allowed: false;
      code: GuardCode;
      status: number;
      retryAfterSeconds?: number;
      response: Response;
    };

export function createRequestGuard(deps: GuardDeps) {
  const now = deps.now ?? (() => new Date());
  const flags = deps.flags ?? (() => loadFeatureFlags());
  const policy = deps.policy ?? DEFAULT_BUDGET_POLICY;
  const limiter = deps.limiter ?? new RateLimiter(deps.db, now);

  const featureGate = (
    scope: VisitorScope,
    at: Date,
  ): { code: GuardCode; status: number } | undefined => {
    const current = flags();
    if (scope === "planning_job") {
      if (!regressionAllowsCustomGeneration())
        return { code: "MODEL_REGRESSION_REQUIRED", status: 403 };
      const decision = canStartNewGeneration(
        current.customGeneration,
        monthlyProductCost(deps.db, at),
        policy,
      );
      return decision.allowed ? undefined : { code: decision.code, status: 403 };
    }
    const feature = FEATURE_BY_SCOPE[scope];
    if (feature && !current[feature])
      return { code: "FEATURE_DISABLED", status: 403 };
    return undefined;
  };

  const cookieFor = (request: Request, sessionId: string): string =>
    `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}${
      new URL(request.url).protocol === "https:" ? "; Secure" : ""
    }`;

  const quotaHeaders = (decision: RateLimitDecision): [string, string][] => [
    ["X-RateLimit-Limit", String(decision.limit)],
    ["X-RateLimit-Remaining", String(decision.remaining)],
    ["X-RateLimit-Reset", decision.resetAt],
  ];

  /**
   * Evaluates feature flags, the owner monthly hard stop and the per-scope
   * quota. Flags are checked first so a closed feature never spends quota.
   */
  const check = (scope: VisitorScope, request: Request): GuardCheck => {
    const at = now();
    const existing = readCookie(request, SESSION_COOKIE);
    const sessionId = existing ?? randomUUID();
    const cookies: [string, string][] = existing
      ? []
      : [["Set-Cookie", cookieFor(request, sessionId)]];
    const identityHash = limiter.identity(
      { sessionId, ip: clientIp(request) },
      at,
    );
    const gate = featureGate(scope, at);
    if (gate)
      return {
        allowed: false,
        code: gate.code,
        status: gate.status,
        response: withHeaders(
          Response.json(
            { code: gate.code, message: MESSAGES[gate.code] },
            { status: gate.status, headers: baseHeaders },
          ),
          cookies,
        ),
      };
    const decision = limiter.consume(scope, identityHash, at);
    if (!decision.allowed)
      return {
        allowed: false,
        code: "RATE_LIMITED",
        status: 429,
        retryAfterSeconds: decision.retryAfterSeconds,
        response: withHeaders(
          Response.json(
            {
              code: "RATE_LIMITED",
              message: MESSAGES.RATE_LIMITED,
              retryAfterSeconds: decision.retryAfterSeconds,
              retryAt: decision.resetAt,
            },
            { status: 429, headers: baseHeaders },
          ),
          [
            ...cookies,
            ["Retry-After", String(decision.retryAfterSeconds)],
            ...quotaHeaders(decision),
          ],
        ),
      };
    return {
      allowed: true,
      identityHash,
      remaining: decision.remaining,
      decorate: (response) =>
        withHeaders(response, [...cookies, ...quotaHeaders(decision)]),
    };
  };

  return {
    limiter,
    check,
    /** Runs `handler` only when the request is admitted. */
    async protect(
      scope: VisitorScope,
      request: Request,
      handler: () => Response | Promise<Response>,
    ): Promise<Response> {
      const decision = check(scope, request);
      if (!decision.allowed) return decision.response;
      return decision.decorate(await handler());
    },
    /** Shared product quota for outbound search/Amap tool calls. */
    allowProductCall(scope: ProductScope): boolean {
      return limiter.consumeProduct(scope, now()).allowed;
    },
    recordProductCost(amountCny: number): void {
      recordProductCost(deps.db, amountCny, now());
    },
    monthlyProductCostCny(): number {
      return monthlyProductCost(deps.db, now());
    },
  };
}

export type RequestGuard = ReturnType<typeof createRequestGuard>;
