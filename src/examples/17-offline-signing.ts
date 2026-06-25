import {
  Keypair,
  Horizon,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
  Transaction,
} from '@stellar/stellar-sdk';

/**
 * Runs the offline signing example.
 * Demonstrates a complete flow of preparing an unsigned transaction, exporting it as XDR,
 * signing it in an isolated simulation step, verifying the signature, and submitting it.
 *
 * @param params Optional parameters for the payment amount.
 */
export async function run(params?: { amount?: string }): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const server = new Horizon.Server(horizonUrl);

  const amount = params?.amount || '10';

  console.log(`Starting Offline Transaction Signer Example: amount=${amount} XLM`);

  // 1. Prepare keypairs
  console.log('Generating keypairs...');
  const sourceKeypair = Keypair.random();
  const destinationKeypair = Keypair.random();

  console.log(`Source Public Key:      ${sourceKeypair.publicKey()}`);
  console.log(`Destination Public Key: ${destinationKeypair.publicKey()}`);

  // 2. Fund source account
  console.log('\nFunding source account via Friendbot...');
  const fundRes = await fetch(
    `https://friendbot.stellar.org/?addr=${encodeURIComponent(sourceKeypair.publicKey())}`,
  );
  if (!fundRes.ok) {
    throw new Error(`Failed to fund source account: ${fundRes.statusText}`);
  }
  console.log('Source account funded successfully.');

  // 3. Load source account to get its current sequence number
  console.log('Loading source account from Horizon...');
  const sourceAccount = await server.loadAccount(sourceKeypair.publicKey());

  // === Phase 1: Build Unsigned Transaction ===
  console.log('\n--- Phase 1: Build Unsigned Transaction ---');
  const unsignedTx = new TransactionBuilder(sourceAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: destinationKeypair.publicKey(),
        asset: Asset.native(),
        amount: amount,
      }),
    )
    .setTimeout(30)
    .build();

  // Export unsigned transaction XDR
  const unsignedXdr = unsignedTx.toXDR();
  console.log('Unsigned Transaction XDR generated:');
  console.log(unsignedXdr);

  console.log('\nUnsigned Transaction Details:');
  console.log(`  - Source Account: ${unsignedTx.source}`);
  console.log(`  - Sequence Number: ${unsignedTx.sequence}`);
  console.log(`  - Number of Signatures: ${unsignedTx.signatures.length}`);

  // === Phase 2: Sign Transaction (Simulated Offline Environment) ===
  console.log('\n--- Phase 2: Load and Sign Transaction (Simulated Offline Device) ---');
  console.log('Loading transaction from XDR on offline device...');
  const offlineTx = TransactionBuilder.fromXDR(unsignedXdr, Networks.TESTNET);
  if (!(offlineTx instanceof Transaction)) {
    throw new Error('Expected a standard Transaction, not a FeeBumpTransaction');
  }

  console.log('Signing transaction using offline private key...');
  // The offline device has access to the private key (sourceKeypair)
  offlineTx.sign(sourceKeypair);

  // Export signed transaction XDR
  const signedXdr = offlineTx.toXDR();
  console.log('Signed Transaction XDR generated:');
  console.log(signedXdr);

  console.log('\nSigned Transaction Details:');
  console.log(`  - Source Account: ${offlineTx.source}`);
  console.log(`  - Sequence Number: ${offlineTx.sequence}`);
  console.log(`  - Number of Signatures: ${offlineTx.signatures.length}`);

  if (offlineTx.signatures.length > 0) {
    const sig = offlineTx.signatures[0];
    console.log(`  - Signature Hint: ${sig.hint().toString('hex')}`);
    console.log(`  - Signature Payload: ${sig.signature().toString('base64')}`);
  }

  // === Verification ===
  console.log('\n--- Verification: Verify Signatures and Submit ---');
  console.log('Verifying transaction signatures programmatically...');
  if (offlineTx.signatures.length === 1) {
    console.log('Verification Success: Transaction contains exactly 1 signature.');
  } else {
    throw new Error(
      `Verification Failed: Expected 1 signature, found ${offlineTx.signatures.length}`,
    );
  }

  console.log('Submitting the signed transaction to Horizon...');
  const response = await server.submitTransaction(offlineTx);
  console.log('Transaction submitted and accepted successfully!');
  console.log(`Transaction Hash: ${response.hash}`);
}
