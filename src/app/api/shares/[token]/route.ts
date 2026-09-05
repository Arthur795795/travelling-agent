import { shareHttp } from "../../../../sharing/runtime.ts";
export const runtime = "nodejs";
export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> },
) {
  return shareHttp().read((await context.params).token);
}
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ token: string }> },
) {
  return shareHttp().delete((await context.params).token);
}
