export interface NetworkHealthReportInput {
  targetId: string;
  horizonLatencyMs: number;
  rpcLatencyMs: number;
  ledgerLagCount: number;
  thresholdLimit?: number;
}

export interface NetworkHealthReport {
  targetId: string;
  horizonLatencyMs: number;
  rpcLatencyMs: number;
  ledgerLagCount: number;
  utilizationRatioBps: number;
  riskLevel: 'low' | 'moderate' | 'elevated';
  findings: string[];
  caveat: string;
}

export interface RunNetworkHealthReportParams {
  targetId?: string;
  horizonLatencyMs?: number;
  rpcLatencyMs?: number;
  ledgerLagCount?: number;
  thresholdLimit?: number;
  json?: boolean;
}

const DEFAULT_TARGET_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export function evaluateNetworkHealthStatus(input: NetworkHealthReportInput): NetworkHealthReport {
  const targetId = input.targetId.trim() || DEFAULT_TARGET_ID;
  const v1 = Math.max(0, Math.trunc(input.horizonLatencyMs));
  const v2 = Math.max(0, Math.trunc(input.rpcLatencyMs));
  const v3 = Math.max(0, Math.trunc(input.ledgerLagCount));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationRatioBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  const findings: string[] = [];

  let riskLevel: 'low' | 'moderate' | 'elevated' = 'low';
  if (utilizationRatioBps >= 8000 || v3 > limit) {
    riskLevel = 'elevated';
    findings.push(
      `Elevated metric threshold reached: utilization=${utilizationRatioBps}bps (ledgerLagCount=${v3} vs limit=${limit}).`,
    );
  } else if (utilizationRatioBps >= 5000 || v2 > 0) {
    riskLevel = 'moderate';
    findings.push(
      `Moderate activity observed for ${targetId}: horizonLatencyMs=${v1}, rpcLatencyMs=${v2}.`,
    );
  } else {
    findings.push(`Nominal metrics observed for ${targetId} within configured bounds.`);
  }

  return {
    targetId,
    horizonLatencyMs: v1,
    rpcLatencyMs: v2,
    ledgerLagCount: v3,
    utilizationRatioBps,
    riskLevel,
    findings,
    caveat: 'Health probes measure point-in-time responsiveness from the caller host.',
  };
}

export function formatNetworkHealthReport(report: NetworkHealthReport): string {
  const lines = [
    '=== 319-network-health-horizon-rpc-monitor ===',
    `Target: ${report.targetId}`,
    `horizonLatencyMs: ${report.horizonLatencyMs}`,
    `rpcLatencyMs: ${report.rpcLatencyMs}`,
    `ledgerLagCount: ${report.ledgerLagCount}`,
    `Utilization (bps): ${report.utilizationRatioBps}`,
    `Risk Level: ${report.riskLevel}`,
    'Findings:',
    ...report.findings.map((finding) => `  - ${finding}`),
    `Caveat: ${report.caveat}`,
  ];
  return lines.join('\n');
}

export async function run(params: RunNetworkHealthReportParams = {}): Promise<NetworkHealthReport> {
  const report = evaluateNetworkHealthStatus({
    targetId: params.targetId ?? DEFAULT_TARGET_ID,
    horizonLatencyMs: params.horizonLatencyMs ?? 250,
    rpcLatencyMs: params.rpcLatencyMs ?? 100,
    ledgerLagCount: params.ledgerLagCount ?? 50,
    thresholdLimit: params.thresholdLimit ?? 1000,
  });
  if (params.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatNetworkHealthReport(report));
  }
  return report;
}
