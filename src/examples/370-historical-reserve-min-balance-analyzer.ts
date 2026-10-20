export interface HistoricalReserveReportInput {
  targetId: string;
  baseReserveStroops: number;
  totalSubentries: number;
  requiredMinBalanceStroops: number;
  thresholdLimit?: number;
}

export interface HistoricalReserveReport {
  targetId: string;
  baseReserveStroops: number;
  totalSubentries: number;
  requiredMinBalanceStroops: number;
  utilizationRatioBps: number;
  riskLevel: 'low' | 'moderate' | 'elevated';
  findings: string[];
  caveat: string;
}

export interface RunHistoricalReserveReportParams {
  targetId?: string;
  baseReserveStroops?: number;
  totalSubentries?: number;
  requiredMinBalanceStroops?: number;
  thresholdLimit?: number;
  json?: boolean;
}

const DEFAULT_TARGET_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export function analyzeHistoricalReserveRequirement(
  input: HistoricalReserveReportInput,
): HistoricalReserveReport {
  const targetId = input.targetId.trim() || DEFAULT_TARGET_ID;
  const v1 = Math.max(0, Math.trunc(input.baseReserveStroops));
  const v2 = Math.max(0, Math.trunc(input.totalSubentries));
  const v3 = Math.max(0, Math.trunc(input.requiredMinBalanceStroops));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationRatioBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  const findings: string[] = [];

  let riskLevel: 'low' | 'moderate' | 'elevated' = 'low';
  if (utilizationRatioBps >= 8000 || v3 > limit) {
    riskLevel = 'elevated';
    findings.push(
      `Elevated metric threshold reached: utilization=${utilizationRatioBps}bps (requiredMinBalanceStroops=${v3} vs limit=${limit}).`,
    );
  } else if (utilizationRatioBps >= 5000 || v2 > 0) {
    riskLevel = 'moderate';
    findings.push(
      `Moderate activity observed for ${targetId}: baseReserveStroops=${v1}, totalSubentries=${v2}.`,
    );
  } else {
    findings.push(`Nominal metrics observed for ${targetId} within configured bounds.`);
  }

  return {
    targetId,
    baseReserveStroops: v1,
    totalSubentries: v2,
    requiredMinBalanceStroops: v3,
    utilizationRatioBps,
    riskLevel,
    findings,
    caveat: 'Historical reserve snapshots depend on the base reserve at that ledger.',
  };
}

export function formatHistoricalReserveReport(report: HistoricalReserveReport): string {
  const lines = [
    '=== 370-historical-reserve-min-balance-analyzer ===',
    `Target: ${report.targetId}`,
    `baseReserveStroops: ${report.baseReserveStroops}`,
    `totalSubentries: ${report.totalSubentries}`,
    `requiredMinBalanceStroops: ${report.requiredMinBalanceStroops}`,
    `Utilization (bps): ${report.utilizationRatioBps}`,
    `Risk Level: ${report.riskLevel}`,
    'Findings:',
    ...report.findings.map((finding) => `  - ${finding}`),
    `Caveat: ${report.caveat}`,
  ];
  return lines.join('\n');
}

export async function run(
  params: RunHistoricalReserveReportParams = {},
): Promise<HistoricalReserveReport> {
  const report = analyzeHistoricalReserveRequirement({
    targetId: params.targetId ?? DEFAULT_TARGET_ID,
    baseReserveStroops: params.baseReserveStroops ?? 250,
    totalSubentries: params.totalSubentries ?? 100,
    requiredMinBalanceStroops: params.requiredMinBalanceStroops ?? 50,
    thresholdLimit: params.thresholdLimit ?? 1000,
  });
  if (params.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatHistoricalReserveReport(report));
  }
  return report;
}
