import { Horizon, Operation, Asset } from '@stellar/stellar-sdk';

export async function run(params?: any): Promise<void> {
  const server = new Horizon.Server('https://horizon-testnet.stellar.org');
  // Fallback to a known Testnet account if none is provided
  const accountId = params?.accountId || 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

  try {
    const account = await server.loadAccount(accountId);
    const trustlines = account.balances.filter((b) => b.asset_type !== 'native');

    console.log(`Found ${trustlines.length} trustlines for ${accountId}.`);
    trustlines.forEach((t) => {
      console.log(
        `Asset: ${(t as any).asset_code} | Balance: ${t.balance} | Limit: ${(t as any).limit}`,
      );
    });

    const op = Operation.changeTrust({
      asset: new Asset('DEMO', accountId),
      limit: '0',
    });

    console.log('\nTrustline removal operation constructed successfully for dry-run:');
    console.log(op);
  } catch (error: any) {
    console.error('Error loading account or building trustline:', error.message);
  }
}
