export interface OperationXdrSummaryReportInput {
  targetId: string;
  operationCount: number;
  paymentOpCount: number;
  invokeHostFunctionCount: number;
  thresholdLimit?: number;
}

export interface OperationXdrSummaryReport {
  targetId: string;
  operationCount: number;
  paymentOpCount: number;
  invokeHostFunctionCount: number;
  utilizationRatioBps: number;
  riskLevel: 'low' | 'moderate' | 'elevated';
  findings: string[];
  caveat: string;
}

export interface RunOperationXdrSummaryReportParams {
  targetId?: string;
  operationCount?: number;
  paymentOpCount?: number;
  invokeHostFunctionCount?: number;
  thresholdLimit?: number;
  json?: boolean;
}

const DEFAULT_TARGET_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export function summarizeTransactionOperations(
  input: OperationXdrSummaryReportInput,
): OperationXdrSummaryReport {
  const targetId = input.targetId.trim() || DEFAULT_TARGET_ID;
  const v1 = Math.max(0, Math.trunc(input.operationCount));
  const v2 = Math.max(0, Math.trunc(input.paymentOpCount));
  const v3 = Math.max(0, Math.trunc(input.invokeHostFunctionCount));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationRatioBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  const findings: string[] = [];

  let riskLevel: 'low' | 'moderate' | 'elevated' = 'low';
  if (utilizationRatioBps >= 8000 || v3 > limit) {
    riskLevel = 'elevated';
    findings.push(
      `Elevated metric threshold reached: utilization=${utilizationRatioBps}bps (invokeHostFunctionCount=${v3} vs limit=${limit}).`,
    );
  } else if (utilizationRatioBps >= 5000 || v2 > 0) {
    riskLevel = 'moderate';
    findings.push(
      `Moderate activity observed for ${targetId}: operationCount=${v1}, paymentOpCount=${v2}.`,
    );
  } else {
    findings.push(`Nominal metrics observed for ${targetId} within configured bounds.`);
  }

  return {
    targetId,
    operationCount: v1,
    paymentOpCount: v2,
    invokeHostFunctionCount: v3,
    utilizationRatioBps,
    riskLevel,
    findings,
    caveat: 'Human-readable summaries are informational; signers must verify raw XDR.',
  };
}

export function formatOperationXdrSummaryReport(report: OperationXdrSummaryReport): string {
  const lines = [
    '=== 352-tx-operation-xdr-human-summary ===',
    `Target: ${report.targetId}`,
    `operationCount: ${report.operationCount}`,
    `paymentOpCount: ${report.paymentOpCount}`,
    `invokeHostFunctionCount: ${report.invokeHostFunctionCount}`,
    `Utilization (bps): ${report.utilizationRatioBps}`,
    `Risk Level: ${report.riskLevel}`,
    'Findings:',
    ...report.findings.map((finding) => `  - ${finding}`),
    `Caveat: ${report.caveat}`,
  ];
  return lines.join('\n');
}

export async function run(
  params: RunOperationXdrSummaryReportParams = {},
): Promise<OperationXdrSummaryReport> {
  const report = summarizeTransactionOperations({
    targetId: params.targetId ?? DEFAULT_TARGET_ID,
    operationCount: params.operationCount ?? 250,
    paymentOpCount: params.paymentOpCount ?? 100,
    invokeHostFunctionCount: params.invokeHostFunctionCount ?? 50,
    thresholdLimit: params.thresholdLimit ?? 1000,
  });
  if (params.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatOperationXdrSummaryReport(report));
  }
  return report;
}
