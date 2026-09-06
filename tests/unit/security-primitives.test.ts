import assert from "node:assert/strict";
import test from "node:test";
import {
  findSensitiveData,
  redactText,
  redactValue,
  safeStringify,
} from "../../src/security/redaction.ts";
import { TransientSecret } from "../../src/security/secrets.ts";
import { validateChatInput } from "../../src/security/sensitive-input.ts";
import {
  MissingEnvironmentVariableError,
  requireServerEnvironment,
} from "../../src/config/environment.ts";

test("TransientSecret never serializes its value", () => {
  const raw = "sk-example-0123456789abcdef";
  const secret = new TransientSecret(raw);
  assert.equal(String(secret), "[REDACTED]");
  assert.equal(JSON.stringify({ secret }), '{"secret":"[REDACTED]"}');
  assert.equal(
    secret.use((value) => value.length),
    raw.length,
  );
});

test("recursive redaction handles fields, values, errors, and circular objects", () => {
  const raw = "sk-example-0123456789abcdef";
  const circular: Record<string, unknown> = {
    authorization: `Bearer ${raw}`,
    nested: { note: raw },
  };
  circular.self = circular;
  const output = safeStringify(circular);
  assert.equal(output.includes(raw), false);
  assert.match(output, /REDACTED/);
  assert.equal(
    JSON.stringify(redactValue(new Error(`failed ${raw}`))).includes(raw),
    false,
  );
  assert.equal(
    redactText(`身份证 110101199001011234`).includes("110101199001011234"),
    false,
  );
  assert.deepEqual(
    redactValue({
      tokenUsage: { input: 10, output: 2 },
      readTokenHash: "safe-hash",
    }),
    {
      tokenUsage: { input: 10, output: 2 },
      readTokenHash: "safe-hash",
    },
  );
  const personal =
    "手机号 13800138000，护照号 E12345678，银行卡 6222 0212 3456 7890，订单号 ABCD1234567890，姓名：张三，家庭住址：上海市长宁区某路一号";
  const redacted = redactText(personal);
  for (const sensitive of [
    "13800138000",
    "E12345678",
    "6222 0212 3456 7890",
    "ABCD1234567890",
    "张三",
    "上海市长宁区某路一号",
  ]) {
    assert.equal(
      redacted.includes(sensitive),
      false,
      `${sensitive} should be redacted`,
    );
  }
});

test("chat blocks sensitive values without rejecting ordinary travel facts", () => {
  assert.deepEqual(
    validateChatInput("key 是 sk-example-0123456789abcdef").accepted,
    false,
  );
  assert.deepEqual(
    validateChatInput("身份证 110101199001011234").accepted,
    false,
  );
  assert.deepEqual(validateChatInput("订单号 ABCD1234567890").accepted, false);
  assert.deepEqual(validateChatInput("手机号 13800138000").accepted, false);
  assert.deepEqual(validateChatInput("护照号 E12345678").accepted, false);
  assert.deepEqual(
    validateChatInput("银行卡 6222-0212-3456-7890").accepted,
    false,
  );
  assert.deepEqual(validateChatInput("姓名：张三").accepted, false);
  assert.deepEqual(
    validateChatInput("家庭住址：上海市长宁区某路一号").accepted,
    false,
  );
  for (const ordinary of [
    "预算 8000 元",
    "2026-10-01 出发",
    "乘坐 G1234 次列车",
    "2 位成人",
    "景点地址：北京市东城区景山前街4号",
    "酒店名称：和平饭店",
  ]) {
    assert.deepEqual(validateChatInput(ordinary), { accepted: true });
  }
});

test("machine UUIDs and hashes are not mistaken for personal numbers", () => {
  assert.equal(
    findSensitiveData("550e8400-e29b-41d4-a716-446655440000"),
    undefined,
  );
  assert.equal(
    findSensitiveData("12345678-1234-1234-1234-123456789012"),
    undefined,
  );
  assert.equal(findSensitiveData("6222-0212-3456-7890"), "payment");
  assert.equal(
    findSensitiveData("550e8400-e29b-41d4-a716-13800138000a"),
    undefined,
  );
  assert.equal(
    findSensitiveData("claim:abcd-1380-0138-000a-bcde-1234"),
    undefined,
  );
  assert.equal(
    findSensitiveData(
      "abcdef110101199001011234b0123456789abcdef0123456789abcdef0123" +
        "abc",
    ),
    undefined,
  );
  assert.equal(
    findSensitiveData(
      "abcdef6222021234567890b0123456789abcdef0123456789abcdef012345" +
        "abc",
    ),
    undefined,
  );
  assert.equal(findSensitiveData("手机号 13800138000"), "phone");
  assert.equal(findSensitiveData("身份证 110101199001011234"), "identity");
  assert.equal(findSensitiveData("银行卡 6222021234567890"), "payment");
});

test("server environment helper fails safely without exposing values", () => {
  assert.equal(
    requireServerEnvironment("DEEPSEEK_API_KEY", {
      DEEPSEEK_API_KEY: "server-only",
    }),
    "server-only",
  );
  assert.throws(
    () => requireServerEnvironment("DEEPSEEK_API_KEY", {}),
    (error: unknown) =>
      error instanceof MissingEnvironmentVariableError &&
      !error.message.includes("undefined"),
  );
  assert.throws(
    () => requireServerEnvironment("NEXT_PUBLIC_DEEPSEEK_API_KEY", {}),
    TypeError,
  );
});
