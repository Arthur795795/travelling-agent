import assert from "node:assert/strict";
import { test } from "node:test";

test("live evaluation remains disabled by default", () => {
  assert.notEqual(process.env.ENABLE_LIVE_EVAL, "true");
});
