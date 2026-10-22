export interface SponsorshipReconcileReportInput {
  targetId: string;
  expectedReserveStroops: number;
  actualReserveStroops: number;
  discrepancyStroops: number;
  thresholdLimit?: number;
}

export interface SponsorshipReconcileReport {
  targetId: string;
  expectedReserveStroops: number;
  actualReserveStroops: number;
  discrepancyStroops: number;
  utilizationRatioBps: number;
  riskLevel: 'low' | 'moderate' | 'elevated';
  findings: string[];
  caveat: string;
}

export interface RunSponsorshipReconcileReportParams {
  targetId?: string;
  expectedReserveStroops?: number;
  actualReserveStroops?: number;
  discrepancyStroops?: number;
  thresholdLimit?: number;
  json?: boolean;
}

const DEFAULT_TARGET_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export function reconcileSponsorshipReserves(
  input: SponsorshipReconcileReportInput,
): SponsorshipReconcileReport {
  const targetId = input.targetId.trim() || DEFAULT_TARGET_ID;
  const v1 = Math.max(0, Math.trunc(input.expectedReserveStroops));
  const v2 = Math.max(0, Math.trunc(input.actualReserveStroops));
  const v3 = Math.max(0, Math.trunc(input.discrepancyStroops));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationRatioBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  const findings: string[] = [];

  let riskLevel: 'low' | 'moderate' | 'elevated' = 'low';
  if (utilizationRatioBps >= 8000 || v3 > limit) {
    riskLevel = 'elevated';
    findings.push(
      `Elevated metric threshold reached: utilization=${utilizationRatioBps}bps (discrepancyStroops=${v3} vs limit=${limit}).`,
    );
  } else if (utilizationRatioBps >= 5000 || v2 > 0) {
    riskLevel = 'moderate';
    findings.push(
      `Moderate activity observed for ${targetId}: expectedReserveStroops=${v1}, actualReserveStroops=${v2}.`,
    );
  } else {
    findings.push(`Nominal metrics observed for ${targetId} within configured bounds.`);
  }

  return {
    targetId,
    expectedReserveStroops: v1,
    actualReserveStroops: v2,
    discrepancyStroops: v3,
    utilizationRatioBps,
    riskLevel,
    findings,
    caveat: 'Reserve reconciliation uses the active network base reserve.',
  };
}

export function formatSponsorshipReconcileReport(report: SponsorshipReconcileReport): string {
  const lines = [
    '=== 353-sponsorship-reconciliation-reserve-verifier ===',
    `Target: ${report.targetId}`,
    `expectedReserveStroops: ${report.expectedReserveStroops}`,
    `actualReserveStroops: ${report.actualReserveStroops}`,
    `discrepancyStroops: ${report.discrepancyStroops}`,
    `Utilization (bps): ${report.utilizationRatioBps}`,
    `Risk Level: ${report.riskLevel}`,
    'Findings:',
    ...report.findings.map((finding) => `  - ${finding}`),
    `Caveat: ${report.caveat}`,
  ];
  return lines.join('\n');
}

export async function run(
  params: RunSponsorshipReconcileReportParams = {},
): Promise<SponsorshipReconcileReport> {
  const report = reconcileSponsorshipReserves({
    targetId: params.targetId ?? DEFAULT_TARGET_ID,
    expectedReserveStroops: params.expectedReserveStroops ?? 250,
    actualReserveStroops: params.actualReserveStroops ?? 100,
    discrepancyStroops: params.discrepancyStroops ?? 50,
    thresholdLimit: params.thresholdLimit ?? 1000,
  });
  if (params.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatSponsorshipReconcileReport(report));
  }
  return report;
}
