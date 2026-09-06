/**
 * Offline read-only policy, kept free of imports so both a Client Component and
 * the shipped service worker's test can use exactly these values.
 *
 * The rule that matters: nothing that could be mistaken for a fresh fact is
 * ever replayed from a cache. Only the shell document and immutable build
 * assets are cached; every `/api/` call, every non-GET and every cross-origin
 * request stays network-only, so a share, export, replan or evidence check
 * fails visibly offline instead of returning a stale success.
 */
export const OFFLINE_CACHE_PREFIX = "travel-agent-shell-";
export const OFFLINE_CACHE = `${OFFLINE_CACHE_PREFIX}v1`;
export const OFFLINE_FALLBACK_PATH = "/offline";
export const SERVICE_WORKER_PATH = "/sw.js";
/** Build assets are content-hashed, so they may be served from the cache. */
export const IMMUTABLE_ASSET_PREFIX = "/_next/static/";

export type RequestPlan = "network-only" | "shell-fallback" | "cache-first";

export function planRequest(request: {
  method: string;
  path: string;
  sameOrigin: boolean;
  navigation: boolean;
}): RequestPlan {
  if (!request.sameOrigin) return "network-only";
  if (request.method.toUpperCase() !== "GET") return "network-only";
  if (request.path.startsWith("/api/")) return "network-only";
  if (request.navigation) return "shell-fallback";
  if (request.path.startsWith(IMMUTABLE_ASSET_PREFIX)) return "cache-first";
  return "network-only";
}

const beijing = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  dateStyle: "short",
  timeStyle: "short",
  hour12: false,
});

export function lastUpdatedText(updatedAt: string): string {
  const at = new Date(updatedAt);
  return Number.isNaN(at.getTime())
    ? "时间未知"
    : `${beijing.format(at)}（北京时间）`;
}

/** Always names the moment the copy was written, never claims it is current. */
export function offlineCopyNotice(updatedAt: string): string {
  return `离线只读副本 · 最后更新 ${lastUpdatedText(updatedAt)}。离线期间不获取新数据，开放时间、票务与库存可能已变化，恢复网络后请重新核验。`;
}

export const OFFLINE_NO_DATA_TITLE = "离线，且本机没有可读行程";
export const OFFLINE_NO_DATA_DETAIL =
  "当前设备离线，这个浏览器也没有保存过可离线打开的行程。恢复网络后重新打开链接，或改用保存了该行程的浏览器。";
export const OFFLINE_DISABLED_ACTIONS = [
  "局部重规划",
  "链接核验",
  "只读分享",
  "PDF/ICS 导出",
];
export const OFFLINE_DISABLED_NOTICE = `离线：${OFFLINE_DISABLED_ACTIONS.join("、")}需要网络，已暂时停用；备注与锁定仍只写入本机。`;
export const OFFLINE_MAJOR_CHANGE_NOTICE =
  "离线：重大修改需要先在服务端预览，未保存；恢复网络后再试。";
export const OFFLINE_FEATURE_OFF_NOTICE =
  "离线只读未启用：该能力可以从部署中裁剪，当前构建没有开启。";

/**
 * The worker answers a navigation to "/trips/<id>" with the offline document,
 * so the trip to read is taken from the address the browser still shows.
 */
export function tripIdFromPath(path: string): string {
  const match = /^\/trips\/([^/?#]+)/.exec(path);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return "";
  }
}
