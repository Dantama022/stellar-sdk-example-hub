export interface SequenceCoordinatorReportInput {
  targetId: string;
  baseSequence: number;
  allocatedCount: number;
  gapDetectedCount: number;
  thresholdLimit?: number;
}

export interface SequenceCoordinatorReport {
  targetId: string;
  baseSequence: number;
  allocatedCount: number;
  gapDetectedCount: number;
  utilizationRatioBps: number;
  riskLevel: 'low' | 'moderate' | 'elevated';
  findings: string[];
  caveat: string;
}

export interface RunSequenceCoordinatorReportParams {
  targetId?: string;
  baseSequence?: number;
  allocatedCount?: number;
  gapDetectedCount?: number;
  thresholdLimit?: number;
  json?: boolean;
}

const DEFAULT_TARGET_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export function coordinateConcurrentSequences(
  input: SequenceCoordinatorReportInput,
): SequenceCoordinatorReport {
  const targetId = input.targetId.trim() || DEFAULT_TARGET_ID;
  const v1 = Math.max(0, Math.trunc(input.baseSequence));
  const v2 = Math.max(0, Math.trunc(input.allocatedCount));
  const v3 = Math.max(0, Math.trunc(input.gapDetectedCount));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationRatioBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  const findings: string[] = [];

  let riskLevel: 'low' | 'moderate' | 'elevated' = 'low';
  if (utilizationRatioBps >= 8000 || v3 > limit) {
    riskLevel = 'elevated';
    findings.push(
      `Elevated metric threshold reached: utilization=${utilizationRatioBps}bps (gapDetectedCount=${v3} vs limit=${limit}).`,
    );
  } else if (utilizationRatioBps >= 5000 || v2 > 0) {
    riskLevel = 'moderate';
    findings.push(
      `Moderate activity observed for ${targetId}: baseSequence=${v1}, allocatedCount=${v2}.`,
    );
  } else {
    findings.push(`Nominal metrics observed for ${targetId} within configured bounds.`);
  }

  return {
    targetId,
    baseSequence: v1,
    allocatedCount: v2,
    gapDetectedCount: v3,
    utilizationRatioBps,
    riskLevel,
    findings,
    caveat: 'Sequence coordination requires fee-bump or channel accounts for parallelism.',
  };
}

export function formatSequenceCoordinatorReport(report: SequenceCoordinatorReport): string {
  const lines = [
    '=== 366-account-sequence-concurrent-coordinator ===',
    `Target: ${report.targetId}`,
    `baseSequence: ${report.baseSequence}`,
    `allocatedCount: ${report.allocatedCount}`,
    `gapDetectedCount: ${report.gapDetectedCount}`,
    `Utilization (bps): ${report.utilizationRatioBps}`,
    `Risk Level: ${report.riskLevel}`,
    'Findings:',
    ...report.findings.map((finding) => `  - ${finding}`),
    `Caveat: ${report.caveat}`,
  ];
  return lines.join('\n');
}

export async function run(
  params: RunSequenceCoordinatorReportParams = {},
): Promise<SequenceCoordinatorReport> {
  const report = coordinateConcurrentSequences({
    targetId: params.targetId ?? DEFAULT_TARGET_ID,
    baseSequence: params.baseSequence ?? 250,
    allocatedCount: params.allocatedCount ?? 100,
    gapDetectedCount: params.gapDetectedCount ?? 50,
    thresholdLimit: params.thresholdLimit ?? 1000,
  });
  if (params.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatSequenceCoordinatorReport(report));
  }
  return report;
}
