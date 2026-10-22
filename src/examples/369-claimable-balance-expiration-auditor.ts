export interface ClaimableExpirationReportInput {
  targetId: string;
  claimantCount: number;
  unconditionalClaimants: number;
  expiredPredicateCount: number;
  thresholdLimit?: number;
}

export interface ClaimableExpirationReport {
  targetId: string;
  claimantCount: number;
  unconditionalClaimants: number;
  expiredPredicateCount: number;
  utilizationRatioBps: number;
  riskLevel: 'low' | 'moderate' | 'elevated';
  findings: string[];
  caveat: string;
}

export interface RunClaimableExpirationReportParams {
  targetId?: string;
  claimantCount?: number;
  unconditionalClaimants?: number;
  expiredPredicateCount?: number;
  thresholdLimit?: number;
  json?: boolean;
}

const DEFAULT_TARGET_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export function auditClaimableBalanceExpiration(
  input: ClaimableExpirationReportInput,
): ClaimableExpirationReport {
  const targetId = input.targetId.trim() || DEFAULT_TARGET_ID;
  const v1 = Math.max(0, Math.trunc(input.claimantCount));
  const v2 = Math.max(0, Math.trunc(input.unconditionalClaimants));
  const v3 = Math.max(0, Math.trunc(input.expiredPredicateCount));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationRatioBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  const findings: string[] = [];

  let riskLevel: 'low' | 'moderate' | 'elevated' = 'low';
  if (utilizationRatioBps >= 8000 || v3 > limit) {
    riskLevel = 'elevated';
    findings.push(
      `Elevated metric threshold reached: utilization=${utilizationRatioBps}bps (expiredPredicateCount=${v3} vs limit=${limit}).`,
    );
  } else if (utilizationRatioBps >= 5000 || v2 > 0) {
    riskLevel = 'moderate';
    findings.push(
      `Moderate activity observed for ${targetId}: claimantCount=${v1}, unconditionalClaimants=${v2}.`,
    );
  } else {
    findings.push(`Nominal metrics observed for ${targetId} within configured bounds.`);
  }

  return {
    targetId,
    claimantCount: v1,
    unconditionalClaimants: v2,
    expiredPredicateCount: v3,
    utilizationRatioBps,
    riskLevel,
    findings,
    caveat: 'Predicate evaluation depends on the next ledger close timestamp.',
  };
}

export function formatClaimableExpirationReport(report: ClaimableExpirationReport): string {
  const lines = [
    '=== 369-claimable-balance-expiration-auditor ===',
    `Target: ${report.targetId}`,
    `claimantCount: ${report.claimantCount}`,
    `unconditionalClaimants: ${report.unconditionalClaimants}`,
    `expiredPredicateCount: ${report.expiredPredicateCount}`,
    `Utilization (bps): ${report.utilizationRatioBps}`,
    `Risk Level: ${report.riskLevel}`,
    'Findings:',
    ...report.findings.map((finding) => `  - ${finding}`),
    `Caveat: ${report.caveat}`,
  ];
  return lines.join('\n');
}

export async function run(
  params: RunClaimableExpirationReportParams = {},
): Promise<ClaimableExpirationReport> {
  const report = auditClaimableBalanceExpiration({
    targetId: params.targetId ?? DEFAULT_TARGET_ID,
    claimantCount: params.claimantCount ?? 250,
    unconditionalClaimants: params.unconditionalClaimants ?? 100,
    expiredPredicateCount: params.expiredPredicateCount ?? 50,
    thresholdLimit: params.thresholdLimit ?? 1000,
  });
  if (params.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatClaimableExpirationReport(report));
  }
  return report;
}
