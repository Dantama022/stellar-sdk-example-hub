export interface MergeEligibilityReportInput {
  targetId: string;
  subentryCount: number;
  NonZeroTrustlines: number;
  sponsoringCount: number;
  thresholdLimit?: number;
}

export interface MergeEligibilityReport {
  targetId: string;
  subentryCount: number;
  NonZeroTrustlines: number;
  sponsoringCount: number;
  utilizationRatioBps: number;
  riskLevel: 'low' | 'moderate' | 'elevated';
  findings: string[];
  caveat: string;
}

export interface RunMergeEligibilityReportParams {
  targetId?: string;
  subentryCount?: number;
  NonZeroTrustlines?: number;
  sponsoringCount?: number;
  thresholdLimit?: number;
  json?: boolean;
}

const DEFAULT_TARGET_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export function auditAccountMergeEligibility(
  input: MergeEligibilityReportInput,
): MergeEligibilityReport {
  const targetId = input.targetId.trim() || DEFAULT_TARGET_ID;
  const v1 = Math.max(0, Math.trunc(input.subentryCount));
  const v2 = Math.max(0, Math.trunc(input.NonZeroTrustlines));
  const v3 = Math.max(0, Math.trunc(input.sponsoringCount));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationRatioBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  const findings: string[] = [];

  let riskLevel: 'low' | 'moderate' | 'elevated' = 'low';
  if (utilizationRatioBps >= 8000 || v3 > limit) {
    riskLevel = 'elevated';
    findings.push(
      `Elevated metric threshold reached: utilization=${utilizationRatioBps}bps (sponsoringCount=${v3} vs limit=${limit}).`,
    );
  } else if (utilizationRatioBps >= 5000 || v2 > 0) {
    riskLevel = 'moderate';
    findings.push(
      `Moderate activity observed for ${targetId}: subentryCount=${v1}, NonZeroTrustlines=${v2}.`,
    );
  } else {
    findings.push(`Nominal metrics observed for ${targetId} within configured bounds.`);
  }

  return {
    targetId,
    subentryCount: v1,
    NonZeroTrustlines: v2,
    sponsoringCount: v3,
    utilizationRatioBps,
    riskLevel,
    findings,
    caveat: 'Eligibility checks reflect current Horizon state only.',
  };
}

export function formatMergeEligibilityReport(report: MergeEligibilityReport): string {
  const lines = [
    '=== 378-account-merge-eligibility-auditor ===',
    `Target: ${report.targetId}`,
    `subentryCount: ${report.subentryCount}`,
    `NonZeroTrustlines: ${report.NonZeroTrustlines}`,
    `sponsoringCount: ${report.sponsoringCount}`,
    `Utilization (bps): ${report.utilizationRatioBps}`,
    `Risk Level: ${report.riskLevel}`,
    'Findings:',
    ...report.findings.map((finding) => `  - ${finding}`),
    `Caveat: ${report.caveat}`,
  ];
  return lines.join('\n');
}

export async function run(
  params: RunMergeEligibilityReportParams = {},
): Promise<MergeEligibilityReport> {
  const report = auditAccountMergeEligibility({
    targetId: params.targetId ?? DEFAULT_TARGET_ID,
    subentryCount: params.subentryCount ?? 250,
    NonZeroTrustlines: params.NonZeroTrustlines ?? 100,
    sponsoringCount: params.sponsoringCount ?? 50,
    thresholdLimit: params.thresholdLimit ?? 1000,
  });
  if (params.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatMergeEligibilityReport(report));
  }
  return report;
}
