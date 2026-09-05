import { jobHttp } from "../../../../../jobs/runtime.ts";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return jobHttp().events(request, id);
}
