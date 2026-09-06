import { feedbackApi } from "../../../../analytics/runtime.ts";
export const runtime = "nodejs";
/**
 * Withdrawing your own feedback is never rate limited or feature gated, the
 * same way a share can always be revoked: the delete token is the only proof
 * of ownership and erasure must not be refused by a quota.
 */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ token: string }> },
) {
  return feedbackApi().remove((await context.params).token);
}
