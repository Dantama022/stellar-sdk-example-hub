import { Horizon } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_ACCOUNT_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export interface AccountSignerInput {
  key: string;
  type: string;
  weight: number;
}

export interface ThresholdInput {
  low_threshold: number;
  med_threshold: number;
  high_threshold: number;
}

export interface SignerAuditReport {
  accountId: string;
  signers: Array<AccountSignerInput & { isMasterKey: boolean }>;
  thresholds: Array<{
    name: 'low' | 'medium' | 'high';
    requiredWeight: number;
    maximumConfiguredWeight: number;
    configurationCanMeetThreshold: boolean;
    missingWeight: number;
  }>;
  masterKeyWeight: number;
  additionalSignerCount: number;
  maximumConfiguredWeight: number;
  findings: string[];
  recoveryCaveat: string;
}

export interface SignerAuditParams {
  accountId?: string;
  horizonUrl?: string;
  json?: boolean | string;
}

export function buildSignerAuditReport(account: {
  account_id: string;
  signers: AccountSignerInput[];
  thresholds: ThresholdInput;
}): SignerAuditReport {
  const signers = account.signers.map((signer) => ({
    key: signer.key,
    type: signer.type,
    weight: signer.weight,
    isMasterKey: signer.key === account.account_id,
  }));
  const maximumConfiguredWeight = signers.reduce((sum, signer) => sum + signer.weight, 0);
  const masterKeyWeight = signers.find((signer) => signer.isMasterKey)?.weight ?? 0;
  const additionalSignerCount = signers.filter(
    (signer) => !signer.isMasterKey && signer.weight > 0,
  ).length;
  const thresholds: SignerAuditReport['thresholds'] = [
    { name: 'low', requiredWeight: account.thresholds.low_threshold },
    { name: 'medium', requiredWeight: account.thresholds.med_threshold },
    { name: 'high', requiredWeight: account.thresholds.high_threshold },
  ].map(({ name, requiredWeight }) => ({
    name,
    requiredWeight,
    maximumConfiguredWeight,
    configurationCanMeetThreshold: maximumConfiguredWeight >= requiredWeight,
    missingWeight: Math.max(0, requiredWeight - maximumConfiguredWeight),
  }));

  const findings: string[] = [];
  for (const threshold of thresholds) {
    if (!threshold.configurationCanMeetThreshold) {
      findings.push(
        `Configured signer weights cannot meet the ${threshold.name} threshold: ` +
          `${maximumConfiguredWeight} available versus ${threshold.requiredWeight} required.`,
      );
    }
  }
  if (masterKeyWeight === 0) {
    findings.push('The master key has weight 0 or is absent from the signer list.');
  }
  if (additionalSignerCount < 2) {
    findings.push(
      `Only ${additionalSignerCount} additional nonzero-weight signer(s) are configured; ` +
        'independent backup signer coverage is not apparent from this account record.',
    );
  }
  if (findings.length === 0) {
    findings.push(
      'Configured weights can meet all listed thresholds, assuming every required signer can provide a valid signature.',
    );
  }

  return {
    accountId: account.account_id,
    signers,
    thresholds,
    masterKeyWeight,
    additionalSignerCount,
    maximumConfiguredWeight,
    findings,
    recoveryCaveat:
      'This is a configuration-only assessment. Horizon cannot verify signing-key custody, ' +
      'availability, signer independence, or the ability to produce valid signatures; it does not ' +
      'confirm that the account can be recovered.',
  };
}

export function formatSignerAuditReport(report: SignerAuditReport): string {
  const lines = [
    '=== Stellar Account Signer and Recovery Readiness Audit ===',
    `Account: ${report.accountId}`,
    `Master key weight: ${report.masterKeyWeight}`,
    `Additional nonzero-weight signers: ${report.additionalSignerCount}`,
    `Maximum configured signer weight: ${report.maximumConfiguredWeight}`,
    '',
    'Signers:',
  ];

  if (report.signers.length === 0) lines.push('  (none reported)');
  for (const signer of report.signers) {
    lines.push(
      `  ${signer.key}  type=${signer.type}  weight=${signer.weight}${signer.isMasterKey ? '  [master]' : ''}`,
    );
  }

  lines.push('', 'Threshold feasibility (all configured signers assumed available):');
  for (const threshold of report.thresholds) {
    lines.push(
      `  ${threshold.name.padEnd(6)} ${threshold.configurationCanMeetThreshold ? 'reachable' : 'UNREACHABLE'}: ` +
        `${threshold.maximumConfiguredWeight} configured / ${threshold.requiredWeight} required` +
        (threshold.missingWeight > 0 ? ` (short ${threshold.missingWeight})` : ''),
    );
  }

  lines.push('', 'Findings:');
  for (const finding of report.findings) lines.push(`  - ${finding}`);
  lines.push('', `Caveat: ${report.recoveryCaveat}`);
  return lines.join('\n');
}

export async function run(params: SignerAuditParams = {}): Promise<void> {
  const accountId = params.accountId?.trim() || process.env.ACCOUNT_ID || DEFAULT_ACCOUNT_ID;
  const horizonUrl = params.horizonUrl || process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const json = params.json === true || params.json === 'true' || process.env.JSON_OUTPUT === 'true';

  try {
    const server = new Horizon.Server(horizonUrl);
    const account = await server.loadAccount(accountId);
    const report = buildSignerAuditReport({
      account_id: account.account_id,
      signers: account.signers,
      thresholds: account.thresholds,
    });
    console.log(json ? JSON.stringify(report, null, 2) : formatSignerAuditReport(report));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) console.log(JSON.stringify({ accountId, error: message }, null, 2));
    else console.error(`Could not audit account ${accountId}: ${message}`);
  }
}