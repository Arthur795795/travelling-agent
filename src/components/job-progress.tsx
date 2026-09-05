"use client";
import { useEffect, useState } from "react";
import type { JobView } from "../jobs/protocol.ts";
import { BrowserTripStore } from "../persistence/browser-store.ts";
const terminal = (view: JobView) =>
  ["completed", "failed", "cancelled", "waiting_for_credentials"].includes(
    view.status,
  );
export default function JobProgress({ id }: { id: string }) {
  const [view, setView] = useState<JobView>();
  const [error, setError] = useState("");
  const [key, setKey] = useState("");
  const [epoch, setEpoch] = useState(0);
  const [transport, setTransport] = useState("连接进度流");
  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    let cursor = 0;
    let latest: JobView | undefined;
    const accept = (next: JobView) => {
      if (stopped || next.sequence < cursor) return;
      cursor = next.sequence;
      latest = next;
      setError("");
      setView(next);
      if (next.trip) {
        try {
          const store = new BrowserTripStore(localStorage);
          if (next.baseVersion !== undefined) {
            const current = store.loadTrip(next.trip.id);
            if (next.trip.version === next.baseVersion) {
              /* Failed repair retains the original without overwriting local edits. */
            } else if (current?.version === next.baseVersion)
              store.commitEdit(
                next.trip,
                {
                  id: crypto.randomUUID(),
                  tripId: next.trip.id,
                  baseVersion: next.baseVersion,
                  nextVersion: next.trip.version,
                  summary: "已确认局部重规划",
                  createdAt: next.trip.updatedAt,
                },
                next.baseVersion,
              );
            else if (JSON.stringify(current) !== JSON.stringify(next.trip))
              throw new Error("VERSION_CONFLICT");
          } else store.saveTrip(next.trip);
        } catch {
          setError("行程已完成，但本地保存失败，请保留本页。");
        }
      }
    };
    const wait = () =>
      new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          controller.signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, 1000);
        controller.signal.addEventListener("abort", finish, { once: true });
      });
    async function connect() {
      while (!stopped) {
        try {
          setTransport("实时进度");
          const response = await fetch(`/api/planning-jobs/${id}/events`, {
            headers: { "Last-Event-ID": String(cursor) },
            signal: controller.signal,
            cache: "no-store",
          });
          if (!response.ok || !response.body)
            throw new Error("STREAM_UNAVAILABLE");
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          try {
            while (!stopped) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const blocks = buffer.split("\n\n");
              buffer = blocks.pop() ?? "";
              for (const block of blocks) {
                const line = block
                  .split("\n")
                  .find((l) => l.startsWith("data: "));
                if (!line) continue;
                const next = JSON.parse(line.slice(6)) as JobView;
                accept(next);
              }
            }
          } finally {
            void reader.cancel().catch(() => undefined);
            reader.releaseLock();
          }
          // Historical waiting events may precede a resumed run in the same stream.
          if (latest && terminal(latest)) return;
        } catch {
          if (stopped) return;
        }
        setTransport("连接中断，正在轮询进度");
        try {
          const response = await fetch(`/api/planning-jobs/${id}`, {
            signal: controller.signal,
            cache: "no-store",
          });
          if (response.status === 404) {
            setError("任务不存在、已过期或当前浏览器没有访问权限。");
            return;
          }
          if (!response.ok) throw new Error();
          const next = (await response.json()) as JobView;
          accept(next);
          if (terminal(next)) return;
        } catch {
          if (!stopped) setError("网络暂时不可用，正在重试。");
        }
        await wait();
      }
    }
    void connect();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [id, epoch]);
  async function cancel() {
    try {
      const response = await fetch(`/api/planning-jobs/${id}/cancel`, {
        method: "POST",
      });
      if (!response.ok) throw new Error();
      setView(await response.json());
      setEpoch((e) => e + 1);
    } catch {
      setError("取消未成功，请重试。");
    }
  }
  async function resume() {
    try {
      const response = await fetch(`/api/planning-jobs/${id}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: key }),
      });
      setKey("");
      if (!response.ok) throw new Error();
      setEpoch((e) => e + 1);
    } catch {
      setError("未能恢复，请检查 Key 后重试。");
    }
  }
  return (
    <section>
      <p className="eyebrow">AI 辅助生成 · {view?.model ?? "DeepSeek"}</p>
      <h1>正在整理你的旅行</h1>
      <p role="status">{view?.message ?? "正在获取任务状态…"}</p>
      {view && !terminal(view) && (
        <>
          <p>{transport}</p>
          <button onClick={cancel}>取消任务</button>
        </>
      )}
      {view && (
        <p>
          已完成步骤：{view.usage.steps} · 模型估算费用：¥
          {view.usage.visitorModelCostCny.toFixed(3)}
        </p>
      )}
      {view?.status === "waiting_for_credentials" && (
        <>
          <label>
            重新提供 DeepSeek Key
            <input
              aria-label="恢复 Key"
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          <button disabled={!key} onClick={resume}>
            继续规划
          </button>
          <button onClick={cancel}>取消任务</button>
        </>
      )}
      {view?.status === "failed" && (
        <p>
          本次规划未能完成。
          {view.errorCode?.includes("LIMIT")
            ? "已达到费用或步骤上限。"
            : view.errorCode === "CALL_INTERRUPTED"
              ? "上次外部调用结果未确认，为避免重复计费已停止。"
              : "请检查网络、Key 或旅行约束。"}
          <a href="/plan">返回重新规划</a>
        </p>
      )}
      {view?.status === "completed" && (
        <>
          <p>
            {view.trip?.lifecycleStatus === "blocked"
              ? "行程仍有待解决事项，请核对后再出发。"
              : "行程已整理完成。"}
          </p>
          {view.trip && (
            <a
              className="button"
              href={`/trips/${encodeURIComponent(view.trip.id)}`}
            >
              查看行程时间线
            </a>
          )}
          {view.choices.map((choice) => (
            <p key={choice}>{choice}</p>
          ))}
        </>
      )}
      <p role="alert">{error}</p>
    </section>
  );
}
