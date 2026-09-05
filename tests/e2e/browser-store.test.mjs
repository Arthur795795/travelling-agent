import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const chromePath =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const projectRoot = resolve(import.meta.dirname, "../..");

async function transpile(relativePath, replacements = {}) {
  let source = await readFile(join(projectRoot, relativePath), "utf8");
  for (const [from, to] of Object.entries(replacements))
    source = source.replaceAll(from, to);
  return ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
  }).outputText;
}

async function createHarnessServer() {
  const modules = new Map([
    [
      "/browser-session.js",
      await transpile("src/persistence/browser-session.ts"),
    ],
    [
      "/browser-store.js",
      await transpile("src/persistence/browser-store.ts", {
        "../domain/schema.ts": "/schema.js",
        "../security/redaction.ts": "/redaction.js",
        "./browser-session.ts": "/browser-session.js",
      }),
    ],
    ["/schema.js", await transpile("src/domain/schema.ts")],
    [
      "/redaction.js",
      await transpile("src/security/redaction.ts", {
        "./secrets.ts": "/secrets.js",
      }),
    ],
    ["/secrets.js", await transpile("src/security/secrets.ts")],
  ]);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html><head>
        <script type="importmap">{"imports":{"zod":"/node_modules/zod/index.js"}}</script>
        </head><body><output id="result">loading</output>
        <script>
          addEventListener("error", (event) => document.querySelector("#result").textContent = "error:" + event.message);
          addEventListener("unhandledrejection", (event) => document.querySelector("#result").textContent = "error:" + event.reason);
        </script>
        <script type="module">
          import { BrowserTripStore } from "/browser-store.js";
          const proposedId = new URLSearchParams(location.search).get("id");
          const mode = new URLSearchParams(location.search).get("mode");
          const store = new BrowserTripStore(localStorage, () => new Date("2026-09-04T00:00:00Z"), () => proposedId);
          if (mode === "write") store.saveTrip({
            schemaVersion: 1, id: "trip-browser", version: 1,
            brief: {
              schemaVersion: 1, origin: "上海", destination: "北京",
              startDate: "2026-10-01", endDate: "2026-10-01", timeZone: "Asia/Shanghai",
              party: { adults: 1, childrenAgeBands: [], seniors: 0, mobilityNotes: [] },
              budget: { includes: ["intercity", "lodging", "tickets", "meals", "local_transport"], contingencyPercent: 10 },
              preferences: [], hardConstraints: [], bookedItems: [],
            },
            assumptions: [], lockedBookings: [],
            days: [{ id: "day-1", date: "2026-10-01", title: "北京一日", activities: [], legs: [], notes: [] }],
            budget: {
              items: [], contingencyPercent: 10,
              total: { kind: "unknown", currency: "CNY", reason: "尚未规划" },
            },
            evidence: [], claims: [], alerts: [], alternatives: [], lifecycleStatus: "draft",
            createdAt: "2026-09-04T10:00:00+08:00", updatedAt: "2026-09-04T10:00:00+08:00",
          });
          const loaded = store.loadTrip("trip-browser");
          document.querySelector("#result").textContent = store.getOrCreateSession() + "|" + (loaded?.brief.destination ?? "missing");
        </script></body></html>`);
      return;
    }
    if (modules.has(url.pathname)) {
      response.setHeader("content-type", "text/javascript; charset=utf-8");
      response.end(modules.get(url.pathname));
      return;
    }
    if (url.pathname.startsWith("/node_modules/")) {
      const path = join(projectRoot, url.pathname);
      if (!path.startsWith(join(projectRoot, "node_modules"))) {
        response.writeHead(403).end();
        return;
      }
      try {
        response.setHeader("content-type", "text/javascript; charset=utf-8");
        response.end(await readFile(path));
      } catch {
        response.writeHead(404).end();
      }
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

async function dumpDom(url, profilePath) {
  const chrome = spawn(
    chromePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--virtual-time-budget=2000",
      `--user-data-dir=${profilePath}`,
      "--dump-dom",
      url,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let html = "";
  let stderr = "";
  chrome.stdout.setEncoding("utf8");
  chrome.stderr.setEncoding("utf8");
  chrome.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  await new Promise((resolveDump, rejectDump) => {
    const timeout = setTimeout(() => {
      chrome.kill("SIGKILL");
      rejectDump(new Error(`Chrome did not produce DOM output: ${stderr}`));
    }, 15_000);
    chrome.stdout.on("data", (chunk) => {
      html += chunk;
      if (html.includes("</html>")) {
        clearTimeout(timeout);
        chrome.kill("SIGTERM");
        resolveDump();
      }
    });
    chrome.once("error", (error) => {
      clearTimeout(timeout);
      rejectDump(error);
    });
    chrome.once("exit", (code) => {
      if (html.includes("</html>")) return;
      clearTimeout(timeout);
      rejectDump(new Error(`Chrome exited with ${code}: ${stderr}`));
    });
  });
  if (chrome.exitCode === null && chrome.signalCode === null) {
    await Promise.race([
      once(chrome, "exit"),
      new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
    ]);
  }
  if (chrome.exitCode === null && chrome.signalCode === null)
    chrome.kill("SIGKILL");
  return html;
}

test("BrowserTripStore persists a validated trip across a real browser reload", async (t) => {
  const server = await createHarnessServer();
  const address = server.address();
  assert(address && typeof address === "object");
  const profilePath = await mkdtemp(
    join(tmpdir(), "travel-agent-storage-e2e-"),
  );
  t.after(async () => {
    await new Promise((resolveClose) => {
      server.close(() => resolveClose());
      server.closeAllConnections();
    });
    await rm(profilePath, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${address.port}`;
  const first = await dumpDom(
    `${origin}/?id=first-session&mode=write`,
    profilePath,
  );
  const refreshed = await dumpDom(
    `${origin}/?id=should-not-replace`,
    profilePath,
  );
  assert.match(first, /<output id="result">first-session\|北京<\/output>/);
  assert.match(refreshed, /<output id="result">first-session\|北京<\/output>/);
  assert.doesNotMatch(refreshed, /should-not-replace/);
});
