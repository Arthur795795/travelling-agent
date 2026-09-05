import assert from "node:assert/strict";
import test from "node:test";
import { exportIcs } from "../../src/exports/ics.ts";
import { executableTrip } from "../fixtures/executable-trip.ts";
test("ICS has Shanghai times, stable events, folding and AI/recheck wording", () => {
  const trip = executableTrip();
  trip.days[0].activities[0].title = "中文地点".repeat(20);
  trip.lockedBookings = [
    {
      id: "untimed",
      type: "other",
      title: "未知时间",
      locked: true,
      source: "user",
    },
  ];
  const output = exportIcs(trip, { privateNotes: true });
  assert.match(output.content, /TZID:Asia\/Shanghai/);
  assert.match(output.content, /DTSTART;TZID=Asia\/Shanghai:20261001T090000/);
  assert.match(output.content, /AI 辅助生成/);
  assert.match(output.content, /关键事实请在出发前复核/);
  assert.equal(output.skipped, 1);
  for (const line of output.content.split("\r\n"))
    assert.ok(Buffer.byteLength(line) <= 75, line);
  assert.doesNotMatch(exportIcs(trip).content, /未知时间/);
});
test("ICS carries pre-generated platform and Amap action links", () => {
  const trip = executableTrip();
  trip.evidence.push({
    id: "platform-search",
    sourceType: "platform",
    sourceName: "飞猪酒店搜索",
    url: "https://www.fliggy.com/search",
    status: "recheck_required",
    checkedAt: trip.updatedAt,
    assertedValue: "北京酒店",
  });
  trip.claims[0].evidenceIds.push("platform-search");
  trip.days[0].activities[0].evidenceIds.push("platform-search");
  trip.days[0].legs.push({
    id: "route-action",
    fromPlaceId: trip.days[0].activities[0].place.id,
    toPlaceId: trip.days[0].activities[0].place.id,
    mode: "walk",
    departureWindow: {
      start: "2026-10-01T11:00:00+08:00",
      end: "2026-10-01T11:10:00+08:00",
      flexibilityMinutes: 0,
    },
    durationMinutes: { min: 10, max: 10 },
    bufferMinutes: 0,
    cost: {
      kind: "exact",
      currency: "CNY",
      amount: 0,
      confidence: "high",
    },
    locked: false,
    evidenceIds: [],
    externalActionUrl:
      "https://uri.amap.com/navigation?from=1,2,A&to=3,4,B",
  });
  const content = exportIcs(trip).content;
  assert.match(content, /X-TRAVEL-ACTION:/);
  assert.match(content, /uri\.amap\.com/);
  assert.match(content, /fliggy\.com/);
  assert.match(content, /未读取实时库存/);
});

test("ICS preserves a cross-day timed booking and hides it by default", () => {
  const trip = executableTrip();
  trip.lockedBookings = [
    {
      id: "overnight-train",
      type: "train",
      title: "跨夜列车",
      start: "2026-10-01T23:30:00+08:00",
      end: "2026-10-02T00:30:00+08:00",
      locationText: "北京站",
      locked: true,
      source: "user",
    },
  ];
  assert.doesNotMatch(exportIcs(trip).content, /跨夜列车/);
  const visible = exportIcs(trip, { privateNotes: true }).content;
  assert.match(visible, /SUMMARY:跨夜列车/);
  assert.match(visible, /DTSTART;TZID=Asia\/Shanghai:20261001T233000/);
  assert.match(visible, /DTEND;TZID=Asia\/Shanghai:20261002T003000/);
});
