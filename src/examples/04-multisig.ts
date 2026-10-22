import { Keypair, Horizon, TransactionBuilder, Networks, Operation } from '@stellar/stellar-sdk';

export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const server = new Horizon.Server(horizonUrl);

  // 1. Prepare primary account
  console.log('Preparing primary account...');
  const primary = Keypair.random();
  console.log(`Primary Public Key: ${primary.publicKey()}`);

  await fetch(`https://friendbot.stellar.org/?addr=${primary.publicKey()}`);
  console.log('Primary funded with XLM.');

  // 2. Prepare secondary signer key
  const signer = Keypair.random();
  console.log(`Secondary Signer Public Key: ${signer.publicKey()}`);

  // 3. Load primary account
  const primaryAccount = await server.loadAccount(primary.publicKey());

  // 4. Build Multi-sig configuration transaction
  // - Add secondary signer with weight 1
  // - Update thresholds: Low=1, Medium=2, High=2
  // - Set master key weight to 1
  console.log('\nBuilding multi-sig transaction...');
  const tx = new TransactionBuilder(primaryAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    // Add signer
    .addOperation(
      Operation.setOptions({
        signer: {
          ed25519PublicKey: signer.publicKey(),
          weight: 1,
        },
      }),
    )
    // Modify thresholds and master weight
    .addOperation(
      Operation.setOptions({
        masterWeight: 1,
        lowThreshold: 1,
        medThreshold: 2,
        highThreshold: 2,
      }),
    )
    .setTimeout(30)
    .build();

  // 5. Sign transaction with primary key
  tx.sign(primary);

  // 6. Submit transaction
  console.log('Submitting multi-sig transaction to Horizon...');
  const response = await server.submitTransaction(tx);
  console.log('Multi-sig successfully configured!');
  console.log(`Hash: ${response.hash}`);

  // Verify
  console.log('\nLoading updated account configurations...');
  const updatedAccount = await server.loadAccount(primary.publicKey());
  console.log(
    `Master Weight: ${updatedAccount.thresholds.low_threshold} (Low), ${updatedAccount.thresholds.med_threshold} (Medium), ${updatedAccount.thresholds.high_threshold} (High)`,
  );
  console.log('Signers list:');
  for (const s of updatedAccount.signers) {
    console.log(`  - Key: ${s.key.slice(0, 15)}... Weight: ${s.weight}`);
  }
}
