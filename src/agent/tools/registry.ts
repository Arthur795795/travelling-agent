import { z } from "zod";
import type { PlanningStage } from "../../domain/schema.ts";
import { recordUsage, type UsageEvent } from "../../domain/usage.ts";

export const TOOL_NAMES = [
  "search_places",
  "get_place_details",
  "calculate_route",
  "get_weather",
  "web_search",
  "read_official_page",
  "create_platform_link",
  "submit_skeleton",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export const DEFAULT_STAGE_TOOLS: Record<
  PlanningStage,
  ReadonlySet<ToolName>
> = {
  requirements_check: new Set(),
  skeleton_planning: new Set(["submit_skeleton"]),
  evidence_collection: new Set([
    "search_places",
    "get_place_details",
    "get_weather",
    "web_search",
    "read_official_page",
  ]),
  route_and_budget: new Set(["calculate_route", "create_platform_link"]),
  hard_validation: new Set(),
  repair: new Set([
    "search_places",
    "get_place_details",
    "calculate_route",
    "get_weather",
    "web_search",
    "read_official_page",
    "create_platform_link",
  ]),
  finalization: new Set(),
};

export interface ToolContext {
  jobId: string;
  stage: PlanningStage;
  callId: string;
  checkedAt: string;
  signal: AbortSignal;
}

export type ToolHandlerResult<T> =
  | {
      status: "success";
      data: T;
      evidenceIds?: string[];
      productCostCny?: number;
      usageEvents?: UsageEvent[];
    }
  | {
      status: "retryable_error" | "non_retryable_error" | "blocked";
      code: string;
      message: string;
      data?: T;
      evidenceIds?: string[];
      productCostCny?: number;
      usageEvents?: UsageEvent[];
    };

export interface ToolDefinition<TInput, TOutput> {
  name: ToolName;
  inputSchema: z.ZodType<TInput>;
  isEnabled?: () => boolean;
  execute: (
    input: TInput,
    context: ToolContext,
  ) => Promise<ToolHandlerResult<TOutput>>;
}

export interface ToolInvocation {
  jobId: string;
  stage: PlanningStage;
  callId: string;
  idempotencyKey: string;
  name: string;
  arguments: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ToolInvocationResult {
  jobId: string;
  stage: PlanningStage;
  callId: string;
  idempotencyKey: string;
  name: string;
  status: "success" | "retryable_error" | "non_retryable_error" | "blocked";
  code?: string;
  message?: string;
  data?: unknown;
  evidenceIds: string[];
  durationMs: number;
  usageEvents: UsageEvent[];
  replayed?: boolean;
}

function rejected(
  invocation: ToolInvocation,
  code: string,
  message: string,
): ToolInvocationResult {
  return {
    jobId: invocation.jobId,
    stage: invocation.stage,
    callId: invocation.callId,
    idempotencyKey: invocation.idempotencyKey,
    name: invocation.name,
    status: "non_retryable_error",
    code,
    message,
    evidenceIds: [],
    durationMs: 0,
    usageEvents: [],
  };
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return JSON.parse(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export class AgentToolRegistry {
  private readonly definitions = new Map<
    ToolName,
    ToolDefinition<unknown, unknown>
  >();
  private readonly executions = new Map<
    string,
    { signature: string; result: Promise<ToolInvocationResult> }
  >();
  private readonly stageTools: Record<PlanningStage, ReadonlySet<ToolName>>;
  private readonly now: () => Date;

  constructor(
    stageTools: Record<
      PlanningStage,
      ReadonlySet<ToolName>
    > = DEFAULT_STAGE_TOOLS,
    now = () => new Date(),
  ) {
    this.stageTools = stageTools;
    this.now = now;
  }

  register<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): void {
    if (this.definitions.has(definition.name))
      throw new Error(`Tool ${definition.name} is already registered`);
    this.definitions.set(
      definition.name,
      definition as ToolDefinition<unknown, unknown>,
    );
  }

  async invoke(invocation: ToolInvocation): Promise<ToolInvocationResult> {
    if (invocation.signal?.aborted)
      return rejected(invocation, "TOOL_CANCELLED", "Tool call was cancelled");
    if (!invocation.jobId || !invocation.callId || !invocation.idempotencyKey) {
      return rejected(
        invocation,
        "INVALID_INVOCATION",
        "Tool invocation identifiers are required",
      );
    }
    if (!TOOL_NAMES.includes(invocation.name as ToolName)) {
      return rejected(invocation, "UNKNOWN_TOOL", "Tool is not registered");
    }
    const name = invocation.name as ToolName;
    const definition = this.definitions.get(name);
    if (!definition)
      return rejected(invocation, "UNKNOWN_TOOL", "Tool is not registered");
    if (!this.stageTools[invocation.stage]?.has(name)) {
      return rejected(
        invocation,
        "TOOL_NOT_ALLOWED",
        "Tool is not allowed in this planning stage",
      );
    }
    if (definition.isEnabled && !definition.isEnabled()) {
      return {
        ...rejected(invocation, "TOOL_DISABLED", "Tool is disabled"),
        status: "blocked",
      };
    }

    let parsedJson: unknown;
    try {
      parsedJson = parseArguments(invocation.arguments);
    } catch {
      return rejected(
        invocation,
        "INVALID_ARGUMENTS",
        "Tool arguments must be valid JSON",
      );
    }
    const parsed = definition.inputSchema.safeParse(parsedJson);
    if (!parsed.success)
      return rejected(
        invocation,
        "INVALID_ARGUMENTS",
        "Tool arguments do not match the schema",
      );

    const idempotencyKey = `${invocation.jobId}:${invocation.stage}:${invocation.idempotencyKey}`;
    const signature = `${name}:${canonicalJson(parsed.data)}`;
    const previous = this.executions.get(idempotencyKey);
    if (previous) {
      if (previous.signature !== signature) {
        return rejected(
          invocation,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency key was already used for a different tool call",
        );
      }
      return {
        ...(await previous.result),
        callId: invocation.callId,
        usageEvents: [],
        replayed: true,
      };
    }

    const execution = this.executeOnce(invocation, definition, parsed.data);
    this.executions.set(idempotencyKey, { signature, result: execution });
    return execution;
  }

  private async executeOnce(
    invocation: ToolInvocation,
    definition: ToolDefinition<unknown, unknown>,
    input: unknown,
  ): Promise<ToolInvocationResult> {
    const startedAt = this.now();
    const controller = new AbortController();
    const abort = () => controller.abort();
    invocation.signal?.addEventListener("abort", abort, { once: true });
    const timeoutMs = Math.min(
      Math.max(invocation.timeoutMs ?? 15_000, 1),
      60_000,
    );
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const timeoutResult = new Promise<ToolHandlerResult<unknown>>(
        (resolve) => {
          controller.signal.addEventListener(
            "abort",
            () =>
              resolve({
                status: "retryable_error",
                code: "TOOL_TIMEOUT",
                message: "Tool execution timed out",
              }),
            { once: true },
          );
        },
      );
      const result = await Promise.race([
        definition.execute(input, {
          jobId: invocation.jobId,
          stage: invocation.stage,
          callId: invocation.callId,
          checkedAt: startedAt.toISOString(),
          signal: controller.signal,
        }),
        timeoutResult,
      ]);
      const productCostCny = result.productCostCny ?? 0;
      if (!Number.isFinite(productCostCny) || productCostCny < 0) {
        return this.result(invocation, startedAt, {
          status: "non_retryable_error",
          code: "INVALID_TOOL_COST",
          message: "Tool returned invalid cost metadata",
        });
      }
      for (const event of result.usageEvents ?? []) {
        recordUsage(
          {
            steps: 0,
            searchCalls: 0,
            repairRounds: 0,
            outputTokens: 0,
            visitorModelCostCny: 0,
            productCostCny: 0,
          },
          event,
        );
      }
      return this.result(invocation, startedAt, result);
    } catch {
      return this.result(invocation, startedAt, {
        status: "retryable_error",
        code: "TOOL_EXECUTION_FAILED",
        message: "Tool execution failed",
      });
    } finally {
      clearTimeout(timer);
      invocation.signal?.removeEventListener("abort", abort);
    }
  }

  private result(
    invocation: ToolInvocation,
    startedAt: Date,
    result: ToolHandlerResult<unknown>,
  ): ToolInvocationResult {
    const cost = result.productCostCny ?? 0;
    return {
      jobId: invocation.jobId,
      stage: invocation.stage,
      callId: invocation.callId,
      idempotencyKey: invocation.idempotencyKey,
      name: invocation.name,
      status: result.status,
      code: result.status === "success" ? undefined : result.code,
      message: result.status === "success" ? undefined : result.message,
      data: result.data,
      evidenceIds: result.evidenceIds ?? [],
      durationMs: Math.max(0, this.now().getTime() - startedAt.getTime()),
      usageEvents: [
        ...(result.usageEvents ?? []),
        ...(cost > 0
          ? [{ type: "product_cost" as const, amountCny: cost }]
          : []),
      ],
    };
  }
}
