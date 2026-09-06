import OfflineTrip from "../../components/offline-trip.tsx";
import { loadFeatureFlags } from "../../config/features.ts";

/**
 * The document the service worker keeps for offline navigations. It carries no
 * server data of its own: everything shown comes from this browser's storage,
 * so it stays valid whatever url the worker serves it for.
 */
export default function OfflinePage() {
  return (
    <main className="shell" id="main-content" tabIndex={-1}>
      <OfflineTrip enabled={loadFeatureFlags().offlineReadonly} />
    </main>
  );
}
