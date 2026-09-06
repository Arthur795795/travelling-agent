import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { SqliteDatabase } from "../persistence/database.ts";
import { validateChatInput } from "../security/sensitive-input.ts";
import type { SensitiveDataKind } from "../security/redaction.ts";
import {
  FEEDBACK_COMMENT_MAX,
  FEEDBACK_CONTEXTS,
  FEEDBACK_REASONS,
  FEEDBACK_RETENTION_DAYS,
} from "./feedback-contract.ts";

/**
 * `confirmed` is the user's explicit submit action after the purpose notice.
 * Without it nothing is stored, so a draft comment is never uploaded.
 */
export const FeedbackSubmissionSchema = z
  .object({
    rating: z.enum(["up", "down"]),
    context: z.enum(FEEDBACK_CONTEXTS),
    reasons: z
      .array(z.enum(FEEDBACK_REASONS))
      .max(FEEDBACK_REASONS.length)
      .default([]),
    comment: z.string().trim().max(FEEDBACK_COMMENT_MAX).optional(),
    confirmed: z.literal(true),
  })
  .strict();

export type FeedbackSubmission = z.infer<typeof FeedbackSubmissionSchema>;

export interface FeedbackReceipt {
  id: string;
  deleteToken: string;
  expiresAt: string;
}

export class SensitiveFeedbackError extends Error {
  readonly code = "SENSITIVE_FEEDBACK";
  readonly kind: SensitiveDataKind;
  constructor(kind: SensitiveDataKind, message: string) {
    super(message);
    this.name = "SensitiveFeedbackError";
    this.kind = kind;
  }
}

const tokenHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export class FeedbackService {
  private readonly db: SqliteDatabase;
  private readonly now: () => Date;
  constructor(db: SqliteDatabase, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  /** Stores one rating; returns the only token that can delete it again. */
  create(input: unknown): FeedbackReceipt {
    const submission = FeedbackSubmissionSchema.parse(input);
    const comment = submission.comment?.length ? submission.comment : undefined;
    if (comment) {
      const checked = validateChatInput(comment);
      if (!checked.accepted)
        throw new SensitiveFeedbackError(checked.kind, checked.message);
    }
    const at = this.now();
    const receipt: FeedbackReceipt = {
      id: randomUUID(),
      deleteToken: randomBytes(32).toString("hex"),
      expiresAt: new Date(
        at.getTime() + FEEDBACK_RETENTION_DAYS * 86_400_000,
      ).toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO feedback_records
           (id,delete_token_hash,rating,reasons,comment,context,created_at,expires_at)
         VALUES (@id,@deleteTokenHash,@rating,@reasons,@comment,@context,@createdAt,@expiresAt)`,
      )
      .run({
        id: receipt.id,
        deleteTokenHash: tokenHash(receipt.deleteToken),
        rating: submission.rating,
        reasons: JSON.stringify([...new Set(submission.reasons)]),
        comment: comment ?? null,
        context: submission.context,
        createdAt: at.toISOString(),
        expiresAt: receipt.expiresAt,
      });
    return receipt;
  }

  /** Deletes the visitor's own record; unknown or stale tokens report false. */
  delete(token: string): boolean {
    return (
      /^[a-f0-9]{64}$/.test(token) &&
      this.db
        .prepare("DELETE FROM feedback_records WHERE delete_token_hash = ?")
        .run(tokenHash(token)).changes === 1
    );
  }
}

/** Drops feedback past its 30-day retention window. */
export function cleanupFeedback(
  db: SqliteDatabase,
  at: Date = new Date(),
): number {
  return db
    .prepare("DELETE FROM feedback_records WHERE expires_at <= ?")
    .run(at.toISOString()).changes;
}
