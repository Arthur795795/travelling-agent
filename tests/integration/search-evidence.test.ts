import assert from "node:assert/strict";
import test from "node:test";
import type { DeepSeekResponseResult } from "../../src/providers/deepseek/responses-client.ts";
import { SafeFetchError } from "../../src/security/safe-fetch.ts";
import { AgentToolRegistry } from "../../src/agent/tools/registry.ts";
import {
  candidatesFromDeepSeek,
  classifySearchResult,
  OfficialPageEvidenceReader,
  registerSearchEvidenceTools,
} from "../../src/search/source-evidence.ts";

const now = new Date("2026-09-05T10:00:00+08:00");

test("classifies discovered sources without treating search summaries as verified evidence", () => {
  assert.equal(
    classifySearchResult(
      {
        title: "故宫官网",
        url: "https://www.dpm.org.cn/visit.html",
        snippet: "开放信息",
      },
      ["dpm.org.cn"],
    ).sourceType,
    "official",
  );
  assert.equal(
    classifySearchResult({
      title: "中国铁路",
      url: "https://www.12306.cn/index/",
      snippet: "车票",
    }).category,
    "carrier",
  );
  assert.equal(
    classifySearchResult({
      title: "携程",
      url: "https://hotels.ctrip.com/",
      snippet: "酒店",
    }).sourceType,
    "platform",
  );
  assert.equal(
    classifySearchResult({
      title: "游记",
      url: "https://example.com/post",
      snippet: "经验",
    }).status,
    "discovery_only",
  );

  const deepSeek = {
    outputText: "故宫官网介绍",
    citations: [
      {
        url: "https://www.dpm.org.cn/visit.html",
        title: "故宫官网",
        startIndex: 0,
        endIndex: 4,
      },
    ],
  } as DeepSeekResponseResult;
  const candidates = candidatesFromDeepSeek(deepSeek, ["dpm.org.cn"]);
  assert.equal(candidates[0].snippet, "故宫官网");
  assert.equal(candidates[0].status, "discovery_only");
});

test("extracts a positioned excerpt from an accessible official page", async () => {
  const reader = new OfficialPageEvidenceReader(
    async () => ({
      url: "https://www.dpm.org.cn/visit.html",
      status: 200,
      contentType: "text/html",
      body: "<html><script>ignore()</script><body><h1>参观须知</h1><p>故宫博物院周一闭馆，参观需要提前预约。</p></body></html>",
    }),
    () => now,
  );
  const result = await reader.read({
    subjectId: "place-palace",
    field: "openingHours",
    candidate: classifySearchResult(
      {
        title: "故宫官网",
        url: "https://www.dpm.org.cn/visit.html",
        snippet: "",
      },
      ["dpm.org.cn"],
    ),
    queryTerms: ["周一闭馆", "预约"],
  });
  assert.equal(result.status, "success");
  assert.equal(result.evidence.status, "verified");
  assert.match(result.evidence.excerpt ?? "", /周一闭馆/);
  assert.ok(
    (result.position?.textEnd ?? 0) > (result.position?.textStart ?? 0),
  );
  assert.doesNotMatch(result.evidence.excerpt ?? "", /ignore/);
});

test("stops at login, captcha, unavailable facts, and dangerous redirects", async () => {
  const candidate = classifySearchResult(
    { title: "官网", url: "https://official.example/info", snippet: "" },
    ["official.example"],
  );
  for (const [body, expected] of [
    ["请先登录后查看", "login_required"],
    ["请完成人机验证码 captcha", "captcha"],
    ["页面正常但没有目标内容", "fact_not_found"],
  ] as const) {
    const reader = new OfficialPageEvidenceReader(
      async () => ({
        url: candidate.url,
        status: 200,
        contentType: "text/plain",
        body,
      }),
      () => now,
    );
    const result = await reader.read({
      subjectId: "place-1",
      field: "reservation",
      candidate,
      queryTerms: ["预约"],
    });
    assert.equal(result.failureCode, expected);
  }
  const blocked = new OfficialPageEvidenceReader(
    async () => {
      throw new SafeFetchError("BLOCKED_ADDRESS", "redirect target blocked");
    },
    () => now,
  );
  const result = await blocked.read({
    subjectId: "place-1",
    field: "reservation",
    candidate,
    queryTerms: ["预约"],
  });
  assert.equal(result.status, "failed");
  assert.equal(result.failureCode, "unsafe_url");
  assert.equal(result.evidence.status, "failed");
});

test("404 pages and cross-domain redirects cannot inherit official verification", async () => {
  const candidate = classifySearchResult(
    { title: "官网", url: "https://official.example/info", snippet: "" },
    ["official.example"],
  );
  const input = {
    subjectId: "place-1",
    field: "reservation",
    candidate,
    queryTerms: ["预约"],
  };
  const missing = await new OfficialPageEvidenceReader(
    async () => ({
      url: candidate.url,
      status: 404,
      contentType: "text/html",
      body: "预约页面不存在",
    }),
    () => now,
  ).read(input);
  assert.equal(missing.evidence.status, "failed");
  assert.equal(missing.failureCode, "unavailable");
  const redirected = await new OfficialPageEvidenceReader(
    async () => ({
      url: "https://other.example/page",
      status: 200,
      contentType: "text/html",
      body: "预约建议",
    }),
    () => now,
  ).read(input);
  assert.equal(redirected.evidence.status, "recheck_required");
  assert.equal(redirected.evidence.sourceType, "web");
  assert.equal(redirected.evidence.url, "https://other.example/page");
});

test("search tool reports visitor model usage once and failed page evidence remains retrievable", async () => {
  const registry = new AgentToolRegistry();
  registerSearchEvidenceTools(
    registry,
    async () =>
      ({
        outputText: "来源",
        citations: [],
        usage: { inputTokens: 30, outputTokens: 12 },
        estimatedCostCny: 0.01,
      }) as unknown as DeepSeekResponseResult,
    new OfficialPageEvidenceReader(
      async () => ({
        url: "https://official.example/info",
        status: 404,
        contentType: "text/plain",
        body: "missing",
      }),
      () => now,
    ),
  );
  const invocation = {
    jobId: "job-search",
    stage: "evidence_collection" as const,
    callId: "search-1",
    idempotencyKey: "search-1",
    name: "web_search",
    arguments: { query: "参观须知" },
  };
  const result = await registry.invoke(invocation);
  assert.deepEqual(result.usageEvents, [
    { type: "search", count: 1 },
    {
      type: "model",
      inputTokens: 30,
      outputTokens: 12,
      estimatedCostCny: 0.01,
      payer: "visitor",
    },
  ]);
  assert.deepEqual(
    (await registry.invoke({ ...invocation, callId: "search-2" })).usageEvents,
    [],
  );
  const page = await registry.invoke({
    ...invocation,
    name: "read_official_page",
    idempotencyKey: "page-1",
    arguments: {
      subjectId: "place-1",
      field: "reservation",
      queryTerms: ["预约"],
      candidate: classifySearchResult(
        { title: "官网", url: "https://official.example/info", snippet: "" },
        ["official.example"],
      ),
    },
  });
  assert.equal(page.status, "non_retryable_error");
  const data = page.data as { evidence: { id: string; status: string } };
  assert.equal(data.evidence.id, page.evidenceIds[0]);
  assert.equal(data.evidence.status, "failed");
});
