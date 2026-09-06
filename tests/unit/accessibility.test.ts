import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { describeField } from "../../src/a11y/fields.ts";

const root = join(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
/** Comments are dropped and whitespace collapsed so rules read as written. */
const css = read("src/app/styles.css")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/\s+/g, " ");

/** Body of one rule or at-rule, matched at a rule boundary only. */
function ruleBody(selector: string, source = css): string {
  const marker = `${selector} {`;
  const at = source.startsWith(marker) ? 0 : source.indexOf(`} ${marker}`);
  assert.notEqual(at, -1, `stylesheet has no "${selector}" rule`);
  const open = source.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i).trim();
    }
  }
  assert.fail(`unterminated rule for "${selector}"`);
}
function declaration(
  selector: string,
  property: string,
  source = css,
): string {
  const body = ruleBody(selector, source);
  const found = body.match(new RegExp(`(?:^|[;{] )${property}: ([^;]+);`));
  assert.ok(found, `"${selector}" does not set ${property}`);
  return found[1].trim();
}
const hex = (selector: string, property: string, source = css) => {
  const found = declaration(selector, property, source).match(/#[0-9a-f]{6}/i);
  assert.ok(found, `"${selector}" ${property} has no hex colour`);
  return found[0];
};
const pixels = (selector: string, property: string, source = css) =>
  Number.parseFloat(declaration(selector, property, source));

/** WCAG 2.2 relative luminance and contrast ratio. */
function luminance(colour: string): number {
  const parts = [1, 3, 5].map((i) => {
    const channel = Number.parseInt(colour.slice(i, i + 2), 16) / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2];
}
function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}
const WHITE = "#ffffff";

describe("error to field association", () => {
  it("marks a field only when there is a message to point at", () => {
    assert.deepEqual(describeField([]), {});
    assert.deepEqual(describeField([false, undefined, null, ""]), {});
  });
  it("names every message that explains one field", () => {
    assert.deepEqual(describeField(["job-error"]), {
      "aria-invalid": true,
      "aria-describedby": "job-error",
    });
    assert.deepEqual(
      describeField(["requirement-issue-0", false, "field-error-text"]),
      {
        "aria-invalid": true,
        "aria-describedby": "requirement-issue-0 field-error-text",
      },
    );
  });
  it("does not repeat an id that two sources produced", () => {
    assert.deepEqual(describeField(["dates", "dates"]), {
      "aria-invalid": true,
      "aria-describedby": "dates",
    });
  });
});

describe("contrast", () => {
  it("agrees with the WCAG reference ratios", () => {
    assert.equal(Math.round(contrast("#000000", WHITE)), 21);
    assert.equal(contrast(WHITE, WHITE), 1);
    // Published 4.54:1 pair, guarding the luminance curve itself.
    assert.equal(contrast("#767676", WHITE).toFixed(2), "4.54");
  });
  it("keeps body and accent text readable", () => {
    const text: [string, string][] = [
      [":root", "color"],
      [".eyebrow", "color"],
      ["a", "color"],
      [".muted", "color"],
      [".time", "color"],
      [".field-error", "color"],
    ];
    for (const [selector, property] of text)
      assert.ok(
        contrast(hex(selector, property), WHITE) >= 4.5,
        `${selector} ${property} needs 4.5:1 on the page background`,
      );
  });
  it("keeps label text on filled surfaces readable", () => {
    const ink = hex(":root", "color");
    for (const surface of [
      hex(".workspace aside", "background"),
      hex(".tag", "background"),
      hex(".leg", "background"),
      hex(":root", "background"),
    ])
      assert.ok(
        contrast(ink, surface) >= 4.5,
        `body text needs 4.5:1 on ${surface}`,
      );
    for (const selector of ["button, .button", ".skip-link"])
      assert.ok(
        contrast(hex(selector, "background"), WHITE) >= 4.5,
        `${selector} carries white text and needs 4.5:1`,
      );
  });
  it("keeps focus rings visible on the page and inside the aside", () => {
    const ring = hex(":focus-visible", "outline");
    assert.ok(pixels(":focus-visible", "outline") >= 3, "ring must be 3px");
    assert.ok(pixels(":focus-visible", "outline-offset") >= 2, "needs offset");
    for (const surface of [WHITE, hex(".workspace aside", "background")])
      assert.ok(
        contrast(ring, surface) >= 3,
        `focus ring needs 3:1 against ${surface}`,
      );
  });
  it("keeps field boundaries visible as non-text UI", () => {
    assert.ok(
      contrast(hex("input, select, textarea", "border"), WHITE) >= 3,
      "field borders are non-text UI and need 3:1",
    );
  });
});

describe("pointer targets and motion", () => {
  it("gives buttons, links and checkboxes a reachable size", () => {
    for (const selector of ["button, .button", ".checkbox", ".skip-link"])
      assert.ok(
        pixels(selector, "min-height") >= 44,
        `${selector} needs a 44px target`,
      );
    for (const property of ["width", "height"])
      assert.ok(
        pixels('input[type="checkbox"], input[type="radio"]', property) >= 24,
        `checkboxes need 24px of ${property}`,
      );
    // A disclosure control is a target of its own; 24px is the SC 2.5.8 floor.
    assert.ok(pixels("summary", "min-height") >= 24, "summary needs a target");
    assert.equal(
      pixels(".site-nav a:not(.button), .actions a:not(.button)", "min-height"),
      44,
    );
  });
  it("treats motion as opt-in", () => {
    const reduced = ruleBody("@media (prefers-reduced-motion: reduce)");
    for (const property of ["animation-duration", "transition-duration"])
      assert.match(reduced, new RegExp(`${property}: 0\\.01ms !important`));
    assert.match(reduced, /scroll-behavior: auto !important/);
    assert.match(
      ruleBody("@media (prefers-reduced-motion: no-preference)"),
      /scroll-behavior: smooth/,
    );
    // Nothing scrolls smoothly outside the guarded block.
    assert.equal(css.split("scroll-behavior: smooth").length - 1, 1);
  });
});

describe("responsive layout rules", () => {
  it("uses two desktop columns that cannot be pushed wider than the grid", () => {
    assert.equal(
      declaration(".workspace", "grid-template-columns"),
      "minmax(0, 2fr) minmax(260px, 1fr)",
    );
    assert.equal(declaration(".workspace > *", "min-width"), "0");
    assert.equal(declaration("*", "box-sizing"), "border-box");
    assert.equal(declaration(".shell", "overflow-wrap"), "anywhere");
    assert.equal(declaration(".workspace aside", "overflow-wrap"), "anywhere");
  });
  it("collapses to a single column on a phone", () => {
    const mobile = ruleBody("@media (max-width: 720px)");
    assert.equal(
      declaration(
        ".workspace, .cards, .form-grid",
        "grid-template-columns",
        mobile,
      ),
      "1fr",
    );
    assert.match(
      declaration(".shell, .hero", "width", mobile),
      /calc\(100% - \d+px\)/,
    );
    assert.ok(pixels(".shell, .hero", "padding", mobile) <= 24);
  });
});

const pages = readdirSync(join(root, "src/app"), { recursive: true })
  .map(String)
  .filter((file) => file.endsWith("page.tsx"))
  .map((file) => join("src/app", file));

describe("keyboard entry points", () => {
  it("offers a skip link before the navigation", () => {
    const layout = read("src/app/layout.tsx");
    const link = layout.indexOf('className="skip-link"');
    assert.notEqual(link, -1, "layout has no skip link");
    assert.ok(link < layout.indexOf("<header"), "skip link comes first");
    assert.match(layout, /href="#main-content"/);
  });
  it("gives every page a focusable landmark to skip into", () => {
    assert.equal(pages.length, 9, `found pages: ${pages.join(", ")}`);
    for (const page of pages) {
      const source = read(page);
      assert.match(source, /<main[^>]*id="main-content"/, `${page} target`);
      assert.match(source, /<main[^>]*tabIndex=\{-1\}/, `${page} focus`);
    }
  });
  it("never blocks pinch zoom", () => {
    for (const page of [...pages, "src/app/layout.tsx"])
      assert.doesNotMatch(
        read(page),
        /user-scalable|maximum-scale|maximumScale/,
        `${page} must leave the framework viewport default alone`,
      );
  });
});

describe("blocking messages reach their field", () => {
  const form = read("src/components/planning-form.tsx");
  const workspace = read("src/components/trip-workspace.tsx");
  const progress = read("src/components/job-progress.tsx");
  const quoted = (source: string, call: string) =>
    [...source.matchAll(new RegExp(`${call}\\(([^)]*)\\)`, "g"))]
      .flatMap((match) => match[1].match(/"[^"]+"/g) ?? [])
      .map((value) => value.slice(1, -1));
  it("renders one id per requirement issue and per field error", () => {
    assert.match(form, /id=\{`requirement-issue-\$\{index\}`\}/);
    assert.match(form, /id=\{`field-error-\$\{name\}`\}/);
    assert.match(form, /className="field-error"/);
    assert.match(form, /id="deepseek-key"/);
  });
  it("describes every planning control that can be blocked", () => {
    // Brief rows are rendered by a shared helper, so their name is the field
    // argument rather than a literal describe() call.
    const described = [
      ...quoted(form, "describe"),
      ...[...form.matchAll(/field\("([^"]+)"/g)].map((match) => match[1]),
    ];
    for (const name of [
      "text",
      "origin",
      "destination",
      "startDate",
      "endDate",
      "adults",
      "seniors",
      "children",
      "budget",
      "preferences",
      "hardConstraints",
      "confirmed",
      "bookingTitle",
      "key",
    ])
      assert.ok(described.includes(name), `${name} has no described control`);
  });
  it("points the edit alert at the fields that produced it", () => {
    assert.match(workspace, /id="trip-edit-error"/);
    assert.match(workspace, /describeField\(\[[^\]]*"trip-edit-error"\]\)/);
    const described = quoted(workspace, "describe");
    for (const kind of [
      "note",
      "activity",
      "move",
      "budget",
      "replan",
      "replan-key",
    ])
      assert.ok(described.includes(kind), `${kind} failures mark no field`);
    // The alert text is written once and reused, never duplicated per field.
    assert.equal(workspace.split("修改未保存").length - 1, 1);
  });
  it("blames the resume key only when the resume itself failed", () => {
    assert.match(progress, /id="job-error"/);
    assert.match(progress, /describeField\(\[invalidKey && "job-error"\]\)/);
    assert.match(progress, /setInvalidKey\(true\);\s*setError\("未能恢复/);
    // Stream and cancel failures report without accusing the field.
    const cancel = progress.slice(progress.indexOf("async function cancel"));
    assert.doesNotMatch(
      cancel.slice(0, cancel.indexOf("async function resume")),
      /setInvalidKey/,
    );
  });
});
