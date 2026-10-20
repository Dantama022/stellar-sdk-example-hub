export interface LedgerContinuityReportInput {
  targetId: string;
  scannedLedgers: number;
  gapCount: number;
  maxCloseDeltaSecs: number;
  thresholdLimit?: number;
}

export interface LedgerContinuityReport {
  targetId: string;
  scannedLedgers: number;
  gapCount: number;
  maxCloseDeltaSecs: number;
  utilizationRatioBps: number;
  riskLevel: 'low' | 'moderate' | 'elevated';
  findings: string[];
  caveat: string;
}

export interface RunLedgerContinuityReportParams {
  targetId?: string;
  scannedLedgers?: number;
  gapCount?: number;
  maxCloseDeltaSecs?: number;
  thresholdLimit?: number;
  json?: boolean;
}

const DEFAULT_TARGET_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export function auditLedgerSequenceContinuity(
  input: LedgerContinuityReportInput,
): LedgerContinuityReport {
  const targetId = input.targetId.trim() || DEFAULT_TARGET_ID;
  const v1 = Math.max(0, Math.trunc(input.scannedLedgers));
  const v2 = Math.max(0, Math.trunc(input.gapCount));
  const v3 = Math.max(0, Math.trunc(input.maxCloseDeltaSecs));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationRatioBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  const findings: string[] = [];

  let riskLevel: 'low' | 'moderate' | 'elevated' = 'low';
  if (utilizationRatioBps >= 8000 || v3 > limit) {
    riskLevel = 'elevated';
    findings.push(
      `Elevated metric threshold reached: utilization=${utilizationRatioBps}bps (maxCloseDeltaSecs=${v3} vs limit=${limit}).`,
    );
  } else if (utilizationRatioBps >= 5000 || v2 > 0) {
    riskLevel = 'moderate';
    findings.push(
      `Moderate activity observed for ${targetId}: scannedLedgers=${v1}, gapCount=${v2}.`,
    );
  } else {
    findings.push(`Nominal metrics observed for ${targetId} within configured bounds.`);
  }

  return {
    targetId,
    scannedLedgers: v1,
    gapCount: v2,
    maxCloseDeltaSecs: v3,
    utilizationRatioBps,
    riskLevel,
    findings,
    caveat: 'Missing sequences indicate archive gaps rather than consensus halts.',
  };
}

export function formatLedgerContinuityReport(report: LedgerContinuityReport): string {
  const lines = [
    '=== 364-ledger-sequence-gap-continuity-audit ===',
    `Target: ${report.targetId}`,
    `scannedLedgers: ${report.scannedLedgers}`,
    `gapCount: ${report.gapCount}`,
    `maxCloseDeltaSecs: ${report.maxCloseDeltaSecs}`,
    `Utilization (bps): ${report.utilizationRatioBps}`,
    `Risk Level: ${report.riskLevel}`,
    'Findings:',
    ...report.findings.map((finding) => `  - ${finding}`),
    `Caveat: ${report.caveat}`,
  ];
  return lines.join('\n');
}

export async function run(
  params: RunLedgerContinuityReportParams = {},
): Promise<LedgerContinuityReport> {
  const report = auditLedgerSequenceContinuity({
    targetId: params.targetId ?? DEFAULT_TARGET_ID,
    scannedLedgers: params.scannedLedgers ?? 250,
    gapCount: params.gapCount ?? 100,
    maxCloseDeltaSecs: params.maxCloseDeltaSecs ?? 50,
    thresholdLimit: params.thresholdLimit ?? 1000,
  });
  if (params.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatLedgerContinuityReport(report));
  }
  return report;
}
