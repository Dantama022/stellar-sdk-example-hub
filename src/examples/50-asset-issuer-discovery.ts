import { Asset, Horizon } from '@stellar/stellar-sdk';

/**
 * Example 50: Asset Issuer and Trustline Discovery
 *
 * On Stellar, a non-native asset is uniquely identified by the pair
 * (asset_code, asset_issuer). The code alone is not enough: many issuers can
 * mint an asset named "USDC", and each is a distinct ledger asset. Native XLM
 * is the exception — it has no issuer.
 *
 * Horizon's `/assets` endpoint indexes issued assets and reports:
 *   - how many accounts currently hold a trustline (`num_accounts`)
 *   - how many claimable balances reference the asset
 *   - authorization flags inherited from the issuer account
 *   - liquidity-pool participation counts where available
 *
 * This example is strictly read-only. It looks up an asset by code + issuer and
 * presents the indexed metadata so developers can inspect an asset's ecosystem
 * without submitting transactions.
 */

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';

export interface AssetDiscoveryParams {
  assetCode?: string;
  assetIssuer?: string;
  horizonUrl?: string;
}

export interface HorizonAssetFlags {
  auth_required?: boolean;
  auth_revocable?: boolean;
  auth_immutable?: boolean;
  auth_clawback_enabled?: boolean;
}

export interface RawAssetRecord {
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  num_accounts?: number;
  num_claimable_balances?: number;
  num_liquidity_pools?: number;
  amount?: string;
  flags?: HorizonAssetFlags;
  paging_token?: string;
}

export interface ParsedAssetRecord {
  assetType: string;
  assetCode: string;
  assetIssuer: string;
  numAccounts: number;
  numClaimableBalances: number;
  numLiquidityPools: number;
  circulatingAmount: string;
  flags: {
    authRequired: boolean;
    authRevocable: boolean;
    authImmutable: boolean;
    authClawbackEnabled: boolean;
  };
}

/**
 * Parses CODE:ISSUER input (or separate code/issuer) into an SDK Asset.
 */
export function parseAssetIdentifier(code: string, issuer: string): Asset {
  const trimmedCode = code.trim();
  const trimmedIssuer = issuer.trim();

  if (!trimmedCode) {
    throw new Error('Missing asset code. Provide a 1-12 character asset code.');
  }

  if (!trimmedIssuer) {
    throw new Error('Missing asset issuer. Provide the issuer account public key.');
  }

  try {
    return new Asset(trimmedCode, trimmedIssuer);
  } catch (error: any) {
    throw new Error(
      `Invalid asset identifier "${trimmedCode}:${trimmedIssuer}": ${error?.message || error}`,
    );
  }
}

/**
 * Parses a combined `CODE:ISSUER` string into an Asset.
 */
export function parseCombinedAssetInput(value: string): Asset {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('Missing asset. Use "CODE:ISSUER".');
  }

  const separator = trimmed.indexOf(':');
  if (separator <= 0 || separator === trimmed.length - 1) {
    throw new Error(`Invalid asset "${trimmed}". Use "CODE:ISSUER".`);
  }

  return parseAssetIdentifier(trimmed.slice(0, separator), trimmed.slice(separator + 1));
}

/**
 * Converts a Horizon asset record into a structured summary.
 */
export function parseAssetRecord(record: RawAssetRecord): ParsedAssetRecord {
  const flags = record.flags ?? {};

  return {
    assetType: record.asset_type ?? 'credit_alphanum4',
    assetCode: record.asset_code ?? '',
    assetIssuer: record.asset_issuer ?? '',
    numAccounts: record.num_accounts ?? 0,
    numClaimableBalances: record.num_claimable_balances ?? 0,
    numLiquidityPools: record.num_liquidity_pools ?? 0,
    circulatingAmount: record.amount ?? '0',
    flags: {
      authRequired: Boolean(flags.auth_required),
      authRevocable: Boolean(flags.auth_revocable),
      authImmutable: Boolean(flags.auth_immutable),
      authClawbackEnabled: Boolean(flags.auth_clawback_enabled),
    },
  };
}

/**
 * Formats a parsed asset record for console display.
 */
export function formatAssetDiscoveryReport(asset: ParsedAssetRecord): string {
  const lines: string[] = [];

  lines.push('=== Stellar Asset Issuer & Trustline Discovery ===');
  lines.push(`Asset Code:              ${asset.assetCode}`);
  lines.push(`Asset Issuer:            ${asset.assetIssuer}`);
  lines.push(`Asset Type:              ${asset.assetType}`);
  lines.push(`Unique Identity:         ${asset.assetCode}:${asset.assetIssuer}`);
  lines.push('');
  lines.push('Trustline / Holder Summary:');
  lines.push(`  Accounts Trusting:     ${asset.numAccounts}`);
  lines.push(`  Claimable Balances:    ${asset.numClaimableBalances}`);
  lines.push(`  Liquidity Pools:       ${asset.numLiquidityPools}`);
  lines.push(`  Circulating Amount:    ${asset.circulatingAmount}`);
  lines.push('');
  lines.push('Issuer Authorization Flags:');
  lines.push(`  AUTH_REQUIRED:         ${asset.flags.authRequired}`);
  lines.push(`  AUTH_REVOCABLE:        ${asset.flags.authRevocable}`);
  lines.push(`  AUTH_IMMUTABLE:        ${asset.flags.authImmutable}`);
  lines.push(`  AUTH_CLAWBACK_ENABLED: ${asset.flags.authClawbackEnabled}`);
  lines.push('');
  lines.push('How asset identity works:');
  lines.push('  - The asset code is a short label (1-12 characters) chosen by the issuer.');
  lines.push('  - The issuer is the account that created the asset; it is part of the identity.');
  lines.push(
    '  - Two assets with the same code but different issuers are unrelated ledger assets.',
  );
  lines.push('  - Native XLM has no issuer; every other asset is identified by code + issuer.');

  return lines.join('\n');
}

/**
 * Detects Horizon responses that mean the asset is unknown / unindexed.
 */
export function isUnknownAssetError(error: any): boolean {
  return error?.response?.status === 404 || error?.name === 'NotFoundError';
}

/**
 * Discovers a recently indexed issued asset so the example stays runnable
 * without requiring the caller to know a Testnet asset identity in advance.
 */
async function discoverRecentAsset(
  server: Horizon.Server,
): Promise<{ code: string; issuer: string } | null> {
  try {
    const page = await server.assets().order('desc').limit(20).call();
    for (const record of page.records as unknown as RawAssetRecord[]) {
      if (record.asset_code && record.asset_issuer) {
        return { code: record.asset_code, issuer: record.asset_issuer };
      }
    }
  } catch {
    // Fall through — caller will explain how to supply an asset explicitly.
  }
  return null;
}

/**
 * Runs the asset issuer and trustline discovery example.
 *
 * Asset identity can be supplied as:
 *   - runner params (`assetCode`, `assetIssuer`)
 *   - `ASSET_CODE` / `ASSET_ISSUER` environment variables
 *   - CLI: `npm run run-example -- 50-asset-issuer-discovery CODE ISSUER`
 *   - or a combined `CODE:ISSUER` as the sole CLI argument / `ASSET` env var
 */
export async function run(params: AssetDiscoveryParams = {}): Promise<void> {
  const horizonUrl = params.horizonUrl || process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const server = new Horizon.Server(horizonUrl);

  const combined =
    process.env.ASSET?.trim() ||
    (process.argv[3]?.includes(':') && !process.argv[4] ? process.argv[3].trim() : undefined);

  let assetCode =
    params.assetCode?.trim() || process.env.ASSET_CODE?.trim() || process.argv[3]?.trim();
  let assetIssuer =
    params.assetIssuer?.trim() || process.env.ASSET_ISSUER?.trim() || process.argv[4]?.trim();

  console.log('Starting Asset Issuer and Trustline Discovery Example...');
  console.log(`Using Horizon: ${horizonUrl}`);
  console.log('An issued asset is uniquely identified by asset_code + asset_issuer.');

  if (combined && (!assetIssuer || assetCode?.includes(':'))) {
    try {
      const parsed = parseCombinedAssetInput(combined);
      assetCode = parsed.getCode();
      assetIssuer = parsed.getIssuer();
    } catch (error: any) {
      console.log(`\n${error?.message || error}`);
      return;
    }
  }

  if (!assetCode || !assetIssuer) {
    console.log('\nNo asset code/issuer supplied. Looking for a recently indexed asset...');
    const discovered = await discoverRecentAsset(server);
    if (!discovered) {
      console.log('Could not discover an indexed asset on this network.');
      console.log('Supply one explicitly, for example:');
      console.log('  npm run run-example -- 50-asset-issuer-discovery USDC <issuer-account-id>');
      return;
    }
    assetCode = discovered.code;
    assetIssuer = discovered.issuer;
  }

  let asset: Asset;
  try {
    asset = parseAssetIdentifier(assetCode, assetIssuer);
  } catch (error: any) {
    console.log(`\n${error?.message || error}`);
    return;
  }

  console.log(`\nLooking up asset: ${asset.getCode()}:${asset.getIssuer()}`);

  let records: RawAssetRecord[] = [];
  try {
    const page = await server
      .assets()
      .forCode(asset.getCode())
      .forIssuer(asset.getIssuer())
      .limit(10)
      .call();
    records = page.records as unknown as RawAssetRecord[];
  } catch (error: any) {
    if (isUnknownAssetError(error)) {
      records = [];
    } else {
      console.log(`\nCould not query Horizon assets: ${error?.message || error}`);
      return;
    }
  }

  if (records.length === 0) {
    console.log('\nNo Horizon asset record found for this code + issuer pair.');
    console.log('This usually means:');
    console.log('  - the asset has never been issued / no trustlines exist yet, or');
    console.log('  - the code or issuer does not match an indexed asset exactly, or');
    console.log('  - you are querying the wrong network (Testnet vs Mainnet).');
    console.log('\nRemember: asset code alone is not unique — the issuer is required.');
    console.log('\nAsset issuer discovery completed (unknown asset handled gracefully).');
    return;
  }

  const parsed = parseAssetRecord(records[0]);
  console.log('\n' + formatAssetDiscoveryReport(parsed));
  console.log('\nAsset issuer and trustline discovery completed successfully.');
}
