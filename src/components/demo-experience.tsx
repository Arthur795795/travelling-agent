"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  beijingDemo,
  copyDemo,
  demoScenario,
  DEMO_SCENARIOS,
  DEMO_NOTICE,
} from "../demo/beijing.ts";
import { BrowserTripStore } from "../persistence/browser-store.ts";
import { FeedbackPanel } from "./feedback-panel.tsx";
import { TripTimeline } from "./trip-timeline.tsx";
import { TripDetails } from "./trip-details.tsx";
export default function DemoExperience() {
  const [trip, setTrip] = useState(beijingDemo),
    [scenario, setScenario] = useState<string>();
  const router = useRouter();
  return (
    <>
      <h1>北京四日预设案例</h1>
      <p>{DEMO_NOTICE}</p>
      <p>
        以下三个情境均为预先验证的固定结果，无
        Key、无模型调用；不接受任意文本冒充预设结果。
      </p>
      {DEMO_SCENARIOS.map((s) => (
        <button key={s.id} onClick={() => setScenario(s.id)}>
          {s.title}
        </button>
      ))}
      {scenario && (
        <section aria-label="预设影响预览">
          <h2>预设情境影响预览</h2>
          <p>
            {DEMO_SCENARIOS.find((s) => s.id === scenario)?.title} · 仅涉及{" "}
            {DEMO_SCENARIOS.find((s) => s.id === scenario)?.date}
            ，锁定酒店保持不变。
          </p>
          <button
            onClick={() => {
              setTrip(demoScenario(scenario));
              setScenario(undefined);
            }}
          >
            应用预设情境
          </button>
          <button onClick={() => setScenario(undefined)}>取消预设情境</button>
        </section>
      )}
      <button
        onClick={() => {
          setTrip(beijingDemo());
          setScenario(undefined);
        }}
      >
        恢复公共案例基线
      </button>
      <button
        onClick={() => {
          const copy = copyDemo();
          Object.assign(copy, trip, { id: copy.id, version: 1 });
          new BrowserTripStore(localStorage).saveTrip(copy);
          router.push(`/trips/${copy.id}`);
        }}
      >
        创建个人副本
      </button>
      <TripDetails trip={trip} />
      <TripTimeline trip={trip} />
      <FeedbackPanel context="fixed_demo" />
    </>
  );
}
