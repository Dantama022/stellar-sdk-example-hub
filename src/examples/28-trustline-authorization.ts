import {
  Keypair,
  Horizon,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
} from '@stellar/stellar-sdk';

export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const server = new Horizon.Server(horizonUrl);

  console.log('Starting Trustline Authorization Example...');

  const issuer = Keypair.random();
  const distribution = Keypair.random();
  const customAssetCode = 'REGCOIN';

  console.log('Funding issuer and distribution accounts via Friendbot...');
  await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(issuer.publicKey())}`);
  await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(distribution.publicKey())}`);

  // 1. Configure the issuer account with AUTHORIZATION_REQUIRED
  console.log('\n--- Configuring Issuer Flags ---');
  const issuerAccount = await server.loadAccount(issuer.publicKey());
  
  // Note: authRevocable is required to allow deauthorization later
  let tx = new TransactionBuilder(issuerAccount, { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(
      Operation.setOptions({
        setFlags: 1 | 2, // 1 = AUTH_REQUIRED_FLAG, 2 = AUTH_REVOCABLE_FLAG
      })
    )
    .setTimeout(30)
    .build();
  
  tx.sign(issuer);
  await server.submitTransaction(tx);
  console.log('Issuer account configured with AUTH_REQUIRED and AUTH_REVOCABLE.');

  // 2. Create trustline from distribution account
  console.log('\n--- Creating Trustline ---');
  const customAsset = new Asset(customAssetCode, issuer.publicKey());
  const distAccount = await server.loadAccount(distribution.publicKey());

  tx = new TransactionBuilder(distAccount, { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(
      Operation.changeTrust({
        asset: customAsset,
        limit: '10000',
      })
    )
    .setTimeout(30)
    .build();

  tx.sign(distribution);
  await server.submitTransaction(tx);
  console.log(`Trustline created by distribution account for ${customAssetCode}. Status is currently UNAUTHORIZED.`);

  // Helper to submit allowTrust
  const setAuthorization = async (authorize: number, actionName: string) => {
    const account = await server.loadAccount(issuer.publicKey());
    const authTx = new TransactionBuilder(account, { fee: '100', networkPassphrase: Networks.TESTNET })
      .addOperation(
        Operation.allowTrust({
          trustor: distribution.publicKey(),
          assetCode: customAssetCode,
          authorize: authorize, // 1 = Authorized, 0 = Unauthorized
        })
      )
      .setTimeout(30)
      .build();

    authTx.sign(issuer);
    const response = await server.submitTransaction(authTx);
    console.log(`${actionName} successful! Transaction Hash: ${response.hash}`);
  };

  // 3. Authorize the trustline
  console.log('\n--- Authorizing Trustline ---');
  await setAuthorization(1, 'Authorization');

  // 4. Deauthorize the trustline
  console.log('\n--- Deauthorizing Trustline ---');
  await setAuthorization(0, 'Deauthorization');

  // 5. Reauthorize the trustline
  console.log('\n--- Reauthorizing Trustline ---');
  await setAuthorization(1, 'Reauthorization');
  
  console.log('\nTrustline authorization lifecycle complete.');
}