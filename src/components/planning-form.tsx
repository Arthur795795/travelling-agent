"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { checkRequirements } from "../requirements/service.ts";
import { validateChatInput } from "../security/sensitive-input.ts";
import { describeField } from "../a11y/fields.ts";
import type { TripBrief } from "../domain/schema.ts";
import { describeDeepSeekKeyFailure } from "../providers/deepseek/key-validation-public.ts";
import { GENERATION_READINESS_MESSAGES } from "../config/generation-readiness-public.ts";
import {
  clearDeepSeekSession,
  readDeepSeekSession,
  rememberDeepSeekSession,
} from "../security/deepseek-session.ts";

const JOB_FAILURE_MESSAGES: Record<string, string> = {
  ...GENERATION_READINESS_MESSAGES,
  MODEL_REGRESSION_REQUIRED: "模型更新回归尚未通过，自定义生成已暂停。",
  PRODUCT_BUDGET_STOP: "本月产品服务额度已用完，固定案例和已有行程仍可使用。",
  RATE_LIMITED: "本项目的规划次数已达当前限制，请按提示稍后再试。",
};

/**
 * Which requirement issues each control answers for. A blocking issue is
 * rendered once in the aside and referenced from its field, so assistive
 * technology reads the reason while that field has focus.
 */
const REQUIREMENT_FIELDS = {
  text: ["input"],
  origin: ["origin"],
  destination: ["destination", "destinations", "destinationCandidates"],
  startDate: ["dates", "startDate"],
  endDate: ["dates", "endDate"],
  adults: ["party"],
  seniors: ["party"],
  children: ["party"],
  budget: ["budget"],
  preferences: ["preferences"],
  hardConstraints: ["hardConstraints"],
  confirmed: ["bookedItems"],
  bookingTitle: [],
  key: [],
} as const satisfies Record<string, readonly string[]>;
type FieldName = keyof typeof REQUIREMENT_FIELDS;
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
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [key, setKey] = useState("");
  const [keyStatus, setKeyStatus] = useState("未连接");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const keyRevision = useRef(0);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      const remembered = readDeepSeekSession(sessionStorage);
      if (!active || !remembered) return;
      setKey(remembered.apiKey);
      setModel(remembered.model);
      setKeyStatus("已连接");
    });
    return () => {
      active = false;
    };
  }, []);
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
  // Blocking issues get a stable id in the aside list so fields can point at
  // the same text instead of repeating it.
  const issueIds = new Map<string, string[]>();
  checked.issues.forEach((issue, index) => {
    if (issue.severity !== "blocking") return;
    const root = issue.field.split(".")[0] ?? issue.field;
    issueIds.set(root, [
      ...(issueIds.get(root) ?? []),
      `requirement-issue-${index}`,
    ]);
  });
  const describe = (name: FieldName) => {
    const requirementFields: readonly string[] = REQUIREMENT_FIELDS[name];
    return describeField([
      errors[name] && `field-error-${name}`,
      name === "key" &&
        keyStatus !== "未连接" &&
        keyStatus !== "已连接" &&
        "deepseek-key",
      ...requirementFields.flatMap((f) => issueIds.get(f) ?? []),
    ]);
  };
  const fieldError = (name: FieldName) =>
    errors[name] ? (
      <span className="field-error" id={`field-error-${name}`} role="alert">
        {errors[name]}
      </span>
    ) : null;
  const field = (name: keyof typeof fields, label: string, type = "text") => (
    <label key={name}>
      {label}
      <input
        aria-label={label}
        type={type}
        value={fields[name]}
        onChange={(e) => setFields({ ...fields, [name]: e.target.value })}
        {...describe(name)}
      />
    </label>
  );
  function applyText() {
    const safe = validateChatInput(text);
    if (!safe.accepted) {
      setErrors({ ...errors, text: safe.message });
      setMessage("");
      setText("");
      return;
    }
    setErrors({ ...errors, text: undefined });
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
      const data: unknown = await response.json().catch(() => null);
      if (revision !== keyRevision.current) return;
      if (
        response.ok &&
        data &&
        typeof data === "object" &&
        "ok" in data &&
        data.ok === true &&
        "model" in data &&
        typeof data.model === "string"
      ) {
        setKeyStatus("已连接");
        setModel(data.model);
        rememberDeepSeekSession(sessionStorage, {
          apiKey: key,
          model: data.model,
        });
      } else {
        setKeyStatus(describeDeepSeekKeyFailure(response.status, data).message);
        setModel("");
      }
    } catch {
      if (revision === keyRevision.current) {
        setKeyStatus(
          describeDeepSeekKeyFailure(0, { code: "network_error" }).message,
        );
        setModel("");
      }
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
          typeof data?.code === "string" && JOB_FAILURE_MESSAGES[data.code]
            ? JOB_FAILURE_MESSAGES[data.code]
            : "任务未能创建，请检查输入后重试。",
        );
        return;
      }
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
            {...describe("text")}
          />
          {fieldError("text")}
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
              {...describe("budget")}
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
            {...describe("preferences")}
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
            {...describe("hardConstraints")}
          />
        </label>
        <h3>已订项目</h3>
        <p>仅填写酒店、车次或航班及时间，不填写姓名或完整订单号。</p>
        <div className="form-grid">
          <label>
            预订类型
            <select
              aria-label="预订类型"
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
              aria-label="项目名称"
              value={booking.title}
              onChange={(e) =>
                setBooking({ ...booking, title: e.target.value })
              }
              {...describe("bookingTitle")}
            />
            {fieldError("bookingTitle")}
          </label>
          <label>
            开始时间
            <input
              aria-label="预订开始时间"
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
              aria-label="预订结束时间"
              type="datetime-local"
              value={booking.end}
              onChange={(e) => setBooking({ ...booking, end: e.target.value })}
            />
          </label>
        </div>
        <button
          onClick={() => {
            if (!booking.title) {
              setErrors({ ...errors, bookingTitle: "请先填写项目名称。" });
              return;
            }
            const safe = validateChatInput(booking.title);
            if (!safe.accepted) {
              setErrors({ ...errors, bookingTitle: safe.message });
              return;
            }
            setErrors({ ...errors, bookingTitle: undefined });
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
            {...describe("confirmed")}
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
                <li key={index} id={`requirement-issue-${index}`}>
                  {i.message}
                </li>
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
              clearDeepSeekSession(sessionStorage);
              setKey(e.target.value);
              keyRevision.current++;
              setBusy(false);
              setKeyStatus("未连接");
              setModel("");
            }}
            {...describe("key")}
          />
        </label>
        <p aria-live="polite" id="deepseek-key">
          {keyStatus}
          {model ? ` · ${model}` : ""}
        </p>
        <div className="actions">
          <button disabled={busy || !key} onClick={validateKey}>
            验证 Key
          </button>
          <button
            onClick={() => {
              clearDeepSeekSession(sessionStorage);
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
        <p>
          Key 仅保存在当前标签页会话中；刷新和站内跳转会保留，关闭标签页后消失。共享设备使用后请主动清除。AI
          辅助生成。
        </p>
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
