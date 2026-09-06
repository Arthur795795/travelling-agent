import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { RegressionStateSchema, observeModel, recordFullRegression, recordSmoke } from "../src/evaluation/regression.ts";

const [command, observedModel, reportPath] = process.argv.slice(2);
const path = resolve(process.env.MODEL_REGRESSION_STATE_PATH ?? "data/model-regression.json");
let state;
try {
  state = RegressionStateSchema.parse(JSON.parse(await readFile(path, "utf8")));
} catch {
  if (!observedModel) throw new Error("Observed model is required to initialize regression state");
  state = { schemaVersion: 1 as const, lastPassedModel: observedModel, lastPassedAt: new Date().toISOString(), observedModel, status: "passed" as const, smokeSampleCount: 0, criticalFailureCount: 0, fullRegressionSampleCount: 0 };
}
if (command === "observe") state = observeModel(state, observedModel);
else if (command === "smoke") {
  const report = JSON.parse(await readFile(resolve(reportPath), "utf8"));
  state = recordSmoke(observeModel(state, observedModel), { sampleCount: report.sampleCount, criticalFailureCount: report.criticalFailureCount });
} else if (command === "full") {
  const report = JSON.parse(await readFile(resolve(reportPath), "utf8"));
  state = recordFullRegression(observeModel(state, observedModel), { sampleCount: report.sampleCount, gatePassed: report.gate?.passed === true, completedAt: report.generatedAt });
} else throw new Error("Usage: model:regression -- observe|smoke|full <model> [report.json]");
await mkdir(dirname(path), { recursive: true });
await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
console.log(`${state.status} -> ${path}`);
