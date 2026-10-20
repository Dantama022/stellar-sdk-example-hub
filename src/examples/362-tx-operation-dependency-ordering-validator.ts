export interface OpOrderingValidationReportInput {
  targetId: string;
  totalOperations: number;
  dependencyViolationCount: number;
  createdAccountCount: number;
  thresholdLimit?: number;
}

export interface OpOrderingValidationReport {
  targetId: string;
  totalOperations: number;
  dependencyViolationCount: number;
  createdAccountCount: number;
  utilizationRatioBps: number;
  riskLevel: 'low' | 'moderate' | 'elevated';
  findings: string[];
  caveat: string;
}

export interface RunOpOrderingValidationReportParams {
  targetId?: string;
  totalOperations?: number;
  dependencyViolationCount?: number;
  createdAccountCount?: number;
  thresholdLimit?: number;
  json?: boolean;
}

const DEFAULT_TARGET_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export function validateOperationOrdering(
  input: OpOrderingValidationReportInput,
): OpOrderingValidationReport {
  const targetId = input.targetId.trim() || DEFAULT_TARGET_ID;
  const v1 = Math.max(0, Math.trunc(input.totalOperations));
  const v2 = Math.max(0, Math.trunc(input.dependencyViolationCount));
  const v3 = Math.max(0, Math.trunc(input.createdAccountCount));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationRatioBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  const findings: string[] = [];

  let riskLevel: 'low' | 'moderate' | 'elevated' = 'low';
  if (utilizationRatioBps >= 8000 || v3 > limit) {
    riskLevel = 'elevated';
    findings.push(
      `Elevated metric threshold reached: utilization=${utilizationRatioBps}bps (createdAccountCount=${v3} vs limit=${limit}).`,
    );
  } else if (utilizationRatioBps >= 5000 || v2 > 0) {
    riskLevel = 'moderate';
    findings.push(
      `Moderate activity observed for ${targetId}: totalOperations=${v1}, dependencyViolationCount=${v2}.`,
    );
  } else {
    findings.push(`Nominal metrics observed for ${targetId} within configured bounds.`);
  }

  return {
    targetId,
    totalOperations: v1,
    dependencyViolationCount: v2,
    createdAccountCount: v3,
    utilizationRatioBps,
    riskLevel,
    findings,
    caveat: 'Static operation ordering checks assume sequential atomic execution.',
  };
}

export function formatOpOrderingValidationReport(report: OpOrderingValidationReport): string {
  const lines = [
    '=== 362-tx-operation-dependency-ordering-validator ===',
    `Target: ${report.targetId}`,
    `totalOperations: ${report.totalOperations}`,
    `dependencyViolationCount: ${report.dependencyViolationCount}`,
    `createdAccountCount: ${report.createdAccountCount}`,
    `Utilization (bps): ${report.utilizationRatioBps}`,
    `Risk Level: ${report.riskLevel}`,
    'Findings:',
    ...report.findings.map((finding) => `  - ${finding}`),
    `Caveat: ${report.caveat}`,
  ];
  return lines.join('\n');
}

export async function run(
  params: RunOpOrderingValidationReportParams = {},
): Promise<OpOrderingValidationReport> {
  const report = validateOperationOrdering({
    targetId: params.targetId ?? DEFAULT_TARGET_ID,
    totalOperations: params.totalOperations ?? 250,
    dependencyViolationCount: params.dependencyViolationCount ?? 100,
    createdAccountCount: params.createdAccountCount ?? 50,
    thresholdLimit: params.thresholdLimit ?? 1000,
  });
  if (params.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatOpOrderingValidationReport(report));
  }
  return report;
}
