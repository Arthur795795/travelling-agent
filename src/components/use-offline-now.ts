"use client";
import { useEffect, useState } from "react";
import { useOffline } from "next/offline";

/**
 * Offline as this page can actually tell, from the two signals that disagree:
 *
 * - `useOffline()` turns true when a framework fetch fails, which is the only
 *   way to notice a connection that is up but answers nothing. It stays false
 *   until such a fetch happens, and it is always false in a build made without
 *   `experimental.useOffline`.
 * - `navigator.onLine` turns false the moment the interface goes down, before
 *   anything has been requested. It can be true with no usable network, so it
 *   is read as a positive signal only.
 *
 * Either one is enough to stop offering an action that needs the network.
 */
export function useOfflineNow(): boolean {
  const reportedByFramework = useOffline();
  const [disconnected, setDisconnected] = useState(false);
  useEffect(() => {
    let active = true;
    const read = () => {
      if (active) setDisconnected(!navigator.onLine);
    };
    // Deferred: reading connectivity is a mount-time effect, not a render.
    void Promise.resolve().then(read);
    addEventListener("online", read);
    addEventListener("offline", read);
    return () => {
      active = false;
      removeEventListener("online", read);
      removeEventListener("offline", read);
    };
  }, []);
  return reportedByFramework || disconnected;
}
