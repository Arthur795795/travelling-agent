import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserHarness, waitFor } from "./helpers/browser.mjs";

/** Only the delete token is kept locally, under one key per screen. */
const STORAGE_KEY = "travel.feedback.fixed_demo";

/**
 * Records every feedback request the page makes, so an unsubmitted draft or a
 * trip attached to the body would show up in the assertions below.
 */
const SPY = `(()=>{window.__calls=[];window.__bodies=[];const original=window.fetch;window.fetch=(input,init)=>{const url=String(typeof input==='string'?input:input.url??input);if(url.includes('/api/feedback')){window.__calls.push(((init&&init.method)||'GET')+' '+url);if(init&&init.body)window.__bodies.push(String(init.body));}return original(input,init);};})()`;

/** Ticks a reason: the labels are not buttons, so `click` cannot reach them. */
const tickReason = (browser, label) =>
  browser.evaluate(
    `(()=>{const el=[...document.querySelectorAll('label')].find(l=>l.textContent.trim()===${JSON.stringify(label)});if(!el)throw new Error('Missing reason');const box=el.querySelector('input[type=checkbox]');box.click();return box.checked;})()`,
  );

test("feedback is submitted, cancelled and deleted by the visitor", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "travel-agent-41-50-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const browser = await browserHarness(t, {
    env: { SQLITE_PATH: join(data, "app.sqlite") },
  });
  const calls = () => browser.evaluate("window.__calls.join('|')");
  const stored = () =>
    browser.evaluate(`localStorage.getItem(${JSON.stringify(STORAGE_KEY)})`);

  await browser.goto("/demo");
  // The purpose notice is readable before anything can be submitted.
  assert.ok(await browser.contains("这份行程好用吗？"));
  assert.ok(await browser.contains("反馈只用于改进行程规划质量"));
  assert.equal(await browser.contains("补充说明"), false);
  await browser.evaluate(SPY);

  // The panel only reacts once hydrated, so the first press is retried.
  await waitFor(async () => {
    await browser.click("不好用");
    return browser.contains("原因（可多选）");
  }, 60_000);
  assert.equal(await tickReason(browser, "时间安排不合理"), true);
  await browser.fill("反馈补充说明", "第二天太赶了");
  // Typing is not submitting: nothing has left the browser yet.
  assert.equal(await calls(), "");

  await browser.click("取消反馈");
  await waitFor(() => browser.contains("已取消，没有发送任何内容。"));
  assert.equal(await calls(), "");
  assert.equal(await stored(), null);
  assert.equal(await browser.contains("补充说明"), false);

  // A comment carrying a phone number is refused, so no token is issued.
  await browser.click("不好用");
  await waitFor(() => browser.contains("原因（可多选）"));
  await browser.fill("反馈补充说明", "有问题请打 13800138000");
  await browser.click("提交反馈");
  await waitFor(() => browser.contains("请移除完整手机号后再发送。"), 60_000);
  assert.equal(await stored(), null);

  await browser.fill("反馈补充说明", "第二天太赶了");
  await browser.click("提交反馈");
  await waitFor(() => browser.contains("已收到你的反馈，谢谢。"), 60_000);
  const token = await stored();
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(await browser.contains("补充说明"), false);

  await browser.click("删除我的反馈");
  await waitFor(() => browser.contains("已删除你的反馈记录。"));
  assert.equal(await stored(), null);
  assert.deepEqual((await calls()).split("|"), [
    "POST /api/feedback",
    "POST /api/feedback",
    `DELETE /api/feedback/${token}`,
  ]);

  // Every request carried the rating only: no trip, no chat, no identity.
  const bodies = JSON.parse(
    await browser.evaluate("JSON.stringify(window.__bodies)"),
  );
  assert.equal(bodies.length, 2);
  for (const body of bodies)
    assert.deepEqual(Object.keys(JSON.parse(body)).sort(), [
      "comment",
      "confirmed",
      "context",
      "rating",
      "reasons",
    ]);
  assert.doesNotMatch(bodies.join("|"), /北京|故宫/);

  // The record is really gone, so repeating the same deletion reports 404.
  assert.equal(
    await browser.evaluate(
      `fetch('/api/feedback/'+${JSON.stringify(token)},{method:'DELETE'}).then(r=>r.status)`,
    ),
    404,
  );
});
