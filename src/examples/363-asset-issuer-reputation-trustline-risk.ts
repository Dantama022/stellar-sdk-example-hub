export interface TrustlineRiskReportInput {
  targetId: string;
  homeDomainVerified: number;
  clawbackEnabled: number;
  riskScoreBps: number;
  thresholdLimit?: number;
}

export interface TrustlineRiskReport {
  targetId: string;
  homeDomainVerified: number;
  clawbackEnabled: number;
  riskScoreBps: number;
  utilizationRatioBps: number;
  riskLevel: 'low' | 'moderate' | 'elevated';
  findings: string[];
  caveat: string;
}

export interface RunTrustlineRiskReportParams {
  targetId?: string;
  homeDomainVerified?: number;
  clawbackEnabled?: number;
  riskScoreBps?: number;
  thresholdLimit?: number;
  json?: boolean;
}

const DEFAULT_TARGET_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export function assessIssuerTrustlineRisk(input: TrustlineRiskReportInput): TrustlineRiskReport {
  const targetId = input.targetId.trim() || DEFAULT_TARGET_ID;
  const v1 = Math.max(0, Math.trunc(input.homeDomainVerified));
  const v2 = Math.max(0, Math.trunc(input.clawbackEnabled));
  const v3 = Math.max(0, Math.trunc(input.riskScoreBps));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationRatioBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  const findings: string[] = [];

  let riskLevel: 'low' | 'moderate' | 'elevated' = 'low';
  if (utilizationRatioBps >= 8000 || v3 > limit) {
    riskLevel = 'elevated';
    findings.push(
      `Elevated metric threshold reached: utilization=${utilizationRatioBps}bps (riskScoreBps=${v3} vs limit=${limit}).`,
    );
  } else if (utilizationRatioBps >= 5000 || v2 > 0) {
    riskLevel = 'moderate';
    findings.push(
      `Moderate activity observed for ${targetId}: homeDomainVerified=${v1}, clawbackEnabled=${v2}.`,
    );
  } else {
    findings.push(`Nominal metrics observed for ${targetId} within configured bounds.`);
  }

  return {
    targetId,
    homeDomainVerified: v1,
    clawbackEnabled: v2,
    riskScoreBps: v3,
    utilizationRatioBps,
    riskLevel,
    findings,
    caveat: 'Risk scores summarize on-chain flags and are not investment advice.',
  };
}

export function formatTrustlineRiskReport(report: TrustlineRiskReport): string {
  const lines = [
    '=== 363-asset-issuer-reputation-trustline-risk ===',
    `Target: ${report.targetId}`,
    `homeDomainVerified: ${report.homeDomainVerified}`,
    `clawbackEnabled: ${report.clawbackEnabled}`,
    `riskScoreBps: ${report.riskScoreBps}`,
    `Utilization (bps): ${report.utilizationRatioBps}`,
    `Risk Level: ${report.riskLevel}`,
    'Findings:',
    ...report.findings.map((finding) => `  - ${finding}`),
    `Caveat: ${report.caveat}`,
  ];
  return lines.join('\n');
}

export async function run(params: RunTrustlineRiskReportParams = {}): Promise<TrustlineRiskReport> {
  const report = assessIssuerTrustlineRisk({
    targetId: params.targetId ?? DEFAULT_TARGET_ID,
    homeDomainVerified: params.homeDomainVerified ?? 250,
    clawbackEnabled: params.clawbackEnabled ?? 100,
    riskScoreBps: params.riskScoreBps ?? 50,
    thresholdLimit: params.thresholdLimit ?? 1000,
  });
  if (params.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatTrustlineRiskReport(report));
  }
  return report;
}
