import { Horizon } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_BASE_RESERVE = 0.5; // Standard Stellar base reserve in XLM

export interface AccountReserveData {
  accountId: string;
  nativeBalance: number;
  subentryCount: number;
  numSponsored: number;
  numSponsoring: number;
  baseReserve: number;
  minimumReserve: number;
  availableBalance: number;
}

export interface AccountReserveParams {
  accountId?: string;
  baseReserve?: number;
}

/**
 * Calculates the minimum reserve requirement in XLM.
 * Formula: (2 + subentryCount - numSponsored + numSponsoring) * baseReserve
 * Bounded below by 2 * baseReserve (the base account reserve).
 */
export function calculateMinimumReserve(
  subentryCount: number,
  numSponsored = 0,
  numSponsoring = 0,
  baseReserve = DEFAULT_BASE_RESERVE,
): number {
  const effectiveEntries = 2 + Math.max(0, subentryCount - numSponsored + numSponsoring);
  return effectiveEntries * baseReserve;
}

/**
 * Calculates available balance above the minimum reserve requirement.
 */
export function calculateAvailableBalance(nativeBalance: number, minimumReserve: number): number {
  return Math.max(0, Number((nativeBalance - minimumReserve).toFixed(7)));
}

/**
 * Parses account response data to extract reserve-relevant fields.
 */
export function parseAccountReserveData(
  accountResponse: {
    id: string;
    balances: Array<{ asset_type: string; balance: string }>;
    subentry_count: number;
    num_sponsored?: number;
    num_sponsoring?: number;
  },
  baseReserve = DEFAULT_BASE_RESERVE,
): AccountReserveData {
  const nativeObj = accountResponse.balances.find((b) => b.asset_type === 'native');
  const nativeBalance = nativeObj ? parseFloat(nativeObj.balance) : 0;
  const subentryCount = accountResponse.subentry_count || 0;
  const numSponsored = accountResponse.num_sponsored || 0;
  const numSponsoring = accountResponse.num_sponsoring || 0;

  const minimumReserve = calculateMinimumReserve(
    subentryCount,
    numSponsored,
    numSponsoring,
    baseReserve,
  );
  const availableBalance = calculateAvailableBalance(nativeBalance, minimumReserve);

  return {
    accountId: accountResponse.id,
    nativeBalance,
    subentryCount,
    numSponsored,
    numSponsoring,
    baseReserve,
    minimumReserve,
    availableBalance,
  };
}

/**
 * Formats account reserve breakdown into a readable summary string.
 */
export function formatReserveSummary(data: AccountReserveData): string {
  const lines: string[] = [];

  lines.push(`=== Stellar Account Reserve & Minimum Balance Summary ===`);
  lines.push(`Account ID:                ${data.accountId}`);
  lines.push(`Network Base Reserve Rate: ${data.baseReserve} XLM`);
  lines.push(`Total XLM Balance:         ${data.nativeBalance.toFixed(7)} XLM`);

  lines.push(`\nLedger Entry Breakdown:`);
  lines.push(`  - Account Entry Base:     2 * ${data.baseReserve} = ${(2 * data.baseReserve).toFixed(2)} XLM`);
  lines.push(`  - Total Subentry Count:   ${data.subentryCount} subentries`);
  lines.push(`  - Sponsored by Others:    ${data.numSponsored} subentries (exempt from reserve)`);
  lines.push(`  - Sponsoring for Others:  ${data.numSponsoring} subentries (adds reserve responsibility)`);

  lines.push(`\nCalculated Reserves:`);
  lines.push(`  - Minimum Required Reserve: ${data.minimumReserve.toFixed(7)} XLM`);
  lines.push(`  - Available Spendable XLM:  ${data.availableBalance.toFixed(7)} XLM`);

  lines.push(`\nReserve Breakdown Notes:`);
  lines.push(
    `  - Every subentry (trustline, offer, signer, data entry) requires 1 base reserve (${data.baseReserve} XLM).`,
  );
  lines.push(
    `  - Sponsored entries shift reserve responsibility from the account holder to the sponsor.`,
  );
  lines.push(
    `  - Transactions that would reduce an account's XLM balance below minimum reserve will fail on-chain.`,
  );

  return lines.join('\n');
}

/**
 * Runs the account reserve calculator example.
 */
export async function run(params: AccountReserveParams = {}): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const baseReserve = params.baseReserve ?? DEFAULT_BASE_RESERVE;
  const server = new Horizon.Server(horizonUrl);

  let accountId =
    params.accountId?.trim() ||
    process.env.ACCOUNT_ID?.trim() ||
    process.argv[3]?.trim();

  console.log('Starting Account Reserve and Minimum Balance Calculator Example...');
  console.log(`Using Horizon: ${horizonUrl}`);

  if (!accountId) {
    console.log('No account ID supplied. Fetching recent account from Horizon activity...');
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

  console.log(`Calculating reserve for account: ${accountId}`);

  try {
    const accountResponse = await server.loadAccount(accountId);
    const parsedData = parseAccountReserveData(accountResponse as any, baseReserve);

    console.log('\n' + formatReserveSummary(parsedData));
  } catch (error: any) {
    console.log(`Could not load account ${accountId} from Horizon: ${error.message || error}`);
    console.log('Demonstrating reserve calculation model for a sample account:');

    const sampleData: AccountReserveData = {
      accountId,
      nativeBalance: 100.0,
      subentryCount: 4,
      numSponsored: 1,
      numSponsoring: 0,
      baseReserve,
      minimumReserve: calculateMinimumReserve(4, 1, 0, baseReserve),
      availableBalance: calculateAvailableBalance(
        100.0,
        calculateMinimumReserve(4, 1, 0, baseReserve),
      ),
    };

    console.log('\n' + formatReserveSummary(sampleData));
  }

  console.log('\nAccount reserve calculation completed successfully.');
}
