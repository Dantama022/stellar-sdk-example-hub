export interface MemoPrivacyAuditReportInput {
  targetId: string;
  memoType: number;
  memoByteLength: number;
  piiPatternCount: number;
  thresholdLimit?: number;
}

export interface MemoPrivacyAuditReport {
  targetId: string;
  memoType: number;
  memoByteLength: number;
  piiPatternCount: number;
  utilizationRatioBps: number;
  riskLevel: 'low' | 'moderate' | 'elevated';
  findings: string[];
  caveat: string;
}

export interface RunMemoPrivacyAuditReportParams {
  targetId?: string;
  memoType?: number;
  memoByteLength?: number;
  piiPatternCount?: number;
  thresholdLimit?: number;
  json?: boolean;
}

const DEFAULT_TARGET_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export function auditTransactionMemoPrivacy(
  input: MemoPrivacyAuditReportInput,
): MemoPrivacyAuditReport {
  const targetId = input.targetId.trim() || DEFAULT_TARGET_ID;
  const v1 = Math.max(0, Math.trunc(input.memoType));
  const v2 = Math.max(0, Math.trunc(input.memoByteLength));
  const v3 = Math.max(0, Math.trunc(input.piiPatternCount));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationRatioBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  const findings: string[] = [];

  let riskLevel: 'low' | 'moderate' | 'elevated' = 'low';
  if (utilizationRatioBps >= 8000 || v3 > limit) {
    riskLevel = 'elevated';
    findings.push(
      `Elevated metric threshold reached: utilization=${utilizationRatioBps}bps (piiPatternCount=${v3} vs limit=${limit}).`,
    );
  } else if (utilizationRatioBps >= 5000 || v2 > 0) {
    riskLevel = 'moderate';
    findings.push(
      `Moderate activity observed for ${targetId}: memoType=${v1}, memoByteLength=${v2}.`,
    );
  } else {
    findings.push(`Nominal metrics observed for ${targetId} within configured bounds.`);
  }

  return {
    targetId,
    memoType: v1,
    memoByteLength: v2,
    piiPatternCount: v3,
    utilizationRatioBps,
    riskLevel,
    findings,
    caveat: 'Pattern heuristics flag potential PII exposure on a public ledger.',
  };
}

export function formatMemoPrivacyAuditReport(report: MemoPrivacyAuditReport): string {
  const lines = [
    '=== 368-tx-memo-privacy-exposure-auditor ===',
    `Target: ${report.targetId}`,
    `memoType: ${report.memoType}`,
    `memoByteLength: ${report.memoByteLength}`,
    `piiPatternCount: ${report.piiPatternCount}`,
    `Utilization (bps): ${report.utilizationRatioBps}`,
    `Risk Level: ${report.riskLevel}`,
    'Findings:',
    ...report.findings.map((finding) => `  - ${finding}`),
    `Caveat: ${report.caveat}`,
  ];
  return lines.join('\n');
}

export async function run(
  params: RunMemoPrivacyAuditReportParams = {},
): Promise<MemoPrivacyAuditReport> {
  const report = auditTransactionMemoPrivacy({
    targetId: params.targetId ?? DEFAULT_TARGET_ID,
    memoType: params.memoType ?? 250,
    memoByteLength: params.memoByteLength ?? 100,
    piiPatternCount: params.piiPatternCount ?? 50,
    thresholdLimit: params.thresholdLimit ?? 1000,
  });
  if (params.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatMemoPrivacyAuditReport(report));
  }
  return report;
}
