"use client";
import { useEffect, useState } from "react";
import type { Trip } from "../domain/schema.ts";
import { BrowserTripStore } from "../persistence/browser-store.ts";
import { TripDetails } from "./trip-details.tsx";
import { TripTimeline } from "./trip-timeline.tsx";
import {
  OFFLINE_DISABLED_ACTIONS,
  OFFLINE_DISABLED_NOTICE,
  OFFLINE_FEATURE_OFF_NOTICE,
  OFFLINE_NO_DATA_DETAIL,
  OFFLINE_NO_DATA_TITLE,
  lastUpdatedText,
  offlineCopyNotice,
  tripIdFromPath,
} from "../offline/shell.ts";

export default function OfflineTrip({ enabled }: { enabled: boolean }) {
  const [state, setState] = useState<{ trip: Trip | null; others: Trip[] }>();
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      try {
        const store = new BrowserTripStore(localStorage);
        const id = tripIdFromPath(window.location.pathname);
        const trip = id ? store.loadTrip(id) : null;
        const others = store.listTrips().filter((t) => t.id !== trip?.id);
        if (active) setState({ trip, others });
      } catch {
        if (active) setState({ trip: null, others: [] });
      }
    });
    return () => {
      active = false;
    };
  }, []);
  if (!enabled) return <p role="alert">{OFFLINE_FEATURE_OFF_NOTICE}</p>;
  if (!state) return <p>正在读取本机行程…</p>;
  if (!state.trip)
    return (
      <>
        <h1>{OFFLINE_NO_DATA_TITLE}</h1>
        <p role="alert">{OFFLINE_NO_DATA_DETAIL}</p>
        {state.others.length > 0 && (
          <section>
            <h2>本机保存的行程</h2>
            {state.others.map((trip) => (
              <p key={trip.id}>
                <a href={`/trips/${encodeURIComponent(trip.id)}`}>
                  {trip.brief.destination} · {trip.brief.startDate}
                </a>{" "}
                · 最后更新 {lastUpdatedText(trip.updatedAt)}
              </p>
            ))}
          </section>
        )}
      </>
    );
  return (
    <>
      {/* Written before the itinerary: what this copy is, and when it was made. */}
      <p className="offline-banner" role="note">
        {offlineCopyNotice(state.trip.updatedAt)}
      </p>
      <TripTimeline trip={state.trip} />
      <TripDetails trip={state.trip} />
      <section aria-label="离线不可用的操作">
        <h2>离线不可用</h2>
        {OFFLINE_DISABLED_ACTIONS.map((action) => (
          <button
            key={action}
            type="button"
            disabled
            aria-describedby="offline-disabled-reason"
          >
            {action}
          </button>
        ))}
        <p id="offline-disabled-reason">{OFFLINE_DISABLED_NOTICE}</p>
        <p>恢复网络后重新打开该行程，即可继续编辑、核验、分享和导出。</p>
      </section>
    </>
  );
}
