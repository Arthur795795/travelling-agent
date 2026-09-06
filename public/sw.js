/**
 * Offline shell worker for the read-only trip view. Classic script served from
 * "/sw.js" so it can claim scope "/".
 *
 * The policy mirrors src/offline/shell.ts planRequest() and is asserted against
 * it in tests/unit/offline.test.ts: only the shell document and build assets
 * are cached, so no `/api/` response can ever be replayed as a fresh fact.
 */
const CACHE_PREFIX = "travel-agent-shell-";
const CACHE = CACHE_PREFIX + "v1";
const FALLBACK = "/offline";
const IMMUTABLE_ASSET_PREFIX = "/_next/static/";

/** The build assets the fallback document needs in order to hydrate offline. */
function shellAssets(html) {
  const urls = new Set();
  const pattern = /(?:src|href)="(\/_next\/[^"]+)"/g;
  let found = pattern.exec(html);
  while (found !== null) {
    urls.add(found[1].replace(/&amp;/g, "&"));
    found = pattern.exec(html);
  }
  return [...urls];
}

async function precacheShell() {
  const cache = await caches.open(CACHE);
  const response = await fetch(FALLBACK, { cache: "reload" });
  if (!response.ok) throw new Error("offline shell unavailable");
  const html = await response.clone().text();
  await cache.put(FALLBACK, response);
  await Promise.all(
    shellAssets(html).map(async (url) => {
      try {
        const asset = await fetch(url, { cache: "reload" });
        if (asset.ok) await cache.put(url, asset);
      } catch {
        // One missing asset must not block the install; the page degrades.
      }
    }),
  );
}

function planRequest(method, path, sameOrigin, navigation) {
  if (!sameOrigin) return "network-only";
  if (method.toUpperCase() !== "GET") return "network-only";
  if (path.startsWith("/api/")) return "network-only";
  if (navigation) return "shell-fallback";
  if (path.startsWith(IMMUTABLE_ASSET_PREFIX)) return "cache-first";
  return "network-only";
}

async function serveNavigation(request) {
  try {
    // A browser may satisfy a navigation from its ordinary HTTP cache while
    // disconnected. That would replay the old trip document, whose client
    // code then cannot finish loading. Force a network attempt so failure
    // deterministically selects the deliberately cached offline shell.
    const response = await fetch(request, { cache: "no-store" });
    // Keep the fallback current whenever it is reached with a network.
    if (response.ok && new URL(request.url).pathname === FALLBACK) {
      const cache = await caches.open(CACHE);
      await cache.put(FALLBACK, response.clone());
    }
    return response;
  } catch {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(FALLBACK);
    if (cached) return cached;
    return new Response("离线：本机没有可用的离线页面缓存。", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}

async function serveAsset(event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(event.request);
  if (cached) {
    // Dev chunk names are not content-hashed, so a cached asset is refreshed
    // in the background instead of being trusted forever.
    event.waitUntil(
      (async () => {
        try {
          const fresh = await fetch(event.request);
          if (fresh.ok) await cache.put(event.request, fresh);
        } catch {
          // Offline: the cached copy stays in place.
        }
      })(),
    );
    return cached;
  }
  const response = await fetch(event.request);
  if (response.ok) await cache.put(event.request, response.clone());
  return response;
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const plan = planRequest(
    event.request.method,
    url.pathname,
    url.origin === self.location.origin,
    event.request.mode === "navigate",
  );
  if (plan === "network-only") return;
  if (plan === "shell-fallback") {
    event.respondWith(serveNavigation(event.request));
    return;
  }
  event.respondWith(serveAsset(event));
});
