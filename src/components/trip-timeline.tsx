"use client";
import { useEffect, useState } from "react";
import type { Trip, Money } from "../domain/schema.ts";
import { BrowserTripStore } from "../persistence/browser-store.ts";
const time = (value: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
function cost(value: Money) {
  return value.kind === "unknown"
    ? "费用待确认"
    : value.kind === "exact"
      ? `${value.currency} ${value.amount}`
      : `${value.currency} ${value.min}–${value.max}`;
}
const modes = {
  walk: "步行",
  public_transit: "公共交通",
  taxi: "出租车估算",
  drive: "驾车",
  train: "火车",
  flight: "航班",
  other: "其他交通",
};
export function TripTimeline({ trip }: { trip: Trip }) {
  return (
    <section aria-label="行程时间线" className="itinerary-section">
      <header className="itinerary-header">
        <div>
          <p className="eyebrow">你的行程 · 北京时间</p>
          <h1>{trip.brief.destination}旅行计划</h1>
          <p>
            {trip.brief.startDate} 至 {trip.brief.endDate} ·{" "}
            {trip.brief.party.adults} 位成人
          </p>
        </div>
        <div className="destination-mark" aria-hidden="true">
          {trip.brief.destination.slice(0, 1)}
        </div>
      </header>
      <div className="workspace itinerary-grid">
        <div>
          {trip.days.map((day, dayIndex) => (
            <section key={day.id} className="day">
              <header className="day-header">
                <span>DAY {dayIndex + 1}</span>
                <div>
                  <h2>{day.date}</h2>
                  <p>{day.title.replace(`${trip.brief.destination} · `, "")}</p>
                </div>
              </header>
              <ol className="timeline">
                {[
                  ...day.activities.map((activity) => ({
                    type: "activity" as const,
                    start: activity.timeWindow.start,
                    activity,
                  })),
                  ...day.legs.map((leg) => ({
                    type: "leg" as const,
                    start: leg.departureWindow.start,
                    leg,
                  })),
                ]
                  .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
                  .map((entry) => {
                    if (entry.type === "leg") {
                      const leg = entry.leg;
                      return (
                        <li className="leg timeline-card" key={`leg:${leg.id}`}>
                          <p className="time">
                            {time(leg.departureWindow.start)}–
                            {time(leg.departureWindow.end)}
                          </p>
                          {modes[leg.mode]} · {leg.durationMinutes.min}–
                          {leg.durationMinutes.max} 分钟 + 缓冲{" "}
                          {leg.bufferMinutes} 分钟 · {cost(leg.cost)}
                          {leg.locked ? " · 已锁定" : ""}
                        </li>
                      );
                    }
                    const a = entry.activity;
                    return (
                      <li className="timeline-card" key={a.id}>
                        <p className="time">
                          {time(a.timeWindow.start)}–{time(a.timeWindow.end)} ·{" "}
                          {a.durationMinutes} 分钟
                        </p>
                        <h3>{a.title}</h3>
                        <span className="tag">
                          {a.importance === "core"
                            ? "核心"
                            : a.importance === "optional"
                              ? "可选"
                              : "备选"}
                        </span>
                        {a.locked && <span className="tag">已锁定</span>}
                        <p className="place-line">
                          {a.place.name} · {cost(a.cost)}
                        </p>
                        <p className="muted">{a.rationale}</p>
                      </li>
                    );
                  })}
              </ol>
              {!day.activities.length && <p>此日留白，活动和时间待确认。</p>}
              {day.notes.map((note, index) => (
                <p className="muted" key={index}>
                  {note}
                </p>
              ))}
            </section>
          ))}
        </div>
        <aside className="route-overview">
          <p className="eyebrow">快速浏览</p>
          <h2>每日路线</h2>
          {trip.days.map((day) => (
            <section key={day.id}>
              <h3>{day.date}</h3>
              <ol>
                {[...day.activities]
                  .sort((a, b) =>
                    a.timeWindow.start.localeCompare(b.timeWindow.start),
                  )
                  .map((a) => (
                    <li key={a.id}>{a.place.name}</li>
                  ))}
              </ol>
              {day.legs.map((leg) => (
                <p key={leg.id}>
                  {day.activities.find((a) => a.place.id === leg.fromPlaceId)
                    ?.place.name ?? "外部出发点"}{" "}
                  →{" "}
                  {day.activities.find((a) => a.place.id === leg.toPlaceId)
                    ?.place.name ?? "外部到达点"}
                  <br />
                  <span className="muted">在高德打开：入口待配置</span>
                </p>
              ))}
            </section>
          ))}
          {trip.lockedBookings.length > 0 && <h2>锁定预订</h2>}
          {trip.lockedBookings.map((b) => (
            <p key={b.id}>
              {b.title} · 已锁定
              <br />
              {b.start
                ? `${new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "short" }).format(new Date(b.start))}`
                : "时间待确认"}
              {b.end &&
                ` 至 ${new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "short" }).format(new Date(b.end))}`}
            </p>
          ))}
          <p className="muted">路线仅展示地点顺序，不包含地图瓦片。</p>
        </aside>
      </div>
    </section>
  );
}
export default function StoredTripTimeline({ id }: { id: string }) {
  const [trip, setTrip] = useState<Trip | null>();
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      try {
        const value = new BrowserTripStore(localStorage).loadTrip(id);
        if (active) setTrip(value);
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
        <p>请从完成的规划任务进入，或使用保存该行程的浏览器。</p>
        <a href="/plan">规划旅行</a>
      </>
    );
  return <TripTimeline trip={trip} />;
}
