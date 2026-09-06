import assert from "node:assert/strict";
import test from "node:test";
import { decodePathSegment } from "../../src/routing/path-segment.ts";

test("decodes one encoded trip-id segment and keeps plain ids unchanged", () => {
  assert.equal(
    decodePathSegment("trip%3A123e4567-e89b-12d3-a456-426614174000"),
    "trip:123e4567-e89b-12d3-a456-426614174000",
  );
  assert.equal(decodePathSegment("plain-job-id"), "plain-job-id");
});

test("malformed path encoding fails closed", () => {
  assert.equal(decodePathSegment("trip%3Ainvalid%"), "");
});
