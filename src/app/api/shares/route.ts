import { observe } from "../../../analytics/runtime.ts";
import { shareHttp } from "../../../sharing/runtime.ts";
import { withGuard } from "../../../security/guard-runtime.ts";
export const runtime = "nodejs";
export const POST = (request: Request) =>
  withGuard("sharing", request, () =>
    observe("share_created", () => shareHttp().create(request)),
  );
