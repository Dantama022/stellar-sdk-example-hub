export interface SepCustomerValidationReportInput {
  targetId: string;
  providedFieldCount: number;
  invalidFieldCount: number;
  missingRequiredCount: number;
  thresholdLimit?: number;
}

export interface SepCustomerValidationReport {
  targetId: string;
  providedFieldCount: number;
  invalidFieldCount: number;
  missingRequiredCount: number;
  utilizationRatioBps: number;
  riskLevel: 'low' | 'moderate' | 'elevated';
  findings: string[];
  caveat: string;
}

export interface RunSepCustomerValidationReportParams {
  targetId?: string;
  providedFieldCount?: number;
  invalidFieldCount?: number;
  missingRequiredCount?: number;
  thresholdLimit?: number;
  json?: boolean;
}

const DEFAULT_TARGET_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export function validateSepCustomerFields(
  input: SepCustomerValidationReportInput,
): SepCustomerValidationReport {
  const targetId = input.targetId.trim() || DEFAULT_TARGET_ID;
  const v1 = Math.max(0, Math.trunc(input.providedFieldCount));
  const v2 = Math.max(0, Math.trunc(input.invalidFieldCount));
  const v3 = Math.max(0, Math.trunc(input.missingRequiredCount));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationRatioBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  const findings: string[] = [];

  let riskLevel: 'low' | 'moderate' | 'elevated' = 'low';
  if (utilizationRatioBps >= 8000 || v3 > limit) {
    riskLevel = 'elevated';
    findings.push(
      `Elevated metric threshold reached: utilization=${utilizationRatioBps}bps (missingRequiredCount=${v3} vs limit=${limit}).`,
    );
  } else if (utilizationRatioBps >= 5000 || v2 > 0) {
    riskLevel = 'moderate';
    findings.push(
      `Moderate activity observed for ${targetId}: providedFieldCount=${v1}, invalidFieldCount=${v2}.`,
    );
  } else {
    findings.push(`Nominal metrics observed for ${targetId} within configured bounds.`);
  }

  return {
    targetId,
    providedFieldCount: v1,
    invalidFieldCount: v2,
    missingRequiredCount: v3,
    utilizationRatioBps,
    riskLevel,
    findings,
    caveat: 'Field syntax validation does not constitute KYC identity verification.',
  };
}

export function formatSepCustomerValidationReport(report: SepCustomerValidationReport): string {
  const lines = [
    '=== 365-sep9-sep12-customer-field-validator ===',
    `Target: ${report.targetId}`,
    `providedFieldCount: ${report.providedFieldCount}`,
    `invalidFieldCount: ${report.invalidFieldCount}`,
    `missingRequiredCount: ${report.missingRequiredCount}`,
    `Utilization (bps): ${report.utilizationRatioBps}`,
    `Risk Level: ${report.riskLevel}`,
    'Findings:',
    ...report.findings.map((finding) => `  - ${finding}`),
    `Caveat: ${report.caveat}`,
  ];
  return lines.join('\n');
}

export async function run(
  params: RunSepCustomerValidationReportParams = {},
): Promise<SepCustomerValidationReport> {
  const report = validateSepCustomerFields({
    targetId: params.targetId ?? DEFAULT_TARGET_ID,
    providedFieldCount: params.providedFieldCount ?? 250,
    invalidFieldCount: params.invalidFieldCount ?? 100,
    missingRequiredCount: params.missingRequiredCount ?? 50,
    thresholdLimit: params.thresholdLimit ?? 1000,
  });
  if (params.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatSepCustomerValidationReport(report));
  }
  return report;
}
