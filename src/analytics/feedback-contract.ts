/**
 * Values shared by the feedback API and the browser panel. Kept free of any
 * import so the client bundle never pulls in `node:crypto` or the database.
 */

/** Reason tags are a closed list, so no reason can carry free text. */
export const FEEDBACK_REASONS = [
  "schedule",
  "evidence",
  "budget",
  "alternatives",
  "speed",
  "interface",
  "other",
] as const;

/** Where the rating was given; also a closed list. */
export const FEEDBACK_CONTEXTS = [
  "fixed_demo",
  "generated_trip",
  "replan",
  "share",
] as const;

export const FEEDBACK_COMMENT_MAX = 500;
export const FEEDBACK_RETENTION_DAYS = 30;

/** Why the data is collected; shown before submitting and served for reuse. */
export const FEEDBACK_PURPOSE =
  "反馈只用于改进行程规划质量。我们保存评分、原因标签和你主动输入的评论，最多 30 天，不保存聊天内容、行程正文或身份信息。";

export const FEEDBACK_REASON_LABELS: Record<FeedbackReason, string> = {
  schedule: "时间安排不合理",
  evidence: "信息或证据不足",
  budget: "预算估算不准",
  alternatives: "备选方案不够",
  speed: "生成太慢",
  interface: "界面不好用",
  other: "其他",
};

export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];
export type FeedbackContext = (typeof FEEDBACK_CONTEXTS)[number];
