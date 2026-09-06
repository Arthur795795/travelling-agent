import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserHarness, waitFor } from "./helpers/browser.mjs";
import {
  BROWSER_MATRIX,
  automatedEnvNames,
  availableBrowsers,
  manualBrowsers,
} from "./helpers/browsers.mjs";

/** Sharing and export are flagged off by default; this journey needs both. */
const FEATURES = { FEATURE_SHARING: "true", FEATURE_EXPORT: "true" };

/** Widths that decide the layout: two desktop columns, one mobile column. */
const VIEWPORTS = [
  { label: "desktop", width: 1280, height: 900, columns: 2 },
  { label: "tablet", width: 834, height: 1112, columns: 2 },
  { label: "mobile", width: 390, height: 844, mobile: true, columns: 1 },
];

/**
 * Every visible control, judged as a pointer target and as something a finger
 * can actually reach. The skip link is excluded because it parks itself
 * off-screen until focused; the keyboard journey asserts its focused position.
 *
 * Links inside running text keep the SC 2.5.8 inline exception, so only the
 * remaining controls are measured for size. Everything is measured for
 * horizontal overflow and for being hit-testable instead of covered.
 */
const REACH = `(()=>{
const problems=[];
for(const el of document.querySelectorAll('a[href],button,input,select,textarea,summary,[tabindex="0"]')){
  if(el.classList.contains('skip-link'))continue;
  if(el.closest('details:not([open])'))continue;
  const initial=el.getBoundingClientRect();
  if(!initial.width&&!initial.height)continue;
  if(getComputedStyle(el).visibility==='hidden')continue;
  el.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
  // Inline links can wrap across lines. Their union rectangle may have an
  // empty centre even though every rendered fragment is reachable, so test a
  // concrete rendered fragment instead of that union's centre.
  const box=el.getBoundingClientRect();
  const hitBox=[...el.getClientRects()].find(r=>r.width&&r.height)||box;
  const name=((el.getAttribute('aria-label')||el.textContent||'').trim()||el.tagName).slice(0,24);
  if(box.left<-0.5||box.right>window.innerWidth+0.5){problems.push('横向溢出：'+name);continue;}
  if(el.tagName!=='A'&&(box.width<23.5||box.height<23.5))
    problems.push('触控目标过小：'+name+' '+Math.round(box.width)+'x'+Math.round(box.height));
  const hit=document.elementFromPoint((hitBox.left+hitBox.right)/2,(hitBox.top+hitBox.bottom)/2);
  if(!hit||!(hit===el||el.contains(hit)||hit.contains(el)))problems.push('被遮挡：'+name);
}
return problems;})()`;

/** Guards that every id an error points at really exists in the document. */
function assertDescribes(field, { id, text }) {
  assert.equal(field.invalid, "true", `${field.name} 未标记 aria-invalid`);
  assert.ok(
    id(field.describedBy),
    `${field.name} 的 aria-describedby 缺少说明：${field.describedBy.join(" ")}`,
  );
  assert.doesNotMatch(field.description, /MISSING:/);
  assert.match(field.description, text);
}
const requirementIssue = (ids) =>
  ids.some((id) => id.startsWith("requirement-issue-"));

test("browser matrix names the current and previous major of every engine", () => {
  const channels = new Map();
  for (const entry of BROWSER_MATRIX) {
    assert.ok(entry.name && entry.engine, `矩阵条目缺少名称或引擎`);
    channels.set(
      entry.engine,
      new Set([...(channels.get(entry.engine) ?? []), entry.channel]),
    );
  }
  assert.deepEqual([...channels.keys()].sort(), ["chromium", "gecko", "webkit"]);
  for (const [engine, seen] of channels)
    assert.deepEqual(
      [...seen].sort(),
      ["current", "previous"],
      `${engine} 缺少当前或前一个主要版本`,
    );
  // This harness speaks CDP only, so Gecko and WebKit stay a manual pass.
  assert.deepEqual(
    [...new Set(manualBrowsers().map((entry) => entry.engine))].sort(),
    ["gecko", "webkit"],
  );
  for (const entry of availableBrowsers())
    assert.equal(entry.engine, "chromium", `${entry.name} 无法用 CDP 驱动`);
});

test("keyboard, error wiring and viewports hold across the matrix", async (t) => {
  const targets = availableBrowsers();
  if (!targets.length) {
    t.skip(
      `矩阵中没有已安装的可自动化浏览器；设置 ${automatedEnvNames().join(" / ")} 后重新运行`,
    );
    return;
  }
  for (const target of targets)
    await t.test(target.name, async (sub) => {
      const data = await mkdtemp(join(tmpdir(), "travel-agent-a11y-"));
      sub.after(() => rm(data, { recursive: true, force: true }));
      const browser = await browserHarness(sub, {
        browser: target,
        env: { SQLITE_PATH: join(data, "app.sqlite"), ...FEATURES },
      });
      await browser.viewport(VIEWPORTS[0]);
      await planByKeyboard(browser);
      await reducedMotion(browser);
      await viewportSweep(browser, await tripByKeyboard(browser));
    });
});

/** 输入：从跳转链接一路键盘走到"需求完整"，并核对错误与字段的关联。 */
async function planByKeyboard(browser) {
  await browser.goto("/plan");
  await waitFor(() => browser.contains("下一步需要确认"), 60_000);
  await browser.press("Tab");
  const skip = await browser.focused();
  assert.equal(skip.name, "跳到主要内容");
  // Focused, the link is on screen and carries the shared 3px ring.
  assert.equal(
    await browser.evaluate(
      `(()=>{const el=document.activeElement;const s=getComputedStyle(el);const r=el.getBoundingClientRect();return [r.left>=0&&r.top>=0&&r.width>0,s.outlineStyle,s.outlineWidth].join(' ');})()`,
    ),
    "true solid 3px",
  );
  await browser.press("Enter");
  await waitFor(() =>
    browser.evaluate(
      "document.activeElement===document.getElementById('main-content')",
    ),
  );
  // A blocking requirement is written once in the aside and pointed at here.
  assertDescribes(await browser.tabUntil("目的城市", { limit: 60 }), {
    id: requirementIssue,
    text: /目的地尚未确定/,
  });
  // Typing and pressing are retried as a pair: before hydration neither has an
  // effect, and a half-hydrated attempt only clears the field again.
  await waitFor(async () => {
    await browser.tabUntil("旅行描述", { shift: true, limit: 20 });
    await browser.typeText("sk-sensitive-0123456789abcdef");
    await browser.tabUntil("整理到简报", { limit: 20 });
    await browser.press("Space");
    return browser.contains("请使用专用密钥输入框");
  }, 60_000);
  assertDescribes(
    await browser.tabUntil("旅行描述", { shift: true, limit: 20 }),
    { id: (ids) => ids.includes("field-error-text"), text: /专用密钥输入框/ },
  );
  await browser.typeText(
    "从上海去北京，2026-10-01 到 2026-10-04，2人，喜欢历史文化。",
  );
  await browser.tabUntil("整理到简报", { limit: 20 });
  await browser.press("Enter");
  await waitFor(() =>
    browser.evaluate(
      `document.querySelector('[aria-label="目的城市"]').value==='北京'`,
    ),
  );
  const budget = await browser.tabUntil("预算档位", { limit: 60 });
  assert.ok(requirementIssue(budget.describedBy), "预算档位未指向待确认需求");
  // A native select's own value editing belongs to the browser widget, so only
  // its place in the focus order is asserted; the value is set directly rather
  // than relying on whether headless arrow keys open a native menu.
  await browser.fill("预算档位", "balanced");
  const confirmed = await browser.tabUntil(
    "已核对预订、偏好和硬约束；空白表示无",
    { limit: 80 },
  );
  assert.equal(confirmed.type, "checkbox");
  await browser.press("Space");
  await waitFor(() => browser.contains("需求完整，可以开始规划。"), 60_000);
}

/** 查看、锁定、分享、导出：都在个人副本上用键盘完成，返回该行程的路径。 */
async function tripByKeyboard(browser) {
  await browser.goto("/demo");
  await waitFor(() => browser.contains("北京四日预设案例"), 60_000);
  // A CDP navigation can retain a stale focus owner while the new document is
  // settling. Re-enter through the real skip link so the keyboard route has a
  // deterministic, user-visible starting point.
  await browser.press("Tab");
  assert.equal((await browser.focused()).name, "跳到主要内容");
  await browser.press("Enter");
  await waitFor(() =>
    browser.evaluate(
      "document.activeElement===document.getElementById('main-content')",
    ),
  );
  // 创建个人副本 is the keyboard-only bridge from the public case to editing.
  // Wait for React to own the server-rendered button, then activate it exactly
  // once. Retrying the whole action can navigate successfully on the first
  // attempt and then look for this old-page control on the destination page.
  await waitFor(() =>
    browser.evaluate(`(()=>{
      const button=[...document.querySelectorAll('button')]
        .find((item)=>item.textContent.trim()==='创建个人副本');
      return Boolean(button && Object.keys(button).some((key)=>key.startsWith('__reactProps$')));
    })()`),
  60_000);
  await browser.tabUntil("创建个人副本", { limit: 120 });
  await browser.press("Enter");
  await waitFor(
    () => browser.evaluate("location.pathname.startsWith('/trips/')"),
    60_000,
  );
  await waitFor(() => browser.contains("行程概览"), 60_000);
  assert.ok(await browser.contains("北京旅行计划"), "个人副本没有渲染时间线");
  await browser.tabUntil("编辑、锁定或局部调整行程", { limit: 300 });
  await browser.press("Enter");
  const lock = await browser.evaluate(
    `[...document.querySelectorAll('button')].map(b=>b.textContent.trim()).find(t=>t.startsWith('锁定 '))`,
  );
  assert.match(lock ?? "", /^锁定 \S/, "没有可锁定的项目");
  await browser.tabUntil(lock, { limit: 300 });
  await browser.press("Enter");
  // The saved version re-mounts the editor, so the label itself is the proof.
  await waitFor(() => browser.contains(lock.replace("锁定", "解锁")), 60_000);
  await browser.tabUntil("创建只读分享", { limit: 300 });
  await browser.press("Enter");
  await browser.tabUntil("预览分享字段", { limit: 40 });
  await browser.press("Enter");
  await waitFor(() => browser.contains("分享前预览"), 60_000);
  await browser.tabUntil("确认创建只读分享", { limit: 300 });
  await browser.press("Enter");
  await waitFor(() => browser.contains("打开只读分享"), 60_000);
  // ICS needs no external renderer, so the export result stays deterministic.
  await browser.tabUntil("导出 ICS", { limit: 300 });
  await browser.press("Enter");
  await waitFor(() => browser.contains("已导出 ICS"), 60_000);
  return browser.evaluate("location.pathname");
}

/** 系统减少动画：只有在系统没有要求减少动画时才平滑滚动。 */
async function reducedMotion(browser) {
  const scrollBehavior = () =>
    browser.evaluate(
      "getComputedStyle(document.documentElement).scrollBehavior",
    );
  const prefer = (value) =>
    browser.cdp("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value }],
    });
  await prefer("reduce");
  assert.equal(
    await browser.evaluate(
      "matchMedia('(prefers-reduced-motion: reduce)').matches",
    ),
    true,
    "减少动画的媒体查询没有生效",
  );
  assert.equal(await scrollBehavior(), "auto");
  await prefer("no-preference");
  assert.equal(await scrollBehavior(), "smooth");
  await browser.cdp("Emulation.setEmulatedMedia", {});
}

/** 主要视口：列数、无横向溢出、控件够大且没被遮挡，并留下截图证据。 */
async function viewportSweep(browser, tripPath) {
  const pages = [
    { path: "/", label: "home", ready: "不代订", grid: ".cards" },
    {
      path: "/plan",
      label: "plan",
      ready: "下一步需要确认",
      grid: ".workspace",
    },
    { path: "/demo", label: "demo", ready: "北京四日预设案例" },
    { path: tripPath, label: "trip", ready: "分享与导出" },
    { path: "/planning/no-such-job", label: "progress", ready: "任务不存在" },
  ];
  for (const view of VIEWPORTS) {
    await browser.viewport(view);
    for (const page of pages) {
      await browser.goto(page.path);
      await waitFor(() => browser.contains(page.ready), 60_000);
      const where = `${page.label}-${view.label}`;
      assert.equal(
        await browser.evaluate(
          "document.documentElement.scrollWidth<=window.innerWidth",
        ),
        true,
        `${where} 出现横向溢出`,
      );
      if (page.grid)
        assert.equal(
          await browser.evaluate(
            `getComputedStyle(document.querySelector(${JSON.stringify(page.grid)})).gridTemplateColumns.split(' ').length`,
          ),
          view.columns,
          `${where} 的列数与视口不符`,
        );
      assert.deepEqual(await browser.evaluate(REACH), [], where);
      await browser.screenshot(where);
    }
  }
}
