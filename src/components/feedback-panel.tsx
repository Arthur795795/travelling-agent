"use client";
import { useEffect, useState } from "react";
import {
  FEEDBACK_COMMENT_MAX,
  FEEDBACK_PURPOSE,
  FEEDBACK_REASONS,
  FEEDBACK_REASON_LABELS,
  type FeedbackContext,
  type FeedbackReason,
} from "../analytics/feedback-contract.ts";

const STORAGE_PREFIX = "travel.feedback.";

/**
 * Rating panel for one screen. Nothing leaves the browser until the visitor
 * presses 提交反馈 after reading the purpose notice, so a draft comment is
 * never uploaded. The delete token is the only thing kept locally, and it is
 * the only way to withdraw the record again.
 */
export function FeedbackPanel({ context }: { context: FeedbackContext }) {
  const key = `${STORAGE_PREFIX}${context}`;
  const [token, setToken] = useState<string | null>(null);
  const [rating, setRating] = useState<"up" | "down">();
  const [reasons, setReasons] = useState<FeedbackReason[]>([]);
  const [comment, setComment] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      try {
        if (active) setToken(localStorage.getItem(key));
      } catch {}
    });
    return () => {
      active = false;
    };
  }, [key]);
  const reset = () => {
    setRating(undefined);
    setReasons([]);
    setComment("");
  };
  async function submit() {
    if (!rating) return;
    setBusy(true);
    setStatus("");
    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rating,
          context,
          reasons,
          ...(comment.trim() ? { comment: comment.trim() } : {}),
          confirmed: true,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        deleteToken?: string;
        message?: string;
      };
      if (response.status === 201 && body.deleteToken) {
        try {
          localStorage.setItem(key, body.deleteToken);
        } catch {}
        setToken(body.deleteToken);
        reset();
        setStatus("已收到你的反馈，谢谢。");
        return;
      }
      setStatus(
        body.message ??
          (response.status === 429
            ? "提交过于频繁，请稍后再试。"
            : "反馈未提交：请调整内容后重试。"),
      );
    } catch {
      setStatus("反馈未提交：网络异常，请稍后再试。");
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!token) return;
    setBusy(true);
    try {
      await fetch(`/api/feedback/${encodeURIComponent(token)}`, {
        method: "DELETE",
      });
      try {
        localStorage.removeItem(key);
      } catch {}
      setToken(null);
      setStatus("已删除你的反馈记录。");
    } catch {
      setStatus("删除失败：请稍后再试。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="行程反馈">
      <h2>这份行程好用吗？</h2>
      <p>{FEEDBACK_PURPOSE}</p>
      {token ? (
        <button disabled={busy} onClick={remove}>
          删除我的反馈
        </button>
      ) : (
        <>
          <button
            aria-pressed={rating === "up"}
            disabled={busy}
            onClick={() => setRating("up")}
          >
            有帮助
          </button>
          <button
            aria-pressed={rating === "down"}
            disabled={busy}
            onClick={() => setRating("down")}
          >
            不好用
          </button>
          {rating && (
            <>
              <fieldset>
                <legend>原因（可多选）</legend>
                {FEEDBACK_REASONS.map((reason) => (
                  <label className="checkbox" key={reason}>
                    <input
                      type="checkbox"
                      checked={reasons.includes(reason)}
                      onChange={(event) =>
                        setReasons((current) =>
                          event.target.checked
                            ? [...current, reason]
                            : current.filter((value) => value !== reason),
                        )
                      }
                    />
                    {FEEDBACK_REASON_LABELS[reason]}
                  </label>
                ))}
              </fieldset>
              <label>
                补充说明（可选，请勿填写证件、联系方式等个人信息）
                <textarea
                  aria-label="反馈补充说明"
                  maxLength={FEEDBACK_COMMENT_MAX}
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                />
              </label>
              <button disabled={busy} onClick={submit}>
                提交反馈
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  reset();
                  setStatus("已取消，没有发送任何内容。");
                }}
              >
                取消反馈
              </button>
            </>
          )}
        </>
      )}
      <p role="status">{status}</p>
    </section>
  );
}
