/**
 * 265-authorization-revocation-impact: Stellar Asset Authorization Revocation
 * Impact and Account Exposure Analyzer
 *
 * OVERVIEW
 * --------
 * Issuers can require explicit authorization before an account may hold or
 * transact with an issued asset. With `AUTH_REQUIRED` and `AUTH_REVOCABLE`, an
 * issuer can move a trustline between:
 *
 *   • fully authorized,
 *   • authorized to maintain liabilities only, and
 *   • unauthorized.
 *
 * This example retrieves the issuer's flags and every trustline for an asset,
 * summarizes current authorization states and balances, and estimates which
 * accounts a proposed authorization change would affect.
 *
 * REVOCATION IS NOT CLAWBACK
 * --------------------------
 * Revoking authorization restricts future transfers according to the protocol's
 * authorization rules; it does not by itself remove an account's existing asset
 * balance. Clawback is a separate operation that requires
 * `AUTH_CLAWBACK_ENABLED`. This example never constructs or submits either
 * operation.
 */

import { Asset, Horizon, StrKey } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_ASSET_CODE = 'USDC';
const DEFAULT_ASSET_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const HORIZON_PAGE_LIMIT = 200;
const DEFAULT_MAX_TRUSTLINES = 400;
const DEFAULT_HISTORY_LIMIT = 25;

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export type TrustlineAuthorizationState =
  | 'AUTHORIZED'
  | 'AUTHORIZED_TO_MAINTAIN_LIABILITIES'
  | 'UNAUTHORIZED';

export type ProposedAuthorizationChange = 'revoke' | 'authorize' | 'maintain_liabilities';

export type AuthorizationMode = 'not_required' | 'revocable' | 'locked' | 'immutable';

export interface AuthorizationRevocationParams {
  assetCode?: string;
  assetIssuer?: string;
  horizonUrl?: string;
  proposedChange?: ProposedAuthorizationChange | string;
  targetAccounts?: string[] | string;
  maxTrustlines?: number | string;
  historyLimit?: number | string;
  includeHistory?: boolean | string;
  json?: boolean | string;
}

export interface IssuerFlagsLike {
  auth_required?: boolean;
  auth_revocable?: boolean;
  auth_immutable?: boolean;
  auth_clawback_enabled?: boolean;
}

export interface IssuerAuthorizationConfig {
  authRequired: boolean;
  authRevocable: boolean;
  authImmutable: boolean;
  authClawbackEnabled: boolean;
  authorizationMode: AuthorizationMode;
  clawbackStatus: 'enabled' | 'disabled' | 'unknown';
  warnings: string[];
}

export interface TrustlineBalanceLike {
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  balance?: string;
  limit?: string;
  buying_liabilities?: string;
  selling_liabilities?: string;
  is_authorized?: boolean;
  is_authorized_to_maintain_liabilities?: boolean;
}

export interface AccountTrustlineRecord {
  account_id?: string;
  id?: string;
  balances?: TrustlineBalanceLike[];
}

export interface AssetTrustline {
  account: string;
  assetCode: string;
  assetIssuer: string;
  balance: string;
  balanceUnits: string;
  limit: string | null;
  buyingLiabilities: string;
  sellingLiabilities: string;
  state: TrustlineAuthorizationState;
}

export interface TrustlineFetchResult {
  trustlines: AssetTrustline[];
  pagesFetched: number;
  truncated: boolean;
  paginationError: string | null;
}

export interface AuthorizationStatistics {
  totalTrustlines: number;
  authorizedCount: number;
  maintainLiabilitiesCount: number;
  unauthorizedCount: number;
  zeroBalanceCount: number;
  nonZeroBalanceCount: number;
  totalBalance: string;
  authorizedBalance: string;
  maintainLiabilitiesBalance: string;
  unauthorizedBalance: string;
  nonZeroAccounts: string[];
}

export interface AuthorizationImpactChange {
  account: string;
  previousState: TrustlineAuthorizationState;
  proposedState: TrustlineAuthorizationState;
  balance: string;
  hasNonzeroBalance: boolean;
  receiveRestricted: boolean;
  transferRestricted: boolean;
}

export interface AuthorizationImpact {
  proposedChange: ProposedAuthorizationChange;
  targetAccountCount: number | null;
  affectedTrustlineCount: number;
  affectedAccounts: string[];
  unaffectedAccounts: string[];
  missingTargetAccounts: string[];
  aggregateAffectedBalance: string;
  accountsWithNonzeroBalances: string[];
  changes: AuthorizationImpactChange[];
  assumptions: string[];
}

export interface HistoricalAuthorizationChange {
  operationId: string;
  operationType: string;
  createdAt: string | null;
  ledger: number | null;
  sourceAccount: string | null;
  trustor: string | null;
  assetCode: string | null;
  assetIssuer: string | null;
  description: string;
}

export interface AuthorizationHistoryResult {
  changes: HistoricalAuthorizationChange[];
  pagesFetched: number;
  truncated: boolean;
  error: string | null;
}

export interface AuthorizationImpactReportInput {
  assetCode: string;
  assetIssuer: string;
  issuerAccount: { account_id?: string; flags?: IssuerFlagsLike } | null;
  issuerError?: string | null;
  trustlines: AssetTrustline[];
  pagesFetched?: number;
  trustlinesTruncated?: boolean;
  trustlineError?: string | null;
  proposedChange?: ProposedAuthorizationChange;
  targetAccounts?: string[];
  history?: AuthorizationHistoryResult | null;
  extraWarnings?: string[];
}

export interface AuthorizationImpactReport {
  assetCode: string;
  assetIssuer: string;
  issuerAccountId: string | null;
  issuerAccountExists: boolean;
  issuerAuthorization: IssuerAuthorizationConfig;
  totalTrustlinesInspected: number;
  statistics: AuthorizationStatistics;
  proposedChange: ProposedAuthorizationChange;
  impact: AuthorizationImpact;
  historicalAuthorizationChanges: HistoricalAuthorizationChange[];
  historyStatus: 'not_requested' | 'retrieved' | 'failed';
  historyError: string | null;
  clawbackConfigurationStatus: 'enabled' | 'disabled' | 'unknown';
  warnings: string[];
  limitations: string[];
  overallImpactAssessment: 'none' | 'low' | 'medium' | 'high' | 'unknown';
}

// ──────────────────────────────────────────────────────────────────────────────
// Validation and amount helpers
// ──────────────────────────────────────────────────────────────────────────────

export function isValidAssetCode(code: unknown): code is string {
  return typeof code === 'string' && /^[A-Za-z0-9]{1,12}$/.test(code);
}

export function isValidAccountId(accountId: unknown): accountId is string {
  return typeof accountId === 'string' && StrKey.isValidEd25519PublicKey(accountId);
}

export function validateAssetIdentity(assetCode: unknown, assetIssuer: unknown): {
  assetCode: string;
  assetIssuer: string;
} {
  if (!isValidAssetCode(assetCode)) {
    throw new Error(
      `Invalid asset code "${String(assetCode)}": expected 1-12 alphanumeric characters.`,
    );
  }
  if (assetCode.toUpperCase() === 'XLM') {
    throw new Error('XLM is the native asset and has no issuer-managed trustlines.');
  }
  if (!isValidAccountId(assetIssuer)) {
    throw new Error(
      `Invalid issuer account "${String(assetIssuer)}": expected a valid Stellar G... public key.`,
    );
  }
  return { assetCode, assetIssuer };
}

export function parseAmountUnits(value: unknown, field = 'amount'): bigint {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,7})?$/.test(value)) {
    throw new Error(
      `${field} must be a non-negative decimal string with at most 7 decimal places.`,
    );
  }
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, '0'));
}

export function formatAmountUnits(units: bigint): string {
  if (units < 0n) throw new Error('amount cannot be negative.');
  const whole = units / 10_000_000n;
  const fraction = units % 10_000_000n;
  return `${whole}.${fraction.toString().padStart(7, '0')}`;
}

function safeAmountUnits(value: string | undefined): bigint {
  try {
    return parseAmountUnits(value ?? '0');
  } catch {
    return 0n;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Issuer flags and trustline extraction
// ──────────────────────────────────────────────────────────────────────────────

export function getIssuerAuthorizationConfig(
  flags: IssuerFlagsLike = {},
): IssuerAuthorizationConfig {
  const authRequired = flags.auth_required === true;
  const authRevocable = flags.auth_revocable === true;
  const authImmutable = flags.auth_immutable === true;
  const authClawbackEnabled = flags.auth_clawback_enabled === true;
  const warnings: string[] = [];

  let authorizationMode: AuthorizationMode;
  if (!authRequired) authorizationMode = 'not_required';
  else if (authImmutable) authorizationMode = 'immutable';
  else if (authRevocable) authorizationMode = 'revocable';
  else authorizationMode = 'locked';

  if (!authRequired) {
    warnings.push(
      'AUTH_REQUIRED is not set. Trustlines are authorized by default, so a revocation has no effect until authorization is required.',
    );
  }
  if (authRequired && !authRevocable) {
    warnings.push(
      'AUTH_REQUIRED is set without AUTH_REVOCABLE. Existing authorizations cannot be revoked under the current flags.',
    );
  }
  if (authImmutable) {
    warnings.push('AUTH_IMMUTABLE is set; issuer authorization flags can no longer be changed.');
  }

  return {
    authRequired,
    authRevocable,
    authImmutable,
    authClawbackEnabled,
    authorizationMode,
    clawbackStatus:
      flags.auth_clawback_enabled === undefined
        ? 'unknown'
        : authClawbackEnabled
          ? 'enabled'
          : 'disabled',
    warnings,
  };
}

export function getTrustlineAuthorizationState(
  trustline: TrustlineBalanceLike,
): TrustlineAuthorizationState {
  if (trustline.is_authorized === true) return 'AUTHORIZED';
  if (trustline.is_authorized_to_maintain_liabilities === true) {
    return 'AUTHORIZED_TO_MAINTAIN_LIABILITIES';
  }
  if (
    trustline.is_authorized === false ||
    trustline.is_authorized_to_maintain_liabilities === false
  ) {
    return 'UNAUTHORIZED';
  }
  // Horizon omits both flags when the issuer does not require authorization.
  return 'AUTHORIZED';
}

export function extractTrustline(
  account: AccountTrustlineRecord,
  assetCode: string,
  assetIssuer: string,
): AssetTrustline | null {
  const accountId = account.account_id ?? account.id;
  if (!accountId) return null;
  const line = (account.balances ?? []).find(
    (balance) =>
      balance.asset_code === assetCode &&
      balance.asset_issuer === assetIssuer &&
      balance.asset_type !== 'native',
  );
  if (!line) return null;

  const balance = line.balance ?? '0.0000000';
  return {
    account: accountId,
    assetCode,
    assetIssuer,
    balance,
    balanceUnits: safeAmountUnits(balance).toString(),
    limit: line.limit ?? null,
    buyingLiabilities: line.buying_liabilities ?? '0.0000000',
    sellingLiabilities: line.selling_liabilities ?? '0.0000000',
    state: getTrustlineAuthorizationState(line),
  };
}

export async function fetchAllTrustlines(
  server: Horizon.Server,
  asset: Asset,
  maxTrustlines = DEFAULT_MAX_TRUSTLINES,
): Promise<TrustlineFetchResult> {
  const trustlines: AssetTrustline[] = [];
  let pagesFetched = 0;
  let truncated = false;
  let paginationError: string | null = null;

  try {
    let page = (await server
      .accounts()
      .forAsset(asset)
      .limit(Math.min(HORIZON_PAGE_LIMIT, Math.max(1, maxTrustlines)))
      .call()) as unknown as {
      records: AccountTrustlineRecord[];
      next: () => Promise<{ records: AccountTrustlineRecord[]; next: () => Promise<any> }>;
    };

    while (page.records.length > 0) {
      pagesFetched += 1;
      for (const record of page.records) {
        const trustline = extractTrustline(record, asset.getCode(), asset.getIssuer());
        if (trustline) trustlines.push(trustline);
      }
      if (trustlines.length >= maxTrustlines) {
        truncated = true;
        break;
      }
      page = await page.next();
    }
  } catch (error) {
    paginationError = error instanceof Error ? error.message : String(error);
  }

  return {
    trustlines: trustlines.slice(0, maxTrustlines),
    pagesFetched,
    truncated,
    paginationError,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Authorization statistics and impact simulation
// ──────────────────────────────────────────────────────────────────────────────

export function summarizeTrustlineAuthorization(
  trustlines: AssetTrustline[],
): AuthorizationStatistics {
  let authorizedUnits = 0n;
  let maintainUnits = 0n;
  let unauthorizedUnits = 0n;
  const nonZeroAccounts: string[] = [];

  for (const trustline of trustlines) {
    const units = BigInt(trustline.balanceUnits);
    if (units > 0n) nonZeroAccounts.push(trustline.account);
    if (trustline.state === 'AUTHORIZED') authorizedUnits += units;
    else if (trustline.state === 'AUTHORIZED_TO_MAINTAIN_LIABILITIES') {
      maintainUnits += units;
    } else unauthorizedUnits += units;
  }

  return {
    totalTrustlines: trustlines.length,
    authorizedCount: trustlines.filter((line) => line.state === 'AUTHORIZED').length,
    maintainLiabilitiesCount: trustlines.filter(
      (line) => line.state === 'AUTHORIZED_TO_MAINTAIN_LIABILITIES',
    ).length,
    unauthorizedCount: trustlines.filter((line) => line.state === 'UNAUTHORIZED').length,
    zeroBalanceCount: trustlines.filter((line) => BigInt(line.balanceUnits) === 0n).length,
    nonZeroBalanceCount: nonZeroAccounts.length,
    totalBalance: formatAmountUnits(authorizedUnits + maintainUnits + unauthorizedUnits),
    authorizedBalance: formatAmountUnits(authorizedUnits),
    maintainLiabilitiesBalance: formatAmountUnits(maintainUnits),
    unauthorizedBalance: formatAmountUnits(unauthorizedUnits),
    nonZeroAccounts: nonZeroAccounts.sort(),
  };
}

function proposedStateFor(change: ProposedAuthorizationChange): TrustlineAuthorizationState {
  if (change === 'authorize') return 'AUTHORIZED';
  if (change === 'maintain_liabilities') return 'AUTHORIZED_TO_MAINTAIN_LIABILITIES';
  return 'UNAUTHORIZED';
}

function isProposedChange(value: unknown): value is ProposedAuthorizationChange {
  return value === 'revoke' || value === 'authorize' || value === 'maintain_liabilities';
}

export function simulateAuthorizationImpact(
  trustlines: AssetTrustline[],
  proposedChange: ProposedAuthorizationChange,
  targetAccounts?: string[],
): AuthorizationImpact {
  const targetSet =
    targetAccounts && targetAccounts.length > 0 ? new Set(targetAccounts) : null;
  const relevant = targetSet
    ? trustlines.filter((trustline) => targetSet.has(trustline.account))
    : trustlines;
  const foundTargets = new Set(relevant.map((trustline) => trustline.account));
  const missingTargetAccounts = targetSet
    ? [...targetSet].filter((account) => !foundTargets.has(account)).sort()
    : [];
  const proposedState = proposedStateFor(proposedChange);
  const changes: AuthorizationImpactChange[] = [];

  for (const trustline of relevant) {
    if (trustline.state === proposedState) continue;
    const hasNonzeroBalance = BigInt(trustline.balanceUnits) > 0n;
    changes.push({
      account: trustline.account,
      previousState: trustline.state,
      proposedState,
      balance: trustline.balance,
      hasNonzeroBalance,
      receiveRestricted: proposedState !== 'AUTHORIZED',
      transferRestricted: proposedState === 'UNAUTHORIZED',
    });
  }

  const affectedAccounts = changes.map((change) => change.account).sort();
  const unaffectedAccounts = relevant
    .filter((trustline) => trustline.state === proposedState)
    .map((trustline) => trustline.account)
    .sort();
  const aggregateAffectedUnits = changes.reduce(
    (total, change) => total + parseAmountUnits(change.balance),
    0n,
  );
  const accountsWithNonzeroBalances = changes
    .filter((change) => change.hasNonzeroBalance)
    .map((change) => change.account)
    .sort();

  return {
    proposedChange,
    targetAccountCount: targetSet ? targetSet.size : null,
    affectedTrustlineCount: changes.length,
    affectedAccounts,
    unaffectedAccounts,
    missingTargetAccounts,
    aggregateAffectedBalance: formatAmountUnits(aggregateAffectedUnits),
    accountsWithNonzeroBalances,
    changes,
    assumptions: [
      'Impact is projected from the trustline state retrieved at analysis time and may change before any transaction executes.',
      'Revoking authorization restricts transfers according to the current authorization mode; it does not guarantee removal of an existing balance.',
      'Clawback is a separate operation and is not simulated by this analysis.',
    ],
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Historical authorization operations
// ──────────────────────────────────────────────────────────────────────────────

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function normalizeAuthorizationOperation(
  raw: Record<string, unknown>,
): HistoricalAuthorizationChange | null {
  const operationType = readString(raw, 'type');
  if (!operationType) return null;
  const isAuthorizationType =
    operationType === 'set_trust_line_flags' ||
    operationType === 'allow_trust' ||
    (operationType === 'set_options' &&
      ((readNumber(raw, 'set_flags') ?? 0) !== 0 ||
        (readNumber(raw, 'clear_flags') ?? 0) !== 0));
  if (!isAuthorizationType) return null;

  const trustor = readString(raw, 'trustor');
  const setFlags = readNumber(raw, 'set_flags') ?? 0;
  const clearFlags = readNumber(raw, 'clear_flags') ?? 0;
  const authorize = raw.authorize;
  const description =
    operationType === 'set_options'
      ? `Issuer authorization flags changed (set=${setFlags}, clear=${clearFlags}).`
      : operationType === 'allow_trust'
        ? `Legacy allow_trust operation for ${trustor ?? 'unknown account'} (authorize=${String(authorize ?? 'unknown')}).`
        : `Trustline flags changed for ${trustor ?? 'unknown account'} (set=${setFlags}, clear=${clearFlags}).`;

  return {
    operationId: readString(raw, 'id') ?? '',
    operationType,
    createdAt: readString(raw, 'created_at'),
    ledger: readNumber(raw, 'ledger'),
    sourceAccount: readString(raw, 'source_account'),
    trustor,
    assetCode: readString(raw, 'asset_code'),
    assetIssuer: readString(raw, 'asset_issuer'),
    description,
  };
}

export async function fetchAuthorizationHistory(
  server: Horizon.Server,
  issuerAccountId: string,
  limit = DEFAULT_HISTORY_LIMIT,
): Promise<AuthorizationHistoryResult> {
  const changes: HistoricalAuthorizationChange[] = [];
  let pagesFetched = 0;
  let truncated = false;
  let error: string | null = null;

  try {
    let page = (await server
      .operations()
      .forAccount(issuerAccountId)
      .order('desc')
      .limit(Math.min(HORIZON_PAGE_LIMIT, Math.max(1, limit)))
      .call()) as unknown as {
      records: Array<Record<string, unknown>>;
      next: () => Promise<{ records: Array<Record<string, unknown>>; next: () => Promise<any> }>;
    };

    while (page.records.length > 0) {
      pagesFetched += 1;
      for (const record of page.records) {
        const normalized = normalizeAuthorizationOperation(record);
        if (normalized) changes.push(normalized);
        if (changes.length >= limit) {
          truncated = true;
          break;
        }
      }
      if (changes.length >= limit) break;
      page = await page.next();
    }
  } catch (fetchError) {
    error = fetchError instanceof Error ? fetchError.message : String(fetchError);
  }

  changes.sort((left, right) => (left.createdAt ?? '').localeCompare(right.createdAt ?? ''));
  return {
    changes: changes.slice(0, limit),
    pagesFetched,
    truncated,
    error,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Report assembly and display
// ──────────────────────────────────────────────────────────────────────────────

export function buildAuthorizationImpactReport(
  input: AuthorizationImpactReportInput,
): AuthorizationImpactReport {
  const issuerAuthorization = getIssuerAuthorizationConfig(input.issuerAccount?.flags);
  const statistics = summarizeTrustlineAuthorization(input.trustlines);
  const proposedChange = input.proposedChange ?? 'revoke';
  const impact = simulateAuthorizationImpact(
    input.trustlines,
    proposedChange,
    input.targetAccounts,
  );
  const warnings = [...issuerAuthorization.warnings, ...(input.extraWarnings ?? [])];
  const issuerAccountExists = Boolean(input.issuerAccount);
  const issuerAccountId = input.issuerAccount?.account_id ?? null;

  if (input.issuerError) {
    warnings.push(`Issuer account retrieval failed: ${input.issuerError}`);
  } else if (!issuerAccountExists) {
    warnings.push('Issuer account was not found.');
  }
  if (issuerAccountExists && issuerAccountId !== input.assetIssuer) {
    warnings.push(
      `Horizon returned issuer account ${issuerAccountId ?? 'unknown'}, not ${input.assetIssuer}.`,
    );
  }
  if (input.trustlineError) {
    warnings.push(`Trustline pagination stopped early: ${input.trustlineError}`);
  }
  if (input.trustlinesTruncated) {
    warnings.push(
      'Trustline retrieval reached its configured cap; the analysis covers only the retrieved set.',
    );
  }
  if (input.history?.error) {
    warnings.push(`Historical authorization lookup failed: ${input.history.error}`);
  }
  if (impact.missingTargetAccounts.length > 0) {
    warnings.push(
      `Target account(s) without a matching trustline: ${impact.missingTargetAccounts.join(', ')}.`,
    );
  }
  if (
    proposedChange === 'revoke' &&
    issuerAuthorization.authRequired &&
    !issuerAuthorization.authRevocable
  ) {
    warnings.push(
      'The proposed revocation cannot be applied while AUTH_REQUIRED is set without AUTH_REVOCABLE.',
    );
  }
  if (proposedChange === 'revoke' && !issuerAuthorization.authRequired) {
    warnings.push(
      'Because AUTH_REQUIRED is not set, current trustlines are treated as authorized by default; enabling AUTH_REQUIRED is a separate issuer configuration change.',
    );
  }
  if (issuerAuthorization.authClawbackEnabled) {
    warnings.push(
      'AUTH_CLAWBACK_ENABLED is set. Clawback can remove balances, but it is a separate operation from authorization revocation.',
    );
  }
  if (impact.accountsWithNonzeroBalances.length > 0) {
    warnings.push(
      `${impact.accountsWithNonzeroBalances.length} affected account(s) hold nonzero balances; authorization changes may restrict transfers but do not automatically remove those balances.`,
    );
  }
  for (const line of input.trustlines) {
    if (line.state === 'UNAUTHORIZED' && BigInt(line.balanceUnits) > 0n) {
      warnings.push(
        `Account ${line.account} has an unauthorized trustline with a nonzero balance of ${line.balance}.`,
      );
    }
  }

  const affectedUnits = parseAmountUnits(impact.aggregateAffectedBalance);
  let overallImpactAssessment: AuthorizationImpactReport['overallImpactAssessment'];
  if (!issuerAccountExists || input.trustlineError) {
    overallImpactAssessment = 'unknown';
  } else if (impact.affectedTrustlineCount === 0) {
    overallImpactAssessment = 'none';
  } else if (affectedUnits === 0n) {
    overallImpactAssessment = 'low';
  } else if (impact.accountsWithNonzeroBalances.length >= 10) {
    overallImpactAssessment = 'high';
  } else {
    overallImpactAssessment = 'medium';
  }

  return {
    assetCode: input.assetCode,
    assetIssuer: input.assetIssuer,
    issuerAccountId,
    issuerAccountExists,
    issuerAuthorization,
    totalTrustlinesInspected: input.trustlines.length,
    statistics,
    proposedChange,
    impact,
    historicalAuthorizationChanges: input.history?.changes ?? [],
    historyStatus: input.history
      ? input.history.error
        ? 'failed'
        : 'retrieved'
      : 'not_requested',
    historyError: input.history?.error ?? null,
    clawbackConfigurationStatus: issuerAuthorization.clawbackStatus,
    warnings: [...new Set(warnings)],
    limitations: [
      'Projected impact is an estimate based on retrieved account state, not a guaranteed outcome.',
      'Revoking authorization does not guarantee removal of an existing asset balance.',
      'Authorization revocation and asset clawback are different operations with different requirements.',
      'Historical operations may be incomplete or unavailable through the queried Horizon endpoint.',
      'This example is read-only and never submits an authorization-changing transaction.',
    ],
    overallImpactAssessment,
  };
}

export function formatAuthorizationImpactReport(report: AuthorizationImpactReport): string {
  const lines = [
    '=== Stellar Asset Authorization Revocation Impact Analysis ===',
    `Asset: ${report.assetCode}:${report.assetIssuer}`,
    `Issuer account exists: ${report.issuerAccountExists}`,
    `AUTH_REQUIRED: ${report.issuerAuthorization.authRequired}`,
    `AUTH_REVOCABLE: ${report.issuerAuthorization.authRevocable}`,
    `AUTH_IMMUTABLE: ${report.issuerAuthorization.authImmutable}`,
    `AUTH_CLAWBACK_ENABLED: ${report.issuerAuthorization.authClawbackEnabled}`,
    `Authorization mode: ${report.issuerAuthorization.authorizationMode}`,
    `Clawback configuration: ${report.clawbackConfigurationStatus}`,
    `Trustlines inspected: ${report.totalTrustlinesInspected}`,
    '',
    'Current trustline authorization:',
    `  Authorized: ${report.statistics.authorizedCount} (${report.statistics.authorizedBalance})`,
    `  Maintain liabilities only: ${report.statistics.maintainLiabilitiesCount} (${report.statistics.maintainLiabilitiesBalance})`,
    `  Unauthorized: ${report.statistics.unauthorizedCount} (${report.statistics.unauthorizedBalance})`,
    `  Zero balance: ${report.statistics.zeroBalanceCount}`,
    `  Nonzero balance: ${report.statistics.nonZeroBalanceCount}`,
    '',
    `Proposed change: ${report.proposedChange}`,
    `Affected trustlines: ${report.impact.affectedTrustlineCount}`,
    `Affected accounts: ${report.impact.affectedAccounts.length}`,
    `Aggregate affected balance: ${report.impact.aggregateAffectedBalance}`,
    `Accounts with nonzero affected balances: ${report.impact.accountsWithNonzeroBalances.length}`,
    `Overall impact assessment: ${report.overallImpactAssessment}`,
  ];

  lines.push('', 'Affected accounts:');
  if (report.impact.changes.length === 0) lines.push('  (none)');
  for (const change of report.impact.changes) {
    lines.push(
      `  ${change.account}: ${change.previousState} -> ${change.proposedState}, balance=${change.balance}` +
        `${change.hasNonzeroBalance ? ' [NONZERO BALANCE]' : ''}`,
    );
  }

  lines.push('', 'Historical authorization changes:');
  if (report.historyStatus === 'failed') {
    lines.push(`  Unavailable: ${report.historyError ?? 'unknown error'}`);
  } else if (report.historicalAuthorizationChanges.length === 0) {
    lines.push('  (none retrieved)');
  } else {
    for (const change of report.historicalAuthorizationChanges) {
      lines.push(
        `  ${change.createdAt ?? 'unknown time'} ledger=${change.ledger ?? 'unknown'}: ${change.description}`,
      );
    }
  }

  if (report.warnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const warning of report.warnings) lines.push(`  - ${warning}`);
  }

  lines.push('', 'Limitations:');
  for (const limitation of report.limitations) lines.push(`  - ${limitation}`);
  return lines.join('\n');
}

function wantsJson(value: boolean | string | undefined): boolean {
  return value === true || value === 'true' || process.env.JSON_OUTPUT === 'true';
}

function parsePositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeProposedChange(value: unknown): ProposedAuthorizationChange {
  if (value === undefined || value === null || value === '') return 'revoke';
  if (!isProposedChange(value)) {
    throw new Error('proposedChange must be revoke, authorize, or maintain_liabilities.');
  }
  return value;
}

function normalizeTargetAccounts(value: string[] | string | undefined): string[] | undefined {
  const entries = Array.isArray(value) ? value : value ? value.split(',') : [];
  const accounts = entries.map((entry) => entry.trim()).filter(Boolean);
  for (const account of accounts) {
    if (!isValidAccountId(account)) {
      throw new Error(`Invalid target account "${account}": expected a Stellar G... public key.`);
    }
  }
  return accounts.length > 0 ? [...new Set(accounts)] : undefined;
}

// ──────────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────────

export async function run(params: AuthorizationRevocationParams = {}): Promise<void> {
  const horizonUrl = params.horizonUrl || process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const assetCode = params.assetCode || process.env.ASSET_CODE || DEFAULT_ASSET_CODE;
  const assetIssuer = params.assetIssuer || process.env.ASSET_ISSUER || DEFAULT_ASSET_ISSUER;
  const json = wantsJson(params.json);
  const maxTrustlines = parsePositiveInteger(
    params.maxTrustlines ?? process.env.MAX_TRUSTLINES,
    DEFAULT_MAX_TRUSTLINES,
  );
  const historyLimit = parsePositiveInteger(
    params.historyLimit ?? process.env.AUTHORIZATION_HISTORY_LIMIT,
    DEFAULT_HISTORY_LIMIT,
  );
  const includeHistory =
    params.includeHistory === true ||
    params.includeHistory === 'true' ||
    process.env.INCLUDE_AUTHORIZATION_HISTORY === 'true';

  try {
    const identity = validateAssetIdentity(assetCode.trim(), assetIssuer.trim());
    const proposedChange = normalizeProposedChange(
      params.proposedChange ?? process.env.PROPOSED_AUTHORIZATION_CHANGE,
    );
    const targetAccounts = normalizeTargetAccounts(
      params.targetAccounts ?? process.env.TARGET_ACCOUNTS,
    );
    const asset = new Asset(identity.assetCode, identity.assetIssuer);
    const server = new Horizon.Server(horizonUrl);

    let issuerAccount: { account_id?: string; flags?: IssuerFlagsLike } | null = null;
    let issuerError: string | null = null;
    try {
      const loaded = await server.loadAccount(identity.assetIssuer);
      issuerAccount = {
        account_id: loaded.account_id,
        flags: loaded.flags as unknown as IssuerFlagsLike,
      };
    } catch (error) {
      issuerError = error instanceof Error ? error.message : String(error);
    }

    const fetched = await fetchAllTrustlines(server, asset, maxTrustlines);
    let history: AuthorizationHistoryResult | null = null;
    if (includeHistory && issuerAccount) {
      history = await fetchAuthorizationHistory(server, identity.assetIssuer, historyLimit);
    }

    const report = buildAuthorizationImpactReport({
      ...identity,
      issuerAccount,
      issuerError,
      trustlines: fetched.trustlines,
      pagesFetched: fetched.pagesFetched,
      trustlinesTruncated: fetched.truncated,
      trustlineError: fetched.paginationError,
      proposedChange,
      targetAccounts,
      history,
    });

    console.log(json ? JSON.stringify(report, null, 2) : formatAuthorizationImpactReport(report));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) console.log(JSON.stringify({ assetCode, assetIssuer, error: message }, null, 2));
    else console.error(`Could not analyse authorization revocation impact: ${message}`);
  }
}
