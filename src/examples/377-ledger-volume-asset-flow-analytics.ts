export interface LedgerAssetFlowReportInput {
  targetId: string;
  totalTransactions: number;
  paymentVolumeStroops: number;
  uniqueAssetsCount: number;
  thresholdLimit?: number;
}

export interface LedgerAssetFlowReport {
  targetId: string;
  totalTransactions: number;
  paymentVolumeStroops: number;
  uniqueAssetsCount: number;
  utilizationRatioBps: number;
  riskLevel: 'low' | 'moderate' | 'elevated';
  findings: string[];
  caveat: string;
}

export interface RunLedgerAssetFlowReportParams {
  targetId?: string;
  totalTransactions?: number;
  paymentVolumeStroops?: number;
  uniqueAssetsCount?: number;
  thresholdLimit?: number;
  json?: boolean;
}

const DEFAULT_TARGET_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export function analyzeLedgerAssetFlows(input: LedgerAssetFlowReportInput): LedgerAssetFlowReport {
  const targetId = input.targetId.trim() || DEFAULT_TARGET_ID;
  const v1 = Math.max(0, Math.trunc(input.totalTransactions));
  const v2 = Math.max(0, Math.trunc(input.paymentVolumeStroops));
  const v3 = Math.max(0, Math.trunc(input.uniqueAssetsCount));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationRatioBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  const findings: string[] = [];

  let riskLevel: 'low' | 'moderate' | 'elevated' = 'low';
  if (utilizationRatioBps >= 8000 || v3 > limit) {
    riskLevel = 'elevated';
    findings.push(
      `Elevated metric threshold reached: utilization=${utilizationRatioBps}bps (uniqueAssetsCount=${v3} vs limit=${limit}).`,
    );
  } else if (utilizationRatioBps >= 5000 || v2 > 0) {
    riskLevel = 'moderate';
    findings.push(
      `Moderate activity observed for ${targetId}: totalTransactions=${v1}, paymentVolumeStroops=${v2}.`,
    );
  } else {
    findings.push(`Nominal metrics observed for ${targetId} within configured bounds.`);
  }

  return {
    targetId,
    totalTransactions: v1,
    paymentVolumeStroops: v2,
    uniqueAssetsCount: v3,
    utilizationRatioBps,
    riskLevel,
    findings,
    caveat: 'Aggregated volume excludes off-chain settlement flows.',
  };
}

export function formatLedgerAssetFlowReport(report: LedgerAssetFlowReport): string {
  const lines = [
    '=== 377-ledger-volume-asset-flow-analytics ===',
    `Target: ${report.targetId}`,
    `totalTransactions: ${report.totalTransactions}`,
    `paymentVolumeStroops: ${report.paymentVolumeStroops}`,
    `uniqueAssetsCount: ${report.uniqueAssetsCount}`,
    `Utilization (bps): ${report.utilizationRatioBps}`,
    `Risk Level: ${report.riskLevel}`,
    'Findings:',
    ...report.findings.map((finding) => `  - ${finding}`),
    `Caveat: ${report.caveat}`,
  ];
  return lines.join('\n');
}

export async function run(
  params: RunLedgerAssetFlowReportParams = {},
): Promise<LedgerAssetFlowReport> {
  const report = analyzeLedgerAssetFlows({
    targetId: params.targetId ?? DEFAULT_TARGET_ID,
    totalTransactions: params.totalTransactions ?? 250,
    paymentVolumeStroops: params.paymentVolumeStroops ?? 100,
    uniqueAssetsCount: params.uniqueAssetsCount ?? 50,
    thresholdLimit: params.thresholdLimit ?? 1000,
  });
  if (params.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatLedgerAssetFlowReport(report));
  }
  return report;
}
