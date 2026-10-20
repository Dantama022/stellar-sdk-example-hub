export interface ThresholdSecurityReportInput {
  targetId: string;
  totalWeight: number;
  highThreshold: number;
  singlePointOfFailureCount: number;
  thresholdLimit?: number;
}

export interface ThresholdSecurityReport {
  targetId: string;
  totalWeight: number;
  highThreshold: number;
  singlePointOfFailureCount: number;
  utilizationRatioBps: number;
  riskLevel: 'low' | 'moderate' | 'elevated';
  findings: string[];
  caveat: string;
}

export interface RunThresholdSecurityReportParams {
  targetId?: string;
  totalWeight?: number;
  highThreshold?: number;
  singlePointOfFailureCount?: number;
  thresholdLimit?: number;
  json?: boolean;
}

const DEFAULT_TARGET_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export function auditSignerWeightThresholds(
  input: ThresholdSecurityReportInput,
): ThresholdSecurityReport {
  const targetId = input.targetId.trim() || DEFAULT_TARGET_ID;
  const v1 = Math.max(0, Math.trunc(input.totalWeight));
  const v2 = Math.max(0, Math.trunc(input.highThreshold));
  const v3 = Math.max(0, Math.trunc(input.singlePointOfFailureCount));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationRatioBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  const findings: string[] = [];

  let riskLevel: 'low' | 'moderate' | 'elevated' = 'low';
  if (utilizationRatioBps >= 8000 || v3 > limit) {
    riskLevel = 'elevated';
    findings.push(
      `Elevated metric threshold reached: utilization=${utilizationRatioBps}bps (singlePointOfFailureCount=${v3} vs limit=${limit}).`,
    );
  } else if (utilizationRatioBps >= 5000 || v2 > 0) {
    riskLevel = 'moderate';
    findings.push(
      `Moderate activity observed for ${targetId}: totalWeight=${v1}, highThreshold=${v2}.`,
    );
  } else {
    findings.push(`Nominal metrics observed for ${targetId} within configured bounds.`);
  }

  return {
    targetId,
    totalWeight: v1,
    highThreshold: v2,
    singlePointOfFailureCount: v3,
    utilizationRatioBps,
    riskLevel,
    findings,
    caveat: 'Configuration checks cannot verify key custody separation.',
  };
}

export function formatThresholdSecurityReport(report: ThresholdSecurityReport): string {
  const lines = [
    '=== 375-signer-weight-threshold-auditor ===',
    `Target: ${report.targetId}`,
    `totalWeight: ${report.totalWeight}`,
    `highThreshold: ${report.highThreshold}`,
    `singlePointOfFailureCount: ${report.singlePointOfFailureCount}`,
    `Utilization (bps): ${report.utilizationRatioBps}`,
    `Risk Level: ${report.riskLevel}`,
    'Findings:',
    ...report.findings.map((finding) => `  - ${finding}`),
    `Caveat: ${report.caveat}`,
  ];
  return lines.join('\n');
}

export async function run(
  params: RunThresholdSecurityReportParams = {},
): Promise<ThresholdSecurityReport> {
  const report = auditSignerWeightThresholds({
    targetId: params.targetId ?? DEFAULT_TARGET_ID,
    totalWeight: params.totalWeight ?? 250,
    highThreshold: params.highThreshold ?? 100,
    singlePointOfFailureCount: params.singlePointOfFailureCount ?? 50,
    thresholdLimit: params.thresholdLimit ?? 1000,
  });
  if (params.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatThresholdSecurityReport(report));
  }
  return report;
}
