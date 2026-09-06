import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { summarizeUserStudy } from "../src/user-study/results.ts";

const source = process.env.USER_STUDY_INPUT_PATH;
const target = resolve(process.env.USER_STUDY_REPORT_PATH ?? "reports/user-study.json");
await mkdir(dirname(target), { recursive: true });
const report = source
  ? summarizeUserStudy(JSON.parse(await readFile(resolve(source), "utf8")))
  : { status: "incomplete", participantCount: 0, completedWithoutGuidance: 0, acceptablePlanMedianMs: null, keyEditMedianMs: null, gate: { passed: false, reasons: ["real_participants_missing"] } };
await writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
console.log(`${report.gate.passed ? "PASS" : "NO-GO"} -> ${target}`);
process.exitCode = report.gate.passed ? 0 : 2;
