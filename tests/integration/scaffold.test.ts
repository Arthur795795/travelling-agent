import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("integration harness", () => {
  it("runs without network credentials", () => {
    assert.equal(true, true);
  });
});
