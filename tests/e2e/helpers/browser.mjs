import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
export async function waitFor(check, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Browser assertion timed out");
}
export async function browserHarness(t, options = {}) {
  const nextDist = join(process.cwd(), ".next-e2e");
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const server = spawn(
    "npm",
    ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: {
        ...process.env,
        NEXT_DIST_DIR: ".next-e2e",
        ...(options.env ?? {}),
      },
    },
  );
  let serverOutput = "";
  server.stdout.on("data", (b) => (serverOutput += b));
  server.stderr.on("data", (b) => (serverOutput += b));
  const profile = await mkdtemp(join(tmpdir(), "travel-agent-ui-"));
  const chrome = spawn(
    process.env.CHROME_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let debug = "";
  chrome.stderr.on("data", (b) => (debug += b));
  let socket;
  t.after(async () => {
    socket?.close();
    chrome.kill("SIGTERM");
    server.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 600));
    if (chrome.exitCode === null) chrome.kill("SIGKILL");
    if (server.exitCode === null) server.kill("SIGKILL");
    await rm(profile, { recursive: true, force: true });
    await rm(nextDist, { recursive: true, force: true });
  });
  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}`)).ok;
    } catch {
      return false;
    }
  }, 60000).catch((e) => {
    throw new Error(`${e.message}: ${serverOutput}`);
  });
  await waitFor(() => debug.includes("DevTools listening on"));
  const endpoint = debug.match(/DevTools listening on (ws:\/\/[^\s]+)/)[1];
  const debugPort = new URL(endpoint).port;
  const page = await (
    await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, {
      method: "PUT",
    })
  ).json();
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    socket.addEventListener("open", r, { once: true });
    socket.addEventListener("error", j, { once: true });
  });
  let next = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const payload = JSON.parse(String(event.data));
    if (payload.id) {
      const item = pending.get(payload.id);
      if (item) {
        pending.delete(payload.id);
        if (payload.error) item.reject(new Error(payload.error.message));
        else item.resolve(payload.result);
      }
    }
  });
  const cdp = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  const evaluate = async (expression) => {
    const result = await cdp("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.text +
          JSON.stringify(result.exceptionDetails.exception),
      );
    return result.result.value;
  };
  const goto = async (path) => {
    await cdp("Page.navigate", { url: `http://127.0.0.1:${port}${path}` });
    await waitFor(() =>
      evaluate(
        `document.readyState==='complete'&&location.pathname===${JSON.stringify(path)}`,
      ),
    );
  };
  const fill = async (label, value) => {
    await evaluate(
      `(()=>{const el=[...document.querySelectorAll('[aria-label]')].find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)});if(!el)throw new Error('Missing field');const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await new Promise((r) => setTimeout(r, 60));
  };
  const click = async (text) => {
    await evaluate(
      `(()=>{const el=[...document.querySelectorAll('button,a')].find(el=>el.textContent===${JSON.stringify(text)});if(!el)throw new Error('Missing button');el.click();})()`,
    );
  };
  return {
    cdp,
    evaluate,
    goto,
    fill,
    click,
    contains: (text) =>
      evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`),
  };
}
