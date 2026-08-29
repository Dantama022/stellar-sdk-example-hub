import { Horizon } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_ACCOUNT_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const accountId = process.env.ACCOUNT_ID || DEFAULT_ACCOUNT_ID;
  const server = new Horizon.Server(horizonUrl);
  const page = await server.operations().forAccount(accountId).order('desc').limit(5).call();

  console.log('=== Account Operation History Inspector ===');
  console.log(`Account: ${accountId}`);
  console.log(`Operations Found: ${page.records.length}`);

  page.records.forEach((record, index) => {
    const operation = record as {
      id?: string;
      type?: string;
      transaction_hash?: string;
      created_at?: string;
    };

    console.log(
      `${index + 1}. ${operation.type ?? 'unknown'} | op=${operation.id ?? 'unknown'} | tx=${operation.transaction_hash ?? 'unknown'} | ${operation.created_at ?? 'unknown'}`,
    );
  });
}
