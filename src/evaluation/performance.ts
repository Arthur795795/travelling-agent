import { evaluateOwnerMonthlyCost } from "../domain/usage.ts";

export interface PerformanceSample {
  id: string;
  provider: "fixture" | "controlled_live";
  firstProgressMs: number;
  terminalMs: number;
  terminalStatus: "completed" | "blocked" | "failed" | "waiting_for_credentials";
  inputTokens: number;
  outputTokens: number;
  visitorCostCny: number;
  productCostCny: number;
}

export async function measurePerformanceSample(
  id: string,
  provider: PerformanceSample["provider"],
  run: (progress: () => void) => Promise<
    Pick<
      PerformanceSample,
      | "terminalStatus"
      | "inputTokens"
      | "outputTokens"
      | "visitorCostCny"
      | "productCostCny"
    >
  >,
): Promise<PerformanceSample> {
  const started = performance.now();
  let firstProgressAt: number | undefined;
  const terminal = await run(() => {
    firstProgressAt ??= performance.now();
  });
  const ended = performance.now();
  return {
    id,
    provider,
    firstProgressMs: (firstProgressAt ?? ended) - started,
    terminalMs: ended - started,
    ...terminal,
  };
}

const percentile = (values: number[], fraction: number): number => {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
};

export function performanceReport(
  samples: PerformanceSample[],
  monthlyProductCostCny: number,
) {
  for (const sample of samples)
    for (const value of [
      sample.firstProgressMs,
      sample.terminalMs,
      sample.inputTokens,
      sample.outputTokens,
      sample.visitorCostCny,
      sample.productCostCny,
    ])
      if (!Number.isFinite(value) || value < 0)
        throw new RangeError("Performance values must be non-negative and finite");
  const first = samples.map((sample) => sample.firstProgressMs);
  const terminal = samples.map((sample) => sample.terminalMs);
  const p50 = percentile(terminal, 0.5);
  const p95 = percentile(terminal, 0.95);
  const max = Math.max(0, ...terminal);
  const timeoutSafe = samples.every(
    (sample) =>
      sample.terminalMs <= 180_000 ||
      ["blocked", "failed", "waiting_for_credentials"].includes(
        sample.terminalStatus,
      ),
  );
  const reasons = [
    ...(Math.max(0, ...first) > 2_000 ? ["first_progress_over_2s"] : []),
    ...(p50 > 75_000 ? ["median_over_75s"] : []),
    ...(p95 > 150_000 ? ["p95_over_150s"] : []),
    ...(!timeoutSafe ? ["over_180s_without_safe_terminal"] : []),
  ];
  return {
    sampleCount: samples.length,
    fixedSamples: samples.filter((sample) => sample.provider === "fixture").length,
    controlledLiveSamples: samples.filter(
      (sample) => sample.provider === "controlled_live",
    ).length,
    firstProgressMaxMs: Math.max(0, ...first),
    terminalP50Ms: p50,
    terminalP95Ms: p95,
    terminalMaxMs: max,
    tokens: {
      input: samples.reduce((sum, sample) => sum + sample.inputTokens, 0),
      output: samples.reduce((sum, sample) => sum + sample.outputTokens, 0),
    },
    costs: {
      visitorModelCny: Number(
        samples.reduce((sum, sample) => sum + sample.visitorCostCny, 0).toFixed(4),
      ),
      productCny: Number(
        samples.reduce((sum, sample) => sum + sample.productCostCny, 0).toFixed(4),
      ),
      monthlyProductCny: monthlyProductCostCny,
      monthlyStatus: evaluateOwnerMonthlyCost(monthlyProductCostCny),
    },
    gate: { passed: reasons.length === 0, reasons },
  };
}
