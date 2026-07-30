import { Horizon } from '@stellar/stellar-sdk';

/**
 * Example 63: Horizon Asset Discovery and Search
 *
 * Horizon's `/assets` endpoint indexes issued Stellar assets and exposes
 * current metadata such as:
 *
 *   - asset code and issuer
 *   - asset type
 *   - account-holder counts grouped by authorization state
 *   - balances grouped by authorization state
 *   - claimable-balance counts and amounts
 *   - liquidity-pool and contract statistics where available
 *
 * An issued asset is uniquely identified by BOTH its code and issuer.
 *
 * For example:
 *
 *   USD:GISSUER_ONE
 *   USD:GISSUER_TWO
 *
 * are two distinct Stellar assets even though they share the code `USD`.
 *
 * This example is read-only. It does not create assets, trustlines, or
 * transactions.
 */

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 200;

export interface AssetDiscoveryParams {
  /**
   * Optional asset code filter.
   *
   * When omitted, the example browses recently indexed assets.
   */
  assetCode?: string;

  /**
   * Number of asset records to return, from 1 through 200.
   */
  limit?: number | string;

  /**
   * Horizon URL override.
   */
  horizonUrl?: string;
}

export interface AssetAccountGroups {
  authorized?: number;
  authorized_to_maintain_liabilities?: number;
  unauthorized?: number;
}

export interface AssetBalanceGroups {
  authorized?: string;
  authorized_to_maintain_liabilities?: string;
  unauthorized?: string;
}

export interface AssetFlags {
  auth_required?: boolean;
  auth_revocable?: boolean;
  auth_immutable?: boolean;
  auth_clawback_enabled?: boolean;
}

export interface RawAssetRecord {
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  paging_token?: string;

  /**
   * Some Horizon versions expose a direct account count, while newer asset
   * records group account counts by authorization state.
   */
  num_accounts?: number;
  accounts?: AssetAccountGroups;

  /**
   * Balances held through account trustlines, grouped by authorization state.
   */
  balances?: AssetBalanceGroups;

  num_claimable_balances?: number;
  claimable_balances_amount?: string;

  num_liquidity_pools?: number;
  liquidity_pools_amount?: string;

  num_contracts?: number;
  contracts_amount?: string;

  flags?: AssetFlags;

  _links?: {
    toml?: {
      href?: string;
    };
  };
}

export interface ParsedAssetRecord {
  assetType: string;
  assetCode: string;
  assetIssuer: string;
  uniqueIdentity: string;
  pagingToken: string;

  accountHolders: {
    total: number;
    authorized: number;
    authorizedToMaintainLiabilities: number;
    unauthorized: number;
  };

  balances: {
    authorized: string;
    authorizedToMaintainLiabilities: string;
    unauthorized: string;
  };

  claimableBalances: {
    count: number;
    amount: string;
  };

  liquidityPools: {
    count: number;
    amount: string;
  };

  contracts: {
    count: number;
    amount: string;
  };

  flags: {
    authRequired: boolean;
    authRevocable: boolean;
    authImmutable: boolean;
    authClawbackEnabled: boolean;
  };

  tomlUrl?: string;
}

export interface AssetDiscoverySummary {
  totalRecords: number;
  uniqueAssetCodes: number;
  uniqueIssuers: number;
  totalAccountHolders: number;
  totalClaimableBalances: number;
}

/**
 * Normalizes a result limit to Horizon's supported range.
 */
export function normalizeAssetLimit(value?: number | string): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value.trim(), 10) : value;

  if (parsed === undefined || parsed === null || Number.isNaN(parsed)) {
    return DEFAULT_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_LIMIT);
}

/**
 * Trims and validates an optional asset-code filter.
 *
 * An empty value means "browse all assets".
 */
export function normalizeAssetCode(value?: string): string | undefined {
  const normalized = value?.trim();

  if (!normalized) {
    return undefined;
  }

  if (!/^[a-zA-Z0-9]{1,12}$/.test(normalized)) {
    throw new Error('Invalid asset code. Asset codes must contain 1-12 alphanumeric characters.');
  }

  return normalized;
}

/**
 * Calculates the number of accounts holding an asset.
 *
 * Newer Horizon asset records group account counts by authorization state.
 * The `num_accounts` fallback supports older Horizon response shapes.
 */
export function getTotalAccountHolders(record: RawAssetRecord): number {
  if (record.accounts) {
    return (
      (record.accounts.authorized ?? 0) +
      (record.accounts.authorized_to_maintain_liabilities ?? 0) +
      (record.accounts.unauthorized ?? 0)
    );
  }

  return record.num_accounts ?? 0;
}

/**
 * Converts a Horizon asset record into a consistent representation.
 */
export function parseAssetDiscoveryRecord(record: RawAssetRecord): ParsedAssetRecord {
  const assetCode = record.asset_code ?? 'Unknown';
  const assetIssuer = record.asset_issuer ?? 'Unknown';
  const accounts = record.accounts ?? {};
  const balances = record.balances ?? {};
  const flags = record.flags ?? {};

  return {
    assetType: record.asset_type ?? 'Unknown',
    assetCode,
    assetIssuer,
    uniqueIdentity: `${assetCode}:${assetIssuer}`,
    pagingToken: record.paging_token ?? '',

    accountHolders: {
      total: getTotalAccountHolders(record),
      authorized: accounts.authorized ?? record.num_accounts ?? 0,
      authorizedToMaintainLiabilities: accounts.authorized_to_maintain_liabilities ?? 0,
      unauthorized: accounts.unauthorized ?? 0,
    },

    balances: {
      authorized: balances.authorized ?? '0.0000000',
      authorizedToMaintainLiabilities: balances.authorized_to_maintain_liabilities ?? '0.0000000',
      unauthorized: balances.unauthorized ?? '0.0000000',
    },

    claimableBalances: {
      count: record.num_claimable_balances ?? 0,
      amount: record.claimable_balances_amount ?? '0.0000000',
    },

    liquidityPools: {
      count: record.num_liquidity_pools ?? 0,
      amount: record.liquidity_pools_amount ?? '0.0000000',
    },

    contracts: {
      count: record.num_contracts ?? 0,
      amount: record.contracts_amount ?? '0.0000000',
    },

    flags: {
      authRequired: Boolean(flags.auth_required),
      authRevocable: Boolean(flags.auth_revocable),
      authImmutable: Boolean(flags.auth_immutable),
      authClawbackEnabled: Boolean(flags.auth_clawback_enabled),
    },

    tomlUrl: record._links?.toml?.href,
  };
}

/**
 * Summarizes the asset records returned in the current Horizon page.
 */
export function summarizeAssetRecords(assets: ParsedAssetRecord[]): AssetDiscoverySummary {
  return {
    totalRecords: assets.length,
    uniqueAssetCodes: new Set(assets.map((asset) => asset.assetCode)).size,
    uniqueIssuers: new Set(assets.map((asset) => asset.assetIssuer)).size,
    totalAccountHolders: assets.reduce((total, asset) => total + asset.accountHolders.total, 0),
    totalClaimableBalances: assets.reduce(
      (total, asset) => total + asset.claimableBalances.count,
      0,
    ),
  };
}

/**
 * Queries Horizon's assets endpoint.
 *
 * When `assetCode` is supplied, Horizon performs an exact asset-code filter.
 * The response can still contain several records because multiple issuers can
 * create assets that share the same code.
 */
export async function fetchAssetRecords(
  server: Horizon.Server,
  assetCode: string | undefined,
  limit: number,
): Promise<RawAssetRecord[]> {
  let query = server.assets();

  if (assetCode) {
    query = query.forCode(assetCode);
  }

  const page = await query.order('desc').limit(limit).call();

  return page.records as unknown as RawAssetRecord[];
}

/**
 * Detects invalid Horizon filter responses.
 */
export function isInvalidAssetQueryError(error: any): boolean {
  const status = error?.response?.status;

  return status === 400 || status === 422;
}

/**
 * Formats one asset as a readable console section.
 */
export function formatAssetRecord(asset: ParsedAssetRecord, index: number): string {
  const lines: string[] = [];

  lines.push(`[${index + 1}] ${asset.assetCode}`);
  lines.push(`    Unique Identity: ${asset.uniqueIdentity}`);
  lines.push(`    Asset Type:      ${asset.assetType}`);
  lines.push(`    Issuer:          ${asset.assetIssuer}`);
  lines.push('');
  lines.push('    Account Holders:');
  lines.push(`      Total:                              ${asset.accountHolders.total}`);
  lines.push(`      Authorized:                         ${asset.accountHolders.authorized}`);
  lines.push(
    `      Maintain liabilities only:          ${asset.accountHolders.authorizedToMaintainLiabilities}`,
  );
  lines.push(`      Unauthorized:                       ${asset.accountHolders.unauthorized}`);
  lines.push('');
  lines.push('    Trustline Balances:');
  lines.push(`      Authorized:                         ${asset.balances.authorized}`);
  lines.push(
    `      Maintain liabilities only:          ${asset.balances.authorizedToMaintainLiabilities}`,
  );
  lines.push(`      Unauthorized:                       ${asset.balances.unauthorized}`);
  lines.push('');
  lines.push('    Claimable Balances:');
  lines.push(`      Records:                            ${asset.claimableBalances.count}`);
  lines.push(`      Amount:                             ${asset.claimableBalances.amount}`);
  lines.push('');
  lines.push('    Other Holding Locations:');
  lines.push(`      Liquidity pools:                    ${asset.liquidityPools.count}`);
  lines.push(`      Amount held by liquidity pools:     ${asset.liquidityPools.amount}`);
  lines.push(`      Soroban contracts:                  ${asset.contracts.count}`);
  lines.push(`      Amount held by contracts:           ${asset.contracts.amount}`);
  lines.push('');
  lines.push('    Issuer Flags:');
  lines.push(`      AUTH_REQUIRED:                      ${asset.flags.authRequired}`);
  lines.push(`      AUTH_REVOCABLE:                     ${asset.flags.authRevocable}`);
  lines.push(`      AUTH_IMMUTABLE:                     ${asset.flags.authImmutable}`);
  lines.push(`      AUTH_CLAWBACK_ENABLED:              ${asset.flags.authClawbackEnabled}`);

  if (asset.tomlUrl) {
    lines.push(`    Stellar TOML:     ${asset.tomlUrl}`);
  }

  return lines.join('\n');
}

/**
 * Produces the full console report.
 */
export function formatAssetDiscoveryReport(
  assetCode: string | undefined,
  limit: number,
  assets: ParsedAssetRecord[],
  summary: AssetDiscoverySummary = summarizeAssetRecords(assets),
): string {
  const lines: string[] = [];

  lines.push('=== Stellar Horizon Asset Discovery ===');
  lines.push(`Asset Code Filter: ${assetCode ?? 'None — browsing indexed assets'}`);
  lines.push(`Result Limit:      ${limit}`);
  lines.push(`Records Found:     ${assets.length}`);

  if (assets.length === 0) {
    lines.push('');
    lines.push(
      assetCode
        ? `No Horizon asset records matched the code "${assetCode}".`
        : 'Horizon returned no indexed asset records.',
    );
    lines.push('');
    lines.push('This is a valid empty result. Possible reasons include:');
    lines.push('  - no issued asset currently matches the supplied code,');
    lines.push('  - the selected network has no indexed record for that asset, or');
    lines.push('  - the code uses different capitalization.');
    lines.push('');
    lines.push('Remember: an asset code alone does not uniquely identify an asset.');
    lines.push('Always use the code and issuer together when selecting an asset.');

    return lines.join('\n');
  }

  lines.push('');
  lines.push('Asset Records:');

  assets.forEach((asset, index) => {
    lines.push('');
    lines.push(formatAssetRecord(asset, index));
  });

  lines.push('');
  lines.push('Result Summary:');
  lines.push(`  Asset records:             ${summary.totalRecords}`);
  lines.push(`  Distinct codes:            ${summary.uniqueAssetCodes}`);
  lines.push(`  Distinct issuers:          ${summary.uniqueIssuers}`);
  lines.push(`  Account holders:           ${summary.totalAccountHolders}`);
  lines.push(`  Claimable-balance records: ${summary.totalClaimableBalances}`);

  lines.push('');
  lines.push('How Stellar asset identity works:');
  lines.push('  - The asset code is a label selected by an issuer.');
  lines.push('  - Different issuers may use the same asset code.');
  lines.push('  - Code + issuer uniquely identifies an issued Stellar asset.');
  lines.push('  - Native XLM is not returned as an issued asset record.');
  lines.push('');
  lines.push('This summary covers only the current Horizon result page.');

  return lines.join('\n');
}

/**
 * Runs the asset-discovery example.
 *
 * Configuration:
 *
 *   Interactive runner:
 *     npm run run-example 63-asset-discovery
 *
 *   CLI:
 *     npm run run-example -- 63-asset-discovery USDC 20
 *
 *   Environment:
 *     ASSET_CODE=USDC
 *     ASSET_DISCOVERY_LIMIT=20
 *     HORIZON_URL=https://horizon-testnet.stellar.org
 */
export async function run(params: AssetDiscoveryParams = {}): Promise<void> {
  const horizonUrl = params.horizonUrl || process.env.HORIZON_URL || DEFAULT_HORIZON_URL;

  const server = new Horizon.Server(horizonUrl);

  const limit = normalizeAssetLimit(
    params.limit ?? process.env.ASSET_DISCOVERY_LIMIT ?? process.argv[4],
  );

  let assetCode: string | undefined;

  try {
    assetCode = normalizeAssetCode(params.assetCode ?? process.env.ASSET_CODE ?? process.argv[3]);
  } catch (error: any) {
    console.log(`Invalid asset-code filter: ${error?.message || error}`);
    console.log('Asset discovery stopped safely without querying Horizon.');
    return;
  }

  console.log('Starting Horizon Asset Discovery and Search Example...');
  console.log(`Using Horizon: ${horizonUrl}`);
  console.log(`Result limit: ${limit}`);

  if (assetCode) {
    console.log(`Searching for asset code: ${assetCode}`);
  } else {
    console.log('No asset code supplied. Browsing recently indexed assets.');
  }

  console.log('Asset codes are not unique: every issued asset is identified by code + issuer.');

  let records: RawAssetRecord[];

  try {
    records = await fetchAssetRecords(server, assetCode, limit);
  } catch (error: any) {
    if (isInvalidAssetQueryError(error)) {
      console.log('\nHorizon rejected the asset filter. Check the asset code and network.');
      console.log('Asset discovery completed (invalid filter handled safely).');
      return;
    }

    console.log(`\nCould not retrieve Horizon assets: ${error?.message || error}`);
    return;
  }

  const assets = records.map(parseAssetDiscoveryRecord);
  const summary = summarizeAssetRecords(assets);

  console.log('\n' + formatAssetDiscoveryReport(assetCode, limit, assets, summary));

  if (assets.length === 0) {
    console.log('\nAsset discovery completed (empty result handled gracefully).');
    return;
  }

  console.log('\nAsset discovery completed successfully.');
}
