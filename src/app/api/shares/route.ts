import { shareHttp } from "../../../sharing/runtime.ts";
export const runtime = "nodejs";
export const POST = (request: Request) => shareHttp().create(request);
