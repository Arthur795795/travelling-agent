import assert from "node:assert/strict";
import { test } from "node:test";

test("fixture evaluation command is network-free", () => {
  assert.equal(process.env.ENABLE_LIVE_EVAL, undefined);
});
