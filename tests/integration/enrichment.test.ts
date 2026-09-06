import assert from "node:assert/strict";
import test from "node:test";
import {
  collectEvidence,
  completeRoutesAndBudget,
  type EnrichmentPlan,
  type ToolCaller,
} from "../../src/agent/enrichment.ts";
import type { ItinerarySkeleton } from "../../src/agent/skeleton.ts";
import { executableTrip } from "../fixtures/executable-trip.ts";
import { validateTrip } from "../../src/validation/trip.ts";

test("enrichment builds a complete dated draft while failed sources, routes and unknown prices stay explicit", async () => {
  const brief = executableTrip().brief;
  brief.budget.includes = ["tickets", "meals", "local_transport"];
  const dates = ["2026-10-01", "2026-10-02", "2026-10-03"];
  const skeleton = {
    days: dates.map((date) => ({ date })),
    disclosedDefaults: ["适中密度"],
  } as unknown as ItinerarySkeleton;
  const plan: EnrichmentPlan = {
    days: dates.map((date, i) => ({
      date,
      notes: ["下午留白"],
      activities: [0, 1].map((n) => ({
        id: `a-${i}-${n}`,
        title: `活动${n}`,
        keyword: `地点${n}`,
        city: "北京",
        start: `${date}T${n ? "14" : "09"}:00:00+08:00`,
        end: `${date}T${n ? "16" : "11"}:00:00+08:00`,
        durationMinutes: 120,
        importance: "core",
        rationale: "候选区域内活动",
        fallbackKeyword: "附近公园",
      })),
    })),
  };
  const names: string[] = [];
  const signatures = new Map<string, string>();
  const call: ToolCaller = async (name, args, key, stage) => {
    const signature = JSON.stringify({ name, args });
    if (signatures.has(key))
      assert.equal(
        signatures.get(key),
        signature,
        "one idempotency key must identify one input",
      );
    signatures.set(key, signature);
    names.push(name);
    const input = args as Record<string, string>;
    let data: unknown;
    if (name === "search_places")
      data = {
        candidates: [
          {
            amapId: input.keyword,
            place: {
              id: input.keyword,
              name: input.keyword,
              city: "北京",
              source: "amap",
              longitude: 116.4,
              latitude: 39.9,
            },
            adcode: "110000",
            checkedAt: "2026-09-05T00:00:00Z",
          },
        ],
      };
    if (name === "get_weather")
      data = {
        evidence: {
          id: `weather:${key}`,
          sourceType: "dedicated_api",
          sourceName: "天气",
          checkedAt: "2026-09-05T00:00:00Z",
          status: "recheck_required",
        },
      };
    if (name === "web_search") data = { candidates: [] };
    return {
      jobId: "test",
      name,
      stage,
      callId: key,
      idempotencyKey: key,
      status: data ? "success" : "blocked",
      data,
      evidenceIds: [],
      durationMs: 0,
      usageEvents: [],
    };
  };
  const draft = await collectEvidence(brief, skeleton, plan, call, "trip-1");
  const result = await completeRoutesAndBudget(draft, call);
  assert.equal(result.days.length, 3);
  assert.equal(result.days[0].activities.length, 2);
  assert.equal(result.lifecycleStatus, "draft");
  assert.equal(result.budget.total.kind, "unknown");
  assert.ok(result.alerts.some((a) => a.code === "MISSING_ROUTE"));
  assert.equal(result.days.flatMap((d) => d.legs).length, 0);
  assert.ok(
    result.claims.some(
      (c) => c.field === "opening_hours" && c.status !== "verified",
    ),
  );
  assert.ok(result.alternatives.length);
  assert.ok(names.includes("get_weather"));
  assert.ok(names.includes("create_platform_link"));
});

test("verified simple rules and route results produce a traceable draft, while conditional schedules stay unverified", async () => {
  const brief = executableTrip().brief;
  brief.budget.includes = ["tickets", "local_transport"];
  const dates = ["2026-10-01", "2026-10-02", "2026-10-03"];
  const skeleton = {
    days: dates.map((date) => ({ date })),
    disclosedDefaults: [],
  } as unknown as ItinerarySkeleton;
  const plan: EnrichmentPlan = {
    days: dates.map((date, i) => ({
      date,
      notes: [],
      activities: [0, 1].map((n) => ({
        id: `a-${i}-${n}`,
        title: `地点${n}`,
        keyword: `地点${n}`,
        city: "北京",
        start: `${date}T${n ? "14" : "09"}:00:00+08:00`,
        end: `${date}T${n ? "16" : "11"}:00:00+08:00`,
        durationMinutes: 120,
        importance: "core",
        rationale: "区域内活动",
        fallbackKeyword: "附近公园",
      })),
    })),
  };
  for (const conditional of [false, true]) {
    const call: ToolCaller = async (name, args, key, stage) => {
      const a = args as Record<string, unknown>;
      let data: unknown;
      if (name === "search_places")
        data = {
          candidates: [
            {
              cityCode: "010",
              place: {
                id: a.keyword,
                name: a.keyword,
                city: "北京",
                address: "测试地址",
                longitude: 116.4,
                latitude: 39.9,
                source: "amap",
              },
            },
          ],
        };
      if (name === "web_search")
        data = {
          candidates: [{ sourceType: "official", title: "地点0与地点1官网" }],
        };
      if (name === "read_official_page") {
        const excerpt = `地点0与地点1 开放时间 08:00–17:00，无需预约，门票60元${conditional ? "，周一闭馆" : ""}`;
        data = {
          evidence: {
            id: `rule:${key}`,
            sourceType: "official",
            sourceName: "测试官网",
            checkedAt: "2026-09-05T00:00:00Z",
            status: "verified",
            assertedValue: excerpt,
            excerpt,
          },
        };
      }
      if (name === "calculate_route")
        data = {
          leg: {
            id: a.legId,
            fromPlaceId: a.fromPlaceId,
            toPlaceId: a.toPlaceId,
            mode: a.mode,
            departureWindow: a.departureWindow,
            durationMinutes: { min: 20, max: 30 },
            bufferMinutes: 0,
            cost: {
              kind: "exact",
              currency: "CNY",
              amount: 6,
              confidence: "high",
            },
            evidenceIds: [],
            locked: false,
          },
          suggestedBufferMinutes: 15,
        };
      return {
        jobId: "test",
        name,
        stage,
        callId: key,
        idempotencyKey: key,
        status: data ? "success" : "blocked",
        data,
        evidenceIds: [],
        durationMs: 0,
        usageEvents: [],
      };
    };
    const draft = await collectEvidence(
      brief,
      skeleton,
      plan,
      call,
      "verified-trip",
    );
    const result = await completeRoutesAndBudget(draft, call);
    assert.equal(result.lifecycleStatus, "draft");
    assert.equal(result.days.flatMap((d) => d.legs).length, 3);
    assert.ok(result.days.every((d) => d.legs[0].bufferMinutes >= 15));
    if (conditional) {
      assert.equal(result.budget.total.kind, "unknown");
      assert.ok(
        validateTrip(result).some((i) => i.code === "OPENING_UNVERIFIED"),
      );
    } else {
      assert.equal(result.budget.total.kind, "range");
      assert.deepEqual(validateTrip(result), []);
    }
  }
});

test("a unique exact Amap match resolves among nearby candidates and transfer placeholders are omitted", async () => {
  const brief = executableTrip().brief;
  const dates = ["2026-10-01", "2026-10-02", "2026-10-03"];
  const skeleton = {
    days: dates.map((date) => ({ date })),
    disclosedDefaults: [],
  } as unknown as ItinerarySkeleton;
  const plan: EnrichmentPlan = {
    days: dates.map((date, index) => ({
      date,
      notes: [],
      activities: [
        ...(index === 0
          ? [
              {
                id: "arrival-transfer",
                title: "城际交通：抵达北京",
                keyword: "上海至北京",
                city: "北京",
                start: `${date}T07:00:00+08:00`,
                end: `${date}T08:00:00+08:00`,
                durationMinutes: 60,
                importance: "core" as const,
                rationale: "抵达城市",
                fallbackKeyword: "车站",
              },
            ]
          : []),
        {
          id: `place-${index}`,
          title: "故宫博物院",
          keyword: "故宫博物院",
          city: "北京",
          start: `${date}T09:00:00+08:00`,
          end: `${date}T11:00:00+08:00`,
          durationMinutes: 120,
          importance: "core" as const,
          rationale: "历史文化",
          fallbackKeyword: "景山公园",
        },
      ],
    })),
  };
  const called: string[] = [];
  const call: ToolCaller = async (name, args, key, stage) => {
    called.push(`${name}:${key}`);
    const input = args as Record<string, unknown>;
    let data: unknown;
    if (name === "search_places")
      data = {
        candidates: [
          {
            amapId: "exact",
            place: {
              id: "amap:exact",
              name: "故宫博物院",
              city: "北京市",
              source: "amap",
            },
          },
          {
            amapId: "nearby-1",
            place: {
              id: "amap:nearby-1",
              name: "故宫角楼",
              city: "北京",
              source: "amap",
            },
          },
          {
            amapId: "nearby-2",
            place: {
              id: "amap:nearby-2",
              name: "故宫停车场",
              city: "北京",
              source: "amap",
            },
          },
        ],
      };
    if (name === "get_place_details")
      data = {
        amapId: input.amapId,
        checkedAt: "2026-09-05T00:00:00Z",
        adcode: "110000",
        cityCode: "010",
        place: {
          id: "amap:exact",
          name: "故宫博物院",
          address: "东城区",
          city: "北京",
          source: "amap",
          longitude: 116.397,
          latitude: 39.918,
        },
      };
    if (name === "web_search") data = { candidates: [] };
    return {
      jobId: "test",
      name,
      stage,
      callId: key,
      idempotencyKey: key,
      status: data ? "success" : "blocked",
      data,
      evidenceIds: [],
      durationMs: 0,
      usageEvents: [],
    };
  };

  const draft = await collectEvidence(brief, skeleton, plan, call, "trip-exact");
  assert.equal(draft.days[0].activities.length, 1);
  assert.equal(draft.days[0].activities[0].place.id, "amap:exact");
  assert.equal(draft.alerts.some((alert) => alert.code === "PLACE_UNRESOLVED"), false);
  assert.equal(called.some((item) => item.includes("arrival-transfer")), false);
  assert.ok(draft.days[0].notes.some((note) => note.includes("城际抵达或返程")));
});
