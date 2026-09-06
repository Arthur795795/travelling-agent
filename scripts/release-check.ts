import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { releaseDecision, scanPublicationText } from "../src/operations/release-gate.ts";

const target = resolve(process.env.RELEASE_REPORT_PATH ?? "reports/release-gate.json");
const commands = [
  ["lint", ["run", "lint"]],
  ["typecheck", ["run", "typecheck"]],
  ["unit", ["test"]],
  ["integration", ["run", "test:integration"]],
  ["e2e", ["run", "test:e2e"]],
  ["security", ["run", "test:security"]],
  ["fixture-tests", ["run", "test:eval:fixtures"]],
  ["live-runner-tests", ["run", "test:eval:live"]],
  ["operations", ["run", "test:operations"]],
  ["build", ["run", "build"]],
  ["fixed-36", ["run", "eval:fixtures"]],
] as const;

const commandResults = commands.map(([name, args]) => {
  const result = spawnSync("npm", args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CHROME_PATH:
        process.env.CHROME_PATH ??
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return { name, exitCode: result.status ?? 1, passed: result.status === 0 };
});

interface EvidenceFile {
  sampleCount?: number;
  successRate?: number;
  averageSoftScore?: number;
  criticalFailureCount?: number;
  participantCount?: number;
  controlledLiveSamples?: number;
  status?: string;
  gate?: { passed?: boolean };
  report?: { gate?: { passed?: boolean } };
}
async function json(path: string): Promise<EvidenceFile | null> {
  try { return JSON.parse(await readFile(resolve(path), "utf8")); } catch { return null; }
}

const fixed = await json("reports/eval-fixtures.json");
const live = await json(process.env.LIVE_EVAL_EVIDENCE_PATH ?? "reports/live/latest.json");
const performance = await json(process.env.PERFORMANCE_REPORT_PATH ?? "reports/performance.json");
const userStudy = await json(process.env.USER_STUDY_REPORT_PATH ?? "reports/user-study.json");
const files = spawnSync("rg", ["--files", "-g", "!node_modules", "-g", "!.next*", "-g", "!reports/**"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
let currentText = "";
for (const file of files) {
  try { currentText += `\n${await readFile(file, "utf8")}`; } catch {}
}
const historyText = spawnSync("git", ["log", "-p", "--all", "--no-ext-diff"], { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }).stdout;
const currentScan = scanPublicationText(currentText);
const historyScan = scanPublicationText(historyText);
const readme = await readFile("README.md", "utf8");
const pages = `${readme}\n${await readFile("src/app/case-study/page.tsx", "utf8")}\n${await readFile("src/app/about/page.tsx", "utf8")}`;
const evidence = {
  commandsPassed: commandResults.every((item) => item.passed),
  fixedEvaluation: fixed
    ? { sampleCount: fixed.sampleCount, successRate: fixed.successRate, averageSoftScore: fixed.averageSoftScore, criticalFailureCount: fixed.criticalFailureCount, passed: fixed.gate?.passed === true }
    : null,
  liveEvaluationPassed: live?.report?.gate?.passed === true && live?.status === "completed",
  performancePassed: performance?.gate?.passed === true && performance?.controlledLiveSamples > 0,
  securityPassed: commandResults.find((item) => item.name === "security")?.passed === true,
  userStudyPassed: userStudy?.gate?.passed === true && userStudy?.participantCount === 5,
  repositoryScanPassed: currentScan.passed && historyScan.passed,
  fiveCityLabelsPresent: ["北京", "上海", "重庆", "西安", "杭州"].every((city) => readme.includes(city)),
  aiAndLimitsDisclosurePresent: /AI 辅助生成/.test(pages) && /不绑定第三方账户|不保证实时/.test(pages),
  deploymentEvidencePresent: Boolean(process.env.DEPLOYMENT_EVIDENCE_PATH && existsSync(process.env.DEPLOYMENT_EVIDENCE_PATH)),
  complianceMaterialsPresent: Boolean(process.env.COMPLIANCE_EVIDENCE_PATH && existsSync(process.env.COMPLIANCE_EVIDENCE_PATH)),
};
const gate = releaseDecision(evidence);
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  ...gate,
  commandResults,
  evidence,
  repositoryScan: { current: currentScan, gitHistory: historyScan },
  note: "报告不包含命令输出、凭据、行程正文、参与者数据或扫描命中内容。",
};
await mkdir(dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(target.replace(/\.json$/, ".md"), `# 发布门槛\n\n- 结论：${gate.decision}\n- 时间：${report.generatedAt}\n- 未满足项：${gate.reasons.join("、") || "无"}\n\n此报告不会把缺失的联网、性能、用户、部署或合规证据标记为完成。\n`);
console.log(`${gate.decision.toUpperCase()} -> ${target}`);
process.exitCode = gate.decision === "go" ? 0 : 2;
