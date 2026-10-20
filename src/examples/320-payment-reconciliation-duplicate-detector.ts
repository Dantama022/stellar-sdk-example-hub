export interface PaymentReconcileReportInput {
  targetId: string;
  evaluatedPayments: number;
  matchedInvoiceCount: number;
  duplicateCandidateCount: number;
  thresholdLimit?: number;
}

export interface PaymentReconcileReport {
  targetId: string;
  evaluatedPayments: number;
  matchedInvoiceCount: number;
  duplicateCandidateCount: number;
  utilizationRatioBps: number;
  riskLevel: 'low' | 'moderate' | 'elevated';
  findings: string[];
  caveat: string;
}

export interface RunPaymentReconcileReportParams {
  targetId?: string;
  evaluatedPayments?: number;
  matchedInvoiceCount?: number;
  duplicateCandidateCount?: number;
  thresholdLimit?: number;
  json?: boolean;
}

const DEFAULT_TARGET_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export function detectDuplicatePayments(
  input: PaymentReconcileReportInput,
): PaymentReconcileReport {
  const targetId = input.targetId.trim() || DEFAULT_TARGET_ID;
  const v1 = Math.max(0, Math.trunc(input.evaluatedPayments));
  const v2 = Math.max(0, Math.trunc(input.matchedInvoiceCount));
  const v3 = Math.max(0, Math.trunc(input.duplicateCandidateCount));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationRatioBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  const findings: string[] = [];

  let riskLevel: 'low' | 'moderate' | 'elevated' = 'low';
  if (utilizationRatioBps >= 8000 || v3 > limit) {
    riskLevel = 'elevated';
    findings.push(
      `Elevated metric threshold reached: utilization=${utilizationRatioBps}bps (duplicateCandidateCount=${v3} vs limit=${limit}).`,
    );
  } else if (utilizationRatioBps >= 5000 || v2 > 0) {
    riskLevel = 'moderate';
    findings.push(
      `Moderate activity observed for ${targetId}: evaluatedPayments=${v1}, matchedInvoiceCount=${v2}.`,
    );
  } else {
    findings.push(`Nominal metrics observed for ${targetId} within configured bounds.`);
  }

  return {
    targetId,
    evaluatedPayments: v1,
    matchedInvoiceCount: v2,
    duplicateCandidateCount: v3,
    utilizationRatioBps,
    riskLevel,
    findings,
    caveat: 'Duplicate heuristics flag matching memo and amount within the time window.',
  };
}

export function formatPaymentReconcileReport(report: PaymentReconcileReport): string {
  const lines = [
    '=== 320-payment-reconciliation-duplicate-detector ===',
    `Target: ${report.targetId}`,
    `evaluatedPayments: ${report.evaluatedPayments}`,
    `matchedInvoiceCount: ${report.matchedInvoiceCount}`,
    `duplicateCandidateCount: ${report.duplicateCandidateCount}`,
    `Utilization (bps): ${report.utilizationRatioBps}`,
    `Risk Level: ${report.riskLevel}`,
    'Findings:',
    ...report.findings.map((finding) => `  - ${finding}`),
    `Caveat: ${report.caveat}`,
  ];
  return lines.join('\n');
}

export async function run(
  params: RunPaymentReconcileReportParams = {},
): Promise<PaymentReconcileReport> {
  const report = detectDuplicatePayments({
    targetId: params.targetId ?? DEFAULT_TARGET_ID,
    evaluatedPayments: params.evaluatedPayments ?? 250,
    matchedInvoiceCount: params.matchedInvoiceCount ?? 100,
    duplicateCandidateCount: params.duplicateCandidateCount ?? 50,
    thresholdLimit: params.thresholdLimit ?? 1000,
  });
  if (params.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatPaymentReconcileReport(report));
  }
  return report;
}
