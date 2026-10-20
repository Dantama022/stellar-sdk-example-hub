export interface XdrSignatureSafetyReportInput {
  targetId: string;
  signatureCount: number;
  verifiedSignaturesCount: number;
  unboundedTimebounds: number;
  thresholdLimit?: number;
}

export interface XdrSignatureSafetyReport {
  targetId: string;
  signatureCount: number;
  verifiedSignaturesCount: number;
  unboundedTimebounds: number;
  utilizationRatioBps: number;
  riskLevel: 'low' | 'moderate' | 'elevated';
  findings: string[];
  caveat: string;
}

export interface RunXdrSignatureSafetyReportParams {
  targetId?: string;
  signatureCount?: number;
  verifiedSignaturesCount?: number;
  unboundedTimebounds?: number;
  thresholdLimit?: number;
  json?: boolean;
}

const DEFAULT_TARGET_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export function inspectXdrSignatureSafety(
  input: XdrSignatureSafetyReportInput,
): XdrSignatureSafetyReport {
  const targetId = input.targetId.trim() || DEFAULT_TARGET_ID;
  const v1 = Math.max(0, Math.trunc(input.signatureCount));
  const v2 = Math.max(0, Math.trunc(input.verifiedSignaturesCount));
  const v3 = Math.max(0, Math.trunc(input.unboundedTimebounds));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationRatioBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  const findings: string[] = [];

  let riskLevel: 'low' | 'moderate' | 'elevated' = 'low';
  if (utilizationRatioBps >= 8000 || v3 > limit) {
    riskLevel = 'elevated';
    findings.push(
      `Elevated metric threshold reached: utilization=${utilizationRatioBps}bps (unboundedTimebounds=${v3} vs limit=${limit}).`,
    );
  } else if (utilizationRatioBps >= 5000 || v2 > 0) {
    riskLevel = 'moderate';
    findings.push(
      `Moderate activity observed for ${targetId}: signatureCount=${v1}, verifiedSignaturesCount=${v2}.`,
    );
  } else {
    findings.push(`Nominal metrics observed for ${targetId} within configured bounds.`);
  }

  return {
    targetId,
    signatureCount: v1,
    verifiedSignaturesCount: v2,
    unboundedTimebounds: v3,
    utilizationRatioBps,
    riskLevel,
    findings,
    caveat: 'Signature verification checks cryptographic validity against provided keys.',
  };
}

export function formatXdrSignatureSafetyReport(report: XdrSignatureSafetyReport): string {
  const lines = [
    '=== 322-tx-xdr-signature-safety-inspector ===',
    `Target: ${report.targetId}`,
    `signatureCount: ${report.signatureCount}`,
    `verifiedSignaturesCount: ${report.verifiedSignaturesCount}`,
    `unboundedTimebounds: ${report.unboundedTimebounds}`,
    `Utilization (bps): ${report.utilizationRatioBps}`,
    `Risk Level: ${report.riskLevel}`,
    'Findings:',
    ...report.findings.map((finding) => `  - ${finding}`),
    `Caveat: ${report.caveat}`,
  ];
  return lines.join('\n');
}

export async function run(
  params: RunXdrSignatureSafetyReportParams = {},
): Promise<XdrSignatureSafetyReport> {
  const report = inspectXdrSignatureSafety({
    targetId: params.targetId ?? DEFAULT_TARGET_ID,
    signatureCount: params.signatureCount ?? 250,
    verifiedSignaturesCount: params.verifiedSignaturesCount ?? 100,
    unboundedTimebounds: params.unboundedTimebounds ?? 50,
    thresholdLimit: params.thresholdLimit ?? 1000,
  });
  if (params.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatXdrSignatureSafetyReport(report));
  }
  return report;
}
