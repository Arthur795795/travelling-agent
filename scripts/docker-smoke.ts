import { spawnSync } from "node:child_process";

const suffix = String(process.pid);
const image = `travel-agent-smoke:${suffix}`;
const volume = `travel-agent-smoke-${suffix}`;
const first = `travel-agent-smoke-a-${suffix}`;
const second = `travel-agent-smoke-b-${suffix}`;
const dockerBinary = process.env.DOCKER_BIN ?? "docker";

function docker(args: string[], allowFailure = false): string {
  const result = spawnSync(dockerBinary, args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  if (!allowFailure && result.status !== 0)
    throw new Error(`docker ${args[0]} failed: ${(result.stderr || result.stdout).slice(-1000)}`);
  return result.stdout.trim();
}

async function waitReady(port: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const [home, live, ready] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/`),
        fetch(`http://127.0.0.1:${port}/api/health/live`),
        fetch(`http://127.0.0.1:${port}/api/health/ready`),
      ]);
      if (home.ok && live.ok && ready.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("container readiness timed out");
}

function start(name: string) {
  docker(["run", "-d", "--name", name, "--read-only", "--tmpfs", "/tmp:size=64m", "-p", "127.0.0.1::3000", "-v", `${volume}:/app/data`, image]);
  return docker(["port", name, "3000/tcp"]).split(":").at(-1)!;
}

try {
  docker(["build", "-t", image, "."]);
  const firstPort = start(first);
  await waitReady(firstPort);
  docker(["stop", first]);
  docker(["rm", first]);
  const secondPort = start(second);
  await waitReady(secondPort);
  const databaseExists = docker(["exec", second, "node", "-e", "process.stdout.write(String(require('fs').existsSync('/app/data/travel-agent.sqlite')))"]);
  if (databaseExists !== "true") throw new Error("SQLite volume did not persist across restart");
  const history = docker(["history", "--no-trunc", image]);
  if (/\b(?:sk|ds)-[A-Za-z0-9_-]{12,}\b/.test(history))
    throw new Error("credential-shaped value found in image history");
  console.log("PASS docker build, homepage, health and persistent restart smoke");
} finally {
  docker(["rm", "-f", first], true);
  docker(["rm", "-f", second], true);
  docker(["volume", "rm", volume], true);
  docker(["image", "rm", image], true);
}
