import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { exportPdf } from "../../src/exports/pdf.ts";
import { executableTrip } from "../fixtures/executable-trip.ts";

const python =
  "/Users/a48472/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3";
const font = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf";
test("deterministic PDF renders Chinese, AI metadata and privacy-selected fields", async (t) => {
  if (!existsSync(python) || !existsSync(font)) {
    t.skip("bundled PDF runtime or Chinese font unavailable");
    return;
  }
  const previousPython = process.env.PDF_PYTHON,
    previousFont = process.env.PDF_FONT_PATH;
  process.env.PDF_PYTHON = python;
  process.env.PDF_FONT_PATH = font;
  t.after(() => {
    if (previousPython === undefined) delete process.env.PDF_PYTHON;
    else process.env.PDF_PYTHON = previousPython;
    if (previousFont === undefined) delete process.env.PDF_FONT_PATH;
    else process.env.PDF_FONT_PATH = previousFont;
  });
  const trip = executableTrip();
  trip.days[0].notes = ["PRIVATE-NOTE"];
  trip.brief.hardConstraints = ["PRIVATE-CONSTRAINT"];
  const first = await exportPdf(trip),
    second = await exportPdf(trip);
  assert.deepEqual(first, second);
  const inspect = execFileSync(
    python,
    [
      "-c",
      "import io,json,sys; from pypdf import PdfReader; r=PdfReader(io.BytesIO(sys.stdin.buffer.read())); print(json.dumps({'text':'\\n'.join(p.extract_text() or '' for p in r.pages),'title':r.metadata.title,'subject':r.metadata.subject,'pages':len(r.pages)},ensure_ascii=False))",
    ],
    { input: first },
  ).toString();
  const parsed = JSON.parse(inspect);
  assert.match(parsed.text, /活动1/);
  assert.match(parsed.text, /AI 辅助生成/);
  assert.match(parsed.subject, /AI_GENERATED: true/);
  assert.doesNotMatch(parsed.text, /PRIVATE-NOTE|PRIVATE-CONSTRAINT|分类预算/);
  assert.ok(parsed.pages >= 4);
  const withBudget = await exportPdf(trip, {
    budget: true,
    privateNotes: true,
  });
  const visible = execFileSync(
    python,
    [
      "-c",
      "import io,sys; from pypdf import PdfReader; print('\\n'.join(p.extract_text() or '' for p in PdfReader(io.BytesIO(sys.stdin.buffer.read())).pages))",
    ],
    { input: withBudget },
  ).toString();
  assert.match(visible, /PRIVATE-NOTE|分类预算/);
});
test("PDF renderer fails with a stable error when its runtime is unavailable", async () => {
  const previous = process.env.PDF_FONT_PATH;
  delete process.env.PDF_FONT_PATH;
  try {
    await assert.rejects(exportPdf(executableTrip()), /PDF_FONT_UNAVAILABLE/);
  } finally {
    if (previous !== undefined) process.env.PDF_FONT_PATH = previous;
  }
});
