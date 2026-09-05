"use client";
import { useState } from "react";
import type { Trip } from "../domain/schema.ts";
import { projectTrip } from "../trips/presentation.ts";
import { tripActions } from "../trips/actions.ts";
import { TripTimeline } from "./trip-timeline.tsx";
import { TripDetails } from "./trip-details.tsx";
export function TripTransfer({ trip }: { trip: Trip }) {
  const [fields, setFields] = useState({ budget: false, privateNotes: false });
  const [preview, setPreview] = useState(false),
    [message, setMessage] = useState("");
  const [share, setShare] = useState<{
    readUrl: string;
    deleteToken: string;
    expiresAt: string;
  }>();
  const [busy, setBusy] = useState(false);
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
      if (!response.ok) throw new Error();
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `itinerary.${format}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(
        `已导出 ${format.toUpperCase()}${format === "ics" ? `；跳过无时间项目 ${response.headers.get("X-Skipped-Untimed") ?? 0} 项` : ""}`,
      );
    } catch {
      setMessage("导出失败，请检查导出开关或 PDF 渲染配置后重试。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h2>分享与导出</h2>
      <p>默认隐藏预算、私人备注和预订；不包含聊天。勾选后会公开所选字段。</p>
      <label>
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
      <label>
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
      <button onClick={() => setPreview(true)}>预览分享字段</button>
      <button disabled={busy} onClick={() => download("pdf")}>
        导出 PDF
      </button>
      <button disabled={busy} onClick={() => download("ics")}>
        导出 ICS
      </button>
      {preview && (
        <section aria-label="分享预览">
          <h3>分享前预览</h3>
          <TripDetails
            trip={projectTrip(trip, fields)}
            showBudget={fields.budget}
          />
          <TripTimeline trip={projectTrip(trip, fields)} />
          <button disabled={busy} onClick={createShare}>
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
      <p role="status">{message}</p>
      <h3>外部行动入口</h3>
      {tripActions(trip).map((a, i) => (
        <p key={i}>
          <a href={a.url} target="_blank" rel="noreferrer">
            {a.title}
          </a>{" "}
          · 查询/生成时间 {a.checkedAt} · {a.notice}
        </p>
      ))}
      <p>没有可靠坐标或平台入口的项目不会生成猜测链接。</p>
    </section>
  );
}
