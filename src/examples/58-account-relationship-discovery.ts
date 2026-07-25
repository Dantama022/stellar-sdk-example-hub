import { Horizon } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';

export interface DiscoveredSigner {
  key: string;
  weight: number;
  type: 'primary' | 'co-signer';
}

export interface DiscoveredAssetIssuer {
  assetCode: string;
  issuer: string;
}

export interface DiscoveredSponsorships {
  accountSponsor?: string;
  numSponsored: number;
  numSponsoring: number;
}

export interface AccountRelationships {
  accountId: string;
  signers: DiscoveredSigner[];
  assetIssuers: DiscoveredAssetIssuer[];
  sponsorships: DiscoveredSponsorships;
  transactionCounterparties: string[];
}

export interface AccountRelationshipParams {
  accountId?: string;
}

/**
 * Extracts signer relationships from account data, separating primary account key from co-signers.
 */
export function extractSigners(
  signers: Array<{ key: string; weight: number }>,
  accountId: string,
): DiscoveredSigner[] {
  if (!signers || signers.length === 0) {
    return [
      {
        key: accountId,
        weight: 1,
        type: 'primary',
      },
    ];
  }

  return signers.map((s) => ({
    key: s.key,
    weight: s.weight,
    type: s.key === accountId ? 'primary' : 'co-signer',
  }));
}

/**
 * Extracts asset issuers from account balances (excluding native XLM).
 */
export function extractAssetIssuers(
  balances: Array<{ asset_type: string; asset_code?: string; asset_issuer?: string }>,
): DiscoveredAssetIssuer[] {
  if (!balances || balances.length === 0) {
    return [];
  }

  const issuers: DiscoveredAssetIssuer[] = [];

  for (const b of balances) {
    if (b.asset_type !== 'native' && b.asset_code && b.asset_issuer) {
      issuers.push({
        assetCode: b.asset_code,
        issuer: b.asset_issuer,
      });
    }
  }

  return issuers;
}

/**
 * Extracts sponsorship relationships from account data.
 */
export function extractSponsorships(accountData: {
  sponsor?: string;
  num_sponsored?: number;
  num_sponsoring?: number;
}): DiscoveredSponsorships {
  return {
    accountSponsor: accountData.sponsor || undefined,
    numSponsored: accountData.num_sponsored || 0,
    numSponsoring: accountData.num_sponsoring || 0,
  };
}

/**
 * Extracts and deduplicates transaction counterparties from account operation records.
 */
export function extractCounterparties(
  operations: Array<{
    type?: string;
    source_account?: string;
    funder?: string;
    account?: string;
    to?: string;
    from?: string;
    into?: string;
  }>,
  accountId: string,
): string[] {
  if (!operations || operations.length === 0) {
    return [];
  }

  const counterparties = new Set<string>();

  for (const op of operations) {
    const candidates = [op.source_account, op.funder, op.account, op.to, op.from, op.into];

    for (const addr of candidates) {
      if (addr && addr !== accountId) {
        counterparties.add(addr);
      }
    }
  }

  return Array.from(counterparties);
}

/**
 * Formats discovered relationships into a readable summary string.
 */
export function formatRelationshipSummary(relationships: AccountRelationships): string {
  const lines: string[] = [];

  lines.push(`=== Account Relationship Discovery Summary ===`);
  lines.push(`Target Account: ${relationships.accountId}`);

  lines.push(`\n1. Signers (${relationships.signers.length}):`);
  if (relationships.signers.length === 0) {
    lines.push('  No signers found.');
  } else {
    for (const s of relationships.signers) {
      lines.push(`  - [${s.type.toUpperCase()}] ${s.key} (weight: ${s.weight})`);
    }
  }

  lines.push(`\n2. Asset Issuers (${relationships.assetIssuers.length}):`);
  if (relationships.assetIssuers.length === 0) {
    lines.push('  No non-native asset trustlines held.');
  } else {
    for (const ai of relationships.assetIssuers) {
      lines.push(`  - ${ai.assetCode} issued by ${ai.issuer}`);
    }
  }

  lines.push(`\n3. Sponsorships:`);
  lines.push(
    `  - Account Sponsor: ${relationships.sponsorships.accountSponsor || 'None (Self-sponsored)'}`,
  );
  lines.push(`  - Sponsored Subentries: ${relationships.sponsorships.numSponsored}`);
  lines.push(`  - Sponsoring Subentries for Others: ${relationships.sponsorships.numSponsoring}`);

  lines.push(
    `\n4. Recent Transaction Counterparties (${relationships.transactionCounterparties.length}):`,
  );
  if (relationships.transactionCounterparties.length === 0) {
    lines.push('  No recent counterparties identified from recent activity.');
  } else {
    for (const c of relationships.transactionCounterparties) {
      lines.push(`  - ${c}`);
    }
  }

  return lines.join('\n');
}

/**
 * Runs the account relationship discovery example.
 */
export async function run(params: AccountRelationshipParams = {}): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const server = new Horizon.Server(horizonUrl);

  let accountId =
    params.accountId?.trim() ||
    process.env.ACCOUNT_ID?.trim() ||
    process.argv[3]?.trim();

  console.log('Starting Account Relationship Discovery Example...');
  console.log(`Using Horizon: ${horizonUrl}`);

  if (!accountId) {
    console.log('No account ID supplied. Fetching an active account from recent operations...');
    try {
      const recentOps = await server.operations().order('desc').limit(1).call();
      if (recentOps.records.length > 0) {
        accountId = recentOps.records[0].source_account;
      }
    } catch {
      // Fallback
    }
  }

  if (!accountId) {
    accountId = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
  }

  console.log(`Analyzing relationships for account: ${accountId}`);

  try {
    const accountResponse = await server.loadAccount(accountId);

    const signers = extractSigners(
      accountResponse.signers as Array<{ key: string; weight: number }>,
      accountId,
    );
    const assetIssuers = extractAssetIssuers(
      accountResponse.balances as Array<{
        asset_type: string;
        asset_code?: string;
        asset_issuer?: string;
      }>,
    );
    const sponsorships = extractSponsorships(accountResponse as any);

    let counterparties: string[] = [];
    try {
      const opPage = await server.operations().forAccount(accountId).limit(20).call();
      counterparties = extractCounterparties(opPage.records as any, accountId);
    } catch (opError) {
      console.log('Unable to load recent operations for counterparty analysis:', opError);
    }

    const relationships: AccountRelationships = {
      accountId,
      signers,
      assetIssuers,
      sponsorships,
      transactionCounterparties: counterparties,
    };

    console.log('\n' + formatRelationshipSummary(relationships));
  } catch (error: any) {
    console.log(`Could not load account ${accountId} from Horizon: ${error.message || error}`);
    console.log('Demonstrating relationship structure for account with no active ledger state:');

    const emptyRelationships: AccountRelationships = {
      accountId,
      signers: [
        {
          key: accountId,
          weight: 1,
          type: 'primary',
        },
      ],
      assetIssuers: [],
      sponsorships: {
        numSponsored: 0,
        numSponsoring: 0,
      },
      transactionCounterparties: [],
    };

    console.log('\n' + formatRelationshipSummary(emptyRelationships));
  }

  console.log('\nAccount relationship discovery completed successfully.');
}
