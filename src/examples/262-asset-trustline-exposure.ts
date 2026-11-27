import { Horizon, StrKey } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_ACCOUNT_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export interface TrustlineRecordInput {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  limit?: string;
  buying_liabilities?: string;
  selling_liabilities?: string;
  is_authorized?: boolean;
  is_authorized_to_maintain_liabilities?: boolean;
  is_clawback_enabled?: boolean;
  liquidity_pool_id?: string;
}

export interface TrustlinePage {
  records: TrustlineRecordInput[];
  next?: () => Promise<TrustlinePage>;
}

export interface IssuerAccountFlags {
  auth_required?: boolean;
  auth_revocable?: boolean;
  auth_immutable?: boolean;
  auth_clawback_enabled?: boolean;
}

export interface IssuerContext {
  issuer: string;
  status: 'loaded' | 'unavailable';
  flags?: {
    authRequired: boolean;
    authRevocable: boolean;
    authImmutable: boolean;
    authClawbackEnabled: boolean;
  };
  error?: string;
}

export interface TrustlineDataSource {
  loadAccount(accountId: string): Promise<{
    account_id: string;
    balances: TrustlineRecordInput[];
  }>;
  loadTrustlinePages?(accountId: string): Promise<TrustlinePage>;
  loadIssuerAccount?(issuerId: string): Promise<{
    account_id: string;
    flags?: IssuerAccountFlags;
  }>;
}

export interface TrustlineRetrievalResult {
  accountId: string;
  networkUrl: string;
  nativeBalance: string | null;
  trustlines: TrustlineRecordInput[];
  otherBalances: TrustlineRecordInput[];
  pagesFetched: number;
  paginationComplete: boolean;
  warnings: string[];
}

export interface AnalyzedTrustlineHolding {
  assetIdentity: string;
  assetCode: string;
  assetIssuer: string;
  assetType: string;
  balance: string;
  limit: string | null;
  buyingLiabilities: string | null;
  sellingLiabilities: string | null;
  authorizationState: 'authorized' | 'authorized_to_maintain_liabilities' | 'unauthorized' | 'unknown';
  clawbackEnabled: boolean | null;
  hasDuplicateAssetCode: boolean;
  reviewFlags: string[];
  issuerContext?: IssuerContext;
}

export interface TrustlineExposureReport {
  accountId: string;
  networkUrl: string;
  nativeXlmBalance: string | null;
  trustlineCount: number;
  uniqueAssetIdentities: number;
  duplicateAssetCodes: Array<{ assetCode: string; issuers: string[] }>;
  holdings: AnalyzedTrustlineHolding[];
  itemsRequiringReview: string[];
  missingInformation: string[];
  limitations: string[];
  disclaimer: string;
}

export interface TrustlineExposureParams {
  accountId?: string;
  horizonUrl?: string;
  json?: boolean | string;
}

export function createHorizonDataSource(horizonUrl: string): TrustlineDataSource {
  const server = new Horizon.Server(horizonUrl);
  return {
    async loadAccount(accountId: string) {
      const account = await server.loadAccount(accountId);
      return {
        account_id: account.account_id,
        balances: account.balances as unknown as TrustlineRecordInput[],
      };
    },
    async loadIssuerAccount(issuerId: string) {
      const account = await server.loadAccount(issuerId);
      return {
        account_id: account.account_id,
        flags: account.flags as unknown as IssuerAccountFlags,
      };
    },
  };
}

function isValidBalanceString(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  return /^\d+(\.\d+)?$/.test(value.trim());
}

export async function fetchAccountTrustlines(
  accountId: string,
  horizonUrl: string,
  dataSource: TrustlineDataSource,
): Promise<TrustlineRetrievalResult> {
  if (!StrKey.isValidEd25519PublicKey(accountId)) {
    throw new Error(`Invalid Stellar account public key: "${accountId}"`);
  }

  const warnings: string[] = [];
  let nativeBalance: string | null = null;
  const rawRecords: TrustlineRecordInput[] = [];
  let pagesFetched = 0;
  let paginationComplete = true;

  if (dataSource.loadTrustlinePages) {
    let page = await dataSource.loadTrustlinePages(accountId);
    pagesFetched += 1;
    rawRecords.push(...(Array.isArray(page.records) ? page.records : []));

    while (typeof page.next === 'function') {
      try {
        page = await page.next();
        pagesFetched += 1;
        if (!Array.isArray(page.records)) {
          warnings.push(`Page ${pagesFetched} returned an unexpected non-array records structure.`);
          paginationComplete = false;
          break;
        }
        if (page.records.length === 0) {
          break;
        }
        rawRecords.push(...page.records);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        paginationComplete = false;
        throw new Error(
          `Interrupted pagination after ${pagesFetched} page(s) for account ${accountId}: ${message}`,
        );
      }
    }
  } else {
    const account = await dataSource.loadAccount(accountId);
    pagesFetched = 1;
    if (!Array.isArray(account.balances)) {
      throw new Error(`Unexpected Horizon response: "balances" is not an array for ${accountId}`);
    }
    rawRecords.push(...account.balances);
  }

  const trustlines: TrustlineRecordInput[] = [];
  const otherBalances: TrustlineRecordInput[] = [];

  for (const record of rawRecords) {
    if (!record || typeof record !== 'object') {
      warnings.push('Skipped malformed balance entry in Horizon response.');
      continue;
    }

    if (record.asset_type === 'native') {
      if (isValidBalanceString(record.balance)) {
        nativeBalance = record.balance;
      } else {
        warnings.push('Native XLM balance was missing or had an unexpected format.');
      }
      continue;
    }

    if (record.asset_type === 'liquidity_pool_shares') {
      otherBalances.push(record);
      continue;
    }

    trustlines.push(record);
  }

  return {
    accountId,
    networkUrl: horizonUrl,
    nativeBalance,
    trustlines,
    otherBalances,
    pagesFetched,
    paginationComplete,
    warnings,
  };
}

export async function fetchIssuerContexts(
  trustlines: TrustlineRecordInput[],
  dataSource: TrustlineDataSource,
): Promise<Map<string, IssuerContext>> {
  const contexts = new Map<string, IssuerContext>();
  const uniqueIssuers = Array.from(
    new Set(
      trustlines
        .map((t) => t.asset_issuer?.trim())
        .filter((issuer): issuer is string => Boolean(issuer)),
    ),
  );

  for (const issuer of uniqueIssuers) {
    if (!StrKey.isValidEd25519PublicKey(issuer)) {
      contexts.set(issuer, {
        issuer,
        status: 'unavailable',
        error: 'Issuer identifier is not a valid Ed25519 public key.',
      });
      continue;
    }

    if (!dataSource.loadIssuerAccount) {
      contexts.set(issuer, {
        issuer,
        status: 'unavailable',
        error: 'Issuer account lookup is not configured.',
      });
      continue;
    }

    try {
      const issuerAccount = await dataSource.loadIssuerAccount(issuer);
      const flags = issuerAccount.flags ?? {};
      contexts.set(issuer, {
        issuer,
        status: 'loaded',
        flags: {
          authRequired: Boolean(flags.auth_required),
          authRevocable: Boolean(flags.auth_revocable),
          authImmutable: Boolean(flags.auth_immutable),
          authClawbackEnabled: Boolean(flags.auth_clawback_enabled),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      contexts.set(issuer, {
        issuer,
        status: 'unavailable',
        error: message,
      });
    }
  }

  return contexts;
}

function resolveAuthorizationState(
  record: TrustlineRecordInput,
): AnalyzedTrustlineHolding['authorizationState'] {
  if (record.is_authorized === true) return 'authorized';
  if (record.is_authorized_to_maintain_liabilities === true) {
    return 'authorized_to_maintain_liabilities';
  }
  if (record.is_authorized === false) return 'unauthorized';
  return 'unknown';
}

export function analyzeTrustlineExposure(
  retrieval: TrustlineRetrievalResult,
  issuerContexts: Map<string, IssuerContext> = new Map(),
): TrustlineExposureReport {
  const missingInformation: string[] = [...retrieval.warnings];
  const itemsRequiringReview: string[] = [];

  if (retrieval.nativeBalance === null) {
    missingInformation.push('Native XLM balance was not present in the retrieved records.');
  }

  if (retrieval.otherBalances.length > 0) {
    missingInformation.push(
      `${retrieval.otherBalances.length} non-classic balance entry/entries (e.g. liquidity pool shares) excluded from issued-asset trustline list.`,
    );
  }

  const issuersByCode = new Map<string, Set<string>>();
  for (const tl of retrieval.trustlines) {
    const code = tl.asset_code?.trim() || 'UNKNOWN_CODE';
    const issuer = tl.asset_issuer?.trim() || 'UNKNOWN_ISSUER';
    if (!issuersByCode.has(code)) {
      issuersByCode.set(code, new Set());
    }
    issuersByCode.get(code)!.add(issuer);
  }

  const duplicateAssetCodes: Array<{ assetCode: string; issuers: string[] }> = [];
  for (const [assetCode, issuers] of issuersByCode.entries()) {
    if (issuers.size > 1) {
      const issuerList = Array.from(issuers);
      duplicateAssetCodes.push({ assetCode, issuers: issuerList });
      itemsRequiringReview.push(
        `Asset code "${assetCode}" appears across ${issuerList.length} distinct issuers; asset code alone does not uniquely identify an asset.`,
      );
    }
  }

  const duplicateCodeSet = new Set(duplicateAssetCodes.map((d) => d.assetCode));
  const seenIdentities = new Set<string>();
  const holdings: AnalyzedTrustlineHolding[] = [];

  for (const tl of retrieval.trustlines) {
    const assetCode = tl.asset_code?.trim() || 'UNKNOWN_CODE';
    const assetIssuer = tl.asset_issuer?.trim() || 'UNKNOWN_ISSUER';
    const assetIdentity = `${assetCode}:${assetIssuer}`;
    seenIdentities.add(assetIdentity);

    const reviewFlags: string[] = [];
    if (assetCode === 'UNKNOWN_CODE' || assetIssuer === 'UNKNOWN_ISSUER') {
      reviewFlags.push('missing_asset_identity_fields');
      missingInformation.push(`Trustline entry "${assetIdentity}" is missing asset_code or asset_issuer.`);
    }

    const balanceValid = isValidBalanceString(tl.balance);
    const balance = balanceValid ? tl.balance : 'UNAVAILABLE';
    if (!balanceValid) {
      reviewFlags.push('unavailable_balance');
      missingInformation.push(`Balance for ${assetIdentity} is invalid or unavailable.`);
    }

    const limit = isValidBalanceString(tl.limit) ? tl.limit : null;
    if (limit === null) {
      missingInformation.push(`Trustline limit for ${assetIdentity} is unavailable.`);
    }

    const authorizationState = resolveAuthorizationState(tl);
    if (authorizationState === 'unauthorized') {
      reviewFlags.push('trustline_unauthorized');
      itemsRequiringReview.push(
        `${assetIdentity} is not authorized (is_authorized=false); transfers and offers may be restricted.`,
      );
    } else if (authorizationState === 'authorized_to_maintain_liabilities') {
      reviewFlags.push('authorized_to_maintain_liabilities_only');
      itemsRequiringReview.push(
        `${assetIdentity} is authorized to maintain liabilities only; new balance increases are restricted.`,
      );
    } else if (authorizationState === 'unknown') {
      missingInformation.push(`Authorization flags for ${assetIdentity} were not provided.`);
    }

    const clawbackEnabled =
      typeof tl.is_clawback_enabled === 'boolean' ? tl.is_clawback_enabled : null;
    if (clawbackEnabled === true) {
      reviewFlags.push('clawback_enabled');
      itemsRequiringReview.push(
        `${assetIdentity} has clawback enabled on the trustline; issuer configuration permits clawback operations.`,
      );
    }

    const hasDuplicateAssetCode = duplicateCodeSet.has(assetCode);
    if (hasDuplicateAssetCode) {
      reviewFlags.push('duplicate_asset_code_different_issuer');
    }

    const issuerContext = issuerContexts.get(assetIssuer);
    if (!issuerContext || issuerContext.status === 'unavailable') {
      missingInformation.push(
        `Issuer account flags for ${assetIssuer} (${assetCode}) could not be retrieved${
          issuerContext?.error ? `: ${issuerContext.error}` : '.'
        }`,
      );
    } else if (issuerContext.flags) {
      if (issuerContext.flags.authRevocable) {
        reviewFlags.push('issuer_auth_revocable');
      }
      if (issuerContext.flags.authClawbackEnabled) {
        reviewFlags.push('issuer_auth_clawback_enabled');
      }
      if (issuerContext.flags.authRequired) {
        reviewFlags.push('issuer_auth_required');
      }
    }

    holdings.push({
      assetIdentity,
      assetCode,
      assetIssuer,
      assetType: tl.asset_type,
      balance,
      limit,
      buyingLiabilities: isValidBalanceString(tl.buying_liabilities) ? tl.buying_liabilities : null,
      sellingLiabilities: isValidBalanceString(tl.selling_liabilities) ? tl.selling_liabilities : null,
      authorizationState,
      clawbackEnabled,
      hasDuplicateAssetCode,
      reviewFlags,
      issuerContext,
    });
  }

  return {
    accountId: retrieval.accountId,
    networkUrl: retrieval.networkUrl,
    nativeXlmBalance: retrieval.nativeBalance,
    trustlineCount: holdings.length,
    uniqueAssetIdentities: seenIdentities.size,
    duplicateAssetCodes,
    holdings,
    itemsRequiringReview,
    missingInformation,
    limitations: [
      'Public Horizon flags describe protocol configuration only; they do not establish issuer solvency, governance quality, or trustworthiness.',
      'No external pricing or asset-directory service is queried; monetary value, market liquidity, and redemption rights cannot be inferred from trustlines.',
    ],
    disclaimer:
      'Informational audit only. This report does not establish market value, liquidity, redemption rights, or issuer solvency.',
  };
}

export function formatTrustlineExposureReport(report: TrustlineExposureReport): string {
  const lines: string[] = [
    '=== Stellar Asset Trustline Exposure Report ===',
    `Account: ${report.accountId}`,
    `Horizon: ${report.networkUrl}`,
    `Native XLM balance: ${report.nativeXlmBalance ?? 'unavailable'}`,
    `Issued-asset trustlines: ${report.trustlineCount} (unique code:issuer pairs: ${report.uniqueAssetIdentities})`,
    '',
    'Trustline Holdings:',
  ];

  if (report.holdings.length === 0) {
    lines.push('  (no issued-asset trustlines found)');
  } else {
    for (const h of report.holdings) {
      lines.push(
        `  - ${h.assetIdentity} (${h.assetType}) | balance=${h.balance} | limit=${h.limit ?? 'unavailable'} | auth=${h.authorizationState}`,
      );
      if (h.issuerContext?.status === 'loaded' && h.issuerContext.flags) {
        const f = h.issuerContext.flags;
        lines.push(
          `    Issuer flags: auth_required=${f.authRequired}, auth_revocable=${f.authRevocable}, auth_immutable=${f.authImmutable}, auth_clawback_enabled=${f.authClawbackEnabled}`,
        );
      } else {
        lines.push('    Issuer flags: unavailable');
      }
      if (h.reviewFlags.length > 0) {
        lines.push(`    Review flags: ${h.reviewFlags.join(', ')}`);
      }
    }
  }

  if (report.duplicateAssetCodes.length > 0) {
    lines.push('', 'Duplicate Asset Codes Across Issuers:');
    for (const dup of report.duplicateAssetCodes) {
      lines.push(`  - ${dup.assetCode}: ${dup.issuers.join(', ')}`);
    }
  }

  if (report.itemsRequiringReview.length > 0) {
    lines.push('', 'Items Requiring Review:');
    for (const item of report.itemsRequiringReview) {
      lines.push(`  - ${item}`);
    }
  }

  if (report.missingInformation.length > 0) {
    lines.push('', 'Missing Information / Notes:');
    for (const note of report.missingInformation) {
      lines.push(`  - ${note}`);
    }
  }

  lines.push('', `Disclaimer: ${report.disclaimer}`);
  return lines.join('\n');
}

export async function runTrustlineExposureAudit(
  accountId: string,
  horizonUrl: string,
  dataSource: TrustlineDataSource = createHorizonDataSource(horizonUrl),
): Promise<TrustlineExposureReport> {
  const retrieval = await fetchAccountTrustlines(accountId, horizonUrl, dataSource);
  const issuerContexts = await fetchIssuerContexts(retrieval.trustlines, dataSource);
  return analyzeTrustlineExposure(retrieval, issuerContexts);
}

export async function run(params: TrustlineExposureParams = {}): Promise<void> {
  const accountId = params.accountId?.trim() || process.env.ACCOUNT_ID || DEFAULT_ACCOUNT_ID;
  const horizonUrl = params.horizonUrl?.trim() || process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const json = params.json === true || params.json === 'true' || process.env.JSON_OUTPUT === 'true';

  try {
    const report = await runTrustlineExposureAudit(accountId, horizonUrl);
    console.log(json ? JSON.stringify(report, null, 2) : formatTrustlineExposureReport(report));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      console.log(JSON.stringify({ accountId, horizonUrl, error: message }, null, 2));
    } else {
      console.error(`Could not audit trustlines for ${accountId}: ${message}`);
    }
  }
}
