import { jobHttp } from "../../../../../jobs/runtime.ts";
export const runtime = "nodejs";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return jobHttp().cancel(request, id);
}
