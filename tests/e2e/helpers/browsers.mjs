import { existsSync } from "node:fs";

/**
 * Browser test matrix: the current and the previous major of every engine the
 * app is expected to work in. Binaries come from the environment because CI
 * images and developer machines install browsers in different places.
 *
 * `automated` entries are driven by the CDP harness in this folder. Gecko and
 * WebKit do not speak CDP, so they stay in the matrix as a recorded manual
 * pass instead of silently disappearing from it.
 */
export const BROWSER_MATRIX = [
  {
    name: "chrome-current",
    engine: "chromium",
    channel: "current",
    automated: true,
    env: "CHROME_PATH",
    fallback: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  },
  {
    name: "chrome-previous",
    engine: "chromium",
    channel: "previous",
    automated: true,
    env: "CHROME_PREVIOUS_PATH",
  },
  {
    name: "edge-current",
    engine: "chromium",
    channel: "current",
    automated: true,
    env: "EDGE_PATH",
    fallback:
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  },
  {
    name: "edge-previous",
    engine: "chromium",
    channel: "previous",
    automated: true,
    env: "EDGE_PREVIOUS_PATH",
  },
  {
    name: "firefox-current",
    engine: "gecko",
    channel: "current",
    automated: false,
    env: "FIREFOX_PATH",
  },
  {
    name: "firefox-previous",
    engine: "gecko",
    channel: "previous",
    automated: false,
    env: "FIREFOX_PREVIOUS_PATH",
  },
  { name: "safari-current", engine: "webkit", channel: "current", automated: false },
  { name: "safari-previous", engine: "webkit", channel: "previous", automated: false },
];

const binaryOf = (entry) =>
  (entry.env ? process.env[entry.env] : undefined) ?? entry.fallback;

/** Matrix entries this harness can drive and whose binary is installed here. */
export function availableBrowsers() {
  return BROWSER_MATRIX.filter((entry) => entry.automated)
    .map((entry) => ({ ...entry, binary: binaryOf(entry) }))
    .filter((entry) => entry.binary && existsSync(entry.binary));
}

/** Entries that need a person: no CDP, so the same journey is walked by hand. */
export const manualBrowsers = () =>
  BROWSER_MATRIX.filter((entry) => !entry.automated);

/** Names of the variables that turn an automated entry on. */
export const automatedEnvNames = () =>
  BROWSER_MATRIX.filter((entry) => entry.automated).map((entry) => entry.env);
