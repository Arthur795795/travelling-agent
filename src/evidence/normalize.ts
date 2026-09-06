import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ClaimSchema,
  EntityIdSchema,
  EvidenceSchema,
  IsoDateSchema,
  ValidationIssueSchema,
  type Claim,
  type Evidence,
  type ValidationIssue,
} from "../domain/schema.ts";
import { mergeEvidence, resolveClaim } from "./resolve.ts";

export const EvidenceObservationSchema = z
  .object({
    id: EntityIdSchema,
    subjectId: EntityIdSchema,
    placeId: EntityIdSchema.optional(),
    date: IsoDateSchema.optional(),
    field: z.string().min(1).max(100),
    critical: z.boolean().default(false),
    evidence: EvidenceSchema,
  })
  .strict();

export type EvidenceObservation = z.infer<typeof EvidenceObservationSchema>;

export interface NormalizedEvidenceSet {
  claims: Claim[];
  evidence: Evidence[];
  issues: ValidationIssue[];
}

function normalizedValue(value: Evidence["assertedValue"]): string {
  if (typeof value === "string")
    return `s:${value.trim().replace(/\s+/g, " ").toLocaleLowerCase()}`;
  return `${typeof value}:${JSON.stringify(value)}`;
}

function evidenceKey(evidence: Evidence): string {
  return [
    evidence.sourceType,
    evidence.sourceName,
    evidence.url ?? "",
    normalizedValue(evidence.assertedValue),
  ].join("|");
}

function groupKey(observation: EvidenceObservation): string {
  return [
    observation.subjectId,
    observation.placeId ?? "",
    observation.date ?? "",
    observation.field,
  ].join("|");
}

function stableId(prefix: string, value: string): string {
  const digest = createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 24);
  // Group machine-generated digits so a random hash can never resemble a
  // contiguous mainland-China phone or identity number to the privacy guard.
  return `${prefix}:${digest.match(/.{1,4}/g)!.join("-")}`;
}

export function normalizeEvidence(
  observationsInput: EvidenceObservation[],
): NormalizedEvidenceSet {
  const observations = observationsInput.map((item) =>
    EvidenceObservationSchema.parse(item),
  );
  const evidence: Evidence[] = [];
  const usedEvidenceIds = new Set<string>();
  const groups = new Map<string, EvidenceObservation[]>();
  for (const observation of observations) {
    const key = groupKey(observation);
    groups.set(key, [...(groups.get(key) ?? []), observation]);
  }

  const claims: Claim[] = [];
  const issues: ValidationIssue[] = [];
  for (const [key, group] of groups) {
    const first = group[0];
    const groupEvidence = mergeEvidence(
      [],
      group.map(({ evidence: item }) => item),
    ).map((item) => {
      const id = usedEvidenceIds.has(item.id)
        ? stableId("evidence", JSON.stringify([key, item.id]))
        : item.id;
      usedEvidenceIds.add(id);
      return { ...item, id };
    });
    evidence.push(...groupEvidence);
    const canonicalIds = new Map(
      groupEvidence.map((item) => [evidenceKey(item), item.id]),
    );
    const evidenceIds = [
      ...new Set(
        group.map(
          ({ evidence: item }) =>
            canonicalIds.get(evidenceKey(item)) ?? item.id,
        ),
      ),
    ];
    const initial = ClaimSchema.parse({
      id: stableId("claim", key),
      subjectId: first.subjectId,
      placeId: first.placeId,
      date: first.date,
      critical: group.some((item) => item.critical),
      field: first.field,
      evidenceIds,
      status: "recheck_required",
      conflictEvidenceIds: [],
    });
    const resolution = resolveClaim(initial, groupEvidence);
    claims.push(resolution.claim);
    const critical = group.some(({ critical: value }) => value);
    const unresolved = resolution.claim.status !== "verified";
    if (unresolved) {
      issues.push(
        ValidationIssueSchema.parse({
          id: stableId("issue", `${key}|unresolved`),
          severity: critical ? "blocking" : "warning",
          code: critical
            ? "UNRESOLVED_CRITICAL_EVIDENCE"
            : "UNRESOLVED_EVIDENCE",
          message: critical
            ? "关键事实缺少可裁决的可靠证据。"
            : "事实仍需复核。",
          entityIds: [first.subjectId, ...evidenceIds],
          path: [first.date ?? "", first.field].filter(Boolean),
        }),
      );
    } else if (resolution.claim.conflictEvidenceIds.length > 0) {
      issues.push(
        ValidationIssueSchema.parse({
          id: stableId("issue", `${key}|resolved-conflict`),
          severity: "warning",
          code: "EVIDENCE_CONFLICT_RESOLVED",
          message: "来源存在冲突，当前值依据较高优先级来源裁决。",
          entityIds: [first.subjectId, ...resolution.claim.conflictEvidenceIds],
          path: [first.date ?? "", first.field].filter(Boolean),
        }),
      );
    }
  }
  return { claims, evidence, issues };
}
