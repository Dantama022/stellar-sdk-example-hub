export interface PoolValuationReportInput {
  targetId: string;
  reserveAStroops: number;
  reserveBStroops: number;
  userShareValueAStroops: number;
  thresholdLimit?: number;
}

export interface PoolValuationReport {
  targetId: string;
  reserveAStroops: number;
  reserveBStroops: number;
  userShareValueAStroops: number;
  utilizationRatioBps: number;
  riskLevel: 'low' | 'moderate' | 'elevated';
  findings: string[];
  caveat: string;
}

export interface RunPoolValuationReportParams {
  targetId?: string;
  reserveAStroops?: number;
  reserveBStroops?: number;
  userShareValueAStroops?: number;
  thresholdLimit?: number;
  json?: boolean;
}

const DEFAULT_TARGET_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export function analyzeLiquidityPoolValuation(
  input: PoolValuationReportInput,
): PoolValuationReport {
  const targetId = input.targetId.trim() || DEFAULT_TARGET_ID;
  const v1 = Math.max(0, Math.trunc(input.reserveAStroops));
  const v2 = Math.max(0, Math.trunc(input.reserveBStroops));
  const v3 = Math.max(0, Math.trunc(input.userShareValueAStroops));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationRatioBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  const findings: string[] = [];

  let riskLevel: 'low' | 'moderate' | 'elevated' = 'low';
  if (utilizationRatioBps >= 8000 || v3 > limit) {
    riskLevel = 'elevated';
    findings.push(
      `Elevated metric threshold reached: utilization=${utilizationRatioBps}bps (userShareValueAStroops=${v3} vs limit=${limit}).`,
    );
  } else if (utilizationRatioBps >= 5000 || v2 > 0) {
    riskLevel = 'moderate';
    findings.push(
      `Moderate activity observed for ${targetId}: reserveAStroops=${v1}, reserveBStroops=${v2}.`,
    );
  } else {
    findings.push(`Nominal metrics observed for ${targetId} within configured bounds.`);
  }

  return {
    targetId,
    reserveAStroops: v1,
    reserveBStroops: v2,
    userShareValueAStroops: v3,
    utilizationRatioBps,
    riskLevel,
    findings,
    caveat: 'Constant-product pool valuation is subject to impermanent loss.',
  };
}

export function formatLiquidityPoolValuationReport(report: PoolValuationReport): string {
  const lines = [
    '=== 360-liquidity-pool-share-valuation-analyzer ===',
    `Target: ${report.targetId}`,
    `reserveAStroops: ${report.reserveAStroops}`,
    `reserveBStroops: ${report.reserveBStroops}`,
    `userShareValueAStroops: ${report.userShareValueAStroops}`,
    `Utilization (bps): ${report.utilizationRatioBps}`,
    `Risk Level: ${report.riskLevel}`,
    'Findings:',
    ...report.findings.map((finding) => `  - ${finding}`),
    `Caveat: ${report.caveat}`,
  ];
  return lines.join('\n');
}

export async function run(params: RunPoolValuationReportParams = {}): Promise<PoolValuationReport> {
  const report = analyzeLiquidityPoolValuation({
    targetId: params.targetId ?? DEFAULT_TARGET_ID,
    reserveAStroops: params.reserveAStroops ?? 250,
    reserveBStroops: params.reserveBStroops ?? 100,
    userShareValueAStroops: params.userShareValueAStroops ?? 50,
    thresholdLimit: params.thresholdLimit ?? 1000,
  });
  if (params.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatLiquidityPoolValuationReport(report));
  }
  return report;
}
