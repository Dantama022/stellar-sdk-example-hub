export interface SignerHistoryAuditReportInput {
  targetId: string;
  addedSignersCount: number;
  removedSignersCount: number;
  thresholdDelta: number;
  thresholdLimit?: number;
}

export interface SignerHistoryAuditReport {
  targetId: string;
  addedSignersCount: number;
  removedSignersCount: number;
  thresholdDelta: number;
  utilizationRatioBps: number;
  riskLevel: 'low' | 'moderate' | 'elevated';
  findings: string[];
  caveat: string;
}

export interface RunSignerHistoryAuditReportParams {
  targetId?: string;
  addedSignersCount?: number;
  removedSignersCount?: number;
  thresholdDelta?: number;
  thresholdLimit?: number;
  json?: boolean;
}

const DEFAULT_TARGET_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export function auditSignerChangeHistory(
  input: SignerHistoryAuditReportInput,
): SignerHistoryAuditReport {
  const targetId = input.targetId.trim() || DEFAULT_TARGET_ID;
  const v1 = Math.max(0, Math.trunc(input.addedSignersCount));
  const v2 = Math.max(0, Math.trunc(input.removedSignersCount));
  const v3 = Math.max(0, Math.trunc(input.thresholdDelta));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationRatioBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  const findings: string[] = [];

  let riskLevel: 'low' | 'moderate' | 'elevated' = 'low';
  if (utilizationRatioBps >= 8000 || v3 > limit) {
    riskLevel = 'elevated';
    findings.push(
      `Elevated metric threshold reached: utilization=${utilizationRatioBps}bps (thresholdDelta=${v3} vs limit=${limit}).`,
    );
  } else if (utilizationRatioBps >= 5000 || v2 > 0) {
    riskLevel = 'moderate';
    findings.push(
      `Moderate activity observed for ${targetId}: addedSignersCount=${v1}, removedSignersCount=${v2}.`,
    );
  } else {
    findings.push(`Nominal metrics observed for ${targetId} within configured bounds.`);
  }

  return {
    targetId,
    addedSignersCount: v1,
    removedSignersCount: v2,
    thresholdDelta: v3,
    utilizationRatioBps,
    riskLevel,
    findings,
    caveat: 'Signer changes do not by themselves prove malicious activity.',
  };
}

export function formatSignerHistoryAuditReport(report: SignerHistoryAuditReport): string {
  const lines = [
    '=== 381-signer-change-history-audit ===',
    `Target: ${report.targetId}`,
    `addedSignersCount: ${report.addedSignersCount}`,
    `removedSignersCount: ${report.removedSignersCount}`,
    `thresholdDelta: ${report.thresholdDelta}`,
    `Utilization (bps): ${report.utilizationRatioBps}`,
    `Risk Level: ${report.riskLevel}`,
    'Findings:',
    ...report.findings.map((finding) => `  - ${finding}`),
    `Caveat: ${report.caveat}`,
  ];
  return lines.join('\n');
}

export async function run(
  params: RunSignerHistoryAuditReportParams = {},
): Promise<SignerHistoryAuditReport> {
  const report = auditSignerChangeHistory({
    targetId: params.targetId ?? DEFAULT_TARGET_ID,
    addedSignersCount: params.addedSignersCount ?? 250,
    removedSignersCount: params.removedSignersCount ?? 100,
    thresholdDelta: params.thresholdDelta ?? 50,
    thresholdLimit: params.thresholdLimit ?? 1000,
  });
  if (params.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatSignerHistoryAuditReport(report));
  }
  return report;
}
