import { Horizon } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_ACCOUNT_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const accountId = process.env.ACCOUNT_ID || DEFAULT_ACCOUNT_ID;
  const server = new Horizon.Server(horizonUrl);
  const account = await server.loadAccount(accountId);
  const trustlines = account.balances.filter((balance) => balance.asset_type !== 'native');

  console.log('=== Stellar Asset and Trustline Inspection Example ===');
  console.log(`Account: ${accountId}`);
  console.log(`Trustlines Found: ${trustlines.length}`);
  trustlines.forEach((balance, index) => {
    console.log(
      `${index + 1}. ${(balance as { asset_code?: string }).asset_code ?? 'unknown'} | balance=${balance.balance} | limit=${(balance as { limit?: string }).limit ?? 'none'}`,
    );
  });
}
