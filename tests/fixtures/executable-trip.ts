import { buildTripFixture } from "./trip.ts";
import { TripSchema, type Trip } from "../../src/domain/schema.ts";
export function executableTrip(): Trip {
  const trip = buildTripFixture();
  trip.brief.endDate = "2026-10-03";
  trip.brief.budget.includes = ["tickets"];
  trip.days = [];
  trip.claims = [];
  trip.evidence = [];
  trip.budget.items = [];
  for (let day = 1; day <= 3; day++) {
    const date = `2026-10-0${day}`;
    const id = `activity-${day}`;
    const placeId = `place-${day}`;
    const evidenceIds: string[] = [];
    for (const field of ["address", "opening_hours", "reservation_rules"]) {
      const eid = `evidence-${day}-${field}`;
      evidenceIds.push(eid);
      trip.evidence.push({
        id: eid,
        sourceType: "official",
        sourceName: "测试官网",
        checkedAt: trip.createdAt,
        status: "verified",
        assertedValue: field,
      });
      trip.claims.push({
        id: `claim-${day}-${field}`,
        subjectId: id,
        date,
        field,
        value: field,
        status: "verified",
        evidenceIds: [eid],
        conflictEvidenceIds: [],
      });
    }
    trip.days.push({
      id: `day-${day}`,
      date,
      title: `第${day}天`,
      notes: ["下午留白休息"],
      legs: [],
      activities: [
        {
          id,
          title: `活动${day}`,
          place: {
            id: placeId,
            name: `地点${day}`,
            city: "北京",
            source: "official",
            longitude: 116.4,
            latitude: 39.9,
          },
          timeWindow: {
            start: `${date}T09:00:00+08:00`,
            end: `${date}T11:00:00+08:00`,
            flexibilityMinutes: 0,
          },
          durationMinutes: 120,
          importance: "core",
          locked: false,
          cost: {
            kind: "exact",
            currency: "CNY",
            amount: 60,
            confidence: "high",
          },
          rationale: "测试活动",
          evidenceIds,
          reservation: { required: false, status: "verified" },
          availabilityWindows: [
            {
              start: `${date}T08:00:00+08:00`,
              end: `${date}T17:00:00+08:00`,
              flexibilityMinutes: 0,
            },
          ],
        },
      ],
    });
    trip.budget.items.push({
      id: `cost-${day}`,
      category: "tickets",
      title: `活动${day}`,
      cost: { kind: "exact", currency: "CNY", amount: 60, confidence: "high" },
      paymentStatus: "estimated",
      evidenceIds,
    });
  }
  trip.budget.total = {
    kind: "range",
    currency: "CNY",
    min: 198,
    max: 198,
    confidence: "medium",
  };
  trip.lifecycleStatus = "draft";
  return TripSchema.parse(trip);
}
