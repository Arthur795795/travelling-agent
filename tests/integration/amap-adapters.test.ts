import assert from "node:assert/strict";
import test from "node:test";
import { AmapClient, AmapError } from "../../src/providers/amap/client.ts";
import { AmapPlacesAdapter } from "../../src/providers/amap/places.ts";
import { AmapRoutesAdapter } from "../../src/providers/amap/routes.ts";
import { AmapWeatherAdapter } from "../../src/providers/amap/weather.ts";

const fixedNow = new Date("2026-09-05T10:00:00+08:00");
const success = (data: Record<string, unknown>) =>
  new Response(JSON.stringify({ status: "1", infocode: "10000", ...data }), {
    headers: { "content-type": "application/json" },
  });

function routeInput(overrides: Record<string, unknown> = {}) {
  return {
    legId: "leg-1",
    fromPlaceId: "place-a",
    toPlaceId: "place-b",
    origin: { longitude: 116.397, latitude: 39.908 },
    destination: { longitude: 116.407, latitude: 39.918 },
    mode: "taxi" as const,
    departureWindow: {
      start: "2026-09-06T09:00:00+08:00",
      end: "2026-09-06T09:30:00+08:00",
      flexibilityMinutes: 10,
    },
    cityCodeFrom: "010",
    cityCodeTo: "010",
    ...overrides,
  };
}

test("Amap place search preserves ambiguous candidates and does not leak the server key", async () => {
  const secret = "amap-server-secret";
  let requestedUrl = "";
  const client = new AmapClient({
    environment: { AMAP_WEB_SERVICE_KEY: secret },
    now: () => fixedNow,
    fetchImpl: async (input) => {
      requestedUrl = String(input);
      return success({
        pois: [
          {
            id: "B1",
            name: "人民公园",
            address: "黄浦区",
            cityname: "上海",
            location: "121.470000,31.230000",
            type: "风景名胜",
          },
          {
            id: "B2",
            name: "人民公园",
            address: "渝中区",
            cityname: "重庆",
            location: "106.550000,29.560000",
            type: "风景名胜",
          },
        ],
      });
    },
  });
  const result = await new AmapPlacesAdapter(client).search({
    keyword: "人民公园",
    city: "上海",
    maxResults: 5,
  });
  assert.equal(result.status, "success");
  assert.equal(result.ambiguous, true);
  assert.deepEqual(
    result.candidates.map(({ amapId }) => amapId),
    ["B1", "B2"],
  );
  assert.equal(result.candidates[0].place.source, "amap");
  assert.equal(new URL(requestedUrl).searchParams.get("key"), secret);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("Amap place errors distinguish no results, quota, and timeout", async () => {
  const emptyClient = new AmapClient({
    environment: { AMAP_WEB_SERVICE_KEY: "placeholder" },
    now: () => fixedNow,
    fetchImpl: async () => success({ pois: [] }),
  });
  assert.equal(
    (
      await new AmapPlacesAdapter(emptyClient).search({
        keyword: "不存在",
        city: "北京",
        maxResults: 3,
      })
    ).status,
    "no_results",
  );

  const quotaClient = new AmapClient({
    environment: { AMAP_WEB_SERVICE_KEY: "placeholder" },
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          status: "0",
          infocode: "10003",
          info: "DAILY_QUERY_OVER_LIMIT",
        }),
      ),
  });
  await assert.rejects(
    () =>
      new AmapPlacesAdapter(quotaClient).search({
        keyword: "故宫",
        city: "北京",
        maxResults: 3,
      }),
    (error: unknown) =>
      error instanceof AmapError && error.code === "quota" && error.retryable,
  );

  const timeoutClient = new AmapClient({
    environment: { AMAP_WEB_SERVICE_KEY: "placeholder" },
    timeoutMs: 5,
    fetchImpl: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        );
      }),
  });
  await assert.rejects(
    () =>
      new AmapPlacesAdapter(timeoutClient).search({
        keyword: "故宫",
        city: "北京",
        maxResults: 3,
      }),
    (error: unknown) => error instanceof AmapError && error.code === "timeout",
  );
});

test("Amap routes normalize duration, distance and taxi range without adding buffer twice", async () => {
  const client = new AmapClient({
    environment: { AMAP_WEB_SERVICE_KEY: "placeholder" },
    now: () => fixedNow,
    fetchImpl: async () =>
      success({
        route: {
          taxi_cost: "50",
          paths: [{ distance: "10000", cost: { duration: "1800" } }],
        },
      }),
  });
  const result = await new AmapRoutesAdapter(client, () => fixedNow).route(
    routeInput(),
  );
  assert.equal(result.status, "success");
  if (result.status === "success") {
    assert.equal(result.theoreticalDurationMinutes, 30);
    assert.equal(result.distanceMeters, 10_000);
    assert.equal(result.leg.bufferMinutes, 0);
    assert.equal(result.suggestedBufferMinutes, 15);
    assert.deepEqual(result.leg.cost, {
      kind: "range",
      currency: "CNY",
      min: 42.5,
      max: 57.5,
      confidence: "low",
    });
  }
});

test("Amap routes return explicit blocked results for no route, abnormal route, and unsupported cross-city mode", async () => {
  const noRoute = new AmapRoutesAdapter(
    new AmapClient({
      environment: { AMAP_WEB_SERVICE_KEY: "placeholder" },
      now: () => fixedNow,
      fetchImpl: async () => success({ route: { paths: [] } }),
    }),
    () => fixedNow,
  );
  assert.deepEqual(await noRoute.route(routeInput()), {
    status: "blocked",
    code: "no_route",
    checkedAt: fixedNow.toISOString(),
  });

  const abnormal = new AmapRoutesAdapter(
    new AmapClient({
      environment: { AMAP_WEB_SERVICE_KEY: "placeholder" },
      now: () => fixedNow,
      fetchImpl: async () =>
        success({
          route: { paths: [{ distance: "100", cost: { duration: "0" } }] },
        }),
    }),
    () => fixedNow,
  );
  assert.equal(
    (await abnormal.route(routeInput({ mode: "drive" }))).status,
    "blocked",
  );
  assert.deepEqual(
    await noRoute.route(routeInput({ mode: "drive", cityCodeTo: "021" })),
    {
      status: "blocked",
      code: "cross_city_unsupported",
      checkedAt: fixedNow.toISOString(),
    },
  );

  const zero = new AmapRoutesAdapter(
    new AmapClient({
      environment: { AMAP_WEB_SERVICE_KEY: "placeholder" },
      now: () => fixedNow,
      fetchImpl: async () =>
        success({
          route: { paths: [{ distance: "0", cost: { duration: "0" } }] },
        }),
    }),
  );
  assert.equal(
    (await zero.route(routeInput({ mode: "walk" }))).status,
    "success",
  );
});

test("weather uses only the returned three-day window and degrades incomplete or failed data", async () => {
  let calls = 0;
  const client = new AmapClient({
    environment: { AMAP_WEB_SERVICE_KEY: "placeholder" },
    now: () => fixedNow,
    fetchImpl: async () => {
      calls += 1;
      return success({
        forecasts: [
          {
            reporttime: "2026-09-05 08:00:00",
            casts: [
              {
                date: "2026-09-05",
                dayweather: "晴",
                nightweather: "多云",
                daytemp: "29",
                nighttemp: "20",
              },
              {
                date: "2026-09-06",
                dayweather: "雷阵雨",
                nightweather: "中雨",
                daytemp: "26",
                nighttemp: "19",
              },
              {
                date: "2026-09-07",
                dayweather: "多云",
                nightweather: "晴",
                daytemp: "28",
                nighttemp: "21",
              },
            ],
          },
        ],
      });
    },
  });
  const adapter = new AmapWeatherAdapter(client, () => fixedNow);
  const near = await adapter.weather({
    subjectId: "trip-1",
    adcode: "110000",
    date: "2026-09-06",
  });
  assert.equal(near.status, "verified");
  assert.equal(near.fact?.precipitationExpected, true);
  assert.equal(near.fact?.severeWeather, true);
  assert.equal(near.evidence.checkedAt, "2026-09-05T08:00:00+08:00");

  const boundary = await adapter.weather({
    subjectId: "trip-1",
    adcode: "110000",
    date: "2026-09-07",
  });
  assert.equal(boundary.status, "verified");
  const far = await adapter.weather({
    subjectId: "trip-1",
    adcode: "110000",
    date: "2026-09-08",
  });
  assert.equal(far.status, "recheck_required");
  assert.equal(far.fact, undefined);
  assert.equal(calls, 2);
});

test("place details and authentication failures preserve a standard public boundary", async () => {
  const details = new AmapPlacesAdapter(
    new AmapClient({
      environment: { AMAP_WEB_SERVICE_KEY: "placeholder" },
      now: () => fixedNow,
      fetchImpl: async () =>
        success({
          pois: [
            {
              id: "B1",
              name: "故宫博物院",
              cityname: "北京",
              location: "116.397,39.918",
            },
          ],
        }),
    }),
  );
  const result = await details.details({ amapId: "B1" });
  assert.equal(result?.place.name, "故宫博物院");
  assert.equal(result?.checkedAt, fixedNow.toISOString());
  let calls = 0;
  const missingKey = new AmapPlacesAdapter(
    new AmapClient({
      environment: {},
      fetchImpl: async () => {
        calls += 1;
        return success({ pois: [] });
      },
    }),
  );
  await assert.rejects(
    () => missingKey.details({ amapId: "B1" }),
    (error: unknown) =>
      error instanceof AmapError && error.code === "authentication",
  );
  assert.equal(calls, 0);
});

test("public transit includes transfer names and fare, and route timeouts stay explicit", async () => {
  const transit = new AmapRoutesAdapter(
    new AmapClient({
      environment: { AMAP_WEB_SERVICE_KEY: "placeholder" },
      now: () => fixedNow,
      fetchImpl: async () =>
        success({
          route: {
            transits: [
              {
                distance: "5000",
                cost: { duration: "2400", transit_fee: "4" },
                segments: [
                  { bus: { buslines: [{ name: "地铁1号线" }] } },
                  { bus: { buslines: [{ name: "地铁2号线" }] } },
                ],
              },
            ],
          },
        }),
    }),
  );
  const result = await transit.route({
    ...routeInput(),
    mode: "public_transit",
  });
  assert.equal(result.status, "success");
  if (result.status === "success") {
    assert.equal(result.leg.mode, "public_transit");
    assert.equal(result.theoreticalDurationMinutes, 40);
    assert.equal(result.transferSummary, "地铁1号线 → 地铁2号线");
    assert.equal(result.suggestedBufferMinutes, 20);
    assert.equal(result.leg.bufferMinutes, 0);
    assert.deepEqual(result.leg.cost, {
      kind: "exact",
      currency: "CNY",
      amount: 4,
      confidence: "medium",
    });
  }
  const timeout = new AmapRoutesAdapter(
    new AmapClient({
      environment: { AMAP_WEB_SERVICE_KEY: "placeholder" },
      timeoutMs: 5,
      fetchImpl: async (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    }),
  );
  await assert.rejects(
    () => timeout.route(routeInput()),
    (error: unknown) => error instanceof AmapError && error.code === "timeout",
  );
});

test("weather does not turn missing temperature or provider failures into verified forecasts", async () => {
  const query = { subjectId: "trip-1", adcode: "110000", date: "2026-09-05" };
  for (const temperature of [undefined, null, "", "not-a-number"]) {
    const adapter = new AmapWeatherAdapter(
      new AmapClient({
        environment: { AMAP_WEB_SERVICE_KEY: "placeholder" },
        now: () => fixedNow,
        fetchImpl: async () =>
          success({
            forecasts: [
              {
                casts: [
                  {
                    date: query.date,
                    dayweather: "晴",
                    nightweather: "多云",
                    daytemp: "25",
                    nighttemp: temperature,
                  },
                ],
              },
            ],
          }),
      }),
      () => fixedNow,
    );
    const result = await adapter.weather(query);
    assert.equal(result.status, "recheck_required");
    assert.equal(result.fact, undefined);
  }
  for (const [infocode, expected] of [
    ["10003", "recheck_required"],
    ["10001", "failed"],
  ]) {
    const adapter = new AmapWeatherAdapter(
      new AmapClient({
        environment: { AMAP_WEB_SERVICE_KEY: "placeholder" },
        fetchImpl: async () =>
          new Response(JSON.stringify({ status: "0", infocode })),
      }),
      () => fixedNow,
    );
    const result = await adapter.weather(query);
    assert.equal(result.status, expected);
    assert.equal(result.fact, undefined);
    assert.ok(result.reminder);
  }
});
