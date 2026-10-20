export interface LiquidityCapacityReportInput {
  targetId: string;
  balanceStroops: number;
  minimumReserveStroops: number;
  spendableStroops: number;
  thresholdLimit?: number;
}

export interface LiquidityCapacityReport {
  targetId: string;
  balanceStroops: number;
  minimumReserveStroops: number;
  spendableStroops: number;
  utilizationRatioBps: number;
  riskLevel: 'low' | 'moderate' | 'elevated';
  findings: string[];
  caveat: string;
}

export interface RunLiquidityCapacityReportParams {
  targetId?: string;
  balanceStroops?: number;
  minimumReserveStroops?: number;
  spendableStroops?: number;
  thresholdLimit?: number;
  json?: boolean;
}

const DEFAULT_TARGET_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export function analyzeAccountPaymentCapacity(
  input: LiquidityCapacityReportInput,
): LiquidityCapacityReport {
  const targetId = input.targetId.trim() || DEFAULT_TARGET_ID;
  const v1 = Math.max(0, Math.trunc(input.balanceStroops));
  const v2 = Math.max(0, Math.trunc(input.minimumReserveStroops));
  const v3 = Math.max(0, Math.trunc(input.spendableStroops));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationRatioBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  const findings: string[] = [];

  let riskLevel: 'low' | 'moderate' | 'elevated' = 'low';
  if (utilizationRatioBps >= 8000 || v3 > limit) {
    riskLevel = 'elevated';
    findings.push(
      `Elevated metric threshold reached: utilization=${utilizationRatioBps}bps (spendableStroops=${v3} vs limit=${limit}).`,
    );
  } else if (utilizationRatioBps >= 5000 || v2 > 0) {
    riskLevel = 'moderate';
    findings.push(
      `Moderate activity observed for ${targetId}: balanceStroops=${v1}, minimumReserveStroops=${v2}.`,
    );
  } else {
    findings.push(`Nominal metrics observed for ${targetId} within configured bounds.`);
  }

  return {
    targetId,
    balanceStroops: v1,
    minimumReserveStroops: v2,
    spendableStroops: v3,
    utilizationRatioBps,
    riskLevel,
    findings,
    caveat: 'Spendable capacity excludes unsubmitted in-flight transactions.',
  };
}

export function formatLiquidityCapacityReport(report: LiquidityCapacityReport): string {
  const lines = [
    '=== 372-account-liquidity-payment-capacity ===',
    `Target: ${report.targetId}`,
    `balanceStroops: ${report.balanceStroops}`,
    `minimumReserveStroops: ${report.minimumReserveStroops}`,
    `spendableStroops: ${report.spendableStroops}`,
    `Utilization (bps): ${report.utilizationRatioBps}`,
    `Risk Level: ${report.riskLevel}`,
    'Findings:',
    ...report.findings.map((finding) => `  - ${finding}`),
    `Caveat: ${report.caveat}`,
  ];
  return lines.join('\n');
}

export async function run(
  params: RunLiquidityCapacityReportParams = {},
): Promise<LiquidityCapacityReport> {
  const report = analyzeAccountPaymentCapacity({
    targetId: params.targetId ?? DEFAULT_TARGET_ID,
    balanceStroops: params.balanceStroops ?? 250,
    minimumReserveStroops: params.minimumReserveStroops ?? 100,
    spendableStroops: params.spendableStroops ?? 50,
    thresholdLimit: params.thresholdLimit ?? 1000,
  });
  if (params.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatLiquidityCapacityReport(report));
  }
  return report;
}
