export interface LedgerProtocolReportInput {
  targetId: string;
  protocolVersion: number;
  baseFeeStroops: number;
  maxTxSetSize: number;
  thresholdLimit?: number;
}

export interface LedgerProtocolReport {
  targetId: string;
  protocolVersion: number;
  baseFeeStroops: number;
  maxTxSetSize: number;
  utilizationRatioBps: number;
  riskLevel: 'low' | 'moderate' | 'elevated';
  findings: string[];
  caveat: string;
}

export interface RunLedgerProtocolReportParams {
  targetId?: string;
  protocolVersion?: number;
  baseFeeStroops?: number;
  maxTxSetSize?: number;
  thresholdLimit?: number;
  json?: boolean;
}

const DEFAULT_TARGET_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export function inspectLedgerProtocolTrack(input: LedgerProtocolReportInput): LedgerProtocolReport {
  const targetId = input.targetId.trim() || DEFAULT_TARGET_ID;
  const v1 = Math.max(0, Math.trunc(input.protocolVersion));
  const v2 = Math.max(0, Math.trunc(input.baseFeeStroops));
  const v3 = Math.max(0, Math.trunc(input.maxTxSetSize));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationRatioBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  const findings: string[] = [];

  let riskLevel: 'low' | 'moderate' | 'elevated' = 'low';
  if (utilizationRatioBps >= 8000 || v3 > limit) {
    riskLevel = 'elevated';
    findings.push(
      `Elevated metric threshold reached: utilization=${utilizationRatioBps}bps (maxTxSetSize=${v3} vs limit=${limit}).`,
    );
  } else if (utilizationRatioBps >= 5000 || v2 > 0) {
    riskLevel = 'moderate';
    findings.push(
      `Moderate activity observed for ${targetId}: protocolVersion=${v1}, baseFeeStroops=${v2}.`,
    );
  } else {
    findings.push(`Nominal metrics observed for ${targetId} within configured bounds.`);
  }

  return {
    targetId,
    protocolVersion: v1,
    baseFeeStroops: v2,
    maxTxSetSize: v3,
    utilizationRatioBps,
    riskLevel,
    findings,
    caveat: 'Observing a version change does not prove an upgrade vote transcript.',
  };
}

export function formatLedgerProtocolReport(report: LedgerProtocolReport): string {
  const lines = [
    '=== 380-ledger-header-protocol-tracker ===',
    `Target: ${report.targetId}`,
    `protocolVersion: ${report.protocolVersion}`,
    `baseFeeStroops: ${report.baseFeeStroops}`,
    `maxTxSetSize: ${report.maxTxSetSize}`,
    `Utilization (bps): ${report.utilizationRatioBps}`,
    `Risk Level: ${report.riskLevel}`,
    'Findings:',
    ...report.findings.map((finding) => `  - ${finding}`),
    `Caveat: ${report.caveat}`,
  ];
  return lines.join('\n');
}

export async function run(
  params: RunLedgerProtocolReportParams = {},
): Promise<LedgerProtocolReport> {
  const report = inspectLedgerProtocolTrack({
    targetId: params.targetId ?? DEFAULT_TARGET_ID,
    protocolVersion: params.protocolVersion ?? 250,
    baseFeeStroops: params.baseFeeStroops ?? 100,
    maxTxSetSize: params.maxTxSetSize ?? 50,
    thresholdLimit: params.thresholdLimit ?? 1000,
  });
  if (params.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatLedgerProtocolReport(report));
  }
  return report;
}
