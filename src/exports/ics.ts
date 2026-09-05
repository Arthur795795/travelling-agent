import type { Trip } from "../domain/schema.ts";
import {
  projectTrip,
  type Disclosure,
  AI_LABEL,
} from "../trips/presentation.ts";
import { tripActions } from "../trips/actions.ts";
const escapeText = (value: string) =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n|\r/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
function local(value: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const p = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${p("year")}${p("month")}${p("day")}T${p("hour")}${p("minute")}${p("second")}`;
}
export function foldLine(line: string) {
  const lines = [];
  let part = "";
  for (const char of line) {
    if (Buffer.byteLength(part + char) > 75) {
      lines.push(part);
      part = " ";
    }
    part += char;
  }
  lines.push(part);
  return lines.join("\r\n");
}
export function exportIcs(input: Trip, fields: Partial<Disclosure> = {}) {
  const trip = projectTrip(input, fields);
  const actions = tripActions(trip);
  const stamp = new Date(trip.updatedAt)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Travel Agent//AI Assisted Travel//ZH",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-TIMEZONE:Asia/Shanghai",
    "BEGIN:VTIMEZONE",
    "TZID:Asia/Shanghai",
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    "TZOFFSETFROM:+0800",
    "TZOFFSETTO:+0800",
    "TZNAME:CST",
    "END:STANDARD",
    "END:VTIMEZONE",
    ...actions.map(
      (action) =>
        `X-TRAVEL-ACTION:${escapeText(`${action.title} | ${action.url} | 查询时间 ${action.checkedAt} | ${action.notice}`)}`,
    ),
  ];
  let skipped = 0;
  const event = (
    id: string,
    title: string,
    start: string,
    end: string,
    location: string,
    description: string,
  ) =>
    lines.push(
      "BEGIN:VEVENT",
      `UID:${escapeText(id)}@travel-agent.local`,
      `SEQUENCE:${trip.version}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;TZID=Asia/Shanghai:${local(start)}`,
      `DTEND;TZID=Asia/Shanghai:${local(end)}`,
      `SUMMARY:${escapeText(title)}`,
      `LOCATION:${escapeText(location)}`,
      `DESCRIPTION:${escapeText(`${AI_LABEL} · ${trip.model ?? "deepseek-v4-pro"}\n${description}\n关键事实请在出发前复核，不承诺库存。`)}`,
      "END:VEVENT",
    );
  for (const day of trip.days) {
    for (const a of day.activities.filter((a) => a.importance !== "fallback"))
      event(
        a.id,
        a.title,
        a.timeWindow.start,
        a.timeWindow.end,
        a.place.name,
        `${a.timeWindow.flexibilityMinutes ? `弹性活动时间窗，非精确预约；允许调整 ${a.timeWindow.flexibilityMinutes} 分钟。` : "计划时间，以实际预订为准。"}\n预约规则：${a.reservation?.status === "verified" ? "已有来源，仍需确认预约结果" : "未核验"}\n${day.notes.join("\n")}\n${a.evidenceIds
          .map((id) => trip.evidence.find((e) => e.id === id))
          .filter(Boolean)
          .map(
            (e) =>
              `${e!.sourceName} ${e!.status} ${e!.checkedAt} ${e!.url ?? ""}`,
          )
          .join("\n")}`,
      );
    for (const leg of day.legs)
      event(
        leg.id,
        "计划交通",
        leg.departureWindow.start,
        new Date(
          Date.parse(leg.departureWindow.start) +
            (leg.durationMinutes.max + leg.bufferMinutes) * 60000,
        ).toISOString(),
        "详见行程路线",
        `预计 ${leg.durationMinutes.min}–${leg.durationMinutes.max} 分钟，另含缓冲 ${leg.bufferMinutes} 分钟；非已购车票。`,
      );
  }
  // Bookings are private by default. Missing timestamps are explicitly skipped.
  for (const b of trip.lockedBookings) {
    if (!b.start || !b.end) {
      skipped++;
      continue;
    }
    if (trip.days.some((d) => d.activities.some((a) => a.bookingId === b.id)))
      continue;
    event(
      b.id,
      b.title,
      b.start,
      b.end,
      b.locationText ?? "地点待确认",
      "用户录入项目，请核对原始预订。",
    );
  }
  lines.push(`X-SKIPPED-UNTIMED:${skipped}`, "END:VCALENDAR");
  return { content: lines.map(foldLine).join("\r\n") + "\r\n", skipped };
}
