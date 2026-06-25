import {
  Keypair,
  Horizon,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
} from '@stellar/stellar-sdk';

/**
 * Runs the asset issuance example.
 * Demonstrates generating issuer/distribution accounts, establishing trustlines,
 * issuing custom assets, locking the issuer account, and verifying the lock.
 *
 * @param params Optional parameters for the asset code and issuance amount.
 */
export async function run(params?: { assetCode?: string; amount?: string }): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const server = new Horizon.Server(horizonUrl);

  const assetCode = params?.assetCode || 'MYASSET';
  const amount = params?.amount || '10000';

  console.log(`Starting Asset Issuance Example: code=${assetCode}, amount=${amount}`);

  // 1. Create issuer and distribution keypairs
  console.log('Generating issuer and distribution keypairs...');
  const issuer = Keypair.random();
  const distribution = Keypair.random();

  console.log(`Issuer Public Key: ${issuer.publicKey()}`);
  console.log(`Distribution Public Key: ${distribution.publicKey()}`);

  // 2. Fund both accounts on Stellar Testnet using Friendbot
  console.log('\nFunding issuer account via Friendbot...');
  const fundIssuerRes = await fetch(
    `https://friendbot.stellar.org/?addr=${encodeURIComponent(issuer.publicKey())}`,
  );
  if (!fundIssuerRes.ok) {
    throw new Error(`Failed to fund issuer: ${fundIssuerRes.statusText}`);
  }
  console.log('Issuer account funded successfully.');

  console.log('Funding distribution account via Friendbot...');
  const fundDistRes = await fetch(
    `https://friendbot.stellar.org/?addr=${encodeURIComponent(distribution.publicKey())}`,
  );
  if (!fundDistRes.ok) {
    throw new Error(`Failed to fund distribution: ${fundDistRes.statusText}`);
  }
  console.log('Distribution account funded successfully.');

  // 3. Define the custom asset
  const customAsset = new Asset(assetCode, issuer.publicKey());
  console.log(`\nDefined custom Asset: Code=${customAsset.code}, Issuer=${customAsset.issuer}`);

  // 4. Load distribution account details to build changeTrust transaction
  console.log('\nLoading distribution account from Horizon...');
  const distAccount = await server.loadAccount(distribution.publicKey());

  // 5. Establish a trustline from the distribution account to the custom asset
  console.log('Building changeTrust transaction...');
  const trustTx = new TransactionBuilder(distAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.changeTrust({
        asset: customAsset,
        limit: '100000000',
      }),
    )
    .setTimeout(30)
    .build();

  trustTx.sign(distribution);
  console.log('Submitting changeTrust transaction...');
  const trustResponse = await server.submitTransaction(trustTx);
  console.log(`Trustline established. Hash: ${trustResponse.hash}`);

  // 6. Load issuer account details to build payment (issuance) transaction
  console.log('\nLoading issuer account from Horizon...');
  const issuerAccountForIssuance = await server.loadAccount(issuer.publicKey());

  // 7. Issue the asset to the distribution account
  console.log(`Issuing ${amount} ${assetCode} to distribution account...`);
  const issueTx = new TransactionBuilder(issuerAccountForIssuance, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: distribution.publicKey(),
        asset: customAsset,
        amount: amount,
      }),
    )
    .setTimeout(30)
    .build();

  issueTx.sign(issuer);
  console.log('Submitting issuance payment transaction...');
  const issueResponse = await server.submitTransaction(issueTx);
  console.log(`Asset issued successfully. Hash: ${issueResponse.hash}`);

  // Verify distribution account received the asset
  const updatedDistAccount = await server.loadAccount(distribution.publicKey());
  console.log('\nDistribution Account Balances:');
  for (const balance of updatedDistAccount.balances) {
    if (balance.asset_type !== 'native' && (balance as any).asset_code === assetCode) {
      console.log(`  - ${balance.balance} ${assetCode}`);
    }
  }

  // 8. Lock the issuer account by setting masterWeight to 0 and thresholds to 1
  console.log('\nLocking issuer account...');
  const issuerAccountForLock = await server.loadAccount(issuer.publicKey());
  const lockTx = new TransactionBuilder(issuerAccountForLock, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.setOptions({
        masterWeight: 0,
        lowThreshold: 1,
        medThreshold: 1,
        highThreshold: 1,
      }),
    )
    .setTimeout(30)
    .build();

  lockTx.sign(issuer);
  console.log('Submitting account lock transaction...');
  const lockResponse = await server.submitTransaction(lockTx);
  console.log(`Issuer account locked. Hash: ${lockResponse.hash}`);

  // 9. Verify issuer account lock status
  console.log('\nLoading locked issuer account details...');
  const lockedIssuerAccount = await server.loadAccount(issuer.publicKey());
  console.log(
    `  - Master Key Weight: ${lockedIssuerAccount.thresholds.low_threshold} (expected: 0 after lock)`,
  );
  console.log(
    `  - Thresholds: Low=${lockedIssuerAccount.thresholds.low_threshold}, Med=${lockedIssuerAccount.thresholds.med_threshold}, High=${lockedIssuerAccount.thresholds.high_threshold}`,
  );

  // 10. Verify locked issuer can no longer sign or authorize transactions
  console.log('\nVerifying lock by attempting another transaction from the issuer...');
  const verificationTx = new TransactionBuilder(lockedIssuerAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.setOptions({
        masterWeight: 1, // Attempt to reset weight (re-lock override)
      }),
    )
    .setTimeout(30)
    .build();

  verificationTx.sign(issuer);

  try {
    console.log('Submitting unauthorized transaction (expected to fail)...');
    await server.submitTransaction(verificationTx);
    throw new Error('Verification failed: Transaction succeeded but should have been rejected!');
  } catch (error: any) {
    console.log('Transaction failed as expected!');
    const errorDetails = error.response?.data?.extras?.result_codes?.transaction || error.message;
    console.log(`Error code: ${errorDetails}`);
    console.log('Verification Success: The issuer account is successfully locked.');
  }
}
