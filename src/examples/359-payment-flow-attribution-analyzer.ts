export interface PaymentAttributionReportInput {
  targetId: string;
  inboundStroops: number;
  outboundStroops: number;
  uniqueCounterparties: number;
  thresholdLimit?: number;
}

export interface PaymentAttributionReport {
  targetId: string;
  inboundStroops: number;
  outboundStroops: number;
  uniqueCounterparties: number;
  utilizationRatioBps: number;
  riskLevel: 'low' | 'moderate' | 'elevated';
  findings: string[];
  caveat: string;
}

export interface RunPaymentAttributionReportParams {
  targetId?: string;
  inboundStroops?: number;
  outboundStroops?: number;
  uniqueCounterparties?: number;
  thresholdLimit?: number;
  json?: boolean;
}

const DEFAULT_TARGET_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export function analyzePaymentFlowAttribution(
  input: PaymentAttributionReportInput,
): PaymentAttributionReport {
  const targetId = input.targetId.trim() || DEFAULT_TARGET_ID;
  const v1 = Math.max(0, Math.trunc(input.inboundStroops));
  const v2 = Math.max(0, Math.trunc(input.outboundStroops));
  const v3 = Math.max(0, Math.trunc(input.uniqueCounterparties));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationRatioBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  const findings: string[] = [];

  let riskLevel: 'low' | 'moderate' | 'elevated' = 'low';
  if (utilizationRatioBps >= 8000 || v3 > limit) {
    riskLevel = 'elevated';
    findings.push(
      `Elevated metric threshold reached: utilization=${utilizationRatioBps}bps (uniqueCounterparties=${v3} vs limit=${limit}).`,
    );
  } else if (utilizationRatioBps >= 5000 || v2 > 0) {
    riskLevel = 'moderate';
    findings.push(
      `Moderate activity observed for ${targetId}: inboundStroops=${v1}, outboundStroops=${v2}.`,
    );
  } else {
    findings.push(`Nominal metrics observed for ${targetId} within configured bounds.`);
  }

  return {
    targetId,
    inboundStroops: v1,
    outboundStroops: v2,
    uniqueCounterparties: v3,
    utilizationRatioBps,
    riskLevel,
    findings,
    caveat: 'Address attribution reflects on-chain transfers, not legal entity ownership.',
  };
}

export function formatPaymentAttributionReport(report: PaymentAttributionReport): string {
  const lines = [
    '=== 359-payment-flow-attribution-analyzer ===',
    `Target: ${report.targetId}`,
    `inboundStroops: ${report.inboundStroops}`,
    `outboundStroops: ${report.outboundStroops}`,
    `uniqueCounterparties: ${report.uniqueCounterparties}`,
    `Utilization (bps): ${report.utilizationRatioBps}`,
    `Risk Level: ${report.riskLevel}`,
    'Findings:',
    ...report.findings.map((finding) => `  - ${finding}`),
    `Caveat: ${report.caveat}`,
  ];
  return lines.join('\n');
}

export async function run(
  params: RunPaymentAttributionReportParams = {},
): Promise<PaymentAttributionReport> {
  const report = analyzePaymentFlowAttribution({
    targetId: params.targetId ?? DEFAULT_TARGET_ID,
    inboundStroops: params.inboundStroops ?? 250,
    outboundStroops: params.outboundStroops ?? 100,
    uniqueCounterparties: params.uniqueCounterparties ?? 50,
    thresholdLimit: params.thresholdLimit ?? 1000,
  });
  if (params.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatPaymentAttributionReport(report));
  }
  return report;
}
