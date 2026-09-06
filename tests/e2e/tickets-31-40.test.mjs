import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserHarness, waitFor } from "./helpers/browser.mjs";

test("fixed demo, local edits, disclosure and read-only share work end to end", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "travel-agent-31-40-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const browser = await browserHarness(t, {
    env: {
      FEATURE_SHARING: "true",
      FEATURE_EXPORT: "true",
      FEATURE_CUSTOM_GENERATION: "true",
      SQLITE_PATH: join(data, "app.sqlite"),
    },
  });

  await browser.goto("/demo");
  assert.ok(await browser.contains("北京四日固定模拟案例"));
  assert.ok(await browser.contains("人工出行核验待完成"));
  assert.ok(await browser.contains("deepseek-v4-pro"));
  assert.ok(await browser.contains("已检查：仍有需复核事项"));
  assert.equal(await browser.contains("服务提供方"), false);
  for (const label of [
    "下雨：减少户外活动",
    "未预约成功：取消故宫并留白",
    "临时疲劳：缩短下午散步",
  ])
    assert.ok(await browser.contains(label));

  for (const [label, outcome] of [
    ["下雨：减少户外活动", "预设下雨情境"],
    ["未预约成功：取消故宫并留白", "故宫未预约成功"],
    ["临时疲劳：缩短下午散步", "预设疲劳情境"],
  ]) {
    await browser.click(label);
    await waitFor(() => browser.contains("锁定酒店保持不变"));
    assert.equal(await browser.contains(outcome), false);
    await browser.click("应用预设情境");
    await waitFor(() => browser.contains(outcome));
    await browser.click("恢复公共案例基线");
    await waitFor(async () => !(await browser.contains(outcome)));
  }

  await browser.click("创建个人副本");
  await waitFor(() =>
    browser.evaluate("location.pathname.startsWith('/trips/')"),
  );
  const tripPath = await browser.evaluate("location.pathname");
  await browser.click("编辑、锁定或局部调整行程");
  await waitFor(() => browser.contains("编辑行程 · 版本 1"));
  const storageKey = `travel-agent:trip:${tripPath.split("/").at(-1)}`;
  const baselineEnvelope = await browser.evaluate(
    `localStorage.getItem(${JSON.stringify(storageKey)})`,
  );
  await browser.evaluate(
    `(()=>{const key=${JSON.stringify(storageKey)};const envelope=JSON.parse(localStorage.getItem(key));const trip=envelope.value;trip.lifecycleStatus='blocked';trip.budget.withinLimit=false;trip.budget.items.push({id:'unknown-meals',category:'meals',title:'餐饮待确认',cost:{kind:'unknown',currency:'CNY',reason:'没有可靠报价'},paymentStatus:'unknown',evidenceIds:[]});trip.alerts.push({id:'blocking-reservation',severity:'blocking',code:'RESERVATION_REQUIRED',message:'必须先确认预约',entityIds:[trip.days[0].activities[0].id]});trip.claims[0].status='failed';trip.claims[0].conflictEvidenceIds=[trip.evidence[1].id];localStorage.setItem(key,JSON.stringify(envelope));})()`,
  );
  await browser.cdp("Page.reload");
  await waitFor(() => browser.contains("出发前建议确认"));
  assert.ok(await browser.contains("必须先确认预约"));
  await browser.evaluate(
    `[...document.querySelectorAll('summary')].find(e=>e.textContent.includes('查看来源和技术核验记录')).click()`,
  );
  assert.ok(await browser.contains("查询失败"));
  assert.ok(await browser.contains("来源冲突"));
  assert.ok(await browser.contains("当前估算超过预算上限"));
  await browser.evaluate(
    `[...document.querySelectorAll('summary')].find(e=>e.textContent.includes('查看预算明细')).click()`,
  );
  assert.ok(await browser.contains("费用未知（非零）"));
  await browser.evaluate(
    `localStorage.setItem(${JSON.stringify(storageKey)},${JSON.stringify(baselineEnvelope)})`,
  );
  await browser.cdp("Page.reload");
  await waitFor(() => browser.contains("行程概览"));
  await browser.click("编辑、锁定或局部调整行程");
  await waitFor(() => browser.contains("编辑行程 · 版本 1"));
  await browser.fill("私人备注", "PRIVATE-E2E-NOTE");
  await browser.click("保存备注");
  await waitFor(() => browser.contains("编辑行程 · 版本 2"));
  assert.ok(await browser.contains("PRIVATE-E2E-NOTE"));

  await browser.click("创建只读分享");
  await browser.click("预览分享字段");
  await waitFor(() => browser.contains("分享前预览"));
  const previewText = await browser.evaluate(
    "document.querySelector('[aria-label=\"分享预览\"]')?.innerText ?? ''",
  );
  assert.equal(previewText.includes("PRIVATE-E2E-NOTE"), false);
  assert.equal(previewText.includes("分类预算"), false);
  await browser.click("确认创建只读分享");
  await waitFor(() => browser.contains("打开只读分享"), 60_000);
  const sharePath = await browser.evaluate(
    "document.querySelector('a[href^=\"/share/\"]').getAttribute('href')",
  );
  const deleteToken = await browser.evaluate(
    "[...document.querySelectorAll('input[readonly]')].at(-1).value",
  );
  assert.match(sharePath, /^\/share\/[a-f0-9]{64}$/);
  assert.match(deleteToken, /^[a-f0-9]{64}$/);

  await browser.goto(sharePath);
  await waitFor(() => browser.contains("只读分享"));
  assert.equal(await browser.contains("PRIVATE-E2E-NOTE"), false);
  assert.equal(await browser.contains("分类预算"), false);
  const robots = await browser.evaluate(
    "document.querySelector('meta[name=robots]')?.content ?? ''",
  );
  assert.match(robots, /noindex/i);
  assert.equal(
    await browser.evaluate(
      `fetch('/api/shares/${deleteToken}',{method:'DELETE'}).then(r=>r.status)`,
    ),
    204,
  );
  await browser.goto(sharePath);
  await waitFor(async () => !(await browser.contains("只读分享")));

  await browser.goto(tripPath);
  await waitFor(() => browser.contains("行程概览"));
  await browser.click("编辑、锁定或局部调整行程");
  await waitFor(() => browser.contains("编辑行程 · 版本 2"));
  assert.ok(await browser.contains("PRIVATE-E2E-NOTE"));
  await browser.click("撤销最近修改");
  await waitFor(() => browser.contains("编辑行程 · 版本 3"));
  assert.equal(await browser.contains("PRIVATE-E2E-NOTE"), false);
  await browser.fill("活动开始", "2026-10-06T12:00");
  await browser.fill("活动结束", "2026-10-06T10:00");
  await browser.click("保存活动时间");
  await waitFor(() => browser.contains("修改未保存"));
  assert.ok(await browser.contains("编辑行程 · 版本 3"));
  await browser.click("锁定 抵达北京与酒店休息");
  await waitFor(() => browser.contains("编辑行程 · 版本 4"));
  assert.ok(await browser.contains("解锁 抵达北京与酒店休息"));

  await browser.fill("编辑日期", "2026-10-07");
  await browser.click("移到所选日期并预览");
  await waitFor(() => browser.contains("重大修改尚未应用"));
  assert.ok(await browser.contains("锁定冲突：demo-a-0-0"));
  assert.equal(
    await browser.evaluate(
      "[...document.querySelectorAll('button')].find(b=>b.textContent==='确认并局部重规划').disabled",
    ),
    true,
  );
  await browser.click("取消修改");

  await browser.fill("新预算上限", "9000");
  await browser.click("预览预算变化");
  await waitFor(() => browser.contains("重大修改尚未应用"));
  assert.ok(await browser.contains("受影响日期"));
  await browser.click("取消修改");
  assert.ok(await browser.contains("编辑行程 · 版本 4"));

  await browser.goto("/about");
  assert.ok(await browser.contains("服务提供方：DeepSeek"));
  assert.ok(await browser.contains("模型备案信息：待核实"));

  await browser.goto(tripPath);
  await waitFor(() => browser.contains("行程概览"));
  await browser.click("编辑、锁定或局部调整行程");
  await waitFor(() => browser.contains("编辑行程 · 版本 4"));
  await browser.fill("新预算上限", "8500");
  await browser.click("预览预算变化");
  await waitFor(() => browser.contains("重大修改尚未应用"));
  await browser.click("确认并局部重规划");
  await waitFor(() =>
    browser.evaluate("location.pathname.startsWith('/planning/')"),
  );
  await waitFor(() => browser.contains("重新提供 DeepSeek Key"), 60_000);
});
