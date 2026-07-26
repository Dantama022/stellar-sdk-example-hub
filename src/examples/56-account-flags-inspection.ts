import { Horizon } from '@stellar/stellar-sdk';

/**
 * Example 56: Account Flags Inspection
 *
 * Stellar account flags are account-level switches that control how assets
 * issued by the account behave and how the account itself can be changed.
 * Horizon exposes them on the account resource under the `flags` object as
 * four booleans, which correspond to bits in the on-ledger `AccountEntry.flags`
 * field:
 *
 *   AUTH_REQUIRED_FLAG          (1) -> flags.auth_required
 *   AUTH_REVOCABLE_FLAG         (2) -> flags.auth_revocable
 *   AUTH_IMMUTABLE_FLAG         (4) -> flags.auth_immutable
 *   AUTH_CLAWBACK_ENABLED_FLAG  (8) -> flags.auth_clawback_enabled
 *
 * Unlike example 25 (`25-account-flags`), which submits `setOptions`
 * transactions to change flags, this example is strictly read-only: it loads an
 * account from Horizon and audits its configuration. That makes it safe to run
 * against any account on any network, including Mainnet.
 *
 * Flags only take effect for assets the account issues. An account that never
 * issues an asset can still carry flags, but they have no practical effect
 * until a trustline to one of its assets exists.
 *
 * The master key is not a flag, but it is part of the same audit: an account
 * whose master key weight is 0 can no longer sign for itself, which combined
 * with AUTH_IMMUTABLE produces a permanently frozen configuration.
 */

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';

/** Bit values of each flag in the on-ledger `AccountEntry.flags` field. */
export const FLAG_BITS = {
  auth_required: 1,
  auth_revocable: 2,
  auth_immutable: 4,
  auth_clawback_enabled: 8,
} as const;

export type FlagKey = keyof typeof FLAG_BITS;

export interface HorizonAccountFlags {
  auth_required?: boolean;
  auth_revocable?: boolean;
  auth_immutable?: boolean;
  auth_clawback_enabled?: boolean;
}

export interface FlagDescription {
  /** Horizon field name, e.g. `auth_required`. */
  key: FlagKey;
  /** Protocol constant name, e.g. `AUTH_REQUIRED_FLAG`. */
  constantName: string;
  /** Bit value contributed to the raw flags bitmask. */
  bit: number;
  /** Whether the flag is set on the inspected account. */
  enabled: boolean;
  /** What the flag does when set. */
  meaning: string;
  /** What it means for the account when the flag is left unset. */
  whenUnset: string;
}

export interface AccountFlagsReport {
  accountId: string;
  flags: FlagDescription[];
  /** Reconstructed bitmask value of the enabled flags. */
  rawFlagValue: number;
  /** True when none of the four flags are set (the default for a new account). */
  usesDefaults: boolean;
  /** Weight of the account's own key as a signer; 0 means the master key is disabled. */
  masterKeyWeight: number;
  /** Human-readable notes about restrictive or unusual configurations. */
  notableFindings: string[];
}

export interface AccountFlagsInspectionParams {
  accountId?: string;
  horizonUrl?: string;
}

/**
 * Static reference table describing each supported flag.
 *
 * Kept separate from any account so the descriptions can be reused for
 * documentation, and so `describeAccountFlags` stays a pure mapping step.
 */
const FLAG_REFERENCE: Array<Omit<FlagDescription, 'enabled'>> = [
  {
    key: 'auth_required',
    constantName: 'AUTH_REQUIRED_FLAG',
    bit: FLAG_BITS.auth_required,
    meaning:
      'Holders must be explicitly authorized by the issuer before they can hold or transact ' +
      'assets issued by this account. New trustlines start unauthorized until the issuer ' +
      'submits setTrustLineFlags.',
    whenUnset:
      'Anyone may open a trustline and immediately receive assets issued by this account ' +
      '(open/permissionless issuance).',
  },
  {
    key: 'auth_revocable',
    constantName: 'AUTH_REVOCABLE_FLAG',
    bit: FLAG_BITS.auth_revocable,
    meaning:
      'The issuer can revoke authorization on an existing trustline, freezing the holder ' +
      "balance. Pending offers involving the asset are pulled from the order book when a holder's " +
      'authorization is revoked.',
    whenUnset: 'Once a trustline is authorized, the issuer cannot freeze or revoke it.',
  },
  {
    key: 'auth_immutable',
    constantName: 'AUTH_IMMUTABLE_FLAG',
    bit: FLAG_BITS.auth_immutable,
    meaning:
      'The account can never change any of its flags again, and the account can never be merged ' +
      'away. This is irreversible: even the account holder cannot clear it.',
    whenUnset: 'Flags remain modifiable via setOptions, and the account can still be merged.',
  },
  {
    key: 'auth_clawback_enabled',
    constantName: 'AUTH_CLAWBACK_ENABLED_FLAG',
    bit: FLAG_BITS.auth_clawback_enabled,
    meaning:
      'Trustlines created after this flag is set are clawback-enabled, allowing the issuer to ' +
      'burn assets directly out of a holder balance with a clawback operation. Requires ' +
      'AUTH_REVOCABLE to be set as well.',
    whenUnset: 'The issuer cannot claw back assets once they have been sent to a holder.',
  },
];

/**
 * Maps Horizon's `flags` object onto the reference table.
 *
 * Horizon omits `auth_clawback_enabled` on older/unsupported responses, so
 * every field is coerced to a boolean rather than read directly.
 */
export function describeAccountFlags(flags: HorizonAccountFlags = {}): FlagDescription[] {
  return FLAG_REFERENCE.map((reference) => ({
    ...reference,
    enabled: Boolean(flags[reference.key]),
  }));
}

/**
 * Recomputes the raw on-ledger bitmask from the described flags. Useful when
 * comparing a Horizon response against raw XDR or a core database row.
 */
export function computeRawFlagValue(descriptions: FlagDescription[]): number {
  return descriptions.reduce((mask, flag) => (flag.enabled ? mask | flag.bit : mask), 0);
}

/**
 * Reads the master key weight from the account signer list.
 *
 * The master key is the signer whose key equals the account ID. A weight of 0
 * means the key has been disabled and the account can only be controlled by its
 * other signers — or by nobody at all, if no other signers exist.
 */
export function getMasterKeyWeight(
  accountId: string,
  signers: Array<{ key: string; weight: number }> = [],
): number {
  const master = signers.find((signer) => signer.key === accountId);
  return master ? master.weight : 0;
}

/**
 * Flags configurations worth calling out during an audit.
 *
 * None of these are errors on their own — an issuer of a regulated asset is
 * expected to set most of them — but each one gives the issuer power over
 * holders, so they should be a deliberate choice rather than a surprise.
 */
export function identifyNotableConfigurations(
  descriptions: FlagDescription[],
  masterKeyWeight: number,
  otherSignerCount = 0,
): string[] {
  const enabled = new Set(descriptions.filter((flag) => flag.enabled).map((flag) => flag.key));
  const findings: string[] = [];

  if (enabled.has('auth_immutable')) {
    findings.push(
      'AUTH_IMMUTABLE is set: this flag configuration is permanent and the account can never be merged.',
    );
  }

  if (enabled.has('auth_required') && enabled.has('auth_revocable')) {
    findings.push(
      'AUTH_REQUIRED + AUTH_REVOCABLE: the issuer gates who may hold the asset and can freeze ' +
        'existing holders at any time.',
    );
  } else if (enabled.has('auth_revocable')) {
    findings.push(
      'AUTH_REVOCABLE is set: the issuer can freeze holder balances even though holding the asset ' +
        'is otherwise permissionless.',
    );
  } else if (enabled.has('auth_required')) {
    findings.push(
      'AUTH_REQUIRED is set: holders need issuer approval before they can receive the asset.',
    );
  }

  if (enabled.has('auth_clawback_enabled')) {
    findings.push(
      'AUTH_CLAWBACK_ENABLED is set: the issuer can burn assets out of holder balances without ' +
        'holder consent.',
    );
    if (!enabled.has('auth_revocable')) {
      // The protocol rejects setting clawback without revocable, so seeing this
      // combination usually means the response was hand-built or misparsed.
      findings.push(
        'Unusual: clawback is enabled without AUTH_REVOCABLE. The protocol requires ' +
          'AUTH_REVOCABLE alongside clawback — verify the source of this account data.',
      );
    }
  }

  if (masterKeyWeight === 0) {
    findings.push(
      otherSignerCount > 0
        ? 'Master key weight is 0: the account key cannot sign, so control rests entirely with the ' +
            'additional signers.'
        : 'Master key weight is 0 and no other signers exist: this account is permanently locked ' +
            'and can never submit another transaction.',
    );
  }

  if (enabled.has('auth_immutable') && masterKeyWeight === 0) {
    findings.push(
      'AUTH_IMMUTABLE combined with a disabled master key is the standard "locked issuer" setup ' +
        'used to prove an asset supply can never be inflated.',
    );
  }

  return findings;
}

/**
 * Builds the full audit report for an account.
 */
export function buildAccountFlagsReport(account: {
  id: string;
  flags?: HorizonAccountFlags;
  signers?: Array<{ key: string; weight: number }>;
}): AccountFlagsReport {
  const flags = describeAccountFlags(account.flags);
  const signers = account.signers ?? [];
  const masterKeyWeight = getMasterKeyWeight(account.id, signers);
  const otherSignerCount = signers.filter((signer) => signer.key !== account.id).length;

  return {
    accountId: account.id,
    flags,
    rawFlagValue: computeRawFlagValue(flags),
    usesDefaults: flags.every((flag) => !flag.enabled),
    masterKeyWeight,
    notableFindings: identifyNotableConfigurations(flags, masterKeyWeight, otherSignerCount),
  };
}

/**
 * Renders the report as a readable console summary.
 */
export function formatFlagsReport(report: AccountFlagsReport): string {
  const lines: string[] = [];

  lines.push('=== Stellar Account Flags Inspection ===');
  lines.push(`Account ID:     ${report.accountId}`);
  lines.push(`Raw flag value: ${report.rawFlagValue} (0b${report.rawFlagValue.toString(2)})`);
  lines.push(
    `Configuration:  ${report.usesDefaults ? 'Default (no flags set)' : 'Custom flags set'}`,
  );

  lines.push('\nFlag Configuration:');
  for (const flag of report.flags) {
    const status = flag.enabled ? 'ENABLED ' : 'disabled';
    lines.push(`  [${status}] ${flag.key} (${flag.constantName}, bit ${flag.bit})`);
    lines.push(`      Meaning: ${flag.meaning}`);
    if (!flag.enabled) {
      lines.push(`      Currently: ${flag.whenUnset}`);
    }
  }

  lines.push('\nMaster Key:');
  lines.push(`  Weight: ${report.masterKeyWeight}`);
  lines.push(
    report.masterKeyWeight > 0
      ? '  The account key can still sign for this account.'
      : '  The account key is disabled and cannot sign for this account.',
  );

  lines.push('\nAudit Notes:');
  if (report.notableFindings.length === 0) {
    lines.push(
      '  No restrictive or unusual configuration detected. The account uses default, ' +
        'permissionless behavior.',
    );
  } else {
    for (const finding of report.notableFindings) {
      lines.push(`  - ${finding}`);
    }
  }

  return lines.join('\n');
}

/**
 * Runs the account flags inspection example.
 *
 * The account can be supplied via the runner prompt, the `ACCOUNT_ID`
 * environment variable, or a CLI argument. With none of those, the example
 * picks a recently active account from Horizon so it stays runnable without
 * setup.
 */
export async function run(params: AccountFlagsInspectionParams = {}): Promise<void> {
  const horizonUrl = params.horizonUrl || process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const server = new Horizon.Server(horizonUrl);

  let accountId =
    params.accountId?.trim() || process.env.ACCOUNT_ID?.trim() || process.argv[3]?.trim();

  console.log('Starting Account Flags Inspection Example...');
  console.log(`Using Horizon: ${horizonUrl}`);

  if (!accountId) {
    console.log('No account ID supplied. Fetching a recently active account from Horizon...');
    try {
      const recentOps = await server.operations().order('desc').limit(1).call();
      if (recentOps.records.length > 0) {
        accountId = recentOps.records[0].source_account;
      }
    } catch {
      // Falls through to the hardcoded account below.
    }
  }

  if (!accountId) {
    accountId = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
  }

  console.log(`Inspecting account flags for: ${accountId}`);

  let account;
  try {
    account = await server.loadAccount(accountId);
  } catch (error: any) {
    // A 404 means the account is not funded (or the ID is for another network);
    // anything else is usually connectivity. Neither should crash the example.
    const status = error?.response?.status;
    if (status === 404) {
      console.log(`Account ${accountId} does not exist on this network (Horizon returned 404).`);
      console.log('An unfunded account has no ledger entry, so it has no flags to inspect.');
    } else {
      console.log(`Could not load account ${accountId}: ${error?.message || error}`);
    }

    console.log('\nShowing the flag reference for a default (unflagged) account instead:\n');
    console.log(
      formatFlagsReport(
        buildAccountFlagsReport({
          id: accountId,
          flags: {},
          signers: [{ key: accountId, weight: 1 }],
        }),
      ),
    );
    console.log('\nAccount flags inspection completed.');
    return;
  }

  const report = buildAccountFlagsReport({
    id: account.id,
    flags: account.flags as HorizonAccountFlags,
    signers: account.signers as Array<{ key: string; weight: number }>,
  });

  console.log('\n' + formatFlagsReport(report));

  console.log('\nReminder: flags only affect assets this account issues. They are set with the');
  console.log('setOptions operation (setFlags / clearFlags) — see example 25-account-flags.');
  console.log('\nAccount flags inspection completed successfully.');
}
