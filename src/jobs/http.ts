import { z } from "zod";
import { checkRequirements } from "../requirements/service.ts";
import { TransientSecret } from "../security/secrets.ts";
import type { PlanningExecutor } from "./executor.ts";
import type { ExecutionStore } from "./execution-store.ts";
const KeySchema = z
  .string()
  .min(16)
  .max(300)
  .regex(/^sk-[\w-]+$/);
const CreateSchema = z
  .object({ input: z.unknown(), apiKey: KeySchema })
  .strict();
const headers = { "Cache-Control": "no-store" };
export function createJobHttp(
  store: ExecutionStore,
  executor: PlanningExecutor,
  enabled = () => false,
  now = () => new Date(),
) {
  const authorized = (request: Request, id: string) => {
    const bearer = request.headers
      .get("authorization")
      ?.replace(/^Bearer /, "");
    const cookie = request.headers
      .get("cookie")
      ?.split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(`job_${id}=`))
      ?.split("=")[1];
    return store.authorized(id, bearer ?? cookie ?? "");
  };
  const denied = () =>
    Response.json({ code: "JOB_UNAVAILABLE" }, { status: 404, headers });
  return {
    async create(request: Request) {
      if (!enabled())
        return Response.json(
          { code: "GENERATION_DISABLED" },
          { status: 403, headers },
        );
      const parsed = CreateSchema.safeParse(
        await request.json().catch(() => null),
      );
      if (!parsed.success)
        return Response.json(
          { code: "INVALID_INPUT" },
          { status: 400, headers },
        );
      const checked = checkRequirements(parsed.data.input, now);
      if (checked.state !== "ready")
        return Response.json(checked, { status: 422, headers });
      const { job, token } = store.create(checked.brief);
      void executor.run(job.id, new TransientSecret(parsed.data.apiKey));
      return Response.json(
        { id: job.id, accessToken: token, view: store.view(job.id) },
        {
          status: 202,
          headers: {
            ...headers,
            "Set-Cookie": `job_${job.id}=${token}; HttpOnly; SameSite=Strict; Path=/api/planning-jobs/${job.id}${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`,
          },
        },
      );
    },
    async get(request: Request, id: string) {
      if (!authorized(request, id)) return denied();
      return Response.json(store.view(id), { headers });
    },
    async cancel(request: Request, id: string) {
      if (!authorized(request, id)) return denied();
      executor.cancel(id);
      return Response.json(store.view(id), { headers });
    },
    async resume(request: Request, id: string) {
      if (!authorized(request, id)) return denied();
      if (!enabled())
        return Response.json(
          { code: "GENERATION_DISABLED" },
          { status: 403, headers },
        );
      const parsed = z
        .object({ apiKey: KeySchema })
        .strict()
        .safeParse(await request.json().catch(() => null));
      if (!parsed.success)
        return Response.json(
          { code: "INVALID_INPUT" },
          { status: 400, headers },
        );
      if (store.view(id).status !== "waiting_for_credentials")
        return Response.json({ code: "NOT_WAITING" }, { status: 409, headers });
      void executor.run(id, new TransientSecret(parsed.data.apiKey));
      return Response.json(store.view(id), { status: 202, headers });
    },
    async events(request: Request, id: string) {
      if (!authorized(request, id)) return denied();
      let cursor = Number(
        request.headers.get("last-event-id") ??
          new URL(request.url).searchParams.get("after") ??
          0,
      );
      if (
        !Number.isSafeInteger(cursor) ||
        cursor < 0 ||
        cursor > store.view(id).sequence
      )
        return Response.json(
          { code: "INVALID_CURSOR" },
          { status: 400, headers },
        );
      const encoder = new TextEncoder();
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cleanup = () => {};
      const stop = () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        cleanup();
      };
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const abort = () => {
            stop();
            try {
              controller.close();
            } catch {}
          };
          request.signal.addEventListener("abort", abort, { once: true });
          cleanup = () => request.signal.removeEventListener("abort", abort);
          if (request.signal.aborted) {
            abort();
            return;
          }
          const pump = () => {
            if (stopped) return;
            try {
              for (const event of store.events(id, cursor)) {
                controller.enqueue(
                  encoder.encode(
                    `id: ${event.sequence}\nevent: progress\ndata: ${JSON.stringify(event.view)}\n\n`,
                  ),
                );
                cursor = event.sequence;
              }
              if (
                [
                  "completed",
                  "failed",
                  "cancelled",
                  "waiting_for_credentials",
                ].includes(store.view(id).status)
              ) {
                stop();
                request.signal.removeEventListener("abort", abort);
                controller.close();
                return;
              }
              controller.enqueue(encoder.encode(": heartbeat\n\n"));
              timer = setTimeout(pump, 500);
            } catch {
              stop();
              request.signal.removeEventListener("abort", abort);
              controller.close();
            }
          };
          pump();
        },
        cancel() {
          stop();
        },
      });
      return new Response(stream, {
        headers: {
          ...headers,
          "Content-Type": "text/event-stream",
          "X-Accel-Buffering": "no",
        },
      });
    },
  };
}
