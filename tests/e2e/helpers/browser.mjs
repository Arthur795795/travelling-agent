import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
/** Keys the keyboard journeys need; text-producing keys carry their text. */
const KEYS = {
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
};
/** Accessible name, reduced to what this app actually relies on. */
const ACCESSIBLE_NAME = `(el)=>{if(!el)return'';const aria=el.getAttribute('aria-label');if(aria)return aria.trim();const by=el.getAttribute('aria-labelledby');if(by){const t=by.split(' ').map(i=>document.getElementById(i)?.textContent??'').join(' ').trim();if(t)return t;}const wrap=el.closest('label');if(wrap)return wrap.textContent.trim();if(el.id){const outer=document.querySelector('label[for='+JSON.stringify(el.id)+']');if(outer)return outer.textContent.trim();}return (el.textContent??'').trim();}`;
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
  const generatedFiles = ["next-env.d.ts", "tsconfig.json"];
  const generatedSnapshots = new Map(
    await Promise.all(
      generatedFiles.map(async (file) => [file, await readFile(file)]),
    ),
  );
  const serverEnv = {
    ...process.env,
    NEXT_DIST_DIR: ".next-e2e",
    ...(options.env ?? {}),
  };
  if (options.production) {
    const build = spawn("npm", ["run", "build"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: serverEnv,
    });
    let buildOutput = "";
    build.stdout.on("data", (b) => (buildOutput += b));
    build.stderr.on("data", (b) => (buildOutput += b));
    const [code] = await once(build, "exit");
    if (code !== 0) {
      for (const [file, snapshot] of generatedSnapshots)
        await writeFile(file, snapshot);
      throw new Error(`Production E2E build failed (${code}): ${buildOutput}`);
    }
  }
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const server = spawn(
    "npm",
    [
      "run",
      options.production ? "start" : "dev",
      "--",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: serverEnv,
    },
  );
  let serverOutput = "";
  server.stdout.on("data", (b) => (serverOutput += b));
  server.stderr.on("data", (b) => (serverOutput += b));
  const profile = await mkdtemp(join(tmpdir(), "travel-agent-ui-"));
  const browser = options.browser ?? {
    name: "chrome",
    binary:
      process.env.CHROME_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  };
  // Kept when the runner asks for evidence, thrown away otherwise.
  const shots = process.env.E2E_SCREENSHOT_DIR
    ? join(process.env.E2E_SCREENSHOT_DIR, browser.name)
    : await mkdtemp(join(tmpdir(), "travel-agent-shots-"));
  await mkdir(shots, { recursive: true });
  const chrome = spawn(
    browser.binary,
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
  let serverStopped = false;
  const stopServer = async () => {
    if (serverStopped) return;
    serverStopped = true;
    try {
      // The npm launcher and Next dev server share this isolated process
      // group. Stopping the group makes the service worker see the same hard
      // network failure as a disconnected device.
      process.kill(-server.pid, "SIGTERM");
    } catch {
      server.kill("SIGTERM");
    }
    if (server.exitCode === null)
      await Promise.race([
        once(server, "exit"),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
  };
  t.after(async () => {
    socket?.close();
    chrome.kill("SIGTERM");
    await stopServer();
    await new Promise((r) => setTimeout(r, 600));
    if (chrome.exitCode === null) chrome.kill("SIGKILL");
    if (server.exitCode === null) server.kill("SIGKILL");
    await rm(profile, { recursive: true, force: true });
    await rm(nextDist, { recursive: true, force: true });
    for (const [file, snapshot] of generatedSnapshots)
      await writeFile(file, snapshot);
    if (!process.env.E2E_SCREENSHOT_DIR)
      await rm(shots, { recursive: true, force: true });
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
      `(()=>{const el=[...document.querySelectorAll('button,a,summary')].find(el=>el.textContent.trim()===${JSON.stringify(text)});if(!el)throw new Error('Missing control');el.click();})()`,
    );
  };
  const press = async (name, { shift = false } = {}) => {
    const key = KEYS[name];
    if (!key) throw new Error(`Unsupported key ${name}`);
    const base = {
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.keyCode,
      nativeVirtualKeyCode: key.keyCode,
      modifiers: shift ? 8 : 0,
    };
    // Tab must stay text-free, or it would be typed into the focused field.
    await cdp("Input.dispatchKeyEvent", {
      ...base,
      ...(key.text ? { type: "keyDown", text: key.text } : { type: "rawKeyDown" }),
    });
    await cdp("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
    await new Promise((r) => setTimeout(r, 50));
  };
  const typeText = async (text) => {
    await cdp("Input.insertText", { text });
    await new Promise((r) => setTimeout(r, 50));
  };
  /** What a screen reader would announce for the focused control. */
  const focused = () =>
    evaluate(
      `(()=>{const name=${ACCESSIBLE_NAME};const el=document.activeElement;if(!el)return{name:'',tag:''};const ids=(el.getAttribute('aria-describedby')??'').split(' ').filter(Boolean);return{name:name(el),tag:el.tagName,type:el.getAttribute('type')??'',invalid:el.getAttribute('aria-invalid')??'',describedBy:ids,description:ids.map(i=>{const t=document.getElementById(i);return t?t.textContent.trim():'MISSING:'+i}).join(' | ')};})()`,
    );
  const tabUntil = async (name, { shift = false, limit = 80 } = {}) => {
    const seen = [];
    for (let i = 0; i < limit; i += 1) {
      const current = await focused();
      if (current.name === name) return current;
      if (current.name && seen.at(-1) !== current.name) seen.push(current.name);
      await press("Tab", { shift });
    }
    throw new Error(
      `Tab order never reached ${JSON.stringify(name)}; saw ${JSON.stringify(seen.slice(-20))}`,
    );
  };
  const viewport = async ({ width, height, mobile = false }) => {
    await cdp("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile,
    });
    await new Promise((r) => setTimeout(r, 150));
  };
  const screenshot = async (label) => {
    const shot = await cdp("Page.captureScreenshot", { format: "png" });
    const file = join(shots, `${label}.png`);
    await writeFile(file, Buffer.from(shot.data, "base64"));
    return file;
  };
  return {
    name: browser.name,
    cdp,
    evaluate,
    goto,
    fill,
    click,
    press,
    typeText,
    focused,
    tabUntil,
    viewport,
    screenshot,
    stopServer,
    shots,
    contains: (text) =>
      evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`),
  };
}
