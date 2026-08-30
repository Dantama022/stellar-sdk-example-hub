import { Horizon } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_ACCOUNT_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const accountId = process.env.ACCOUNT_ID || DEFAULT_ACCOUNT_ID;
  const server = new Horizon.Server(horizonUrl);
  const page = await server.transactions().forAccount(accountId).order('desc').limit(5).call();

  console.log('=== Account Transaction History Inspector ===');
  console.log(`Account: ${accountId}`);
  console.log(`Transactions Found: ${page.records.length}`);

  page.records.forEach((record, index) => {
    const tx = record as {
      hash?: string;
      successful?: boolean;
      created_at?: string;
      operation_count?: number;
    };

    console.log(
      `${index + 1}. ${tx.hash ?? 'unknown'} | ${tx.successful ? 'success' : 'failed'} | ops=${tx.operation_count ?? 0} | ${tx.created_at ?? 'unknown'}`,
    );
  });
}
