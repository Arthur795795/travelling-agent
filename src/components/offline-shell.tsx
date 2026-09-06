"use client";
import { useEffect } from "react";
import {
  OFFLINE_CACHE_PREFIX,
  OFFLINE_DISABLED_NOTICE,
  SERVICE_WORKER_PATH,
} from "../offline/shell.ts";
import { useOfflineNow } from "./use-offline-now.ts";

/**
 * Installs the offline shell and reports connectivity.
 *
 * `enabled` comes from FEATURE_OFFLINE_READONLY on the server. When it is off
 * the worker and its caches are removed and nothing is cached, so a reload
 * offline fails as it would without this component at all — the whole capability
 * disappears without touching any other page.
 */
export function OfflineShell({ enabled }: { enabled: boolean }) {
  const offline = useOfflineNow();
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    void (async () => {
      try {
        if (enabled) {
          await navigator.serviceWorker.register(SERVICE_WORKER_PATH, {
            scope: "/",
            updateViaCache: "none",
          });
          return;
        }
        for (const registration of await navigator.serviceWorker.getRegistrations())
          if (
            (registration.active ?? registration.installing)?.scriptURL.endsWith(
              SERVICE_WORKER_PATH,
            )
          )
            await registration.unregister();
        if ("caches" in window)
          for (const name of await caches.keys())
            if (name.startsWith(OFFLINE_CACHE_PREFIX)) await caches.delete(name);
      } catch {
        // Offline viewing is secondary: a failed registration must never break
        // the page it was mounted on.
      }
    })();
  }, [enabled]);
  // The live region exists from the first paint so that going offline is
  // announced instead of silently inserting a new region.
  return (
    <div role="status" aria-live="polite">
      {offline && <p className="offline-banner">{OFFLINE_DISABLED_NOTICE}</p>}
    </div>
  );
}
