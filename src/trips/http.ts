import { createHash } from "node:crypto";
import { z } from "zod";
import { TripSchema } from "../domain/schema.ts";
import { ChangeSchema, previewChange, commitChange } from "./changes.ts";
import { TransientSecret } from "../security/secrets.ts";
import { issue } from "../validation/trip.ts";
import type { ExecutionStore } from "../jobs/execution-store.ts";
import type { PlanningExecutor } from "../jobs/executor.ts";
const InputSchema = z
  .object({
    trip: TripSchema,
    change: ChangeSchema,
    confirmation: z.string().optional(),
    apiKey: z
      .string()
      .regex(/^sk-[\w-]{13,}$/)
      .max(300)
      .optional(),
  })
  .strict();
export function changeHttp(
  store: ExecutionStore,
  executor: PlanningExecutor,
  enabled = () => false,
) {
  return async (
    request: Request,
    id: string,
    action: "preview" | "changes" | "replan",
  ) => {
    const headers = { "Cache-Control": "no-store" };
    try {
      const body = InputSchema.parse(await request.json());
      if (body.trip.id !== id) throw new Error("TRIP_MISMATCH");
      const preview = previewChange(body.trip, body.change);
      const confirmation = createHash("sha256")
        .update(JSON.stringify({ trip: body.trip, change: body.change }))
        .digest("hex");
      if (action === "preview")
        return Response.json({ ...preview, confirmation }, { headers });
      if (preview.major && body.confirmation !== confirmation)
        return Response.json(
          { code: "CONFIRMATION_REQUIRED" },
          { status: 409, headers },
        );
      if (preview.lockConflicts.length)
        return Response.json(
          { code: "UNLOCK_REQUIRED" },
          { status: 409, headers },
        );
      if (action === "changes") {
        if (preview.major)
          return Response.json(
            { code: "USE_REPLAN" },
            { status: 409, headers },
          );
        return Response.json(commitChange(body.trip, body.change), { headers });
      }
      if (!enabled())
        return Response.json(
          { code: "FEATURE_DISABLED" },
          { status: 403, headers },
        );
      const { job, token } = store.create(body.trip.brief);
      store.update(job.id, (_j, state) => {
        state.replan = { base: body.trip, change: body.change };
        state.trip = body.trip;
        state.issues = [issue("REPLAN_REQUESTED", "等待局部重规划", [id])];
      });
      void executor.run(
        job.id,
        body.apiKey ? new TransientSecret(body.apiKey) : undefined,
      );
      return Response.json(
        { id: job.id, accessToken: token, baseVersion: body.trip.version },
        {
          status: 202,
          headers: {
            ...headers,
            "Set-Cookie": `job_${job.id}=${token}; HttpOnly; SameSite=Strict; Path=/api/planning-jobs/${job.id}${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`,
          },
        },
      );
    } catch {
      return Response.json(
        { code: "INVALID_CHANGE" },
        { status: 400, headers },
      );
    }
  };
}
