import assert from "node:assert/strict";
import test from "node:test";
import type { Claim, Evidence } from "../../src/domain/schema.ts";
import { mergeEvidence, resolveClaim } from "../../src/evidence/resolve.ts";

const checkedAt = "2026-09-04T10:00:00+08:00";
const claim: Claim = {
  id: "claim-1",
  subjectId: "place-1",
  field: "openingHours",
  evidenceIds: ["official", "web"],
  status: "recheck_required",
  conflictEvidenceIds: [],
};

function evidence(
  id: string,
  sourceType: Evidence["sourceType"],
  assertedValue: string,
  status: Evidence["status"] = "verified",
): Evidence {
  return { id, sourceType, sourceName: id, checkedAt, status, assertedValue };
}

test("higher-priority official evidence wins but conflicts remain visible", () => {
  const resolution = resolveClaim(claim, [
    evidence("official", "official", "周一闭馆"),
    evidence("web", "web", "每日开放"),
  ]);
  assert.equal(resolution.claim.value, "周一闭馆");
  assert.equal(resolution.claim.status, "verified");
  assert.deepEqual(resolution.claim.conflictEvidenceIds, ["web"]);
  assert.deepEqual(resolution.selectedEvidenceIds, ["official"]);
});

test("same-priority disagreement requires recheck and does not invent a value", () => {
  const samePriorityClaim = {
    ...claim,
    value: "原值",
    evidenceIds: ["a", "b"],
  };
  const resolution = resolveClaim(samePriorityClaim, [
    evidence("a", "platform", "08:00"),
    evidence("b", "platform", "09:00"),
  ]);
  assert.equal(resolution.claim.status, "recheck_required");
  assert.equal(resolution.claim.value, "原值");
  assert.deepEqual(resolution.claim.conflictEvidenceIds.sort(), ["a", "b"]);
  assert.deepEqual(resolution.selectedEvidenceIds, []);
});

test("consistent evidence is normalized and failed evidence is ignored", () => {
  const resolution = resolveClaim(claim, [
    evidence("official", "official", "需要 预约"),
    evidence("web", "web", " 需要   预约 "),
    evidence("failed", "official", "无需预约", "failed"),
  ]);
  assert.equal(resolution.claim.status, "verified");
  assert.equal(resolution.claim.conflictEvidenceIds.length, 0);
});

test("missing usable evidence fails and merge keeps the newest duplicate", () => {
  assert.equal(
    resolveClaim({ ...claim, evidenceIds: ["missing"] }, []).claim.status,
    "failed",
  );
  const old = {
    ...evidence("old", "official", "需要预约"),
    sourceName: "同一官网",
  };
  const newer = {
    ...evidence("new", "official", "需要预约"),
    sourceName: "同一官网",
    checkedAt: "2026-09-04T11:00:00+08:00",
  };
  assert.deepEqual(
    mergeEvidence([old], [newer]).map(({ id }) => id),
    ["old"],
  );
  assert.equal(mergeEvidence([old], [newer])[0].checkedAt, newer.checkedAt);
});

test("compares evidence timestamps as instants even when offsets differ", () => {
  const earlierText = "2026-09-04T09:30:00+08:00"; // 01:30Z
  const laterInstant = "2026-09-04T02:00:00Z";
  const old = {
    ...evidence("old", "official", "需要预约"),
    sourceName: "同一官网",
    checkedAt: earlierText,
  };
  const newer = {
    ...evidence("new", "official", "需要预约"),
    sourceName: "同一官网",
    checkedAt: laterInstant,
  };
  assert.equal(mergeEvidence([old], [newer])[0].checkedAt, laterInstant);

  const resolution = resolveClaim({ ...claim, evidenceIds: ["old", "new"] }, [
    old,
    newer,
  ]);
  assert.equal(resolution.claim.checkedAt, laterInstant);
});
