import {
  DEFAULT_TIME_ZONE,
  SCHEMA_VERSION,
  type Trip,
} from "../../src/domain/schema.ts";

export function buildTripFixture(overrides: Partial<Trip> = {}): Trip {
  const now = "2026-09-04T10:00:00+08:00";
  const trip: Trip = {
    schemaVersion: SCHEMA_VERSION,
    id: "trip-beijing-001",
    version: 1,
    brief: {
      schemaVersion: SCHEMA_VERSION,
      origin: "上海",
      destination: "北京",
      startDate: "2026-10-01",
      endDate: "2026-10-04",
      timeZone: DEFAULT_TIME_ZONE,
      party: { adults: 2, childrenAgeBands: [], seniors: 0, mobilityNotes: [] },
      budget: {
        level: "balanced",
        limit: {
          kind: "exact",
          currency: "CNY",
          amount: 8_000,
          confidence: "high",
        },
        includes: [
          "intercity",
          "lodging",
          "tickets",
          "meals",
          "local_transport",
        ],
        contingencyPercent: 10,
      },
      preferences: ["历史文化"],
      hardConstraints: ["不安排凌晨出发"],
      bookedItems: [],
      dayTrips: [],
    },
    assumptions: ["以公共交通为主"],
    lockedBookings: [],
    days: [
      {
        id: "day-1",
        date: "2026-10-01",
        title: "抵达与中轴线",
        activities: [
          {
            id: "activity-1",
            title: "故宫博物院",
            timeWindow: {
              start: "2026-10-01T09:00:00+08:00",
              end: "2026-10-01T12:00:00+08:00",
              flexibilityMinutes: 15,
            },
            durationMinutes: 180,
            place: {
              id: "place-palace-museum",
              name: "故宫博物院",
              city: "北京",
              source: "official",
            },
            importance: "core",
            locked: false,
            cost: {
              kind: "range",
              currency: "CNY",
              min: 40,
              max: 60,
              confidence: "medium",
            },
            reservation: { required: true, status: "verified" },
            rationale: "首日安排一个核心历史文化景点。",
            evidenceIds: ["evidence-1"],
          },
        ],
        legs: [],
        notes: ["预留安检和排队时间"],
      },
    ],
    budget: {
      items: [
        {
          id: "cost-1",
          category: "tickets",
          title: "故宫门票",
          cost: {
            kind: "range",
            currency: "CNY",
            min: 40,
            max: 60,
            confidence: "medium",
          },
          paymentStatus: "estimated",
          evidenceIds: ["evidence-1"],
        },
      ],
      contingencyPercent: 10,
      total: {
        kind: "range",
        currency: "CNY",
        min: 40,
        max: 60,
        confidence: "medium",
      },
      withinLimit: true,
    },
    evidence: [
      {
        id: "evidence-1",
        sourceType: "official",
        sourceName: "故宫博物院",
        url: "https://www.dpm.org.cn/",
        checkedAt: now,
        status: "verified",
        assertedValue: "需要预约",
      },
    ],
    claims: [
      {
        id: "claim-1",
        subjectId: "activity-1",
        field: "reservation",
        value: "需要预约",
        evidenceIds: ["evidence-1"],
        status: "verified",
        conflictEvidenceIds: [],
      },
    ],
    alerts: [],
    alternatives: [],
    lifecycleStatus: "checked",
    createdAt: now,
    updatedAt: now,
  };

  return { ...trip, ...overrides };
}
