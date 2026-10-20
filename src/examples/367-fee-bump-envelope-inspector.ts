export interface FeeBumpInspectionReportInput {
  targetId: string;
  innerFeeStroops: number;
  outerFeeStroops: number;
  innerOperationCount: number;
  thresholdLimit?: number;
}

export interface FeeBumpInspectionReport {
  targetId: string;
  innerFeeStroops: number;
  outerFeeStroops: number;
  innerOperationCount: number;
  utilizationRatioBps: number;
  riskLevel: 'low' | 'moderate' | 'elevated';
  findings: string[];
  caveat: string;
}

export interface RunFeeBumpInspectionReportParams {
  targetId?: string;
  innerFeeStroops?: number;
  outerFeeStroops?: number;
  innerOperationCount?: number;
  thresholdLimit?: number;
  json?: boolean;
}

const DEFAULT_TARGET_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export function inspectFeeBumpEnvelope(
  input: FeeBumpInspectionReportInput,
): FeeBumpInspectionReport {
  const targetId = input.targetId.trim() || DEFAULT_TARGET_ID;
  const v1 = Math.max(0, Math.trunc(input.innerFeeStroops));
  const v2 = Math.max(0, Math.trunc(input.outerFeeStroops));
  const v3 = Math.max(0, Math.trunc(input.innerOperationCount));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationRatioBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  const findings: string[] = [];

  let riskLevel: 'low' | 'moderate' | 'elevated' = 'low';
  if (utilizationRatioBps >= 8000 || v3 > limit) {
    riskLevel = 'elevated';
    findings.push(
      `Elevated metric threshold reached: utilization=${utilizationRatioBps}bps (innerOperationCount=${v3} vs limit=${limit}).`,
    );
  } else if (utilizationRatioBps >= 5000 || v2 > 0) {
    riskLevel = 'moderate';
    findings.push(
      `Moderate activity observed for ${targetId}: innerFeeStroops=${v1}, outerFeeStroops=${v2}.`,
    );
  } else {
    findings.push(`Nominal metrics observed for ${targetId} within configured bounds.`);
  }

  return {
    targetId,
    innerFeeStroops: v1,
    outerFeeStroops: v2,
    innerOperationCount: v3,
    utilizationRatioBps,
    riskLevel,
    findings,
    caveat: 'Envelope inspection does not submit or validate network state.',
  };
}

export function formatFeeBumpInspectionReport(report: FeeBumpInspectionReport): string {
  const lines = [
    '=== 367-fee-bump-envelope-inspector ===',
    `Target: ${report.targetId}`,
    `innerFeeStroops: ${report.innerFeeStroops}`,
    `outerFeeStroops: ${report.outerFeeStroops}`,
    `innerOperationCount: ${report.innerOperationCount}`,
    `Utilization (bps): ${report.utilizationRatioBps}`,
    `Risk Level: ${report.riskLevel}`,
    'Findings:',
    ...report.findings.map((finding) => `  - ${finding}`),
    `Caveat: ${report.caveat}`,
  ];
  return lines.join('\n');
}

export async function run(
  params: RunFeeBumpInspectionReportParams = {},
): Promise<FeeBumpInspectionReport> {
  const report = inspectFeeBumpEnvelope({
    targetId: params.targetId ?? DEFAULT_TARGET_ID,
    innerFeeStroops: params.innerFeeStroops ?? 250,
    outerFeeStroops: params.outerFeeStroops ?? 100,
    innerOperationCount: params.innerOperationCount ?? 50,
    thresholdLimit: params.thresholdLimit ?? 1000,
  });
  if (params.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatFeeBumpInspectionReport(report));
  }
  return report;
}
