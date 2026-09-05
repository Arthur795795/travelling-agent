"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { checkRequirements } from "../requirements/service.ts";
import { validateChatInput } from "../security/sensitive-input.ts";
import type { TripBrief } from "../domain/schema.ts";
export default function PlanningForm() {
  const router = useRouter();
  const [fields, setFields] = useState({
    origin: "",
    destination: "",
    startDate: "",
    endDate: "",
    adults: "",
    children: "",
    seniors: "0",
    budget: "",
    preferences: "",
    hardConstraints: "",
  });
  const [bookings, setBookings] = useState<TripBrief["bookedItems"]>([]);
  const [booking, setBooking] = useState({
    type: "hotel",
    title: "",
    start: "",
    end: "",
  });
  const [confirmed, setConfirmed] = useState(false);
  const [text, setText] = useState("");
  const [message, setMessage] = useState("");
  const [key, setKey] = useState("");
  const [keyStatus, setKeyStatus] = useState("未连接");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const keyRevision = useRef(0);
  const input = {
    origin: fields.origin || undefined,
    destination: fields.destination || undefined,
    startDate: fields.startDate || undefined,
    endDate: fields.endDate || undefined,
    party: fields.adults
      ? {
          adults: Number(fields.adults),
          childrenAgeBands: fields.children
            ? fields.children.split("、").filter(Boolean)
            : [],
          seniors: Number(fields.seniors),
          mobilityNotes: [],
        }
      : undefined,
    budget: fields.budget ? { level: fields.budget } : undefined,
    preferences: confirmed
      ? fields.preferences.split("\n").filter(Boolean)
      : undefined,
    hardConstraints: confirmed
      ? fields.hardConstraints.split("\n").filter(Boolean)
      : undefined,
    bookedItems: confirmed ? bookings : undefined,
  };
  const checked = checkRequirements(input);
  const field = (name: keyof typeof fields, label: string, type = "text") => (
    <label key={name}>
      {label}
      <input
        aria-label={label}
        type={type}
        value={fields[name]}
        onChange={(e) => setFields({ ...fields, [name]: e.target.value })}
      />
    </label>
  );
  function applyText() {
    const safe = validateChatInput(text);
    if (!safe.accepted) {
      setMessage(safe.message);
      setText("");
      return;
    }
    const cities = text.match(/北京|上海|重庆|西安|杭州/g) ?? [];
    const dates = text.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
    const adults = text.match(/(\d+)\s*(?:人|位成人)/);
    setFields({
      ...fields,
      origin: cities.length > 1 ? (cities[0] ?? fields.origin) : fields.origin,
      destination: cities.at(-1) ?? fields.destination,
      startDate: dates[0] ?? fields.startDate,
      endDate: dates[1] ?? fields.endDate,
      adults: adults?.[1] ?? fields.adults,
      preferences: [fields.preferences, text].filter(Boolean).join("\n"),
    });
    setMessage(
      "已提取明确字段，并保留原文为偏好。请在旅行简报中核对日期、人数和硬约束。",
    );
    setText("");
  }
  async function validateKey() {
    const revision = ++keyRevision.current;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/keys/deepseek/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: key }),
      });
      const data = await response.json();
      if (revision !== keyRevision.current) return;
      setKeyStatus(data.ok ? "已连接" : "验证失败");
      setModel(data.ok ? data.model : "");
    } catch {
      if (revision === keyRevision.current) setKeyStatus("验证失败");
    } finally {
      if (revision === keyRevision.current) setBusy(false);
    }
  }
  async function start() {
    if (checked.state !== "ready" || keyStatus !== "已连接") return;
    setBusy(true);
    try {
      const response = await fetch("/api/planning-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input, apiKey: key }),
      });
      const data = await response.json();
      if (!response.ok) {
        setMessage(
          data.code === "GENERATION_DISABLED"
            ? "自定义生成尚未开放，请稍后再试。"
            : "任务未能创建，请检查输入后重试。",
        );
        return;
      }
      setKey("");
      router.push(`/planning/${encodeURIComponent(data.id)}`);
    } catch {
      setMessage("网络异常，任务未能创建。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="workspace">
      <section>
        <label>
          用自己的话描述旅行
          <textarea
            aria-label="旅行描述"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="例如：从上海去北京，2026-10-01 到 2026-10-04，2人，喜欢历史文化。"
          />
        </label>
        <button onClick={applyText}>整理到简报</button>
        <h2>旅行简报</h2>
        <div className="form-grid">
          {field("origin", "出发城市")}
          {field("destination", "目的城市")}
          {field("startDate", "开始日期", "date")}
          {field("endDate", "结束日期", "date")}
          {field("adults", "成人数量", "number")}
          {field("seniors", "老人数量", "number")}
          {field("children", "儿童年龄段（用顿号分隔，如 7-12）")}
          <label>
            预算档位
            <select
              aria-label="预算档位"
              value={fields.budget}
              onChange={(e) => setFields({ ...fields, budget: e.target.value })}
            >
              <option value="">请选择</option>
              <option value="economy">经济</option>
              <option value="balanced">适中</option>
              <option value="comfort">舒适</option>
              <option value="premium">高品质</option>
            </select>
          </label>
        </div>
        <label>
          偏好
          <textarea
            aria-label="偏好"
            value={fields.preferences}
            onChange={(e) =>
              setFields({ ...fields, preferences: e.target.value })
            }
          />
        </label>
        <label>
          硬约束
          <textarea
            aria-label="硬约束"
            value={fields.hardConstraints}
            onChange={(e) =>
              setFields({ ...fields, hardConstraints: e.target.value })
            }
          />
        </label>
        <h3>已订项目</h3>
        <p>仅填写酒店、车次或航班及时间，不填写姓名或完整订单号。</p>
        <div className="form-grid">
          <label>
            预订类型
            <select
              value={booking.type}
              onChange={(e) => setBooking({ ...booking, type: e.target.value })}
            >
              <option value="hotel">酒店</option>
              <option value="train">火车</option>
              <option value="flight">航班</option>
            </select>
          </label>
          <label>
            项目名称
            <input
              value={booking.title}
              onChange={(e) =>
                setBooking({ ...booking, title: e.target.value })
              }
            />
          </label>
          <label>
            开始时间
            <input
              type="datetime-local"
              value={booking.start}
              onChange={(e) =>
                setBooking({ ...booking, start: e.target.value })
              }
            />
          </label>
          <label>
            结束时间
            <input
              type="datetime-local"
              value={booking.end}
              onChange={(e) => setBooking({ ...booking, end: e.target.value })}
            />
          </label>
        </div>
        <button
          onClick={() => {
            if (!booking.title) return;
            const safe = validateChatInput(booking.title);
            if (!safe.accepted) {
              setMessage(safe.message);
              return;
            }
            setBookings([
              ...bookings,
              {
                id: crypto.randomUUID(),
                type: booking.type as "hotel" | "train" | "flight",
                title: booking.title,
                start: booking.start ? `${booking.start}:00+08:00` : undefined,
                end: booking.end ? `${booking.end}:00+08:00` : undefined,
                locked: true,
                source: "user",
              },
            ]);
            setBooking({ ...booking, title: "", start: "", end: "" });
          }}
        >
          添加预订
        </button>
        <ul>
          {bookings.map((b) => (
            <li key={b.id}>
              {b.title} · 已锁定{" "}
              <button
                onClick={() =>
                  setBookings(bookings.filter((item) => item.id !== b.id))
                }
              >
                移除
              </button>
            </li>
          ))}
        </ul>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          已核对预订、偏好和硬约束；空白表示无
        </label>
      </section>
      <aside>
        <h2>下一步需要确认</h2>
        {checked.state === "ready" ? (
          <p>需求完整，可以开始规划。</p>
        ) : (
          <>
            <ul>
              {checked.issues.map((i, index) => (
                <li key={index}>{i.message}</li>
              ))}
            </ul>
            {checked.questions.map((q) => (
              <p key={q.id}>{q.prompt}</p>
            ))}
          </>
        )}
        {checked.state === "destination_options" && (
          <p>可选：{checked.candidates.map((c) => c.city).join("、")}</p>
        )}
        <p className="muted">
          默认适中密度：上午、下午各一个核心主题，普通移动另加缓冲。时间使用北京时间。
        </p>
        <h2>连接 DeepSeek</h2>
        <label>
          DeepSeek Key
          <input
            type="password"
            autoComplete="off"
            aria-label="DeepSeek Key"
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              keyRevision.current++;
              setBusy(false);
              setKeyStatus("未连接");
              setModel("");
            }}
          />
        </label>
        <p aria-live="polite">
          {keyStatus}
          {model ? ` · ${model}` : ""}
        </p>
        <div className="actions">
          <button disabled={busy || !key} onClick={validateKey}>
            验证 Key
          </button>
          <button
            onClick={() => {
              setKey("");
              keyRevision.current++;
              setBusy(false);
              setKeyStatus("未连接");
              setModel("");
            }}
          >
            清除 Key
          </button>
        </div>
        <p>Key 仅保存在当前页面内存中，刷新后消失。AI 辅助生成。</p>
        <button
          className="button"
          disabled={busy || checked.state !== "ready" || keyStatus !== "已连接"}
          onClick={start}
        >
          开始规划
        </button>
        <p role="status">{message}</p>
      </aside>
    </div>
  );
}
