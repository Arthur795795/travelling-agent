import { jobHttp } from "../../../jobs/runtime.ts";
export const runtime = "nodejs";
export async function POST(request: Request) {
  return jobHttp().create(request);
}
