/**
 * ISSUE-403: Stellar asset clawback eligibility and balance impact simulator.
 *
 * Builds a read-only preflight report: it inspects the issuer flags and the
 * holder trustline, validates clawback preconditions, estimates the remaining
 * balance with BigInt (stroop) arithmetic, and can produce an unsigned
 * transaction XDR for inspection. It never signs or submits a transaction.
 *
 * Usage:
 *   npx ts-node examples/assets/clawback-preflight.ts \
 *     --asset USD \
 *     --issuer G... \
 *     --holder G... \
 *     --amount 10.5 \
 *     --protocol 22 \
 *     --xdr
 */

import {
  Account,
  Asset,
  Horizon,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

const STROOPS_PER_XLM = 10_000_000n;
const MIN_CLAWBACK_PROTOCOL = 17;
const PUBLIC_KEY_RE = /^G[A-Z2-7]{55}$/;
const ASSET_CODE_RE = /^[A-Za-z0-9]{1,12}$/;
const DECIMAL_AMOUNT_RE = /^(\d+)(?:\.(\d{1,7}))?$/;

export interface IssuerFlags {
  authRequired: boolean;
  authRevocable: boolean;
  authClawbackEnabled: boolean;
  authImmutable: boolean;
}

export interface TrustlineInfo {
  assetCode: string;
  issuer: string;
  balanceStroops: bigint;
  authorized: boolean;
  authorizedToMaintainLiabilities: boolean;
  sponsor?: string;
}

export interface AccountSnapshot {
  accountId: string;
  sequence: string;
  flags: IssuerFlags;
  trustlines: TrustlineInfo[];
}

export type TrustlineState =
  'authorized' | 'authorized_to_maintain_liabilities' | 'unauthorized' | 'missing';

export interface FailedPrecondition {
  code: string;
  message: string;
}

export interface ClawbackInput {
  assetCode: string;
  issuer: string;
  holder: string;
  amount: string;
  issuerAccount: AccountSnapshot;
  holderAccount: AccountSnapshot;
  protocolVersion: number;
}

export interface ClawbackReport {
  assetCode: string;
  issuer: string;
  holder: string;
  currentBalance: string;
  proposedAmount: string;
  remainingBalance: string | null;
  clawbackEnabled: boolean;
  trustlineState: TrustlineState;
  protocolVersion: number;
  failedPreconditions: FailedPrecondition[];
  warnings: string[];
  recommendations: string[];
  eligible: boolean;
}

interface HorizonFlagsLike {
  auth_required?: unknown;
  auth_revocable?: unknown;
  auth_clawback_enabled?: unknown;
  auth_immutable?: unknown;
}

interface HorizonBalanceLike {
  asset_type?: unknown;
  asset_code?: unknown;
  asset_issuer?: unknown;
  balance?: unknown;
  authorized?: unknown;
  is_authorized_to_maintain_liabilities?: unknown;
  sponsor?: unknown;
}

interface HorizonAccountLike {
  account_id?: unknown;
  sequence?: unknown;
  flags?: unknown;
  balances?: unknown;
}

export interface AccountLoader {
  loadAccount(accountId: string): Promise<HorizonAccountLike>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Converts a decimal XLM amount to an exact integer stroop value. */
export function parseAmountToStroops(value: string): bigint {
  const match = DECIMAL_AMOUNT_RE.exec(String(value ?? '').trim());
  if (!match)
    throw new Error(
      `Invalid amount "${value}": expected a non-negative decimal with at most 7 places`,
    );
  const whole = BigInt(match[1]);
  const fraction = (match[2] ?? '').padEnd(7, '0');
  return whole * STROOPS_PER_XLM + BigInt(fraction || '0');
}

/** Formats stroops as a fixed 7-decimal XLM amount without floating point. */
export function formatStroops(stroops: bigint): string {
  const sign = stroops < 0n ? '-' : '';
  const absolute = stroops < 0n ? -stroops : stroops;
  const whole = absolute / STROOPS_PER_XLM;
  const fraction = (absolute % STROOPS_PER_XLM).toString().padStart(7, '0');
  return `${sign}${whole}.${fraction}`;
}

export function isPublicKey(value: string): boolean {
  return PUBLIC_KEY_RE.test(value);
}

export function isClawbackableAssetCode(value: string): boolean {
  return ASSET_CODE_RE.test(value) && value.toUpperCase() !== 'XLM';
}

export function findTrustline(
  account: AccountSnapshot,
  code: string,
  issuer: string,
): TrustlineInfo | null {
  return (
    account.trustlines.find((line) => line.assetCode === code && line.issuer === issuer) ?? null
  );
}

export function describeTrustlineState(line: TrustlineInfo | null): TrustlineState {
  if (!line) return 'missing';
  if (!line.authorized) return 'unauthorized';
  return line.authorizedToMaintainLiabilities ? 'authorized_to_maintain_liabilities' : 'authorized';
}

/**
 * Evaluates clawback preconditions and computes the balance impact. This
 * function performs no network calls and builds no transactions.
 */
export function assessClawbackEligibility(input: ClawbackInput): ClawbackReport {
  const failed: FailedPrecondition[] = [];
  const warnings: string[] = [];
  const recommendations: string[] = [];

  if (!isClawbackableAssetCode(input.assetCode)) {
    failed.push({
      code: 'asset-code-invalid',
      message: 'Asset code must be 1-12 alphanumeric characters and cannot be the native XLM asset',
    });
  }
  if (!isPublicKey(input.issuer)) {
    failed.push({
      code: 'issuer-invalid',
      message: 'Issuer must be a valid Stellar public key (G + 55 base32 characters)',
    });
  }
  if (!isPublicKey(input.holder)) {
    failed.push({ code: 'holder-invalid', message: 'Holder must be a valid Stellar public key' });
  }
  if (input.issuer === input.holder) {
    failed.push({
      code: 'issuer-equals-holder',
      message: 'Issuer and holder cannot be the same account',
    });
  }
  if (!Number.isInteger(input.protocolVersion) || input.protocolVersion < MIN_CLAWBACK_PROTOCOL) {
    failed.push({
      code: 'protocol-unsupported',
      message: `Clawback requires protocol version ${MIN_CLAWBACK_PROTOCOL} or newer (selected: ${input.protocolVersion})`,
    });
  }

  const clawbackEnabled = input.issuerAccount.flags.authClawbackEnabled;
  if (!clawbackEnabled) {
    failed.push({
      code: 'clawback-disabled',
      message: 'Issuer account does not have AUTH_CLAWBACK_ENABLED set',
    });
    recommendations.push(
      'Set the AUTH_CLAWBACK_ENABLED flag on the issuer account before attempting a clawback.',
    );
  }

  const trustline = findTrustline(input.holderAccount, input.assetCode, input.issuer);
  const trustlineState = describeTrustlineState(trustline);
  if (trustlineState === 'missing') {
    failed.push({
      code: 'trustline-missing',
      message: `Holder has no trustline for ${input.assetCode}:${input.issuer}`,
    });
  } else if (trustlineState === 'unauthorized') {
    if (input.issuerAccount.flags.authRevocable) {
      warnings.push(
        'Holder trustline is unauthorized; clawback may still be authorized by the issuer because AUTH_REVOCABLE is set.',
      );
    } else {
      failed.push({
        code: 'trustline-unauthorized',
        message: 'Holder trustline is unauthorized and the issuer does not have AUTH_REVOCABLE set',
      });
    }
  } else if (trustlineState === 'authorized_to_maintain_liabilities') {
    warnings.push(
      'Holder trustline is only authorized to maintain liabilities; confirm the intended authorization state before clawback.',
    );
  }

  let proposedStroops: bigint | null = null;
  try {
    proposedStroops = parseAmountToStroops(input.amount);
    if (proposedStroops <= 0n) {
      failed.push({
        code: 'amount-nonpositive',
        message: 'Clawback amount must be greater than zero',
      });
      proposedStroops = null;
    }
  } catch (error) {
    failed.push({ code: 'amount-invalid', message: errorMessage(error) });
  }

  let remaining: bigint | null = null;
  if (trustline && proposedStroops !== null) {
    if (proposedStroops > trustline.balanceStroops) {
      failed.push({
        code: 'amount-exceeds-balance',
        message: `Requested ${formatStroops(proposedStroops)} exceeds holder balance ${formatStroops(trustline.balanceStroops)}`,
      });
    } else {
      remaining = trustline.balanceStroops - proposedStroops;
      if (remaining === 0n) {
        warnings.push("This clawback would consume the holder's entire asset balance.");
      }
    }
  }

  if (input.issuerAccount.flags.authImmutable && !input.issuerAccount.flags.authClawbackEnabled) {
    recommendations.push(
      'The issuer is immutable; its flags cannot be changed to enable clawback.',
    );
  }
  recommendations.push(
    'The issuer must authorize and sign the transaction; this example never signs or submits it.',
  );

  return {
    assetCode: input.assetCode,
    issuer: input.issuer,
    holder: input.holder,
    currentBalance: trustline ? formatStroops(trustline.balanceStroops) : formatStroops(0n),
    proposedAmount: proposedStroops === null ? input.amount : formatStroops(proposedStroops),
    remainingBalance: remaining === null ? null : formatStroops(remaining),
    clawbackEnabled,
    trustlineState,
    protocolVersion: input.protocolVersion,
    failedPreconditions: failed,
    warnings,
    recommendations,
    eligible: failed.length === 0,
  };
}

export interface PreflightTransactionOptions {
  assetCode: string;
  issuer: string;
  holder: string;
  amount: string;
  sequence: string;
  networkPassphrase?: string;
  baseFee?: string;
  timeoutSeconds?: number;
}

/** Builds (but never signs or submits) a clawback transaction. */
export function buildClawbackPreflightTransaction(options: PreflightTransactionOptions): {
  xdr: string;
  operationCount: number;
} {
  if (!isClawbackableAssetCode(options.assetCode)) throw new Error('Invalid clawback asset code');
  if (!isPublicKey(options.issuer) || !isPublicKey(options.holder))
    throw new Error('Invalid issuer or holder public key');
  parseAmountToStroops(options.amount);

  const source = new Account(options.issuer, options.sequence);
  const transaction = new TransactionBuilder(source, {
    fee: options.baseFee ?? '100',
    networkPassphrase: options.networkPassphrase ?? Networks.TESTNET,
  })
    .addOperation(
      Operation.clawback({
        asset: new Asset(options.assetCode, options.issuer),
        from: options.holder,
        amount: options.amount,
      }),
    )
    .setTimeout(options.timeoutSeconds ?? 30)
    .build();

  return { xdr: transaction.toXDR(), operationCount: transaction.operations.length };
}

/** Loads an account from Horizon, keeping lookup failures distinct from ineligibility. */
export async function loadAccountSnapshot(
  loader: AccountLoader,
  accountId: string,
): Promise<AccountSnapshot> {
  let record: HorizonAccountLike;
  try {
    record = await loader.loadAccount(accountId);
  } catch (error) {
    throw new Error(`Unable to load account ${accountId}: ${errorMessage(error)}`);
  }

  const flags = asRecord(record.flags) as HorizonFlagsLike | null;
  const rawBalances = Array.isArray(record.balances) ? record.balances : [];
  const trustlines: TrustlineInfo[] = [];

  for (const raw of rawBalances) {
    const balance = asRecord(raw) as HorizonBalanceLike | null;
    if (!balance || balance.asset_type === 'native') continue;
    const code = asString(balance.asset_code);
    const issuer = asString(balance.asset_issuer);
    const amount = asString(balance.balance);
    if (!code || !issuer || !amount) continue;
    trustlines.push({
      assetCode: code,
      issuer,
      balanceStroops: parseAmountToStroops(amount),
      authorized: balance.authorized !== false,
      authorizedToMaintainLiabilities: balance.is_authorized_to_maintain_liabilities === true,
      sponsor: asString(balance.sponsor) ?? undefined,
    });
  }

  return {
    accountId: asString(record.account_id) ?? accountId,
    sequence: asString(record.sequence) ?? '0',
    flags: {
      authRequired: flags?.auth_required === true,
      authRevocable: flags?.auth_revocable === true,
      authClawbackEnabled: flags?.auth_clawback_enabled === true,
      authImmutable: flags?.auth_immutable === true,
    },
    trustlines,
  };
}

export function formatReport(report: ClawbackReport): string {
  const lines = [
    'Clawback preflight report (no transaction submitted)',
    `Asset:           ${report.assetCode} (${report.issuer})`,
    `Holder:          ${report.holder}`,
    `Balance:         ${report.currentBalance}`,
    `Proposed amount: ${report.proposedAmount}`,
    `Remaining:       ${report.remainingBalance ?? '<not calculable>'}`,
    `Clawback flag:   ${report.clawbackEnabled ? 'enabled' : 'disabled'}`,
    `Trustline:       ${report.trustlineState}`,
    `Protocol:        ${report.protocolVersion}`,
    `Eligible:        ${report.eligible ? 'YES' : 'NO'}`,
  ];
  for (const failure of report.failedPreconditions)
    lines.push(`ERROR   ${failure.code}: ${failure.message}`);
  for (const warning of report.warnings) lines.push(`WARN    ${warning}`);
  for (const recommendation of report.recommendations) lines.push(`ADVICE  ${recommendation}`);
  return lines.join('\n');
}

function argumentValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function run(params?: any): Promise<void> {
  const args = (params?.args as string[] | undefined) ?? process.argv.slice(2);
  const assetCode = params?.assetCode ?? argumentValue(args, '--asset');
  const issuer = params?.issuer ?? argumentValue(args, '--issuer');
  const holder = params?.holder ?? argumentValue(args, '--holder');
  const amount = params?.amount ?? argumentValue(args, '--amount');
  if (!assetCode || !issuer || !holder || !amount) {
    console.log(
      'Usage: clawback-preflight --asset <code> --issuer <G...> --holder <G...> --amount <decimal> [--protocol <n>] [--xdr]',
    );
    return;
  }

  const horizonUrl =
    params?.horizonUrl ?? argumentValue(args, '--horizon') ?? 'https://horizon-testnet.stellar.org';
  const server = new Horizon.Server(horizonUrl);
  const loader: AccountLoader = {
    loadAccount: async (accountId) =>
      (await server.loadAccount(accountId)) as unknown as HorizonAccountLike,
  };
  const protocolVersion = Number(
    params?.protocolVersion ?? argumentValue(args, '--protocol') ?? 22,
  );

  const issuerAccount = await loadAccountSnapshot(loader, issuer);
  const holderAccount = await loadAccountSnapshot(loader, holder);
  const report = assessClawbackEligibility({
    assetCode,
    issuer,
    holder,
    amount,
    issuerAccount,
    holderAccount,
    protocolVersion,
  });

  if (params?.json ?? args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }

  if (params?.includeXdr ?? args.includes('--xdr')) {
    try {
      const preview = buildClawbackPreflightTransaction({
        assetCode,
        issuer,
        holder,
        amount,
        sequence: issuerAccount.sequence,
        networkPassphrase: params?.networkPassphrase ?? Networks.TESTNET,
      });
      console.log(
        `Unsigned transaction XDR (${preview.operationCount} operation):\n${preview.xdr}`,
      );
    } catch (error) {
      console.log(`XDR preview unavailable: ${errorMessage(error)}`);
    }
  }
  if (!report.eligible && (params?.failOnIneligible ?? args.includes('--fail-on-ineligible'))) {
    process.exitCode = 1;
  }
}
