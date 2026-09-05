import assert from "node:assert/strict";
import test from "node:test";
import { PlatformLinkGenerator } from "../../src/platform/links.ts";
import { SensitivePersistenceError } from "../../src/security/redaction.ts";

const now = () => new Date("2026-09-05T10:00:00+08:00");

test("creates a transparent Ctrip train search URL with only supported prefilled fields", async () => {
  const result = await new PlatformLinkGenerator(now).create({
    platform: "ctrip",
    type: "train",
    origin: "上海",
    destination: "北京",
    departureDate: "2026-10-01",
  });
  const url = new URL(result.actionUrl);
  assert.equal(url.hostname, "trains.ctrip.com");
  assert.equal(url.searchParams.get("from"), "上海");
  assert.equal(url.searchParams.get("to"), "北京");
  assert.equal(url.searchParams.get("day"), "2026-10-01");
  assert.deepEqual(result.prefilledFields, [
    "origin",
    "destination",
    "departureDate",
  ]);
  assert.equal(result.inventoryChecked, false);
  assert.equal(result.requiresReconfirmation, true);
  assert.equal(result.commissionRelationship, "none");
  assert.equal(result.generatedAt, now().toISOString());
  assert.match(result.notice, /未读取实时价格、余票或房态/);
});

test("does not claim unsupported prefill and falls back when a deep link is unavailable", async () => {
  const generic = await new PlatformLinkGenerator(now).create({
    platform: "fliggy",
    type: "hotel",
    city: "杭州",
    checkIn: "2026-10-01",
    checkOut: "2026-10-03",
  });
  assert.equal(generic.actionUrl, "https://www.fliggy.com/");
  assert.deepEqual(generic.prefilledFields, []);
  assert.deepEqual(generic.unfilledFields, ["city", "checkIn", "checkOut"]);

  const fallback = await new PlatformLinkGenerator(
    now,
    async () => false,
  ).create({
    platform: "ctrip",
    type: "flight",
    origin: "上海",
    destination: "北京",
    originCode: "SHA",
    destinationCode: "BJS",
    departureDate: "2026-10-01",
  });
  assert.equal(fallback.degraded, true);
  assert.equal(fallback.actionUrl, "https://www.ctrip.com/");
  assert.deepEqual(fallback.prefilledFields, []);
  assert.deepEqual(
    fallback.unfilledFields.sort(),
    ["departureDate", "destinationCode", "originCode"].sort(),
  );
});

test("rejects sensitive values instead of placing them in a platform URL", async () => {
  await assert.rejects(
    () =>
      new PlatformLinkGenerator(now).create({
        platform: "ctrip",
        type: "search",
        keyword: "订单号 ABCD1234567890",
      }),
    SensitivePersistenceError,
  );
});
