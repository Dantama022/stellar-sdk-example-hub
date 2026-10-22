export interface DestinationReadinessReportInput {
  targetId: string;
  accountExists: number;
  trustlineAuthorized: number;
  remainingLimitStroops: number;
  thresholdLimit?: number;
}

export interface DestinationReadinessReport {
  targetId: string;
  accountExists: number;
  trustlineAuthorized: number;
  remainingLimitStroops: number;
  utilizationRatioBps: number;
  riskLevel: 'low' | 'moderate' | 'elevated';
  findings: string[];
  caveat: string;
}

export interface RunDestinationReadinessReportParams {
  targetId?: string;
  accountExists?: number;
  trustlineAuthorized?: number;
  remainingLimitStroops?: number;
  thresholdLimit?: number;
  json?: boolean;
}

const DEFAULT_TARGET_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export function auditPaymentDestinationReadiness(
  input: DestinationReadinessReportInput,
): DestinationReadinessReport {
  const targetId = input.targetId.trim() || DEFAULT_TARGET_ID;
  const v1 = Math.max(0, Math.trunc(input.accountExists));
  const v2 = Math.max(0, Math.trunc(input.trustlineAuthorized));
  const v3 = Math.max(0, Math.trunc(input.remainingLimitStroops));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationRatioBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  const findings: string[] = [];

  let riskLevel: 'low' | 'moderate' | 'elevated' = 'low';
  if (utilizationRatioBps >= 8000 || v3 > limit) {
    riskLevel = 'elevated';
    findings.push(
      `Elevated metric threshold reached: utilization=${utilizationRatioBps}bps (remainingLimitStroops=${v3} vs limit=${limit}).`,
    );
  } else if (utilizationRatioBps >= 5000 || v2 > 0) {
    riskLevel = 'moderate';
    findings.push(
      `Moderate activity observed for ${targetId}: accountExists=${v1}, trustlineAuthorized=${v2}.`,
    );
  } else {
    findings.push(`Nominal metrics observed for ${targetId} within configured bounds.`);
  }

  return {
    targetId,
    accountExists: v1,
    trustlineAuthorized: v2,
    remainingLimitStroops: v3,
    utilizationRatioBps,
    riskLevel,
    findings,
    caveat: 'Readiness at check time can change before ledger close.',
  };
}

export function formatDestinationReadinessReport(report: DestinationReadinessReport): string {
  const lines = [
    '=== 373-payment-destination-readiness-auditor ===',
    `Target: ${report.targetId}`,
    `accountExists: ${report.accountExists}`,
    `trustlineAuthorized: ${report.trustlineAuthorized}`,
    `remainingLimitStroops: ${report.remainingLimitStroops}`,
    `Utilization (bps): ${report.utilizationRatioBps}`,
    `Risk Level: ${report.riskLevel}`,
    'Findings:',
    ...report.findings.map((finding) => `  - ${finding}`),
    `Caveat: ${report.caveat}`,
  ];
  return lines.join('\n');
}

export async function run(
  params: RunDestinationReadinessReportParams = {},
): Promise<DestinationReadinessReport> {
  const report = auditPaymentDestinationReadiness({
    targetId: params.targetId ?? DEFAULT_TARGET_ID,
    accountExists: params.accountExists ?? 250,
    trustlineAuthorized: params.trustlineAuthorized ?? 100,
    remainingLimitStroops: params.remainingLimitStroops ?? 50,
    thresholdLimit: params.thresholdLimit ?? 1000,
  });
  if (params.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatDestinationReadinessReport(report));
  }
  return report;
}
