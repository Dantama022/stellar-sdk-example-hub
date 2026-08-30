import { Horizon } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_ACCOUNT_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const accountId = process.env.ACCOUNT_ID || DEFAULT_ACCOUNT_ID;
  const server = new Horizon.Server(horizonUrl);
  const page = await server.payments().forAccount(accountId).order('desc').limit(3).call();

  const records = page.records as Array<{
    paging_token?: string;
    transaction_hash?: string;
    created_at?: string;
  }>;

  const latest = records[0];

  console.log('=== Persistent Stellar Payment Monitoring Example ===');
  console.log(`Account: ${accountId}`);
  console.log(`Checkpoint Size: ${records.length}`);
  console.log(`Last Paging Token: ${latest?.paging_token ?? 'none'}`);
  console.log(`Last Transaction: ${latest?.transaction_hash ?? 'none'}`);
  console.log(`Last Seen At: ${latest?.created_at ?? 'none'}`);
}
