"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Trip } from "../domain/schema.ts";
import { reportEvent } from "../analytics/client.ts";
import { describeField } from "../a11y/fields.ts";
import { BrowserTripStore } from "../persistence/browser-store.ts";
import {
  OFFLINE_DISABLED_NOTICE,
  OFFLINE_MAJOR_CHANGE_NOTICE,
} from "../offline/shell.ts";
import {
  commitChange,
  previewChange,
  type TripChange,
} from "../trips/changes.ts";
import { FeedbackPanel } from "./feedback-panel.tsx";
import { TripTimeline } from "./trip-timeline.tsx";
import { TripDetails } from "./trip-details.tsx";
import { TripTransfer } from "./trip-transfer.tsx";
import { useOfflineNow } from "./use-offline-now.ts";
import { moneyText } from "../trips/presentation.ts";
import {
  clearDeepSeekSession,
  readDeepSeekSession,
  rememberDeepSeekSession,
} from "../security/deepseek-session.ts";
export default function TripWorkspace({ id }: { id: string }) {
  const [trip, setTrip] = useState<Trip | null>();
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      try {
        if (active) setTrip(new BrowserTripStore(localStorage).loadTrip(id));
      } catch {
        if (active) setTrip(null);
      }
    });
    return () => {
      active = false;
    };
  }, [id]);
  if (trip === undefined) return <p>正在读取行程…</p>;
  if (!trip)
    return (
      <>
        <h1>未找到本地行程</h1>
        <a href="/demo">体验北京案例</a>
      </>
    );
  return (
    <>
      <TripDetails trip={trip} />
      <TripTransfer trip={trip} />
      <TripTimeline trip={trip} />
      <details className="editor-disclosure">
        <summary>编辑、锁定或局部调整行程</summary>
        <TripEditor
          key={`${id}:${trip.version}`}
          trip={trip}
          onSave={setTrip}
          onMessage={setMessage}
        />
      </details>
      <p role="alert" id="trip-edit-error">
        {message}
      </p>
      <FeedbackPanel context="generated_trip" />
    </>
  );
}
function TripEditor({
  trip,
  onSave,
  onMessage,
}: {
  trip: Trip;
  onSave: (trip: Trip) => void;
  onMessage: (message: string) => void;
}) {
  const router = useRouter();
  const offline = useOfflineNow();
  const [date, setDate] = useState(trip.days[0].date),
    [note, setNote] = useState(trip.days[0].notes.join("\n"));
  const [activityId, setActivityId] = useState(
    trip.days[0].activities[0]?.id ?? "",
  );
  const activity = trip.days
    .flatMap((d) => d.activities)
    .find((a) => a.id === activityId);
  const [start, setStart] = useState(
      activity?.timeWindow.start.slice(0, 16) ?? "",
    ),
    [end, setEnd] = useState(activity?.timeWindow.end.slice(0, 16) ?? "");
  const [instruction, setInstruction] = useState(""),
    [limit, setLimit] = useState(""),
    [key, setKey] = useState("");
  const [preview, setPreview] = useState<
    ReturnType<typeof previewChange> & { confirmation: string }
  >();
  const [busy, setBusy] = useState(false);
  // A rejected edit marks the fields it came from. The explanation itself is
  // rendered once by the workspace alert, and every marked field points there.
  const [invalid, setInvalid] = useState("");
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      const remembered = readDeepSeekSession(sessionStorage);
      if (active && remembered) setKey(remembered.apiKey);
    });
    return () => {
      active = false;
    };
  }, []);
  const describe = (...kinds: string[]) =>
    describeField([kinds.includes(invalid) && "trip-edit-error"]);
  const store = () => new BrowserTripStore(localStorage);
  const lockable: {
    id: string;
    title: string;
    locked: boolean;
    entity: "activity" | "leg" | "booking";
  }[] = [
    ...trip.days.flatMap((d) =>
      d.activities.map((a) => ({
        id: a.id,
        title: a.title,
        locked: a.locked,
        entity: "activity" as const,
      })),
    ),
    ...trip.days.flatMap((d) =>
      d.legs.map((l) => ({
        id: l.id,
        title: `交通 ${l.id}`,
        locked: l.locked,
        entity: "leg" as const,
      })),
    ),
    ...trip.lockedBookings.map((b) => ({
      id: b.id,
      title: b.title,
      locked: b.locked,
      entity: "booking" as const,
    })),
  ];
  async function propose(change: TripChange) {
    onMessage("");
    setInvalid("");
    setBusy(true);
    try {
      const result = previewChange(trip, change);
      if (result.major) {
        // A major change is decided by the server, so offline it is refused
        // outright instead of being reported as a generic failed save.
        if (offline) {
          setInvalid(change.type);
          onMessage(OFFLINE_MAJOR_CHANGE_NOTICE);
          return;
        }
        const r = await fetch(
          `/api/trips/${encodeURIComponent(trip.id)}/change-preview`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ trip, change }),
          },
        );
        if (!r.ok) throw new Error();
        setPreview(await r.json());
      } else {
        const applied = commitChange(trip, change);
        store().commitEdit(applied.trip, applied.revision, trip.version);
        onSave(applied.trip);
      }
      // Shape only: which kind of edit, and whether it needed a preview.
      reportEvent({
        name: "trip_edited",
        kind: change.type,
        major: result.major,
        outcome: "ok",
      });
    } catch {
      setInvalid(change.type);
      onMessage("修改未保存：请检查时间、锁定项或版本是否已变化。");
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!preview) return;
    setInvalid("");
    setBusy(true);
    try {
      if (store().loadTrip(trip.id)?.version !== trip.version)
        throw new Error();
      const r = await fetch(
        `/api/trips/${encodeURIComponent(trip.id)}/replan`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            trip,
            change: preview.change,
            confirmation: preview.confirmation,
            ...(key ? { apiKey: key } : {}),
          }),
        },
      );
      if (!r.ok) throw new Error();
      const job = await r.json();
      if (key)
        rememberDeepSeekSession(sessionStorage, {
          apiKey: key,
          model: "deepseek-v4-pro",
        });
      router.push(`/planning/${encodeURIComponent(job.id)}`);
    } catch {
      setInvalid("replan-key");
      onMessage("未启动重规划：请先解锁冲突项目，或检查功能开关与当前版本。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h2>编辑行程 · 版本 {trip.version}</h2>
      <p>仅保存在当前浏览器；共享设备使用后请清除。重大修改需要先预览。</p>
      {offline && (
        <p role="note" id="offline-editor-reason">
          {OFFLINE_DISABLED_NOTICE}
        </p>
      )}
      <label>
        编辑日期
        <select
          aria-label="编辑日期"
          value={date}
          onChange={(e) => {
            setDate(e.target.value);
            setNote(
              trip.days
                .find((d) => d.date === e.target.value)!
                .notes.join("\n"),
            );
          }}
          {...describe("note", "move")}
        >
          {trip.days.map((d) => (
            <option key={d.id}>{d.date}</option>
          ))}
        </select>
      </label>
      <label>
        私人备注
        <textarea
          aria-label="私人备注"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          {...describe("note")}
        />
      </label>
      <button
        disabled={busy}
        onClick={() => propose({ type: "note", date, text: note })}
      >
        保存备注
      </button>
      <label>
        活动
        <select
          aria-label="编辑活动"
          value={activityId}
          onChange={(e) => {
            setActivityId(e.target.value);
            const a = trip.days
              .flatMap((d) => d.activities)
              .find((a) => a.id === e.target.value)!;
            setStart(a.timeWindow.start.slice(0, 16));
            setEnd(a.timeWindow.end.slice(0, 16));
          }}
        >
          {trip.days
            .flatMap((d) => d.activities)
            .map((a) => (
              <option value={a.id} key={a.id}>
                {a.title}
              </option>
            ))}
        </select>
      </label>
      <label>
        活动开始
        <input
          aria-label="活动开始"
          type="datetime-local"
          value={start}
          onChange={(e) => setStart(e.target.value)}
          {...describe("activity", "move")}
        />
      </label>
      <label>
        活动结束
        <input
          aria-label="活动结束"
          type="datetime-local"
          value={end}
          onChange={(e) => setEnd(e.target.value)}
          {...describe("activity", "move")}
        />
      </label>
      {activity && (
        <>
          <button
            disabled={busy}
            onClick={() =>
              propose({
                type: "activity",
                id: activityId,
                timeWindow: {
                  start: `${start}:00+08:00`,
                  end: `${end}:00+08:00`,
                  flexibilityMinutes: activity.timeWindow.flexibilityMinutes,
                },
              })
            }
          >
            保存活动时间
          </button>
          <button
            disabled={busy}
            onClick={() =>
              propose({
                type: "move",
                id: activityId,
                date,
                timeWindow: {
                  start: `${date}T${start.slice(11)}:00+08:00`,
                  end: `${date}T${end.slice(11)}:00+08:00`,
                  flexibilityMinutes: 15,
                },
              })
            }
          >
            移到所选日期并预览
          </button>
          <button
            disabled={busy}
            onClick={() =>
              propose({
                type: "activity",
                id: activityId,
                importance:
                  activity.importance === "core" ? "optional" : "core",
              })
            }
          >
            切换核心/可选并预览
          </button>
        </>
      )}
      <h3>锁定与解锁</h3>
      {lockable.map((item) => (
        <button
          disabled={busy}
          key={`${item.entity}:${item.id}`}
          onClick={() =>
            propose({
              type: "lock",
              entity: item.entity,
              id: item.id,
              locked: !item.locked,
            })
          }
        >
          {item.locked ? "解锁" : "锁定"} {item.title}
        </button>
      ))}
      <label>
        新预算上限
        <input
          aria-label="新预算上限"
          type="number"
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
          {...describe("budget")}
        />
      </label>
      <button
        disabled={!limit || busy}
        onClick={() =>
          propose({
            type: "budget",
            limit: {
              kind: "exact",
              currency: "CNY",
              amount: Number(limit),
              confidence: "high",
            },
          })
        }
      >
        预览预算变化
      </button>
      <label>
        局部重规划要求
        <textarea
          aria-label="局部重规划要求"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          {...describe("replan")}
        />
      </label>
      <button
        disabled={!instruction || busy || offline}
        aria-describedby={offline ? "offline-editor-reason" : undefined}
        onClick={() => propose({ type: "replan", date, instruction })}
      >
        预览局部重规划
      </button>
      {preview && (
        <section aria-label="重大修改预览">
          <h3>重大修改尚未应用</h3>
          <p>受影响日期：{preview.affectedDates.join("、")}</p>
          <p>
            预算：{moneyText(preview.budgetBefore)} →{" "}
            {moneyText(preview.budgetAfter)}
          </p>
          <p>锁定冲突：{preview.lockConflicts.join("、") || "无"}</p>
          {preview.issues.map((i) => (
            <p key={i.id}>{i.message}</p>
          ))}
          <label>
            重规划 Key（可稍后提供）
            <input
              type="password"
              autoComplete="off"
              aria-label="重规划 Key"
              value={key}
              onChange={(e) => {
                clearDeepSeekSession(sessionStorage);
                setKey(e.target.value);
              }}
              {...describe("replan-key")}
            />
          </label>
          <button
            disabled={busy || !!preview.lockConflicts.length || offline}
            aria-describedby={offline ? "offline-editor-reason" : undefined}
            onClick={confirm}
          >
            确认并局部重规划
          </button>
          <button
            onClick={() => {
              setPreview(undefined);
            }}
          >
            取消修改
          </button>
        </section>
      )}
      <button
        onClick={() => {
          onMessage("");
          setInvalid("");
          try {
            onSave(store().undoLast(trip.id));
          } catch {
            setInvalid("undo");
            onMessage("没有可撤销的最近修改。");
          }
        }}
      >
        撤销最近修改
      </button>
      <details>
        <summary>本地版本记录</summary>
        {store()
          .listRevisions(trip.id)
          .map((r) => (
            <p key={r.id}>
              v{r.nextVersion} · {r.summary}
            </p>
          ))}
      </details>
    </section>
  );
}
