export interface Sep45InteropReportInput {
  targetId: string;
  contractAddressValid: number;
  supportsCheckAuth: number;
  domainBindingVerified: number;
  thresholdLimit?: number;
}

export interface Sep45InteropReport {
  targetId: string;
  contractAddressValid: number;
  supportsCheckAuth: number;
  domainBindingVerified: number;
  utilizationRatioBps: number;
  riskLevel: 'low' | 'moderate' | 'elevated';
  findings: string[];
  caveat: string;
}

export interface RunSep45InteropReportParams {
  targetId?: string;
  contractAddressValid?: number;
  supportsCheckAuth?: number;
  domainBindingVerified?: number;
  thresholdLimit?: number;
  json?: boolean;
}

const DEFAULT_TARGET_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export function inspectSep45ContractAccount(input: Sep45InteropReportInput): Sep45InteropReport {
  const targetId = input.targetId.trim() || DEFAULT_TARGET_ID;
  const v1 = Math.max(0, Math.trunc(input.contractAddressValid));
  const v2 = Math.max(0, Math.trunc(input.supportsCheckAuth));
  const v3 = Math.max(0, Math.trunc(input.domainBindingVerified));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationRatioBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  const findings: string[] = [];

  let riskLevel: 'low' | 'moderate' | 'elevated' = 'low';
  if (utilizationRatioBps >= 8000 || v3 > limit) {
    riskLevel = 'elevated';
    findings.push(
      `Elevated metric threshold reached: utilization=${utilizationRatioBps}bps (domainBindingVerified=${v3} vs limit=${limit}).`,
    );
  } else if (utilizationRatioBps >= 5000 || v2 > 0) {
    riskLevel = 'moderate';
    findings.push(
      `Moderate activity observed for ${targetId}: contractAddressValid=${v1}, supportsCheckAuth=${v2}.`,
    );
  } else {
    findings.push(`Nominal metrics observed for ${targetId} within configured bounds.`);
  }

  return {
    targetId,
    contractAddressValid: v1,
    supportsCheckAuth: v2,
    domainBindingVerified: v3,
    utilizationRatioBps,
    riskLevel,
    findings,
    caveat: 'SEP-45 inspection checks interface conventions without live auth signing.',
  };
}

export function formatSep45InteropReport(report: Sep45InteropReport): string {
  const lines = [
    '=== 340-sep45-contract-account-interoperability ===',
    `Target: ${report.targetId}`,
    `contractAddressValid: ${report.contractAddressValid}`,
    `supportsCheckAuth: ${report.supportsCheckAuth}`,
    `domainBindingVerified: ${report.domainBindingVerified}`,
    `Utilization (bps): ${report.utilizationRatioBps}`,
    `Risk Level: ${report.riskLevel}`,
    'Findings:',
    ...report.findings.map((finding) => `  - ${finding}`),
    `Caveat: ${report.caveat}`,
  ];
  return lines.join('\n');
}

export async function run(params: RunSep45InteropReportParams = {}): Promise<Sep45InteropReport> {
  const report = inspectSep45ContractAccount({
    targetId: params.targetId ?? DEFAULT_TARGET_ID,
    contractAddressValid: params.contractAddressValid ?? 250,
    supportsCheckAuth: params.supportsCheckAuth ?? 100,
    domainBindingVerified: params.domainBindingVerified ?? 50,
    thresholdLimit: params.thresholdLimit ?? 1000,
  });
  if (params.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatSep45InteropReport(report));
  }
  return report;
}
