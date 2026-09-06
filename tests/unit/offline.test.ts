import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, it } from "node:test";
import { FEATURE_NAMES, loadFeatureFlags } from "../../src/config/features.ts";
import {
  IMMUTABLE_ASSET_PREFIX,
  OFFLINE_CACHE,
  OFFLINE_CACHE_PREFIX,
  OFFLINE_DISABLED_ACTIONS,
  OFFLINE_DISABLED_NOTICE,
  OFFLINE_FALLBACK_PATH,
  OFFLINE_FEATURE_OFF_NOTICE,
  OFFLINE_NO_DATA_DETAIL,
  OFFLINE_NO_DATA_TITLE,
  SERVICE_WORKER_PATH,
  lastUpdatedText,
  offlineCopyNotice,
  planRequest,
  tripIdFromPath,
} from "../../src/offline/shell.ts";

const root = join(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const workerSource = read(join("public", SERVICE_WORKER_PATH));

describe("feature flag", () => {
  it("keeps offline read-only off unless it is asked for", () => {
    assert.ok(FEATURE_NAMES.includes("offlineReadonly"));
    assert.equal(loadFeatureFlags({}).offlineReadonly, false);
    assert.equal(
      loadFeatureFlags({ FEATURE_OFFLINE_READONLY: "TRUE" }).offlineReadonly,
      true,
    );
    // Nothing else in the app changes when the capability is cut.
    assert.deepEqual(loadFeatureFlags({ FEATURE_OFFLINE_READONLY: "true" }), {
      customGeneration: false,
      webSearch: false,
      amap: false,
      sharing: false,
      export: false,
      offlineReadonly: true,
    });
  });
  it("is decided at build time, where the shell is built", () => {
    const config = read("next.config.ts");
    assert.match(config, /useOffline: process\.env\.FEATURE_OFFLINE_READONLY/);
    assert.match(config, /source: "\/sw\.js"/);
    assert.match(config, /no-cache, no-store, must-revalidate/);
    const layout = read("src/app/layout.tsx");
    assert.match(
      layout,
      /<OfflineShell enabled=\{loadFeatureFlags\(\)\.offlineReadonly\}/,
    );
  });
});

describe("request policy", () => {
  const plan = (
    path: string,
    extra: { method?: string; navigation?: boolean; sameOrigin?: boolean } = {},
  ) =>
    planRequest({
      method: extra.method ?? "GET",
      path,
      sameOrigin: extra.sameOrigin ?? true,
      navigation: extra.navigation ?? false,
    });
  it("answers navigations from the shell so a saved trip can open", () => {
    assert.equal(plan("/trips/abc", { navigation: true }), "shell-fallback");
    assert.equal(
      plan(OFFLINE_FALLBACK_PATH, { navigation: true }),
      "shell-fallback",
    );
  });
  it("serves only content-hashed build assets from the cache", () => {
    assert.equal(plan(`${IMMUTABLE_ASSET_PREFIX}chunks/a.js`), "cache-first");
    assert.equal(plan("/_next/image?url=x"), "network-only");
    assert.equal(plan("/favicon.ico"), "network-only");
  });
  it("never replays an api response, a write or another origin", () => {
    for (const path of [
      "/api/shares",
      "/api/planning-jobs/1",
      "/api/trips/1/export.pdf",
      "/api/analytics/events",
    ])
      assert.equal(plan(path), "network-only", path);
    assert.equal(
      plan("/api/shares", { method: "POST", navigation: true }),
      "network-only",
    );
    assert.equal(
      plan("/trips/abc", { method: "POST", navigation: true }),
      "network-only",
    );
    assert.equal(
      plan(`${IMMUTABLE_ASSET_PREFIX}chunks/a.js`, { sameOrigin: false }),
      "network-only",
    );
  });
});

describe("offline wording", () => {
  it("names the moment the local copy was written", () => {
    const notice = offlineCopyNotice("2026-09-06T14:03:00+08:00");
    assert.match(notice, /2026/);
    assert.match(notice, /14:03/);
    assert.match(notice, /最后更新/);
    // An offline copy must never be presented as current.
    assert.doesNotMatch(notice, /已更新|最新|实时/);
    assert.match(notice, /可能已变化|重新核验/);
  });
  it("survives a timestamp it cannot read", () => {
    assert.equal(lastUpdatedText("not a date"), "时间未知");
  });
  it("lists the actions that need a network", () => {
    assert.deepEqual(OFFLINE_DISABLED_ACTIONS, [
      "局部重规划",
      "链接核验",
      "只读分享",
      "PDF/ICS 导出",
    ]);
    // And says what still works, so the notice is not read as "nothing works".
    assert.match(OFFLINE_DISABLED_NOTICE, /备注与锁定/);
  });
});

describe("trip id from the address the worker answered", () => {
  it("reads the trip out of a trips path only", () => {
    assert.equal(tripIdFromPath("/trips/trip-1"), "trip-1");
    assert.equal(tripIdFromPath("/trips/trip%201?x=1"), "trip 1");
    assert.equal(tripIdFromPath("/trips/trip-1/extra"), "trip-1");
    for (const path of ["/offline", "/", "/demo", "/share/token", "/trips/"])
      assert.equal(tripIdFromPath(path), "", path);
    assert.equal(tripIdFromPath("/trips/%E0%A4%A"), "");
  });
});

// The worker that actually ships is executed here, in a scope that only offers
// what a service worker offers, so the shipped file is what gets tested.
const ORIGIN = "https://trip.example";
interface FakeRequest {
  url: string;
  method: string;
  mode: string;
}
const request = (
  path: string,
  init: { method?: string; mode?: string; origin?: string } = {},
): FakeRequest => ({
  url: new URL(path, init.origin ?? ORIGIN).href,
  method: init.method ?? "GET",
  mode: init.mode ?? "cors",
});
const cacheKey = (key: string | FakeRequest) =>
  typeof key === "string" ? new URL(key, ORIGIN).href : key.url;

class FakeCache {
  readonly entries = new Map<string, Response>();
  put(key: string | FakeRequest, response: Response) {
    this.entries.set(cacheKey(key), response);
    return Promise.resolve();
  }
  match(key: string | FakeRequest) {
    const found = this.entries.get(cacheKey(key));
    return Promise.resolve(found ? found.clone() : undefined);
  }
  paths() {
    return [...this.entries.keys()].map((url) => new URL(url).pathname).sort();
  }
}

function loadWorker(
  routes: Record<string, string>,
  seededCaches: string[] = [],
) {
  const stores = new Map<string, FakeCache>();
  for (const name of seededCaches) stores.set(name, new FakeCache());
  const listeners = new Map<string, (event: never) => void>();
  const requested: string[] = [];
  const state = { offline: false, skipped: false, claimed: false };
  const context = createContext({
    console,
    URL,
    Response,
    self: {
      location: { origin: ORIGIN },
      addEventListener: (type: string, listener: (event: never) => void) => {
        listeners.set(type, listener);
      },
      skipWaiting: () => {
        state.skipped = true;
        return Promise.resolve();
      },
      clients: {
        claim: () => {
          state.claimed = true;
          return Promise.resolve();
        },
      },
    },
    caches: {
      open: (name: string) => {
        const found = stores.get(name) ?? new FakeCache();
        stores.set(name, found);
        return Promise.resolve(found);
      },
      keys: () => Promise.resolve([...stores.keys()]),
      delete: (name: string) => Promise.resolve(stores.delete(name)),
    },
    fetch: (input: string | FakeRequest) => {
      const url = cacheKey(input);
      requested.push(new URL(url).pathname);
      if (state.offline) return Promise.reject(new TypeError("failed"));
      const body = routes[new URL(url).pathname];
      return Promise.resolve(
        body === undefined
          ? new Response("missing", { status: 404 })
          : new Response(body, { status: 200 }),
      );
    },
  });
  runInContext(workerSource, context, { filename: "public/sw.js" });
  const lifecycle = async (type: "install" | "activate") => {
    const listener = listeners.get(type);
    assert.ok(listener, `worker has no ${type} listener`);
    const waits: Promise<unknown>[] = [];
    (listener as (event: { waitUntil(p: Promise<unknown>): void }) => void)({
      waitUntil: (promise) => waits.push(promise),
    });
    await Promise.all(waits);
  };
  return {
    stores,
    requested,
    state,
    routes,
    install: () => lifecycle("install"),
    activate: () => lifecycle("activate"),
    async handle(target: FakeRequest) {
      const listener = listeners.get("fetch");
      assert.ok(listener, "worker has no fetch listener");
      let responded: Promise<Response> | undefined;
      const background: Promise<unknown>[] = [];
      (
        listener as (event: {
          request: FakeRequest;
          respondWith(p: Promise<Response>): void;
          waitUntil(p: Promise<unknown>): void;
        }) => void
      )({
        request: target,
        respondWith: (promise) => {
          responded = promise;
        },
        waitUntil: (promise) => background.push(promise),
      });
      const response = responded ? await responded : undefined;
      await Promise.all(background);
      return { handled: responded !== undefined, response };
    },
  };
}

const SHELL_HTML = (marker: string) =>
  `<!doctype html><html><head><link rel="stylesheet" href="/_next/static/css/app.css"/><script src="/_next/static/chunks/main.js"></script><script src="/_next/static/chunks/gone.js"></script></head><body>${marker}</body></html>`;
const shellRoutes = (marker = "v1") => ({
  [OFFLINE_FALLBACK_PATH]: SHELL_HTML(marker),
  "/_next/static/css/app.css": "body{}",
  "/_next/static/chunks/main.js": `console.log("${marker}")`,
  "/trips/trip-1": "<html>server rendered trip</html>",
});

describe("shell worker lifecycle", () => {
  it("caches the offline document and the assets it needs to hydrate", async () => {
    const worker = loadWorker(shellRoutes());
    await worker.install();
    const cache = worker.stores.get(OFFLINE_CACHE);
    assert.ok(cache, `install must open ${OFFLINE_CACHE}`);
    assert.deepEqual(cache.paths(), [
      "/_next/static/chunks/main.js",
      "/_next/static/css/app.css",
      OFFLINE_FALLBACK_PATH,
    ]);
    // A referenced asset that is gone is skipped, not fatal.
    assert.ok(worker.requested.includes("/_next/static/chunks/gone.js"));
    assert.equal(worker.state.skipped, true);
  });
  it("does not claim to be installed when the shell cannot be fetched", async () => {
    await assert.rejects(loadWorker({}).install());
  });
  it("drops earlier shell versions and leaves other caches alone", async () => {
    const worker = loadWorker(shellRoutes(), [
      `${OFFLINE_CACHE_PREFIX}v0`,
      "unrelated-cache",
    ]);
    await worker.install();
    await worker.activate();
    assert.deepEqual(
      [...worker.stores.keys()].sort(),
      [OFFLINE_CACHE, "unrelated-cache"],
    );
    assert.equal(worker.state.claimed, true);
  });
});

describe("shell worker fetch", () => {
  const ready = async (marker = "v1") => {
    const worker = loadWorker(shellRoutes(marker));
    await worker.install();
    await worker.activate();
    return worker;
  };
  it("opens a saved trip from the shell when the network is gone", async () => {
    const worker = await ready();
    worker.state.offline = true;
    const result = await worker.handle(
      request("/trips/trip-1", { mode: "navigate" }),
    );
    assert.equal(result.handled, true);
    assert.equal(await result.response!.text(), SHELL_HTML("v1"));
  });
  it("hydrates that view from the cache with no network at all", async () => {
    const worker = await ready();
    worker.state.offline = true;
    const asset = await worker.handle(request("/_next/static/chunks/main.js"));
    assert.equal(asset.handled, true);
    assert.equal(await asset.response!.text(), 'console.log("v1")');
  });
  it("refreshes a cached asset instead of trusting it forever", async () => {
    const worker = await ready();
    worker.routes["/_next/static/chunks/main.js"] = 'console.log("v2")';
    const first = await worker.handle(request("/_next/static/chunks/main.js"));
    assert.equal(await first.response!.text(), 'console.log("v1")');
    const second = await worker.handle(request("/_next/static/chunks/main.js"));
    assert.equal(await second.response!.text(), 'console.log("v2")');
  });
  it("keeps the offline document current whenever it loads online", async () => {
    const worker = await ready();
    worker.routes[OFFLINE_FALLBACK_PATH] = SHELL_HTML("v2");
    const online = await worker.handle(
      request(OFFLINE_FALLBACK_PATH, { mode: "navigate" }),
    );
    assert.equal(await online.response!.text(), SHELL_HTML("v2"));
    worker.state.offline = true;
    const offline = await worker.handle(
      request("/trips/trip-1", { mode: "navigate" }),
    );
    assert.equal(await offline.response!.text(), SHELL_HTML("v2"));
  });
  it("says so plainly when nothing was cached before going offline", async () => {
    const worker = loadWorker(shellRoutes());
    worker.state.offline = true;
    const result = await worker.handle(
      request("/trips/trip-1", { mode: "navigate" }),
    );
    assert.equal(result.response!.status, 503);
    assert.match(await result.response!.text(), /离线/);
  });
  it("never answers an api call, a write or another origin", async () => {
    const worker = await ready();
    const cache = worker.stores.get(OFFLINE_CACHE)!;
    // Even a planted api response is not reachable: the worker does not look.
    await cache.put(
      request("/api/shares"),
      new Response("stale share", { status: 201 }),
    );
    worker.state.offline = true;
    for (const target of [
      request("/api/shares", { method: "POST" }),
      request("/api/shares"),
      request("/api/planning-jobs/job-1"),
      request("/api/trips/trip-1/export.pdf", { method: "POST" }),
      request("/trips/trip-1", { method: "POST", mode: "navigate" }),
      request("/_next/static/chunks/main.js", { origin: "https://cdn.example" }),
    ]) {
      const result = await worker.handle(target);
      assert.equal(result.handled, false, `${target.method} ${target.url}`);
    }
  });
});

describe("the shipped worker and the policy module agree", () => {
  it("uses one cache name, one shell path and one asset prefix", () => {
    assert.equal(OFFLINE_CACHE, `${OFFLINE_CACHE_PREFIX}v1`);
    assert.match(
      workerSource,
      new RegExp(`CACHE_PREFIX = "${OFFLINE_CACHE_PREFIX}"`),
    );
    assert.match(workerSource, /CACHE = CACHE_PREFIX \+ "v1"/);
    assert.match(
      workerSource,
      new RegExp(`FALLBACK = "${OFFLINE_FALLBACK_PATH}"`),
    );
    assert.match(
      workerSource,
      new RegExp(`IMMUTABLE_ASSET_PREFIX = "${IMMUTABLE_ASSET_PREFIX}"`),
    );
  });
});

describe("what the page does when the browser is offline", () => {
  const transfer = read("src/components/trip-transfer.tsx");
  const workspace = read("src/components/trip-workspace.tsx");
  const shell = read("src/components/offline-shell.tsx");
  const view = read("src/components/offline-trip.tsx");
  const hook = read("src/components/use-offline-now.ts");
  it("treats a dead fetch and a dropped interface as the same answer", () => {
    // The framework only notices offline once one of its fetches fails, so the
    // interface flag is read as well; it is trusted only when it says "down".
    assert.match(hook, /import \{ useOffline \} from "next\/offline"/);
    assert.match(hook, /return reportedByFramework \|\| disconnected/);
    assert.match(hook, /setDisconnected\(!navigator\.onLine\)/);
    for (const event of ['addEventListener("online"', 'addEventListener("offline"'])
      assert.ok(hook.includes(event), `${event} is never subscribed`);
    assert.equal(hook.split("removeEventListener").length - 1, 2);
    // Every consumer reads the combined signal, not one half of it.
    for (const [name, source] of [
      ["trip-transfer", transfer],
      ["trip-workspace", workspace],
      ["offline-shell", shell],
    ] as const) {
      assert.match(source, /const offline = useOfflineNow\(\)/, name);
      assert.doesNotMatch(source, /from "next\/offline"/, name);
    }
  });
  it("blocks sharing, export, delete and link checks with a reason", () => {
    assert.match(
      transfer,
      /disabled: true, "aria-describedby": "offline-transfer-reason"/,
    );
    // 预览分享字段, 导出 PDF, 导出 ICS, 确认创建只读分享, 立即删除分享.
    assert.equal(transfer.split("{...blocked}").length - 1, 5);
    assert.match(transfer, /离线无法打开与核验/);
  });
  it("refuses a major change and the replan itself", () => {
    assert.match(workspace, /onMessage\(OFFLINE_MAJOR_CHANGE_NOTICE\)/);
    assert.match(workspace, /disabled=\{!instruction \|\| busy \|\| offline\}/);
    assert.match(
      workspace,
      /disabled=\{busy \|\| !!preview\.lockConflicts\.length \|\| offline\}/,
    );
    // The reason is written once and pointed at by both blocked controls.
    assert.equal(workspace.split("offline-editor-reason").length - 1, 3);
  });
  it("keeps local notes and locks working", () => {
    // The only network branch inside propose() is the major-change preview, so
    // note, activity, lock and undo edits still reach browser storage offline.
    assert.equal(workspace.split("if (offline)").length - 1, 1);
    assert.match(workspace, /store\(\)\.commitEdit/);
  });
  it("installs the worker only for a build that wants it", () => {
    assert.match(shell, /if \(enabled\) \{/);
    assert.match(shell, /serviceWorker\.register\(SERVICE_WORKER_PATH/);
    assert.match(shell, /registration\.unregister\(\)/);
    assert.match(shell, /startsWith\(OFFLINE_CACHE_PREFIX\)/);
    assert.match(shell, /caches\.delete\(name\)/);
  });
  it("shows how old the local copy is, and what cannot be done", () => {
    assert.match(view, /offlineCopyNotice\(state\.trip\.updatedAt\)/);
    assert.match(view, /OFFLINE_DISABLED_ACTIONS\.map/);
    assert.match(view, /aria-describedby="offline-disabled-reason"/);
    assert.match(view, /id="offline-disabled-reason"/);
    assert.match(view, /role="alert">\{OFFLINE_NO_DATA_DETAIL\}/);
    assert.match(view, /OFFLINE_FEATURE_OFF_NOTICE/);
    // Nothing on this page may reach the network.
    assert.doesNotMatch(view, /fetch\(/);
  });
});

/**
 * The browser journey needs a real browser, so what can be checked without one
 * is that it walks the required states and quotes the shipped wording rather
 * than a copy that has since drifted.
 */
describe("the offline journey handed to a browser", () => {
  const journey = read("tests/e2e/offline.test.mjs");
  const quotes = (text: string, why: string) =>
    assert.ok(journey.includes(text), `${why} 缺少「${text}」`);
  it("walks both data states, with the flag on and with it off", () => {
    quotes('FEATURE_OFFLINE_READONLY: "true"', "开启构建");
    quotes("Network.emulateNetworkConditions", "断网");
    quotes("localStorage.clear()", "无本地数据");
    quotes("Page.reload", "断网冷启动");
    quotes(OFFLINE_CACHE_PREFIX, "外壳缓存清理");
    // The cut is walked in its own browser profile, not asserted from source.
    assert.match(journey, /关闭 FEATURE_OFFLINE_READONLY/);
  });
  it("quotes the wording that ships, not a copy of it", () => {
    quotes(OFFLINE_NO_DATA_TITLE, "无本地数据错误");
    for (const action of OFFLINE_DISABLED_ACTIONS) quotes(action, "停用动作");
    for (const fragment of [
      "离线只读副本",
      "最后更新",
      OFFLINE_FEATURE_OFF_NOTICE.split("：")[0],
      "恢复网络后重新打开链接",
      "需要网络",
    ])
      quotes(fragment, "文案");
    // Each fragment above is really part of what the app renders.
    assert.match(offlineCopyNotice("2026-09-06T14:03:00+08:00"), /离线只读副本/);
    assert.match(OFFLINE_DISABLED_NOTICE, /需要网络/);
    assert.match(OFFLINE_NO_DATA_DETAIL, /恢复网络后重新打开链接/);
  });
});
