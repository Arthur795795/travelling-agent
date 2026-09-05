import {
  ClaimSchema,
  EvidenceSchema,
  type Claim,
  type Evidence,
} from "../domain/schema.ts";

const SOURCE_PRIORITY: Record<Evidence["sourceType"], number> = {
  official: 4,
  dedicated_api: 3,
  platform: 2,
  web: 1,
};

function normalizedValue(value: Evidence["assertedValue"]): string {
  if (typeof value === "string")
    return `s:${value.trim().replace(/\s+/g, " ").toLocaleLowerCase()}`;
  return `${typeof value}:${JSON.stringify(value)}`;
}

export interface ClaimResolution {
  claim: Claim;
  selectedEvidenceIds: string[];
}

export function resolveClaim(
  inputClaim: Claim,
  allEvidence: Evidence[],
): ClaimResolution {
  const claim = ClaimSchema.parse(inputClaim);
  const referenced = allEvidence
    .map((item) => EvidenceSchema.parse(item))
    .filter(
      (item) =>
        claim.evidenceIds.includes(item.id) &&
        item.status !== "failed" &&
        item.assertedValue !== undefined,
    );

  if (referenced.length === 0) {
    return {
      claim: ClaimSchema.parse({
        ...claim,
        status: "failed",
        conflictEvidenceIds: [],
      }),
      selectedEvidenceIds: [],
    };
  }

  const groups = new Map<string, Evidence[]>();
  for (const evidence of referenced) {
    const key = normalizedValue(evidence.assertedValue);
    groups.set(key, [...(groups.get(key) ?? []), evidence]);
  }
  const ranked = [...groups.values()].sort((left, right) => {
    const leftRank = Math.max(
      ...left.map((item) => SOURCE_PRIORITY[item.sourceType]),
    );
    const rightRank = Math.max(
      ...right.map((item) => SOURCE_PRIORITY[item.sourceType]),
    );
    return rightRank - leftRank;
  });
  const selected = ranked[0];
  const selectedRank = Math.max(
    ...selected.map((item) => SOURCE_PRIORITY[item.sourceType]),
  );
  const nextRank = ranked[1]
    ? Math.max(...ranked[1].map((item) => SOURCE_PRIORITY[item.sourceType]))
    : -1;
  const unresolvedConflict = ranked.length > 1 && selectedRank === nextRank;
  const conflictIds = unresolvedConflict
    ? referenced.map(({ id }) => id)
    : ranked.slice(1).flatMap((group) => group.map(({ id }) => id));
  const highestPrioritySelected = selected.filter(
    (item) => SOURCE_PRIORITY[item.sourceType] === selectedRank,
  );
  const status =
    unresolvedConflict ||
    highestPrioritySelected.every((item) => item.status !== "verified")
      ? "recheck_required"
      : "verified";

  return {
    claim: ClaimSchema.parse({
      ...claim,
      value: unresolvedConflict ? claim.value : selected[0].assertedValue,
      status,
      checkedAt: [...(unresolvedConflict ? referenced : selected)].sort(
        (a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt),
      )[0].checkedAt,
      conflictEvidenceIds: conflictIds,
    }),
    selectedEvidenceIds: unresolvedConflict ? [] : selected.map(({ id }) => id),
  };
}

export function mergeEvidence(
  existing: Evidence[],
  incoming: Evidence[],
): Evidence[] {
  const result = new Map<string, Evidence>();
  for (const item of [...existing, ...incoming]) {
    const evidence = EvidenceSchema.parse(item);
    const key = [
      evidence.sourceType,
      evidence.sourceName,
      evidence.url ?? "",
      normalizedValue(evidence.assertedValue),
    ].join("|");
    const previous = result.get(key);
    if (!previous) result.set(key, evidence);
    else if (Date.parse(evidence.checkedAt) > Date.parse(previous.checkedAt)) {
      result.set(key, { ...evidence, id: previous.id });
    }
  }
  return [...result.values()];
}
