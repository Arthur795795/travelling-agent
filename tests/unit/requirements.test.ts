import assert from "node:assert/strict";
import test from "node:test";
import { checkRequirements } from "../../src/requirements/service.ts";

const now = () => new Date("2026-09-05T10:00:00+08:00");
const complete = {
  origin: "上海",
  destination: "北京",
  startDate: "2026-10-01",
  endDate: "2026-10-04",
  party: {
    adults: 2,
    childrenAgeBands: [] as Array<"0-2" | "3-6" | "7-12" | "13-17">,
    seniors: 0,
    mobilityNotes: [],
  },
  budget: {
    level: "balanced" as const,
    includes: [
      "intercity",
      "lodging",
      "tickets",
      "meals",
      "local_transport",
    ] as const,
    contingencyPercent: 10,
  },
  preferences: ["历史文化"],
  hardConstraints: ["不安排凌晨出发"],
  bookedItems: [],
};

test("complete supported input becomes a validated TripBrief", () => {
  const result = checkRequirements(
    {
      ...complete,
      dayTrips: [{ destination: "古北水镇", travelMinutesOneWay: 120 }],
    },
    now,
  );
  assert.equal(result.state, "ready");
  if (result.state === "ready") {
    assert.equal(result.brief.destination, "北京");
    assert.equal(result.brief.timeZone, "Asia/Shanghai");
    assert.equal(result.brief.party.adults, 2);
    assert.deepEqual(result.brief.dayTrips, [
      { destination: "古北水镇", travelMinutesOneWay: 120 },
    ]);
  }
});

test("missing fields produce only current unanswered high-impact questions", () => {
  const result = checkRequirements(
    { origin: "上海", destination: "北京" },
    now,
  );
  assert.equal(result.state, "needs_clarification");
  if (result.state === "needs_clarification") {
    assert.ok(result.questions.length >= 3 && result.questions.length <= 5);
    assert.equal(
      result.questions.some(({ field }) => field === "origin"),
      false,
    );
    assert.equal(
      result.questions.some(({ field }) => field === "destination"),
      false,
    );
    assert.deepEqual(
      result.questions.slice(0, 3).map(({ field }) => field),
      ["dates", "party", "budget"],
    );
  }
});

test("an unknown destination enters a 2–3 candidate flow without starting planning", () => {
  const result = checkRequirements(
    { origin: "上海", destinationCandidates: ["成都", "北京", "北京"] },
    now,
  );
  assert.equal(result.state, "destination_options");
  if (result.state === "destination_options") {
    assert.ok(result.candidates.length >= 2 && result.candidates.length <= 3);
    assert.equal(
      result.candidates.every(({ support }) => support === "full"),
      true,
    );
    assert.equal(
      result.candidates.some(({ city }) => city === "成都"),
      false,
    );
  }
});

test("multi-city, experimental city, long trip, large party and distant dates stay out of full support", () => {
  const cases = [
    { ...complete, destinations: ["北京", "西安"] },
    { ...complete, destination: "成都" },
    { ...complete, endDate: "2026-10-07" },
    { ...complete, party: { ...complete.party, adults: 7 } },
    { ...complete, startDate: "2027-10-01", endDate: "2027-10-04" },
    {
      ...complete,
      dayTrips: [{ destination: "承德", travelMinutesOneWay: 121 }],
    },
  ];
  for (const input of cases)
    assert.equal(checkRequirements(input, now).state, "out_of_scope");
});

test("start date plus duration resolves dates and sensitive input is rejected", () => {
  const withDuration = { ...complete, endDate: undefined, durationDays: 4 };
  const result = checkRequirements(withDuration, now);
  assert.equal(result.state, "ready");
  if (result.state === "ready")
    assert.equal(result.brief.endDate, "2026-10-04");

  const sensitive = checkRequirements(
    { ...complete, hardConstraints: ["联系人手机号 13800138000"] },
    now,
  );
  assert.equal(sensitive.state, "rejected");
});
