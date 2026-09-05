import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("security harness", () => {
  it("does not expose a public DeepSeek key environment variable", () => {
    assert.equal(
      Object.keys(process.env).some((key) =>
        key.startsWith("NEXT_PUBLIC_DEEPSEEK"),
      ),
      false,
    );
  });
});
