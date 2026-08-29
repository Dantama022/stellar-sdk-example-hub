import { Horizon } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_ACCOUNT_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const accountId = process.env.ACCOUNT_ID || DEFAULT_ACCOUNT_ID;
  const server = new Horizon.Server(horizonUrl);
  const page = await server.payments().forAccount(accountId).order('desc').limit(5).call();

  const records = page.records as Array<{
    transaction_hash?: string;
    amount?: string;
    asset_type?: string;
    created_at?: string;
  }>;

  const totalAmount = records.reduce((sum, record) => sum + Number(record.amount ?? 0), 0);

  console.log('=== Stellar Payment Reconciliation Example ===');
  console.log(`Account: ${accountId}`);
  console.log(`Payments Reviewed: ${records.length}`);
  console.log(`Reconciled Amount: ${totalAmount.toFixed(7)}`);
  records.forEach((record, index) => {
    console.log(
      `${index + 1}. ${record.transaction_hash ?? 'unknown'} | ${record.amount ?? '0'} ${record.asset_type ?? 'native'} | ${record.created_at ?? 'unknown'}`,
    );
  });
}
