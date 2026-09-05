import { NextResponse } from "next/server.js";
import { z } from "zod";
import {
  validateDeepSeekKey,
  type DeepSeekKeyErrorCode,
} from "../../../../../providers/deepseek/key-validator.ts";
import { TransientSecret } from "../../../../../security/secrets.ts";

const RequestSchema = z
  .object({ apiKey: z.string().trim().min(10).max(512) })
  .strict();

const statusByCode: Record<DeepSeekKeyErrorCode, number> = {
  invalid_key: 401,
  quota_or_permission: 402,
  rate_limited: 429,
  invalid_request: 400,
  network_error: 503,
  upstream_error: 502,
};

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, code: "invalid_request", retryable: false },
      { status: 400 },
    );
  }
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", retryable: false },
      { status: 400 },
    );
  }

  const result = await validateDeepSeekKey(
    new TransientSecret(parsed.data.apiKey),
  );
  return NextResponse.json(result, {
    status: result.ok ? 200 : statusByCode[result.code],
  });
}
