import { applicationDatabase } from "../persistence/runtime.ts";
import { createRequestGuard, type RequestGuard } from "./guard.ts";
import type { ProductScope, VisitorScope } from "./rate-limit.ts";

const globals = globalThis as typeof globalThis & {
  travelRequestGuard?: RequestGuard;
};

/** Process-wide guard; shares the application database connection. */
export function requestGuard(): RequestGuard {
  return (globals.travelRequestGuard ??= createRequestGuard({
    db: applicationDatabase(),
  }));
}

/** Route helper: refuses before `handler` runs, so no external call happens. */
export function withGuard(
  scope: VisitorScope,
  request: Request,
  handler: () => Response | Promise<Response>,
): Promise<Response> {
  return requestGuard().protect(scope, request, handler);
}

/** Tool-gate helper for the shared product quota. */
export function allowProductCall(scope: ProductScope): boolean {
  return requestGuard().allowProductCall(scope);
}

export function recordProductSpend(amountCny: number): void {
  requestGuard().recordProductCost(amountCny);
}
