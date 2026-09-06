"use client";
import { useState } from "react";
import type { Trip } from "../domain/schema.ts";
import { projectTrip } from "../trips/presentation.ts";
import { tripActions } from "../trips/actions.ts";
import { OFFLINE_DISABLED_NOTICE } from "../offline/shell.ts";
import { TripTimeline } from "./trip-timeline.tsx";
import { TripDetails } from "./trip-details.tsx";
import { useOfflineNow } from "./use-offline-now.ts";
export function TripTransfer({ trip }: { trip: Trip }) {
  const offline = useOfflineNow();
  const [fields, setFields] = useState({ budget: false, privateNotes: false });
  const [preview, setPreview] = useState(false),
    [message, setMessage] = useState("");
  const [share, setShare] = useState<{
    readUrl: string;
    deleteToken: string;
    expiresAt: string;
  }>();
  const [busy, setBusy] = useState(false);
  // Sharing, export and link checks all need the network, so offline they are
  // disabled with a stated reason rather than failing after a click.
  const blocked: { disabled?: true; "aria-describedby"?: string } = offline
    ? { disabled: true, "aria-describedby": "offline-transfer-reason" }
    : {};
  async function createShare() {
    setBusy(true);
    try {
      const response = await fetch("/api/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trip, fields, confirmed: true }),
      });
      if (!response.ok) throw new Error();
      setShare(await response.json());
      setPreview(false);
    } catch {
      setMessage("分享未创建，请检查功能开关或网络后重试。");
    } finally {
      setBusy(false);
    }
  }
  async function download(format: "pdf" | "ics") {
    setBusy(true);
    try {
      const response = await fetch(
        `/api/trips/${encodeURIComponent(trip.id)}/export.${format}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trip, fields }),
        },
      );
      if (!response.ok) {
        const failure = (await response.json().catch(() => ({}))) as {
          code?: string;
        };
        if (response.status === 403)
          throw new Error("EXPORT_DISABLED");
        if (failure.code === "PDF_EXPORT_FAILED")
          throw new Error("PDF_RUNTIME");
        throw new Error("EXPORT_FAILED");
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `itinerary.${format}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(
        `已导出 ${format.toUpperCase()}${format === "ics" ? `；跳过无时间项目 ${response.headers.get("X-Skipped-Untimed") ?? 0} 项` : ""}`,
      );
    } catch (error) {
      setMessage(
        error instanceof Error && error.message === "EXPORT_DISABLED"
          ? "导出功能尚未启用，请检查本地功能开关。"
          : error instanceof Error && error.message === "PDF_RUNTIME"
            ? "PDF 生成环境不可用；请检查中文字体和 PDF Python 配置。"
            : "导出失败，请稍后重试。",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="transfer-card">
      <div className="section-heading">
        <div>
          <p className="eyebrow">带走行程</p>
          <h2>分享与导出</h2>
        </div>
        <div className="actions">
          <button disabled={busy} {...blocked} onClick={() => download("pdf")}>
            导出 PDF
          </button>
          <button
            className="secondary"
            disabled={busy}
            {...blocked}
            onClick={() => download("ics")}
          >
            导出 ICS
          </button>
        </div>
      </div>
      <p>PDF 默认隐藏预算、私人备注和预订，不包含聊天内容。</p>
      {offline && (
        <p role="note" id="offline-transfer-reason">
          {OFFLINE_DISABLED_NOTICE}
        </p>
      )}
      <details className="disclosure-card">
        <summary>创建只读分享</summary>
        <p>勾选后才会把对应字段放进分享页。</p>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={fields.budget}
            onChange={(e) => {
              setFields({ ...fields, budget: e.target.checked });
              setPreview(false);
            }}
          />
          包含预算
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={fields.privateNotes}
            onChange={(e) => {
              setFields({ ...fields, privateNotes: e.target.checked });
              setPreview(false);
            }}
          />
          包含私人备注和预订
        </label>
        <button {...blocked} onClick={() => setPreview(true)}>
          预览分享字段
        </button>
        {preview && (
          <section aria-label="分享预览">
            <h3>分享前预览</h3>
            <TripDetails
              trip={projectTrip(trip, fields)}
              showBudget={fields.budget}
            />
            <TripTimeline trip={projectTrip(trip, fields)} />
            <button disabled={busy} {...blocked} onClick={createShare}>
              确认创建只读分享
            </button>
            <button onClick={() => setPreview(false)}>取消分享</button>
          </section>
        )}
        {share && (
          <>
            <a href={share.readUrl}>打开只读分享</a>
            <p>到期：{share.expiresAt}</p>
            <label>
              请单独保存删除令牌
              <input readOnly value={share.deleteToken} />
            </label>
            <p>删除令牌仅在本页内存显示，离开前请自行妥善保存。</p>
            <button
              {...blocked}
              onClick={async () => {
                try {
                  const r = await fetch(`/api/shares/${share.deleteToken}`, {
                    method: "DELETE",
                  });
                  if (!r.ok) throw new Error();
                  setShare(undefined);
                  setMessage("分享已删除");
                } catch {
                  setMessage("删除失败，请重试");
                }
              }}
            >
              立即删除分享
            </button>
          </>
        )}
      </details>
      <p role="status">{message}</p>
      <details className="disclosure-card">
        <summary>酒店和交通平台搜索入口</summary>
        {tripActions(trip).map((action, index) => (
          <p key={index}>
            {offline ? (
              <span>{action.title} · 离线无法打开与核验</span>
            ) : (
              <a href={action.url} target="_blank" rel="noreferrer">
                {action.title}
              </a>
            )}{" "}
            · 查询/生成时间 {action.checkedAt} · {action.notice}
          </p>
        ))}
        <p>没有可靠坐标或平台入口的项目不会生成猜测链接。</p>
      </details>
    </section>
  );
}
