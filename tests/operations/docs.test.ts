import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const docs = ["README.md", "docs/ARCHITECTURE.md", "docs/RUNBOOK.md"];

test("documentation links and npm commands resolve to the repository", () => {
  const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, string>;
  for (const file of docs) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/\[[^\]]+\]\((?!https?:)([^)#]+)(?:#[^)]+)?\)/g)) {
      const target = resolve(dirname(file), match[1]);
      assert.ok(existsSync(target), `${file} link is missing: ${match[1]}`);
    }
    for (const match of text.matchAll(/npm run ([a-z0-9:-]+)/g))
      assert.ok(scripts[match[1]], `${file} documents missing script ${match[1]}`);
  }
  assert.match(readFileSync("docs/ARCHITECTURE.md", "utf8"), /BYOK|七阶段|关键失败/);
  assert.match(readFileSync("docs/RUNBOOK.md", "utf8"), /no-go|readiness|重启/);
});
