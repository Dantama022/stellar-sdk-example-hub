export interface SponsorshipGraphReportInput {
  targetId: string;
  sponsoredEntriesCount: number;
  sponsoringEntriesCount: number;
  netReserveImpactStroops: number;
  thresholdLimit?: number;
}

export interface SponsorshipGraphReport {
  targetId: string;
  sponsoredEntriesCount: number;
  sponsoringEntriesCount: number;
  netReserveImpactStroops: number;
  utilizationRatioBps: number;
  riskLevel: 'low' | 'moderate' | 'elevated';
  findings: string[];
  caveat: string;
}

export interface RunSponsorshipGraphReportParams {
  targetId?: string;
  sponsoredEntriesCount?: number;
  sponsoringEntriesCount?: number;
  netReserveImpactStroops?: number;
  thresholdLimit?: number;
  json?: boolean;
}

const DEFAULT_TARGET_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export function analyzeAccountSponsorshipGraph(
  input: SponsorshipGraphReportInput,
): SponsorshipGraphReport {
  const targetId = input.targetId.trim() || DEFAULT_TARGET_ID;
  const v1 = Math.max(0, Math.trunc(input.sponsoredEntriesCount));
  const v2 = Math.max(0, Math.trunc(input.sponsoringEntriesCount));
  const v3 = Math.max(0, Math.trunc(input.netReserveImpactStroops));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationRatioBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  const findings: string[] = [];

  let riskLevel: 'low' | 'moderate' | 'elevated' = 'low';
  if (utilizationRatioBps >= 8000 || v3 > limit) {
    riskLevel = 'elevated';
    findings.push(
      `Elevated metric threshold reached: utilization=${utilizationRatioBps}bps (netReserveImpactStroops=${v3} vs limit=${limit}).`,
    );
  } else if (utilizationRatioBps >= 5000 || v2 > 0) {
    riskLevel = 'moderate';
    findings.push(
      `Moderate activity observed for ${targetId}: sponsoredEntriesCount=${v1}, sponsoringEntriesCount=${v2}.`,
    );
  } else {
    findings.push(`Nominal metrics observed for ${targetId} within configured bounds.`);
  }

  return {
    targetId,
    sponsoredEntriesCount: v1,
    sponsoringEntriesCount: v2,
    netReserveImpactStroops: v3,
    utilizationRatioBps,
    riskLevel,
    findings,
    caveat: 'Sponsorship transfers minimum balance obligation, not asset ownership.',
  };
}

export function formatSponsorshipGraphReport(report: SponsorshipGraphReport): string {
  const lines = [
    '=== 358-account-sponsorship-graph-analyzer ===',
    `Target: ${report.targetId}`,
    `sponsoredEntriesCount: ${report.sponsoredEntriesCount}`,
    `sponsoringEntriesCount: ${report.sponsoringEntriesCount}`,
    `netReserveImpactStroops: ${report.netReserveImpactStroops}`,
    `Utilization (bps): ${report.utilizationRatioBps}`,
    `Risk Level: ${report.riskLevel}`,
    'Findings:',
    ...report.findings.map((finding) => `  - ${finding}`),
    `Caveat: ${report.caveat}`,
  ];
  return lines.join('\n');
}

export async function run(
  params: RunSponsorshipGraphReportParams = {},
): Promise<SponsorshipGraphReport> {
  const report = analyzeAccountSponsorshipGraph({
    targetId: params.targetId ?? DEFAULT_TARGET_ID,
    sponsoredEntriesCount: params.sponsoredEntriesCount ?? 250,
    sponsoringEntriesCount: params.sponsoringEntriesCount ?? 100,
    netReserveImpactStroops: params.netReserveImpactStroops ?? 50,
    thresholdLimit: params.thresholdLimit ?? 1000,
  });
  if (params.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatSponsorshipGraphReport(report));
  }
  return report;
}
