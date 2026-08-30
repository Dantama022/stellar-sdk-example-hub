import { Horizon, Operation, Asset } from '@stellar/stellar-sdk';

export async function run(params?: any): Promise<void> {
  const assetCode = params?.assetCode || 'CLAW';
  const issuer = params?.issuer || 'GB6ZS324HT6VEEDZ6MG6CESWE7YZSY7WAJDRQSP2GZCRZ5GBND377A2F';
  const holder = params?.holder || 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

  const server = new Horizon.Server('https://horizon-testnet.stellar.org');

  try {
    console.log(`Verifying clawback configuration for issuer ${issuer}...`);
    const issuerAccount = await server.loadAccount(issuer);

    if (!issuerAccount.flags.auth_clawback_enabled) {
      console.log(
        'NOTE: Clawback is disabled for this issuer on-chain, but here is how the operation is built:\n',
      );
    }

    const op = Operation.clawback({
      asset: new Asset(assetCode, issuer),
      from: holder,
      amount: params?.amount || '10',
    });

    console.log('Clawback operation built in dry-run mode:');
    console.log(op);
  } catch (error: any) {
    console.error('Error fetching issuer account:', error.message);
  }
}
