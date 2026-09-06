import assert from "node:assert/strict";
import test from "node:test";
import { browserHarness, waitFor } from "./helpers/browser.mjs";
import { executableTrip } from "../fixtures/executable-trip.ts";

test("home, planning, credentials, progress fallback and mobile timeline work in Chrome", async (t) => {
  const browser = await browserHarness(t);
  const trip = executableTrip();
  // Production trip ids contain a colon. Next 16 preserves its percent-encoded
  // form in params, so this guards the browser-store route boundary.
  trip.id = "trip:fixture-colon-id";
  trip.days[0].legs.push({
    id: "arrival",
    fromPlaceId: "station",
    toPlaceId: trip.days[0].activities[0].place.id,
    mode: "train",
    departureWindow: {
      start: "2026-10-01T07:00:00+08:00",
      end: "2026-10-01T08:00:00+08:00",
      flexibilityMinutes: 0,
    },
    durationMinutes: { min: 45, max: 60 },
    bufferMinutes: 20,
    locked: true,
    cost: { kind: "unknown", currency: "CNY", reason: "待确认" },
    evidenceIds: [],
  });
  trip.days[0].activities.push({
    ...trip.days[0].activities[0],
    id: "optional",
    title: "附近散步",
    importance: "optional",
    locked: true,
    timeWindow: {
      start: "2026-10-01T14:00:00+08:00",
      end: "2026-10-01T15:00:00+08:00",
      flexibilityMinutes: 15,
    },
    cost: { kind: "unknown", currency: "CNY", reason: "待确认" },
  });
  const mock = `(()=>{const original=window.fetch;let status='completed';window.__setStatus=s=>status=s;const trip=${JSON.stringify(trip)};const view=()=>({id:'fixture-job',status,message:status==='completed'?'行程整理完成':status==='cancelled'?'任务已取消':status==='waiting_for_credentials'?'请重新提供 DeepSeek Key 继续':'正在计算路线',sequence:2,usage:{steps:7,searchCalls:0,repairRounds:0,outputTokens:10,visitorModelCostCny:.01,productCostCny:0},trip:status==='completed'?trip:undefined,issues:[],choices:[],model:'deepseek-v4-pro'});window.fetch=async(url,init)=>{const path=String(url);if(path.includes('/api/keys/deepseek/validate')){const key=JSON.parse(init.body).apiKey;if(key.includes('project-rate'))return Response.json({code:'RATE_LIMITED'},{status:429});if(key.includes('upstream-rate'))return Response.json({ok:false,code:'rate_limited',retryable:true},{status:429});if(key.includes('bad'))return Response.json({ok:false,code:'invalid_key',retryable:false},{status:401});return Response.json({ok:true,model:'deepseek-v4-pro'});}if(path==='/api/planning-jobs')return Response.json({id:'fixture-job'},{status:202});if(path.includes('/api/planning-jobs/fixture-job')){if(path.endsWith('/events'))return new Response('',{status:503});if(path.endsWith('/cancel'))status='cancelled';if(path.endsWith('/resume'))status='completed';return Response.json(view());}return original(url,init);};})();`;
  await browser.cdp("Page.addScriptToEvaluateOnNewDocument", { source: mock });
  await browser.goto("/");
  assert.ok(await browser.contains("不代订"));
  assert.ok(await browser.contains("BYOK"));
  assert.equal(
    await browser.evaluate(
      `document.querySelector('a[href="/demo"]').getAttribute('href')`,
    ),
    "/demo",
  );
  await browser.goto("/plan");
  await waitFor(() => browser.contains("下一步需要确认"));
  await browser.fill("旅行描述", "sk-sensitive-0123456789abcdef");
  await browser.click("整理到简报");
  await waitFor(() => browser.contains("请使用专用密钥输入框"));
  async function fillBrief() {
    for (const [label, value] of [
      ["出发城市", "上海"],
      ["目的城市", "北京"],
      ["开始日期", "2026-10-01"],
      ["结束日期", "2026-10-03"],
      ["成人数量", "2"],
      ["预算档位", "balanced"],
    ])
      await browser.fill(label, value);
    await browser.evaluate(
      `document.querySelector('input[type=checkbox]').click()`,
    );
    await waitFor(() => browser.contains("需求完整"));
  }
  await fillBrief();
  assert.equal(
    await browser.evaluate(
      `[...document.querySelectorAll('button')].find(b=>b.textContent==='开始规划').disabled`,
    ),
    true,
  );
  await browser.fill("DeepSeek Key", "sk-bad-0123456789abcdef");
  await browser.click("验证 Key");
  await waitFor(() => browser.contains("Key 无效"));
  await browser.fill("DeepSeek Key", "sk-upstream-rate-0123456789");
  await browser.click("验证 Key");
  await waitFor(() => browser.contains("DeepSeek 当前限流"));
  await browser.fill("DeepSeek Key", "sk-project-rate-0123456789");
  await browser.click("验证 Key");
  await waitFor(() => browser.contains("本项目的 Key 验证次数已达上限"));
  await browser.fill("DeepSeek Key", "sk-good-0123456789abcdef");
  await browser.click("验证 Key");
  await waitFor(() => browser.contains("已连接"));
  await browser.click("清除 Key");
  assert.equal(
    await browser.evaluate(
      `document.querySelector('input[type=password]').value`,
    ),
    "",
  );
  assert.equal(
    await browser.evaluate(
      `JSON.stringify(sessionStorage).includes('sk-good')`,
    ),
    false,
  );
  await browser.evaluate(
    `(()=>{const previous=window.fetch;window.fetch=(url,init)=>String(url).includes('/api/keys/deepseek/validate')?new Promise(resolve=>{window.__finishValidation=()=>{window.fetch=previous;resolve(Response.json({ok:true,model:'deepseek-v4-pro'}));};}):previous(url,init);})()`,
  );
  await browser.fill("DeepSeek Key", "sk-delayed-0123456789abcdef");
  await browser.click("验证 Key");
  await waitFor(() =>
    browser.evaluate("typeof window.__finishValidation==='function'"),
  );
  await browser.click("清除 Key");
  await browser.evaluate("window.__finishValidation()");
  await waitFor(() => browser.contains("未连接"));
  assert.equal(
    await browser.evaluate(
      `[...document.querySelectorAll('button')].find(b=>b.textContent==='开始规划').disabled`,
    ),
    true,
  );
  await browser.fill("DeepSeek Key", "sk-good-0123456789abcdef");
  await browser.click("验证 Key");
  await waitFor(() => browser.contains("已连接"));
  const origin = await browser.evaluate("performance.timeOrigin");
  await browser.cdp("Page.reload");
  await waitFor(() =>
    browser.evaluate(
      `performance.timeOrigin!==${origin}&&document.readyState==='complete'`,
    ),
  );
  await waitFor(() => browser.contains("旅行简报"));
  assert.equal(
    await browser.evaluate(
      `document.querySelector('input[type=password]').value`,
    ),
    "sk-good-0123456789abcdef",
  );
  assert.ok(await browser.contains("已连接"));
  await fillBrief();
  await browser.click("开始规划");
  await waitFor(() => browser.contains("查看行程时间线"));
  assert.equal(
    await browser.evaluate(`JSON.stringify(localStorage).includes('sk-good')`),
    false,
  );
  assert.equal(
    await browser.evaluate(
      `JSON.stringify(sessionStorage).includes('sk-good')`,
    ),
    true,
  );
  await browser.click("查看行程时间线");
  await waitFor(() => browser.contains("北京旅行计划"));
  assert.ok(await browser.contains("费用待确认"));
  assert.ok(await browser.contains("已锁定"));
  const text = await browser.evaluate(
    "document.querySelector('[aria-label=\"行程时间线\"]').innerText",
  );
  assert.ok(text.indexOf("活动1") < text.indexOf("附近散步"));
  assert.ok(text.indexOf("火车") < text.indexOf("活动1"));
  assert.ok(text.includes("缓冲 20 分钟"));
  assert.ok(text.includes("活动3"));
  await browser.cdp("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  assert.ok(await browser.contains("活动3"));
  assert.equal(
    await browser.evaluate(
      "document.documentElement.scrollWidth<=window.innerWidth",
    ),
    true,
  );
  await browser.cdp("Page.addScriptToEvaluateOnNewDocument", {
    source: "window.__setStatus('waiting_for_credentials')",
  });
  await browser.goto("/planning/fixture-job");
  await waitFor(() => browser.contains("重新提供 DeepSeek Key"));
  assert.equal(
    await browser.evaluate(
      `document.querySelector('[aria-label="恢复 Key"]').value`,
    ),
    "sk-good-0123456789abcdef",
  );
  await browser.click("继续规划");
  await waitFor(() => browser.contains("查看行程时间线"));
  await browser.cdp("Page.addScriptToEvaluateOnNewDocument", {
    source: "window.__setStatus('running')",
  });
  await browser.goto("/planning/fixture-job");
  await waitFor(() => browser.contains("取消任务"));
  await browser.click("取消任务");
  await waitFor(() => browser.contains("任务已取消"));
  // A resumed stream can replay an old waiting state before its current result.
  await browser.cdp("Page.addScriptToEvaluateOnNewDocument", {
    source: `(()=>{const previous=window.fetch;window.fetch=async(url,init)=>{if(String(url).endsWith('/events')){const response=await previous('/api/planning-jobs/fixture-job');const base=await response.json();const events=[{...base,status:'waiting_for_credentials',sequence:1},{...base,status:'running',message:'恢复后正在计算',sequence:2},{...base,status:'completed',message:'SSE 已完成',sequence:3,trip:${JSON.stringify(trip)},reasoning:'PRIVATE_REASONING_SENTINEL'}];return new Response(events.map(v=>'id: '+v.sequence+'\\ndata: '+JSON.stringify(v)+'\\n\\n').join(''),{headers:{'Content-Type':'text/event-stream'}});}return previous(url,init);};})()`,
  });
  await browser.goto("/planning/fixture-job");
  await waitFor(() => browser.contains("SSE 已完成"));
  assert.ok(await browser.contains("查看行程时间线"));
  assert.equal(await browser.contains("PRIVATE_REASONING_SENTINEL"), false);
  await browser.cdp("Page.addScriptToEvaluateOnNewDocument", {
    source: `(()=>{const previous=window.fetch;window.fetch=async(url,init)=>{if(String(url).endsWith('/events')){const r=await previous('/api/planning-jobs/fixture-job');const v={...await r.json(),status:'failed',errorCode:'VISITOR_COST_HARD_LIMIT',message:'测试任务失败',sequence:4};return new Response('id: 4\\ndata: '+JSON.stringify(v)+'\\n\\n');}return previous(url,init);};})()`,
  });
  await browser.goto("/planning/fixture-job");
  await waitFor(() => browser.contains("已达到费用或步骤上限"));
  assert.ok(await browser.contains("返回重新规划"));
});
