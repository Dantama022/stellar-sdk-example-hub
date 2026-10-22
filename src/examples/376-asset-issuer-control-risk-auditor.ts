export interface IssuerControlRiskReportInput {
  targetId: string;
  authRevocable: number;
  authClawbackEnabled: number;
  masterWeight: number;
  thresholdLimit?: number;
}

export interface IssuerControlRiskReport {
  targetId: string;
  authRevocable: number;
  authClawbackEnabled: number;
  masterWeight: number;
  utilizationRatioBps: number;
  riskLevel: 'low' | 'moderate' | 'elevated';
  findings: string[];
  caveat: string;
}

export interface RunIssuerControlRiskReportParams {
  targetId?: string;
  authRevocable?: number;
  authClawbackEnabled?: number;
  masterWeight?: number;
  thresholdLimit?: number;
  json?: boolean;
}

const DEFAULT_TARGET_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export function auditAssetIssuerControl(
  input: IssuerControlRiskReportInput,
): IssuerControlRiskReport {
  const targetId = input.targetId.trim() || DEFAULT_TARGET_ID;
  const v1 = Math.max(0, Math.trunc(input.authRevocable));
  const v2 = Math.max(0, Math.trunc(input.authClawbackEnabled));
  const v3 = Math.max(0, Math.trunc(input.masterWeight));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationRatioBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  const findings: string[] = [];

  let riskLevel: 'low' | 'moderate' | 'elevated' = 'low';
  if (utilizationRatioBps >= 8000 || v3 > limit) {
    riskLevel = 'elevated';
    findings.push(
      `Elevated metric threshold reached: utilization=${utilizationRatioBps}bps (masterWeight=${v3} vs limit=${limit}).`,
    );
  } else if (utilizationRatioBps >= 5000 || v2 > 0) {
    riskLevel = 'moderate';
    findings.push(
      `Moderate activity observed for ${targetId}: authRevocable=${v1}, authClawbackEnabled=${v2}.`,
    );
  } else {
    findings.push(`Nominal metrics observed for ${targetId} within configured bounds.`);
  }

  return {
    targetId,
    authRevocable: v1,
    authClawbackEnabled: v2,
    masterWeight: v3,
    utilizationRatioBps,
    riskLevel,
    findings,
    caveat: 'Flags indicate technical capability, not issuer intent.',
  };
}

export function formatIssuerControlRiskReport(report: IssuerControlRiskReport): string {
  const lines = [
    '=== 376-asset-issuer-control-risk-auditor ===',
    `Target: ${report.targetId}`,
    `authRevocable: ${report.authRevocable}`,
    `authClawbackEnabled: ${report.authClawbackEnabled}`,
    `masterWeight: ${report.masterWeight}`,
    `Utilization (bps): ${report.utilizationRatioBps}`,
    `Risk Level: ${report.riskLevel}`,
    'Findings:',
    ...report.findings.map((finding) => `  - ${finding}`),
    `Caveat: ${report.caveat}`,
  ];
  return lines.join('\n');
}

export async function run(
  params: RunIssuerControlRiskReportParams = {},
): Promise<IssuerControlRiskReport> {
  const report = auditAssetIssuerControl({
    targetId: params.targetId ?? DEFAULT_TARGET_ID,
    authRevocable: params.authRevocable ?? 250,
    authClawbackEnabled: params.authClawbackEnabled ?? 100,
    masterWeight: params.masterWeight ?? 50,
    thresholdLimit: params.thresholdLimit ?? 1000,
  });
  if (params.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatIssuerControlRiskReport(report));
  }
  return report;
}
