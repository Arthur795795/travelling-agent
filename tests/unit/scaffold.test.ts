import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("project scaffold", () => {
  it("runs the unit test command without external services", () => {
    assert.equal(process.env.DEEPSEEK_API_KEY, undefined);
  });
});
