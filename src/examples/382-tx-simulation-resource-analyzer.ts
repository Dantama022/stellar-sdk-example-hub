export interface SimulationResourceReportInput {
  targetId: string;
  cpuInstructions: number;
  memoryBytes: number;
  refundableFeeStroops: number;
  thresholdLimit?: number;
}

export interface SimulationResourceReport {
  targetId: string;
  cpuInstructions: number;
  memoryBytes: number;
  refundableFeeStroops: number;
  utilizationRatioBps: number;
  riskLevel: 'low' | 'moderate' | 'elevated';
  findings: string[];
  caveat: string;
}

export interface RunSimulationResourceReportParams {
  targetId?: string;
  cpuInstructions?: number;
  memoryBytes?: number;
  refundableFeeStroops?: number;
  thresholdLimit?: number;
  json?: boolean;
}

const DEFAULT_TARGET_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export function analyzeSimulationResources(
  input: SimulationResourceReportInput,
): SimulationResourceReport {
  const targetId = input.targetId.trim() || DEFAULT_TARGET_ID;
  const v1 = Math.max(0, Math.trunc(input.cpuInstructions));
  const v2 = Math.max(0, Math.trunc(input.memoryBytes));
  const v3 = Math.max(0, Math.trunc(input.refundableFeeStroops));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationRatioBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  const findings: string[] = [];

  let riskLevel: 'low' | 'moderate' | 'elevated' = 'low';
  if (utilizationRatioBps >= 8000 || v3 > limit) {
    riskLevel = 'elevated';
    findings.push(
      `Elevated metric threshold reached: utilization=${utilizationRatioBps}bps (refundableFeeStroops=${v3} vs limit=${limit}).`,
    );
  } else if (utilizationRatioBps >= 5000 || v2 > 0) {
    riskLevel = 'moderate';
    findings.push(
      `Moderate activity observed for ${targetId}: cpuInstructions=${v1}, memoryBytes=${v2}.`,
    );
  } else {
    findings.push(`Nominal metrics observed for ${targetId} within configured bounds.`);
  }

  return {
    targetId,
    cpuInstructions: v1,
    memoryBytes: v2,
    refundableFeeStroops: v3,
    utilizationRatioBps,
    riskLevel,
    findings,
    caveat: 'Simulated estimates do not guarantee ledger inclusion.',
  };
}

export function formatSimulationResourceReport(report: SimulationResourceReport): string {
  const lines = [
    '=== 382-tx-simulation-resource-analyzer ===',
    `Target: ${report.targetId}`,
    `cpuInstructions: ${report.cpuInstructions}`,
    `memoryBytes: ${report.memoryBytes}`,
    `refundableFeeStroops: ${report.refundableFeeStroops}`,
    `Utilization (bps): ${report.utilizationRatioBps}`,
    `Risk Level: ${report.riskLevel}`,
    'Findings:',
    ...report.findings.map((finding) => `  - ${finding}`),
    `Caveat: ${report.caveat}`,
  ];
  return lines.join('\n');
}

export async function run(
  params: RunSimulationResourceReportParams = {},
): Promise<SimulationResourceReport> {
  const report = analyzeSimulationResources({
    targetId: params.targetId ?? DEFAULT_TARGET_ID,
    cpuInstructions: params.cpuInstructions ?? 250,
    memoryBytes: params.memoryBytes ?? 100,
    refundableFeeStroops: params.refundableFeeStroops ?? 50,
    thresholdLimit: params.thresholdLimit ?? 1000,
  });
  if (params.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatSimulationResourceReport(report));
  }
  return report;
}
