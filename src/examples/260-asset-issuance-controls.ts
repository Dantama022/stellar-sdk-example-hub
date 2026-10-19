/**
 * Example 260: Stellar Asset Issuance, Authorization, and Clawback Controls
 * (ISSUE-307).
 *
 * Issuing an asset on Stellar is a sequence of irreversible-ish decisions, and
 * most of the footguns come from getting the order or the flags wrong:
 *
 *   1. **`AUTH_REQUIRED` must be set before the first holder is authorized.**
 *      Once a trustline exists, changing `AUTH_REQUIRED` is impossible - the
 *      issuer has permanently committed to the authorization model.
 *   2. **`AUTH_IMMUTABLE` is a one-way door.** Once set, no trustline
 *      authorization can ever change again: no new authorizations, no
 *      revocations, no clawbacks.
 *   3. **A clawback needs `AUTH_REVOCABLE`.** Without it, the clawback
 *      operation is rejected, and the issuer cannot burn a holder's balance.
 *   4. **Clawback can only reach `AUTH_REVOCABLE` trustlines.** A holder that
 *      was authorized while the asset was not revocable is out of reach.
 *
 * This example demonstrates how to:
 *   - model the issuer flag state and detect illegal flag transitions
 *   - compute the authorization state of a trustline
 *   - decide whether a clawback is currently possible, and for which holders
 *   - build the unsigned operations (setOptions / allowTrust / clawback) so
 *     the exact envelopes can be inspected before signing
 *
 * Safety properties:
 *   - the example NEVER calls `submitTransaction`;
 *   - every operation it builds is left unsigned and printed as XDR;
 *   - all network calls are read-only.
 */

import dotenv from 'dotenv';
import {
  AuthClawbackEnabledFlag,
  AuthFlag,
  AuthImmutableFlag,
  AuthRequiredFlag,
  AuthRevocableFlag,
  Horizon,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

import { WorkflowError, accountId, asset } from '../utils/example-input';
import { resolveNetworkConfiguration } from './60-network-configuration';

/** The issuer flags that matter for authorization and clawback. */
export interface IssuerFlags {
  /** The holder must be authorized before the asset is valid for them. */
  authRequired: boolean;
  /** The issuer may revoke trustlines and claw back balances. */
  authRevocable: boolean;
  /** The issuer may change the authorization flags again. */
  authImmutable: boolean;
}

/** The authorization state of a single trustline. */
export type AuthorizationState =
  'AUTHORIZED' | 'AUTHORIZED_TO_MAINTAIN_LIABILITIES' | 'UNAUTHORIZED' | 'NOT_FOUND';

/** A trustline as reported by Horizon. */
export interface TrustlineBalance {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  is_authorized?: boolean;
  is_authorized_to_maintain_liabilities?: boolean;
  limit?: string;
}

/** The result of checking whether an issuer may change its flags. */
export interface FlagTransitionCheck {
  /** True when the transition is legal on the network. */
  allowed: boolean;
  /** The flags before the transition. */
  from: IssuerFlags;
  /** The flags after the transition. */
  to: IssuerFlags;
  /** Why the transition was rejected. */
  problems: string[];
}

/** Read the authorization state of a trustline. */
export function getAuthorizationState(
  balances: TrustlineBalance[],
  assetCode: string,
  issuerPublicKey: string,
): AuthorizationState {
  const trustline = balances.find(
    (balance) =>
      balance.asset_type !== 'native' &&
      balance.asset_code === assetCode &&
      balance.asset_issuer === issuerPublicKey,
  );

  if (!trustline) return 'NOT_FOUND';
  if (trustline.is_authorized === true) return 'AUTHORIZED';
  if (trustline.is_authorized_to_maintain_liabilities === true) {
    return 'AUTHORIZED_TO_MAINTAIN_LIABILITIES';
  }
  return 'UNAUTHORIZED';
}

/**
 * Check whether an issuer may move from one flag state to another.
 *
 * The network enforces two hard rules:
 *
 *   - `AUTH_IMMUTABLE` is final. Once it is set, no flag may change again.
 *   - `AUTH_REQUIRED` cannot be turned off once it has been on, and cannot be
 *     turned on once a trustline already exists.
 */
export function checkFlagTransition(
  from: IssuerFlags,
  to: IssuerFlags,
  options: { hasExistingTrustlines?: boolean } = {},
): FlagTransitionCheck {
  const problems: string[] = [];

  if (from.authImmutable) {
    problems.push('AUTH_IMMUTABLE is already set, so no issuer flag can be changed any more.');
  }

  if (from.authRequired && !to.authRequired) {
    problems.push('AUTH_REQUIRED cannot be turned off once it has been set.');
  }

  if (!from.authRequired && to.authRequired && options.hasExistingTrustlines) {
    problems.push('AUTH_REQUIRED cannot be turned on after trustlines already exist.');
  }

  if (from.authImmutable !== to.authImmutable) {
    problems.push('AUTH_IMMUTABLE can only be set, never cleared, and it is final.');
  }

  return { allowed: problems.length === 0, from, to, problems };
}

/** The result of checking whether a clawback is possible. */
export interface ClawbackCheck {
  /** True when at least one holder can be clawed back. */
  possible: boolean;
  /** The holders that can be clawed back, with the recoverable amount. */
  clawbackable: { account: string; amount: string }[];
  /** The holders that are out of reach, and why. */
  blocked: { account: string; reason: string }[];
  /** Problems that block every clawback. */
  problems: string[];
}

/**
 * Decide whether a clawback is possible, and for which holders.
 *
 * A holder can be clawed back only when the issuer has `AUTH_REVOCABLE` and
 * the holder's trustline is `AUTHORIZED`. Holders that were authorized while
 * the asset was not revocable, and holders that only hold
 * `AUTHORIZED_TO_MAINTAIN_LIABILITIES`, are out of reach.
 */
export function checkClawback(
  flags: IssuerFlags,
  holders: { account: string; amount: string; state: AuthorizationState }[],
): ClawbackCheck {
  const problems: string[] = [];

  if (!flags.authRevocable) {
    problems.push('AUTH_REVOCABLE is not set, so the network rejects every clawback.');
  }
  if (flags.authImmutable && !flags.authRevocable) {
    problems.push(
      'AUTH_IMMUTABLE is set, so AUTH_REVOCABLE can never be enabled; the asset can never be clawed back.',
    );
  }

  const clawbackable: { account: string; amount: string }[] = [];
  const blocked: { account: string; reason: string }[] = [];

  for (const holder of holders) {
    if (holder.state === 'AUTHORIZED') {
      clawbackable.push({ account: holder.account, amount: holder.amount });
    } else if (holder.state === 'AUTHORIZED_TO_MAINTAIN_LIABILITIES') {
      blocked.push({
        account: holder.account,
        reason: 'The holder may only maintain liabilities, so the balance cannot be clawed back.',
      });
    } else if (holder.state === 'UNAUTHORIZED') {
      blocked.push({
        account: holder.account,
        reason: 'The holder is unauthorized; revoke the trustline instead of clawing back.',
      });
    } else {
      blocked.push({
        account: holder.account,
        reason: 'No trustline for this asset was found on the holder account.',
      });
    }
  }

  return {
    possible: problems.length === 0 && clawbackable.length > 0,
    clawbackable,
    blocked,
    problems,
  };
}

/**
 * Summarize the trustlines of a set of holders for one issued asset.
 */
export function summarizeHolders(
  balancesByAccount: Record<string, TrustlineBalance[]>,
  assetCode: string,
  issuerPublicKey: string,
): { account: string; amount: string; state: AuthorizationState }[] {
  return Object.entries(balancesByAccount).map(([account, balances]) => {
    const state = getAuthorizationState(balances, assetCode, issuerPublicKey);
    const trustline = balances.find(
      (balance) =>
        balance.asset_type !== 'native' &&
        balance.asset_code === assetCode &&
        balance.asset_issuer === issuerPublicKey,
    );
    return { account, amount: trustline?.balance ?? '0', state };
  });
}

/** Render a flag / authorization / clawback report as human-readable text. */
export function formatAssetControlReport(params: {
  asset: string;
  issuer: string;
  flags: IssuerFlags;
  transition: FlagTransitionCheck;
  clawback: ClawbackCheck;
}): string {
  const { asset, issuer, flags, transition, clawback } = params;
  const lines = [
    '=== Asset Issuance and Clawback Controls ===',
    `Asset: ${asset}`,
    `Issuer: ${issuer}`,
    '',
    'Issuer flags:',
    `  authRequired:  ${flags.authRequired ? 'yes' : 'no'}`,
    `  authRevocable: ${flags.authRevocable ? 'yes' : 'no'}`,
    `  authImmutable: ${flags.authImmutable ? 'yes' : 'no'}`,
    '',
    'Flag transition:',
    `  allowed: ${transition.allowed ? 'yes' : 'no'}`,
  ];

  if (transition.problems.length > 0) {
    for (const problem of transition.problems) lines.push(`  - ${problem}`);
  }

  lines.push('');
  lines.push('Clawback:');
  lines.push(`  possible: ${clawback.possible ? 'yes' : 'no'}`);
  for (const holder of clawback.clawbackable) {
    lines.push(`  - ${holder.account}: ${holder.amount} clawbackable`);
  }
  for (const holder of clawback.blocked) {
    lines.push(`  - ${holder.account}: blocked (${holder.reason})`);
  }
  for (const problem of clawback.problems) lines.push(`  ! ${problem}`);

  return lines.join('\n');
}

/**
 * Run the asset issuance control example.
 *
 * Configuration (via environment variables):
 *   - ISSUER_ACCOUNT: the issuing account
 *   - HOLDER_ACCOUNTS: comma-separated holder account IDs to inspect
 *   - ASSET_CODE: the issued asset code (default `ISSUED`)
 *   - ENABLE_AUTH_REQUIRED: `true` to model enabling AUTH_REQUIRED
 *   - ENABLE_AUTH_REVOCABLE: `true` to model enabling AUTH_REVOCABLE
 *   - SET_AUTH_IMMUTABLE: `true` to model setting AUTH_IMMUTABLE
 */
export async function run(): Promise<void> {
  const config = resolveNetworkConfiguration();
  const issuerAccountId = accountId(process.env.ISSUER_ACCOUNT);
  const holderIds = (process.env.HOLDER_ACCOUNTS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const assetCode = process.env.ASSET_CODE || 'ISSUED';
  const issuedAsset = asset(process.env.ASSET_CODE);
  const server = new Horizon.Server(config.horizonUrl);

  const issuerAccount = await server.loadAccount(issuerAccountId);

  const flags: IssuerFlags = {
    authRequired: issuerAccount.flags.auth_required ?? false,
    authRevocable: issuerAccount.flags.auth_revocable ?? false,
    authImmutable: issuerAccount.flags.auth_immutable ?? false,
  };

  const desiredFlags: IssuerFlags = {
    authRequired: process.env.ENABLE_AUTH_REQUIRED === 'true' || flags.authRequired,
    authRevocable: process.env.ENABLE_AUTH_REVOCABLE === 'true' || flags.authRevocable,
    authImmutable: process.env.SET_AUTH_IMMUTABLE === 'true' || flags.authImmutable,
  };

  const balancesByAccount: Record<string, TrustlineBalance[]> = {};
  for (const holderId of holderIds) {
    const holder = await server.loadAccount(holderId).catch(() => null);
    balancesByAccount[holderId] = holder ? (holder.balances as unknown as TrustlineBalance[]) : [];
  }

  const holders = summarizeHolders(balancesByAccount, assetCode, issuerAccountId);

  const transition = checkFlagTransition(flags, desiredFlags, {
    hasExistingTrustlines: holders.length > 0,
  });

  const clawback = checkClawback(flags, holders);

  console.log(
    formatAssetControlReport({
      asset: assetCode,
      issuer: issuerAccountId,
      flags,
      transition,
      clawback,
    }),
  );

  // Build the unsigned operations so they can be inspected before signing.
  const operations: string[] = [];

  if (transition.allowed) {
    // `setFlags` is a bitmask of the issuer flag bits.
    let flagBits = 0;
    if (desiredFlags.authRequired) flagBits |= AuthRequiredFlag;
    if (desiredFlags.authRevocable) flagBits |= AuthRevocableFlag;
    if (desiredFlags.authImmutable) flagBits |= AuthImmutableFlag;
    if (desiredFlags.authRevocable) flagBits |= AuthClawbackEnabledFlag;

    const setOptions = Operation.setOptions({
      // The SDK types `setFlags` as a single flag, but the operation accepts a
      // bitmask of the flag bits.
      setFlags: flagBits as unknown as AuthFlag,
    });
    operations.push(setOptions.toXDR('base64'));
  } else {
    console.log(
      'The requested flag transition is not allowed, so no setOptions operation was built.',
    );
  }

  for (const holder of clawback.clawbackable) {
    const clawbackOperation = Operation.clawback({
      from: holder.account,
      asset: issuedAsset,
      amount: holder.amount,
    });
    operations.push(clawbackOperation.toXDR('base64'));
  }

  if (operations.length === 0) {
    console.log('No operations to build.');
    return;
  }

  const transaction = new TransactionBuilder(issuerAccount, {
    fee: String(await server.fetchBaseFee().catch(() => 100)),
    networkPassphrase: config.networkPassphrase,
  })
    .setTimeout(180)
    .build();

  console.log('');
  console.log(
    'The envelopes below are unsigned and unsubmitted. Inspect them, then sign and submit them yourself.',
  );
  for (const xdr of operations) console.log('Operation XDR:', xdr);
  console.log('Transaction XDR:', transaction.toXDR());
}

if (require.main === module) {
  dotenv.config();
  run().catch((error: unknown) => {
    console.error(
      error instanceof WorkflowError
        ? error.message
        : 'Asset control inspection failed. Check ISSUER_ACCOUNT, HOLDER_ACCOUNTS and the asset code.',
    );
    process.exitCode = 1;
  });
}
