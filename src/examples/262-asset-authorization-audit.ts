/**
 * 262-asset-authorization-audit: Stellar Asset Authorization History and Trustline Permission Audit
 *
 * OVERVIEW
 * --------
 * Read-only example that audits authorization controls for a Stellar asset:
 *
 *   1. Inspects the issuer account's authorization-related flags
 *      (AUTH_REQUIRED, AUTH_REVOCABLE, AUTH_IMMUTABLE, AUTH_CLAWBACK_ENABLED).
 *   2. Optionally inspects a holder account's trustline for the asset and
 *      reports its current authorization state.
 *   3. Retrieves historical account operations (bounded pagination) and
 *      surfaces operations that changed issuer configuration or trustline
 *      authorization.
 *
 * It never requests or exposes secret keys and never submits state-changing
 * transactions. Current authorization state is clearly separated from
 * historical observations; no safety claim is inferred from the mere presence
 * of authorization or clawback controls.
 */

import { Asset, Horizon, Keypair } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_PAGE_SIZE = 10;
const DEFAULT_MAX_PAGES = 5;

export type TrustlineAuthorizationState =
  | 'AUTHORIZED'
  | 'AUTHORIZED_TO_MAINTAIN_LIABILITIES'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'UNKNOWN';

export type ReportSection = 'current-state' | 'historical-observations' | 'interpretation';

export interface IssuerAuthorizationSettings {
  accountId: string;
  authRequired: boolean;
  authRevocable: boolean;
  authImmutable: boolean;
  authClawbackEnabled: boolean;
  flagsSource: 'horizon-account-response' | 'unavailable';
}

export interface TrustlineStatus {
  holderAccount: string | null;
  assetCode: string;
  assetIssuer: string;
  state: TrustlineAuthorizationState;
  balance?: string;
  limit?: string;
  lastModifiedLedger?: number;
  note: string;
}

export interface AuthorizationHistoryRecord {
  pagingToken: string;
  transactionHash: string;
  ledgerSequence?: number;
  closedAt: string;
  operationType: string;
  sourceAccount: string;
  category: 'issuer-configuration' | 'trustline-authorization' | 'other';
  description: string;
  assetCode?: string;
  assetIssuer?: string;
}

export interface AuditReport {
  asset: { code: string; issuer: string; type: 'native' | 'credit4' | 'credit12' };
  issuer: IssuerAuthorizationSettings;
  trustline: TrustlineStatus | null;
  history: AuthorizationHistoryRecord[];
  historyNotes: string[];
  sections: Record<ReportSection, string>;
}

export interface RunParams {
  assetCode?: string;
  assetIssuer?: string;
  holder?: string;
  horizonUrl?: string;
  pageSize?: string;
  maxPages?: string;
  json?: boolean | string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Input validation
// ──────────────────────────────────────────────────────────────────────────────

/** Validates a Stellar asset code (alphanum4: 1-4, alphanum12: 5-12 alphanumeric). */
export function validateAssetCode(assetCode: string): string {
  const code = assetCode.trim();
  if (code.length === 0) throw new Error('Missing asset code');
  if (code.length > 12) throw new Error('Asset code must be at most 12 characters');
  if (!/^[A-Za-z0-9]+$/.test(code)) throw new Error('Asset code must be alphanumeric');
  return code;
}

/** Builds an Asset from validated input, throwing on an invalid issuer key. */
export function buildAsset(assetCode: string, assetIssuer: string): Asset {
  const code = validateAssetCode(assetCode);

  try {
    Keypair.fromPublicKey(assetIssuer.trim());
  } catch {
    throw new Error(`Invalid issuer public key: ${assetIssuer}`);
  }

  return code.length <= 4
    ? new Asset(code, assetIssuer.trim())
    : new Asset(code, assetIssuer.trim());
}

/** Validates an issuer public key and returns it normalized. */
export function validateIssuerPublicKey(issuer: string): string {
  const key = issuer.trim();
  if (key.length === 0) throw new Error('Missing issuer public key');
  try {
    Keypair.fromPublicKey(key);
  } catch {
    throw new Error(`Invalid issuer public key: ${issuer}`);
  }
  return key;
}

// ──────────────────────────────────────────────────────────────────────────────
// Horizon data retrieval
// ──────────────────────────────────────────────────────────────────────────────

export function fetchIssuerAuthorizationSettings(
  server: Horizon.Server,
  issuer: string,
): Promise<IssuerAuthorizationSettings> {
  return server
    .loadAccount(issuer)
    .then((account: Horizon.AccountResponse) => ({
      accountId: account.id,
      authRequired: Boolean(account.flags.auth_required),
      authRevocable: Boolean(account.flags.auth_revocable),
      authImmutable: Boolean(account.flags.auth_immutable),
      authClawbackEnabled: Boolean(account.flags.auth_clawback_enabled),
      flagsSource: 'horizon-account-response' as const,
    }))
    .catch(() => ({
      accountId: issuer,
      authRequired: false,
      authRevocable: false,
      authImmutable: false,
      authClawbackEnabled: false,
      flagsSource: 'unavailable' as const,
    }));
}

export interface HorizonAccountLike {
  id: string;
  balances: Array<{
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
    balance: string;
    limit?: string;
    is_authorized?: boolean;
    is_authorized_to_maintain_liabilities?: boolean;
    is_clawback_enabled?: boolean;
    last_modified_ledger?: number;
    sponsor?: string;
  }>;
}

/** Reads a holder's trustline state for the asset from their Horizon account record. */
export function readTrustlineState(
  account: HorizonAccountLike,
  assetCode: string,
  assetIssuer: string,
): TrustlineStatus {
  const trustline = account.balances.find(
    (balance) =>
      balance.asset_type !== 'native' &&
      balance.asset_code === assetCode &&
      balance.asset_issuer === assetIssuer,
  );

  const base: TrustlineStatus = {
    holderAccount: account.id,
    assetCode,
    assetIssuer,
    state: 'NOT_FOUND',
    note: 'No trustline found for this asset on the holder account.',
  };

  if (!trustline) return base;

  base.balance = trustline.balance;
  base.limit = trustline.limit ?? undefined;
  base.lastModifiedLedger = trustline.last_modified_ledger ?? undefined;

  if (trustline.is_authorized === true) {
    base.state = 'AUTHORIZED';
    base.note = 'Trustline is fully authorized; the holder may hold and transact in the asset.';
  } else if (trustline.is_authorized_to_maintain_liabilities === true) {
    base.state = 'AUTHORIZED_TO_MAINTAIN_LIABILITIES';
    base.note =
      'Trustline is in the maintain-liabilities state; existing liabilities may be settled but no new activity is permitted.';
  } else {
    base.state = 'UNAUTHORIZED';
    base.note =
      'Trustline exists but is not authorized; the holder cannot transact in the asset until the issuer authorizes it.';
  }

  return base;
}

export async function fetchTrustlineStatus(
  server: Horizon.Server,
  holder: string | undefined,
  assetCode: string,
  assetIssuer: string,
): Promise<TrustlineStatus | null> {
  if (!holder) return null;

  let account: HorizonAccountLike;
  try {
    account = await server.loadAccount(holder);
  } catch {
    return {
      holderAccount: holder,
      assetCode,
      assetIssuer,
      state: 'UNKNOWN',
      note: 'Holder account could not be retrieved from Horizon; trustline state is unknown.',
    };
  }

  return readTrustlineState(account, assetCode, assetIssuer);
}

export interface HorizonOperationRecordLike {
  paging_token: string;
  transaction_hash: string;
  ledger_at?: string;
  created_at: string;
  source_account: string;
  type: string;
  asset_code?: string;
  asset_issuer?: string;
  trustee?: string;
  trustor?: string;
  authorize?: boolean;
  authorize_to_maintain_liabilities?: boolean;
  set_flags?: number[];
  clear_flags?: number[];
  set_flags_s?: string[];
  clear_flags_s?: string[];
  high_threshold?: number;
  med_threshold?: number;
  low_threshold?: number;
  master_key_weight?: number;
}

/** Authorization-relevant Horizon operation types. */
const AUTHORIZATION_OPERATION_TYPES = new Set([
  'set_options',
  'allow_trust',
  'set_trust_line_flags',
  'clawback',
]);

const FLAG_MEANINGS: Record<number, string> = {
  1: 'AUTH_REQUIRED',
  2: 'AUTH_REVOCABLE',
  4: 'AUTH_CLAWBACK_ENABLED',
};

function flagChangesToText(record: HorizonOperationRecordLike): string {
  const parts: string[] = [];
  for (const flag of record.set_flags ?? [])
    parts.push(`set ${FLAG_MEANINGS[flag] ?? `flag(${flag})`}`);
  for (const flag of record.clear_flags ?? [])
    parts.push(`clear ${FLAG_MEANINGS[flag] ?? `flag(${flag})`}`);
  return parts.length > 0 ? parts.join(', ') : 'no flag changes recorded';
}

/** Classifies a single operation into an audit-relevant record. */
export function classifyOperation(
  record: HorizonOperationRecordLike,
  assetCode: string,
  assetIssuer: string,
): AuthorizationHistoryRecord | null {
  if (!AUTHORIZATION_OPERATION_TYPES.has(record.type)) return null;

  const base: AuthorizationHistoryRecord = {
    pagingToken: record.paging_token,
    transactionHash: record.transaction_hash,
    ledgerSequence: record.ledger_at ? Number(record.ledger_at) : undefined,
    closedAt: record.created_at,
    operationType: record.type,
    sourceAccount: record.source_account,
    category: 'other',
    description: `${record.type} operation`,
  };

  if (record.type === 'set_options') {
    const flagText = flagChangesToText(record);
    const touchesAsset = record.asset_code === assetCode && record.asset_issuer === assetIssuer;
    base.category = 'issuer-configuration';
    base.description = `Issuer account configuration changed: ${flagText || '(none)'}${
      touchesAsset ? ` (operation also references asset ${assetCode}:${assetIssuer})` : ''
    }`;
    base.assetCode = touchesAsset ? assetCode : undefined;
    base.assetIssuer = touchesAsset ? assetIssuer : undefined;
    return base;
  }

  if (record.type === 'allow_trust') {
    const touchesAsset = record.asset_code === assetCode && record.asset_issuer === assetIssuer;
    const target = record.trustee || record.trustor || '(unknown)';
    const authorized =
      record.authorize === true
        ? 'authorized'
        : record.authorize === false
          ? 'deauthorized'
          : 'flag updated';
    const maintainLiabilities =
      record.authorize_to_maintain_liabilities === true ? ' (maintain-liabilities)' : '';
    base.category = 'trustline-authorization';
    base.description = `Trustline authorization for ${target} set to ${authorized}${maintainLiabilities}`;
    base.assetCode = touchesAsset ? assetCode : undefined;
    base.assetIssuer = touchesAsset ? assetIssuer : undefined;
    return base;
  }

  if (record.type === 'set_trust_line_flags') {
    const touchesAsset = record.asset_code === assetCode && record.asset_issuer === assetIssuer;
    const target = record.trustor || '(unknown)';
    base.category = 'trustline-authorization';
    base.description = `Trustline flags for ${target} updated: ${flagChangesToText(record)}`;
    base.assetCode = touchesAsset ? assetCode : undefined;
    base.assetIssuer = touchesAsset ? assetIssuer : undefined;
    return base;
  }

  if (record.type === 'clawback') {
    const touchesAsset = record.asset_code === assetCode && record.asset_issuer === assetIssuer;
    base.category = 'trustline-authorization';
    base.description = `Clawback operation on asset ${record.asset_code ?? assetCode}:${record.asset_issuer ?? assetIssuer}`;
    base.assetCode = touchesAsset ? assetCode : undefined;
    base.assetIssuer = touchesAsset ? assetIssuer : undefined;
    return base;
  }

  return null;
}

/**
 * Retrieves authorization-relevant historical operations with bounded pagination.
 * Results are deduplicated by paging token and returned newest-first by default
 * of the Horizon order requested by the caller (here ascending = chronological).
 */
export async function fetchAuthorizationHistory(
  server: Horizon.Server,
  accountId: string,
  assetCode: string,
  assetIssuer: string,
  params: { pageSize: number; maxPages: number },
): Promise<{
  records: AuthorizationHistoryRecord[];
  pagesRead: number;
  incompleteCoverage: boolean;
}> {
  const records: AuthorizationHistoryRecord[] = [];
  const seen = new Set<string>();
  let page = await server
    .operations()
    .forAccount(accountId)
    .limit(params.pageSize)
    .order('asc')
    .call();

  let pagesRead = 0;
  let incompleteCoverage = false;

  for (let i = 0; i < params.maxPages; i++) {
    pagesRead = i + 1;
    const rawRecords = (page.records ?? []) as HorizonOperationRecordLike[];

    for (const raw of rawRecords) {
      if (seen.has(raw.paging_token)) continue;
      seen.add(raw.paging_token);
      const classified = classifyOperation(raw, assetCode, assetIssuer);
      if (classified) records.push(classified);
    }

    // `next` is present on Horizon collection pages when a further page exists.
    const nextPage = (page as { next?: () => Promise<unknown> }).next;
    if (!nextPage) break;

    try {
      page = (await nextPage()) as typeof page;
    } catch {
      incompleteCoverage = true;
      break;
    }
  }

  if (pagesRead === params.maxPages) incompleteCoverage = true;

  return { records, pagesRead, incompleteCoverage };
}

// ──────────────────────────────────────────────────────────────────────────────
// Analysis and report
// ──────────────────────────────────────────────────────────────────────────────

function describeIssuerSettings(settings: IssuerAuthorizationSettings): string {
  const enabled: string[] = [];
  if (settings.authRequired) enabled.push('AUTH_REQUIRED');
  if (settings.authRevocable) enabled.push('AUTH_REVOCABLE');
  if (settings.authImmutable) enabled.push('AUTH_IMMUTABLE');
  if (settings.authClawbackEnabled) enabled.push('AUTH_CLAWBACK_ENABLED');

  return enabled.length > 0 ? enabled.join(', ') : 'None (default flags)';
}

function buildInterpretation(report: AuditReport): { summary: string; caveats: string[] } {
  const caveats: string[] = [];
  const parts: string[] = [];

  const settings = report.issuer;
  parts.push(
    `Asset ${report.asset.code}:${report.asset.issuer} is issued by ${settings.accountId}. ` +
      `Issuer authorization flags: ${describeIssuerSettings(settings)}.`,
  );

  if (settings.flagsSource === 'unavailable') {
    caveats.push(
      'Issuer account data was unavailable; issuer-level authorization cannot be conclusively determined.',
    );
    parts.push('Issuer-level authorization state could not be retrieved from Horizon.');
  } else {
    if (settings.authRequired) {
      parts.push('New trustlines for this asset require issuer approval (AUTH_REQUIRED).');
    }
    if (settings.authRevocable) {
      parts.push(
        'Existing trustline authorizations can be revoked by the issuer (AUTH_REVOCABLE).',
      );
    }
    if (settings.authImmutable) {
      parts.push('Issuer flags are locked and cannot be changed (AUTH_IMMUTABLE).');
    }
    if (settings.authClawbackEnabled) {
      parts.push('Clawback is enabled for trustlines (AUTH_CLAWBACK_ENABLED).');
    }
  }

  if (report.trustline) {
    parts.push(
      `Holder ${report.trustline.holderAccount}: trustline state is ${report.trustline.state}. ${report.trustline.note}`,
    );
    if (report.trustline.state === 'UNKNOWN') {
      caveats.push(
        "Holder account couldn't be retrieved; trustline state is unknown — not a proof of authorization or lack thereof.",
      );
    }
  } else {
    parts.push('No holder account was supplied, so no individual trustline was inspected.');
  }

  if (report.history.length === 0) {
    parts.push(
      'No authorization-relevant historical operations were found in the inspected history window.',
    );
    caveats.push(
      'Historical coverage is limited to the queried account and page range; older changes may exist.',
    );
  } else {
    const issuerChanges = report.history.filter(
      (r) => r.category === 'issuer-configuration',
    ).length;
    const trustlineChanges = report.history.filter(
      (r) => r.category === 'trustline-authorization',
    ).length;
    parts.push(
      `History shows ${issuerChanges} issuer-configuration change(s) and ${trustlineChanges} trustline-authorization change(s).`,
    );
    if (report.historyNotes.length > 0) caveats.push(...report.historyNotes);
  }

  caveats.push(
    'Authorization flags describe issuer controls, not asset safety. Enabled authorization or clawback',
    'controls are legitimate compliance tools and do not by themselves make an asset unsafe.',
    'Historical observations cannot reconstruct an exact prior state when records are missing.',
  );

  return { summary: parts.join(' '), caveats };
}

export function buildReport(
  assetCode: string,
  assetIssuer: string,
  issuer: IssuerAuthorizationSettings,
  trustline: TrustlineStatus | null,
  history: AuthorizationHistoryRecord[],
  historyNotes: string[],
): AuditReport {
  const assetType = assetCode.length <= 4 ? 'credit4' : 'credit12';
  const report: AuditReport = {
    asset: { code: assetCode, issuer: assetIssuer, type: assetType as 'credit4' | 'credit12' },
    issuer,
    trustline,
    history,
    historyNotes,
    sections: {
      'current-state': '',
      'historical-observations': '',
      interpretation: '',
    },
  };

  const currentStateLines: string[] = [];
  currentStateLines.push(
    `Asset: ${report.asset.code}:${report.asset.issuer} (${report.asset.type})`,
  );
  currentStateLines.push(`Issuer: ${issuer.accountId}`);
  currentStateLines.push(`- AUTH_REQUIRED: ${issuer.authRequired}`);
  currentStateLines.push(`- AUTH_REVOCABLE: ${issuer.authRevocable}`);
  currentStateLines.push(`- AUTH_IMMUTABLE: ${issuer.authImmutable}`);
  currentStateLines.push(`- AUTH_CLAWBACK_ENABLED: ${issuer.authClawbackEnabled}`);
  currentStateLines.push(`Issuer data source: ${issuer.flagsSource}`);
  if (report.trustline) {
    currentStateLines.push(`Holder: ${report.trustline.holderAccount}`);
    currentStateLines.push(`Trustline state: ${report.trustline.state}`);
    currentStateLines.push(`Detail: ${report.trustline.note}`);
    if (report.trustline.balance !== undefined)
      currentStateLines.push(`Balance: ${report.trustline.balance}`);
    if (report.trustline.limit !== undefined)
      currentStateLines.push(`Limit: ${report.trustline.limit}`);
    if (report.trustline.lastModifiedLedger !== undefined) {
      currentStateLines.push(`Last modified ledger: ${report.trustline.lastModifiedLedger}`);
    }
  } else {
    currentStateLines.push('Holder: not supplied — no trustline inspected.');
  }
  report.sections['current-state'] = currentStateLines.join('\n');

  const historyLines: string[] = [];
  historyLines.push(`Authorization-relevant operations retrieved: ${report.history.length}`);
  if (report.history.length > 0) {
    for (const record of report.history) {
      historyLines.push(
        `  [${record.closedAt}] ${record.operationType} in tx ${record.transactionHash}${
          record.ledgerSequence !== undefined ? ` (ledger ${record.ledgerSequence})` : ''
        } — ${record.description}`,
      );
    }
  }
  report.sections['historical-observations'] = historyLines.join('\n');

  const { summary, caveats } = buildInterpretation(report);
  report.sections.interpretation = `${summary}\n\nCaveats:\n- ${caveats.join('\n- ')}`;

  return report;
}

export function formatReport(report: AuditReport): string {
  const lines: string[] = [];
  lines.push('══════════════════════════════════════════════════════════');
  lines.push('  Stellar Asset Authorization Audit Report');
  lines.push('══════════════════════════════════════════════════════════');
  lines.push('');
  lines.push('--- Current state ---');
  lines.push(report.sections['current-state']);
  lines.push('');
  lines.push('--- Trustline (holder) ---');
  lines.push(report.trustline ? report.trustline.note : 'No holder supplied.');
  lines.push('');
  lines.push('--- Historical observations ---');
  lines.push(report.sections['historical-observations']);
  if (report.historyNotes.length > 0) {
    lines.push('History notes: ' + report.historyNotes.join(' '));
  }
  lines.push('');
  lines.push('--- Interpretation ---');
  lines.push(report.sections.interpretation);
  lines.push('');
  lines.push(
    'This is a read-only audit. No secret keys were requested and no transactions were submitted.',
  );
  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────────

export async function run(params: RunParams = {}): Promise<void> {
  const outputJson =
    params.json === true || params.json === 'true' || process.env.OUTPUT_JSON === 'true';
  const horizonUrl = params.horizonUrl || DEFAULT_HORIZON_URL;
  const pageSize = Math.min(Math.max(Number(params.pageSize ?? DEFAULT_PAGE_SIZE), 1), 200);
  const maxPages = Math.min(Math.max(Number(params.maxPages ?? DEFAULT_MAX_PAGES), 1), 50);

  console.log('Starting Asset Authorization Audit...');
  console.log(`Using Horizon: ${horizonUrl}`);

  let assetCode: string;
  let assetIssuer: string;

  try {
    if (!params.assetCode || !params.assetIssuer) {
      throw new Error('Both asset code and issuer public key are required.');
    }
    assetCode = validateAssetCode(params.assetCode);
    assetIssuer = validateIssuerPublicKey(params.assetIssuer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nInput validation failed: ${message}`);
    console.error(
      'Usage: asset code (alphanumeric, 1-12 chars) and a valid Stellar issuer public key (G...).',
    );
    process.exitCode = 1;
    return;
  }

  const server = new Horizon.Server(horizonUrl);

  const issuer = await fetchIssuerAuthorizationSettings(server, assetIssuer);

  let trustline: TrustlineStatus | null = null;
  if (params.holder) {
    trustline = await fetchTrustlineStatus(server, params.holder, assetCode, assetIssuer);
  }

  const historyNotes: string[] = [];
  let history: AuthorizationHistoryRecord[] = [];
  let pagesRead = 0;

  try {
    const result = await fetchAuthorizationHistory(server, assetIssuer, assetCode, assetIssuer, {
      pageSize,
      maxPages,
    });
    history = result.records;
    pagesRead = result.pagesRead;
    if (result.incompleteCoverage) {
      historyNotes.push(
        `History scan stopped after ${pagesRead} page(s); older authorization changes may not be covered.`,
      );
    }
    if (history.length === 0) {
      historyNotes.push(
        'No authorization-relevant operations found in the scanned history window.',
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    historyNotes.push(
      `Failed to retrieve historical operations: ${message}. History-based findings are unavailable.`,
    );
  }

  const report = buildReport(assetCode, assetIssuer, issuer, trustline, history, historyNotes);

  if (outputJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }

  console.log('\nAsset authorization audit completed. This was a read-only inspection only.');
}
