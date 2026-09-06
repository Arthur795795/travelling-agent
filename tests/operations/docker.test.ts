import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("container is non-root, persistent, health-checked and contains no credentials", () => {
  const dockerfile = readFileSync("Dockerfile", "utf8");
  const compose = readFileSync("docker-compose.example.yml", "utf8");
  const combined = `${dockerfile}\n${compose}`;
  assert.match(dockerfile, /USER nextjs/);
  assert.match(dockerfile, /VOLUME \["\/app\/data"\]/);
  assert.match(dockerfile, /\/api\/health\/ready/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /travel-agent-data:\/app\/data/);
  assert.doesNotMatch(combined, /\b(?:sk|ds)-[A-Za-z0-9_-]{12,}\b/);
  assert.doesNotMatch(combined, /AMAP_WEB_SERVICE_KEY:\s*\S+/);
});
