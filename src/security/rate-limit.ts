import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../persistence/database.ts";
import { DEFAULT_TIME_ZONE } from "../domain/schema.ts";

/**
 * Independent quota scopes (Ticket 041 / Spec F17).
 * Visitor scopes are keyed by a daily-rotating identity hash; product scopes
 * ("search"/"amap") are a single product-wide daily quota.
 */
export const VISITOR_SCOPES = [
  "key_validation",
  "planning_job",
  "sharing",
  "export",
  "analytics",
  "feedback",
] as const;
export const PRODUCT_SCOPES = ["search", "amap"] as const;
export const RATE_LIMIT_SCOPES = [...VISITOR_SCOPES, ...PRODUCT_SCOPES] as const;

export type VisitorScope = (typeof VISITOR_SCOPES)[number];
export type ProductScope = (typeof PRODUCT_SCOPES)[number];
export type RateLimitScope = (typeof RATE_LIMIT_SCOPES)[number];

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

export const DEFAULT_RATE_LIMITS: Record<RateLimitScope, RateLimitRule> = {
  key_validation: { limit: 20, windowMs: HOUR },
  planning_job: { limit: 10, windowMs: HOUR },
  sharing: { limit: 20, windowMs: HOUR },
  export: { limit: 30, windowMs: HOUR },
  analytics: { limit: 200, windowMs: HOUR },
  feedback: { limit: 20, windowMs: HOUR },
  search: { limit: 200, windowMs: DAY },
  amap: { limit: 500, windowMs: DAY },
};

/** The product-wide bucket key; never derived from a visitor identity. */
export const PRODUCT_IDENTITY = "product";

export interface RequestIdentity {
  /** Anonymous session id from an HttpOnly cookie; never persisted in clear. */
  sessionId?: string;
  /** Client IP; only ever used as HMAC input, never stored. */
  ip?: string;
}

export type RateLimitDecision =
  | { allowed: true; limit: number; remaining: number; resetAt: string }
  | {
      allowed: false;
      code: "RATE_LIMITED";
      limit: number;
      remaining: 0;
      resetAt: string;
      retryAfterSeconds: number;
    };

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: DEFAULT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Local calendar day (Asia/Shanghai), e.g. "2026-09-05". */
export function localDay(at: Date): string {
  return dayFormatter.format(at);
}

/** Local calendar month (Asia/Shanghai), e.g. "2026-09". */
export function localMonth(at: Date): string {
  return localDay(at).slice(0, 7);
}

export class RateLimiter {
  private readonly db: SqliteDatabase;
  private readonly now: () => Date;
  readonly limits: Record<RateLimitScope, RateLimitRule>;

  constructor(
    db: SqliteDatabase,
    now: () => Date = () => new Date(),
    limits: Record<RateLimitScope, RateLimitRule> = DEFAULT_RATE_LIMITS,
  ) {
    this.db = db;
    this.now = now;
    this.limits = limits;
  }

  /**
   * Returns the salt for `day`, creating it on first use and destroying every
   * other day's salt so a stored hash cannot be linked across days.
   */
  private salt(day: string): string {
    const read = this.db.prepare(
      "SELECT salt FROM rate_limit_salts WHERE day = ?",
    );
    const existing = read.get(day) as { salt: string } | undefined;
    if (existing) return existing.salt;
    const candidate = randomBytes(32).toString("hex");
    this.db.transaction(() => {
      this.db
        .prepare("INSERT OR IGNORE INTO rate_limit_salts (day,salt) VALUES (?,?)")
        .run(day, candidate);
      this.db.prepare("DELETE FROM rate_limit_salts WHERE day <> ?").run(day);
    })();
    return (read.get(day) as { salt: string }).salt;
  }

  /**
   * Combines the anonymous session with the client IP into a hash that is only
   * valid for the current local day. Neither input is persisted.
   */
  identity(identity: RequestIdentity, at: Date = this.now()): string {
    const day = localDay(at);
    return createHmac("sha256", this.salt(day))
      .update(`${day}\0${identity.sessionId ?? ""}\0${identity.ip ?? ""}`)
      .digest("hex");
  }

  peek(
    scope: RateLimitScope,
    identityHash: string,
    at: Date = this.now(),
  ): number {
    const rule = this.limits[scope];
    const row = this.db
      .prepare(
        "SELECT count FROM rate_limit_counters WHERE scope=? AND identity_hash=? AND window_start=?",
      )
      .get(scope, identityHash, this.windowStart(rule, at)) as
      | { count: number }
      | undefined;
    return row?.count ?? 0;
  }

  /** Atomically charges one unit against `scope`, or refuses with a retry time. */
  consume(
    scope: RateLimitScope,
    identityHash: string,
    at: Date = this.now(),
  ): RateLimitDecision {
    const rule = this.limits[scope];
    const start = this.windowStartMs(rule, at);
    const windowStart = new Date(start).toISOString();
    const resetAt = new Date(start + rule.windowMs).toISOString();
    return this.db.transaction((): RateLimitDecision => {
      const used = this.peek(scope, identityHash, at);
      if (used >= rule.limit)
        return {
          allowed: false,
          code: "RATE_LIMITED",
          limit: rule.limit,
          remaining: 0,
          resetAt,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((start + rule.windowMs - at.getTime()) / 1000),
          ),
        };
      this.db
        .prepare(
          `INSERT INTO rate_limit_counters (scope,identity_hash,window_start,count,expires_at)
           VALUES (?,?,?,1,?)
           ON CONFLICT(scope,identity_hash,window_start) DO UPDATE SET count = count + 1`,
        )
        .run(scope, identityHash, windowStart, resetAt);
      return {
        allowed: true,
        limit: rule.limit,
        remaining: rule.limit - used - 1,
        resetAt,
      };
    })();
  }

  /** Charges the shared product quota used by outbound search/Amap tools. */
  consumeProduct(scope: ProductScope, at: Date = this.now()): RateLimitDecision {
    return this.consume(scope, PRODUCT_IDENTITY, at);
  }

  private windowStartMs(rule: RateLimitRule, at: Date): number {
    return Math.floor(at.getTime() / rule.windowMs) * rule.windowMs;
  }

  private windowStart(rule: RateLimitRule, at: Date): string {
    return new Date(this.windowStartMs(rule, at)).toISOString();
  }
}

/** Appends product spend so the owner monthly hard stop can be evaluated. */
export function recordProductCost(
  db: SqliteDatabase,
  amountCny: number,
  at: Date = new Date(),
): void {
  if (!Number.isFinite(amountCny) || amountCny <= 0) return;
  db.prepare(
    "INSERT INTO product_cost_ledger (id,month,amount_cny,created_at) VALUES (?,?,?,?)",
  ).run(randomUUID(), localMonth(at), amountCny, at.toISOString());
}

export function monthlyProductCost(
  db: SqliteDatabase,
  at: Date = new Date(),
): number {
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(amount_cny),0) AS total FROM product_cost_ledger WHERE month = ?",
    )
    .get(localMonth(at)) as { total: number };
  return row.total;
}

/** Drops counters whose window has closed and salts from previous days. */
export function cleanupRateLimits(
  db: SqliteDatabase,
  at: Date = new Date(),
): { counters: number; salts: number } {
  return {
    counters: db
      .prepare("DELETE FROM rate_limit_counters WHERE expires_at <= ?")
      .run(at.toISOString()).changes,
    salts: db
      .prepare("DELETE FROM rate_limit_salts WHERE day <> ?")
      .run(localDay(at)).changes,
  };
}
