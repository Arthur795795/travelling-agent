import assert from "node:assert/strict";
import test from "node:test";
import type { EvidenceObservation } from "../../src/evidence/normalize.ts";
import { normalizeEvidence } from "../../src/evidence/normalize.ts";

function observation(
  id: string,
  sourceType: "official" | "dedicated_api" | "platform" | "web",
  value: string,
  overrides: Partial<EvidenceObservation> = {},
): EvidenceObservation {
  return {
    id: `observation-${id}`,
    subjectId: "place-1",
    date: "2026-10-01",
    field: "openingHours",
    critical: true,
    evidence: {
      id: `evidence-${id}`,
      sourceType,
      sourceName: `${sourceType}-source`,
      checkedAt: "2026-09-05T10:00:00+08:00",
      status: "verified",
      assertedValue: value,
    },
    ...overrides,
  };
}

test("deduplicates claims by subject/date/field while retaining participating sources", () => {
  const result = normalizeEvidence([
    observation("official", "official", "周一闭馆"),
    observation("web", "web", "周一闭馆"),
  ]);
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].status, "verified");
  assert.equal(result.claims[0].value, "周一闭馆");
  assert.deepEqual(result.claims[0].evidenceIds.sort(), [
    "evidence-official",
    "evidence-web",
  ]);
  assert.equal(result.evidence.length, 2);
  assert.deepEqual(result.issues, []);
});

test("lower-priority evidence requiring recheck does not downgrade a matching verified official fact", () => {
  const result = normalizeEvidence([
    observation("official", "official", "周一闭馆"),
    observation("web", "web", "周一闭馆", {
      evidence: {
        id: "evidence-web",
        sourceType: "web",
        sourceName: "web-source",
        checkedAt: "2026-09-05T10:00:00+08:00",
        status: "recheck_required",
        assertedValue: "周一闭馆",
      },
    }),
  ]);
  assert.equal(result.claims[0].status, "verified");
  assert.deepEqual(result.issues, []);
});

test("keeps resolved and unresolved conflicts visible with deterministic severity", () => {
  const resolved = normalizeEvidence([
    observation("official", "official", "周一闭馆"),
    observation("web", "web", "每日开放"),
  ]);
  assert.equal(resolved.claims[0].value, "周一闭馆");
  assert.deepEqual(resolved.claims[0].conflictEvidenceIds, ["evidence-web"]);
  assert.equal(resolved.issues[0].code, "EVIDENCE_CONFLICT_RESOLVED");
  assert.equal(resolved.issues[0].severity, "warning");

  const unresolved = normalizeEvidence([
    observation("platform-a", "platform", "08:00"),
    observation("platform-b", "platform", "09:00"),
  ]);
  assert.equal(unresolved.claims[0].status, "recheck_required");
  assert.deepEqual(unresolved.claims[0].conflictEvidenceIds.sort(), [
    "evidence-platform-a",
    "evidence-platform-b",
  ]);
  assert.equal(unresolved.issues[0].code, "UNRESOLVED_CRITICAL_EVIDENCE");
  assert.equal(unresolved.issues[0].severity, "blocking");
});

test("does not merge facts from different dates and keeps newest exact duplicate evidence", () => {
  const old = observation("old", "official", "开放", {
    evidence: {
      id: "evidence-old",
      sourceType: "official",
      sourceName: "same-source",
      checkedAt: "2026-09-05T01:00:00Z",
      status: "verified",
      assertedValue: "开放",
    },
  });
  const newer = observation("new", "official", "开放", {
    evidence: {
      id: "evidence-new",
      sourceType: "official",
      sourceName: "same-source",
      checkedAt: "2026-09-05T10:00:00+08:00",
      status: "verified",
      assertedValue: "开放",
    },
  });
  const anotherDate = observation("other-date", "official", "闭馆", {
    date: "2026-10-02",
  });
  const result = normalizeEvidence([old, newer, anotherDate]);
  assert.equal(result.claims.length, 2);
  assert.equal(result.evidence.length, 2);
  assert.equal(
    result.evidence.find(({ id }) => id === "evidence-old")?.checkedAt,
    "2026-09-05T10:00:00+08:00",
  );
});

test("same source and value on different dates retain independent evidence status and date association", () => {
  const first = observation("shared", "official", "开放");
  const second = {
    ...first,
    date: "2026-10-02",
    evidence: {
      ...first.evidence,
      status: "recheck_required" as const,
      checkedAt: "2026-09-06T10:00:00+08:00",
    },
  };
  const result = normalizeEvidence([first, second]);
  assert.equal(
    result.claims.find(({ date }) => date === first.date)?.status,
    "verified",
  );
  assert.equal(
    result.claims.find(({ date }) => date === second.date)?.status,
    "recheck_required",
  );
  assert.equal(new Set(result.evidence.map(({ id }) => id)).size, 2);
});
