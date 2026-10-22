export interface SequenceConflictReportInput {
  targetId: string;
  accountSequence: number;
  candidateSequence: number;
  feeBumpMultiplierBps: number;
  thresholdLimit?: number;
}

export interface SequenceConflictReport {
  targetId: string;
  accountSequence: number;
  candidateSequence: number;
  feeBumpMultiplierBps: number;
  utilizationRatioBps: number;
  riskLevel: 'low' | 'moderate' | 'elevated';
  findings: string[];
  caveat: string;
}

export interface RunSequenceConflictReportParams {
  targetId?: string;
  accountSequence?: number;
  candidateSequence?: number;
  feeBumpMultiplierBps?: number;
  thresholdLimit?: number;
  json?: boolean;
}

const DEFAULT_TARGET_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export function diagnoseSequenceReplacement(
  input: SequenceConflictReportInput,
): SequenceConflictReport {
  const targetId = input.targetId.trim() || DEFAULT_TARGET_ID;
  const v1 = Math.max(0, Math.trunc(input.accountSequence));
  const v2 = Math.max(0, Math.trunc(input.candidateSequence));
  const v3 = Math.max(0, Math.trunc(input.feeBumpMultiplierBps));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationRatioBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  const findings: string[] = [];

  let riskLevel: 'low' | 'moderate' | 'elevated' = 'low';
  if (utilizationRatioBps >= 8000 || v3 > limit) {
    riskLevel = 'elevated';
    findings.push(
      `Elevated metric threshold reached: utilization=${utilizationRatioBps}bps (feeBumpMultiplierBps=${v3} vs limit=${limit}).`,
    );
  } else if (utilizationRatioBps >= 5000 || v2 > 0) {
    riskLevel = 'moderate';
    findings.push(
      `Moderate activity observed for ${targetId}: accountSequence=${v1}, candidateSequence=${v2}.`,
    );
  } else {
    findings.push(`Nominal metrics observed for ${targetId} within configured bounds.`);
  }

  return {
    targetId,
    accountSequence: v1,
    candidateSequence: v2,
    feeBumpMultiplierBps: v3,
    utilizationRatioBps,
    riskLevel,
    findings,
    caveat: 'Fee-bump replacement requires strictly sufficient fee per operation.',
  };
}

export function formatSequenceConflictReport(report: SequenceConflictReport): string {
  const lines = [
    '=== 374-tx-replacement-sequence-diagnostics ===',
    `Target: ${report.targetId}`,
    `accountSequence: ${report.accountSequence}`,
    `candidateSequence: ${report.candidateSequence}`,
    `feeBumpMultiplierBps: ${report.feeBumpMultiplierBps}`,
    `Utilization (bps): ${report.utilizationRatioBps}`,
    `Risk Level: ${report.riskLevel}`,
    'Findings:',
    ...report.findings.map((finding) => `  - ${finding}`),
    `Caveat: ${report.caveat}`,
  ];
  return lines.join('\n');
}

export async function run(
  params: RunSequenceConflictReportParams = {},
): Promise<SequenceConflictReport> {
  const report = diagnoseSequenceReplacement({
    targetId: params.targetId ?? DEFAULT_TARGET_ID,
    accountSequence: params.accountSequence ?? 250,
    candidateSequence: params.candidateSequence ?? 100,
    feeBumpMultiplierBps: params.feeBumpMultiplierBps ?? 50,
    thresholdLimit: params.thresholdLimit ?? 1000,
  });
  if (params.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatSequenceConflictReport(report));
  }
  return report;
}
