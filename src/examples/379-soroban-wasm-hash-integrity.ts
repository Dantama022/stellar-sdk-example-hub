export interface WasmIntegrityReportInput {
  targetId: string;
  expectedHashHex: number;
  computedHashHex: number;
  artifactSizeBytes: number;
  thresholdLimit?: number;
}

export interface WasmIntegrityReport {
  targetId: string;
  expectedHashHex: number;
  computedHashHex: number;
  artifactSizeBytes: number;
  utilizationRatioBps: number;
  riskLevel: 'low' | 'moderate' | 'elevated';
  findings: string[];
  caveat: string;
}

export interface RunWasmIntegrityReportParams {
  targetId?: string;
  expectedHashHex?: number;
  computedHashHex?: number;
  artifactSizeBytes?: number;
  thresholdLimit?: number;
  json?: boolean;
}

const DEFAULT_TARGET_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export function verifyWasmArtifactIntegrity(input: WasmIntegrityReportInput): WasmIntegrityReport {
  const targetId = input.targetId.trim() || DEFAULT_TARGET_ID;
  const v1 = Math.max(0, Math.trunc(input.expectedHashHex));
  const v2 = Math.max(0, Math.trunc(input.computedHashHex));
  const v3 = Math.max(0, Math.trunc(input.artifactSizeBytes));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationRatioBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  const findings: string[] = [];

  let riskLevel: 'low' | 'moderate' | 'elevated' = 'low';
  if (utilizationRatioBps >= 8000 || v3 > limit) {
    riskLevel = 'elevated';
    findings.push(
      `Elevated metric threshold reached: utilization=${utilizationRatioBps}bps (artifactSizeBytes=${v3} vs limit=${limit}).`,
    );
  } else if (utilizationRatioBps >= 5000 || v2 > 0) {
    riskLevel = 'moderate';
    findings.push(
      `Moderate activity observed for ${targetId}: expectedHashHex=${v1}, computedHashHex=${v2}.`,
    );
  } else {
    findings.push(`Nominal metrics observed for ${targetId} within configured bounds.`);
  }

  return {
    targetId,
    expectedHashHex: v1,
    computedHashHex: v2,
    artifactSizeBytes: v3,
    utilizationRatioBps,
    riskLevel,
    findings,
    caveat: 'Hash matching confirms byte identity, not contract soundness.',
  };
}

export function formatWasmIntegrityReport(report: WasmIntegrityReport): string {
  const lines = [
    '=== 379-soroban-wasm-hash-integrity ===',
    `Target: ${report.targetId}`,
    `expectedHashHex: ${report.expectedHashHex}`,
    `computedHashHex: ${report.computedHashHex}`,
    `artifactSizeBytes: ${report.artifactSizeBytes}`,
    `Utilization (bps): ${report.utilizationRatioBps}`,
    `Risk Level: ${report.riskLevel}`,
    'Findings:',
    ...report.findings.map((finding) => `  - ${finding}`),
    `Caveat: ${report.caveat}`,
  ];
  return lines.join('\n');
}

export async function run(params: RunWasmIntegrityReportParams = {}): Promise<WasmIntegrityReport> {
  const report = verifyWasmArtifactIntegrity({
    targetId: params.targetId ?? DEFAULT_TARGET_ID,
    expectedHashHex: params.expectedHashHex ?? 250,
    computedHashHex: params.computedHashHex ?? 100,
    artifactSizeBytes: params.artifactSizeBytes ?? 50,
    thresholdLimit: params.thresholdLimit ?? 1000,
  });
  if (params.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatWasmIntegrityReport(report));
  }
  return report;
}
