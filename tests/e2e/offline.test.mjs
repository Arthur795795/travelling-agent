import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserHarness, waitFor } from "./helpers/browser.mjs";
import { automatedEnvNames, availableBrowsers } from "./helpers/browsers.mjs";

/**
 * 离线只读查看（Ticket 044）。走的是真实浏览器路径：注册 service worker、用
 * DevTools 断网、刷新，再分别检查有本机行程和没有本机行程两种结果。
 *
 * 断网操作的判定标准只有一个：需要网络的动作必须明确停用并给出原因，读到的副本
 * 必须写明最后更新时间，任何 `/api/` 响应都不能被缓存重放成新事实。
 */
const FEATURES = {
  FEATURE_OFFLINE_READONLY: "true",
  // 分享与导出默认关闭，这条路径要检查它们离线时被停用，所以先打开。
  FEATURE_SHARING: "true",
  FEATURE_EXPORT: "true",
};
/** 只读离线视图上必须出现且必须停用的动作。 */
const OFFLINE_ONLY_VIEW = ["局部重规划", "链接核验", "只读分享", "PDF/ICS 导出"];
/** 行程页上真正会联网的控件，断网后必须同样停用。 */
const LIVE_CONTROLS = [
  "预览分享字段",
  "导出 PDF",
  "导出 ICS",
  "预览局部重规划",
];
/** 一个不存在的任务：联网时应有 HTTP 状态，断网时必须直接失败。 */
const API_PROBE =
  "fetch('/api/planning-jobs/no-such-job').then(r=>'status:'+r.status).catch(e=>'拒绝:'+e.name)";

/** DevTools 断网：navigator.onLine 随之变化并触发 offline 事件。 */
async function connectivity(browser, offline) {
  await browser.cdp("Network.enable", {});
  await browser.cdp("Network.emulateNetworkConditions", {
    offline,
    latency: 0,
    downloadThroughput: offline ? 0 : -1,
    uploadThroughput: offline ? 0 : -1,
    connectionType: offline ? "none" : "wifi",
  });
  await waitFor(() => browser.evaluate(`navigator.onLine===${!offline}`));
}

/** 导航期间旧执行上下文会被销毁，读取失败按"还没出现"处理。 */
const eventually = (browser, text, timeout = 60_000) =>
  waitFor(async () => {
    try {
      return await browser.contains(text);
    } catch {
      return false;
    }
  }, timeout);

/** 每个按钮的状态和它指向的说明文字，缺失的 id 会显式暴露出来。 */
const controls = (browser, labels) =>
  browser.evaluate(
    `(()=>{return ${JSON.stringify(labels)}.map(label=>{` +
      `const el=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===label);` +
      `if(!el)return label+' → 缺失';` +
      `const ids=(el.getAttribute('aria-describedby')??'').split(' ').filter(Boolean);` +
      `const reason=ids.map(i=>{const t=document.getElementById(i);return t?t.textContent.trim():'MISSING:'+i}).join(' | ');` +
      `return label+' → '+(el.disabled?'停用':'可用')+' → '+reason;});})()`,
  );

const skipWithoutBrowser = (t) => {
  const [target] = availableBrowsers();
  if (target) return target;
  t.skip(
    `矩阵中没有已安装的可自动化浏览器；设置 ${automatedEnvNames().join(" / ")} 后重新运行`,
  );
  return null;
};

test("断网后按本机行程只读打开，联网操作明确停用", async (t) => {
  const target = skipWithoutBrowser(t);
  if (!target) return;
  const data = await mkdtemp(join(tmpdir(), "travel-agent-offline-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const browser = await browserHarness(t, {
    browser: target,
    production: true,
    env: { SQLITE_PATH: join(data, "app.sqlite"), ...FEATURES },
  });

  // 联网：外壳装好，并从固定案例存一份本机行程。
  await browser.goto("/demo");
  await eventually(browser, "北京四日预设案例");
  await waitFor(
    () => browser.evaluate("navigator.serviceWorker.controller!==null"),
    60_000,
  );
  await waitFor(async () => {
    try {
      if (await browser.evaluate("location.pathname.startsWith('/trips/')"))
        return true;
      await browser.click("创建个人副本");
      return false;
    } catch {
      // A successful click destroys the old execution context during
      // navigation; the next retry observes the destination path.
      return false;
    }
  }, 60_000);
  await eventually(browser, "行程概览");
  await browser.click("编辑、锁定或局部调整行程");
  await eventually(browser, "编辑行程 · 版本 1");
  const tripPath = await browser.evaluate("location.pathname");
  await browser.fill("局部重规划要求", "第二天想更轻松一点");
  for (const entry of await controls(browser, LIVE_CONTROLS))
    assert.match(entry, /→ 可用/, `联网时不应停用：${entry}`);
  assert.match(await browser.evaluate(API_PROBE), /^status:/);

  // 断网但不刷新：联网控件立即停用并说明原因，本机编辑照旧。
  await connectivity(browser, true);
  await eventually(browser, "已暂时停用", 30_000);
  for (const entry of await controls(browser, LIVE_CONTROLS))
    assert.match(entry, /→ 停用 → .*需要网络/, entry);
  await browser.fill("私人备注", "OFFLINE-E2E-NOTE");
  await browser.click("保存备注");
  await eventually(browser, "编辑行程 · 版本 2", 30_000);
  assert.ok(await browser.contains("OFFLINE-E2E-NOTE"), "离线备注没有写入本机");

  // 断网冷启动：service worker 用离线外壳回答导航，行程来自本机存储。
  // CDP's page-level network emulation does not necessarily stop the worker's
  // own process. Stop the isolated fixture server too, matching a real hard
  // disconnect for both the page and its service worker.
  await browser.stopServer();
  await browser.cdp("Page.reload", { ignoreCache: true });
  try {
    await eventually(browser, "离线只读副本");
  } catch (error) {
    let visible = "浏览器文档不可读";
    try {
      visible = await browser.evaluate(
        "location.pathname+' | '+document.body.innerText.slice(0,240)",
      );
    } catch {
      // Keep the stable fallback when Chrome is showing its own error page.
    }
    throw new Error(`${error.message}: ${visible}`);
  }
  assert.ok(await browser.contains("北京旅行计划"), "离线视图没有渲染本机行程");
  assert.equal(await browser.evaluate("location.pathname"), tripPath);
  const banners = await browser.evaluate(
    "[...document.querySelectorAll('.offline-banner')].map(e=>e.textContent.trim()).join(' | ')",
  );
  assert.match(banners, /最后更新/);
  for (const claim of ["已更新", "最新", "实时"])
    assert.equal(
      banners.includes(claim),
      false,
      `离线提示不能出现「${claim}」：${banners}`,
    );
  for (const entry of await controls(browser, OFFLINE_ONLY_VIEW))
    assert.match(entry, /→ 停用 → .*需要网络/, entry);
  // 缓存里没有、也不会有任何 api 响应可以顶替一次真实请求。
  assert.match(await browser.evaluate(API_PROBE), /^拒绝:/);

  // 没有本机数据：同一个地址给出明确的离线错误，而不是空白或旧内容。
  await browser.evaluate("localStorage.clear()");
  await browser.cdp("Page.reload", { ignoreCache: true });
  await eventually(browser, "离线，且本机没有可读行程");
  assert.ok(await browser.contains("恢复网络后重新打开链接"));
  assert.equal(await browser.contains("离线只读副本"), false);
});

test("关闭 FEATURE_OFFLINE_READONLY 后离线只读整体消失", async (t) => {
  const target = skipWithoutBrowser(t);
  if (!target) return;
  const data = await mkdtemp(join(tmpdir(), "travel-agent-offline-off-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const browser = await browserHarness(t, {
    browser: target,
    production: true,
    env: { SQLITE_PATH: join(data, "app.sqlite") },
  });
  await browser.goto("/offline");
  await eventually(browser, "离线只读未启用");
  assert.equal(
    await browser.evaluate(
      "navigator.serviceWorker.getRegistrations().then(r=>r.length)",
    ),
    0,
    "关闭后仍注册了 service worker",
  );
  assert.equal(
    await browser.evaluate(
      "caches.keys().then(k=>k.filter(n=>n.startsWith('travel-agent-shell-')).join())",
    ),
    "",
    "关闭后仍留下了外壳缓存",
  );
  // 断网刷新也不会出现只读副本：没有缓存可用，失败是可见的。
  await connectivity(browser, true);
  await browser.cdp("Page.reload", { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 2_000));
  let readOnly = false;
  try {
    readOnly = await browser.contains("离线只读副本");
  } catch {
    // 浏览器自己的网络错误页没有可读文档，同样说明没有离线副本。
  }
  assert.equal(readOnly, false, "关闭后断网刷新仍出现了只读副本");
});
