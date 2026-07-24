import {
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';

const LOW_THRESHOLD = 1;
const MED_THRESHOLD = 2;
const HIGH_THRESHOLD = 3;

async function fundAccount(publicKey: string): Promise<void> {
  const response = await fetch(
    `https://friendbot.stellar.org/?addr=${encodeURIComponent(publicKey)}`,
  );

  if (!response.ok) {
    throw new Error(`Failed to fund account ${publicKey}: ${response.statusText}`);
  }
}

function buildTx(account: Horizon.AccountResponse, operations: xdr.Operation[]) {
  const builder = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  });
  for (const op of operations) {
    builder.addOperation(op);
  }
  return builder.setTimeout(30).build();
}

function printSigners(account: Horizon.AccountResponse): void {
  console.log(
    `Thresholds: low=${account.thresholds.low_threshold}, ` +
      `med=${account.thresholds.med_threshold}, high=${account.thresholds.high_threshold}`,
  );
  console.log('Signers:');
  for (const s of account.signers) {
    console.log(`  - ${s.key.slice(0, 8)}...${s.key.slice(-4)} weight=${s.weight}`);
  }
}

/**
 * Demonstrates production-grade multisig management on Testnet:
 * weighted signers, per-threshold operations, signer rotation, and a
 * rejected submission with insufficient signature weight.
 */
export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const server = new Horizon.Server(horizonUrl);

  const master = Keypair.random();
  const signerA = Keypair.random();
  const signerB = Keypair.random();
  const signerC = Keypair.random();
  const signerD = Keypair.random();

  console.log('Starting Advanced Multi-Signature Wallet Example...');
  console.log(`Using Horizon: ${horizonUrl}`);
  console.log('\nSigner roster:');
  console.log(`Master  (weight 1): ${master.publicKey()}`);
  console.log(`SignerA (weight 1): ${signerA.publicKey()}`);
  console.log(`SignerB (weight 1): ${signerB.publicKey()}`);
  console.log(`SignerC (weight 2): ${signerC.publicKey()}`);
  console.log(`SignerD (weight 2): ${signerD.publicKey()} (added later via rotation)`);

  console.log('\nFunding wallet account via Friendbot...');
  await fundAccount(master.publicKey());

  // --- Step 1: configure signers and thresholds ---
  console.log('\nStep 1: Configuring signer weights and thresholds...');
  console.log(
    `Target thresholds: low=${LOW_THRESHOLD}, med=${MED_THRESHOLD}, high=${HIGH_THRESHOLD}`,
  );

  let account = await server.loadAccount(master.publicKey());
  // setOptions accepts only one signer per operation, so one op per signer
  const setupTx = buildTx(account, [
    Operation.setOptions({
      signer: { ed25519PublicKey: signerA.publicKey(), weight: 1 },
    }),
    Operation.setOptions({
      signer: { ed25519PublicKey: signerB.publicKey(), weight: 1 },
    }),
    Operation.setOptions({
      signer: { ed25519PublicKey: signerC.publicKey(), weight: 2 },
    }),
    Operation.setOptions({
      masterWeight: 1,
      lowThreshold: LOW_THRESHOLD,
      medThreshold: MED_THRESHOLD,
      highThreshold: HIGH_THRESHOLD,
    }),
  ]);
  setupTx.sign(master);
  await server.submitTransaction(setupTx);
  console.log('Multisig configuration submitted.');

  account = await server.loadAccount(master.publicKey());
  printSigners(account);

  // --- Step 2: low-threshold operation ---
  console.log('\nStep 2: Low-threshold operation (bumpSequence) signed by SignerA alone...');
  const lowTx = buildTx(account, [
    Operation.bumpSequence({ bumpTo: (BigInt(account.sequence) + 2n).toString() }),
  ]);
  lowTx.sign(signerA);
  const lowResponse = await server.submitTransaction(lowTx);
  console.log(
    `Accepted with weight 1 >= low threshold ${LOW_THRESHOLD}. Hash: ${lowResponse.hash}`,
  );

  // --- Step 3: medium-threshold operation ---
  console.log('\nStep 3: Medium-threshold operation (manageData) signed by SignerA + SignerB...');
  account = await server.loadAccount(master.publicKey());
  const medTx = buildTx(account, [Operation.manageData({ name: 'wallet_policy', value: 'v1' })]);
  medTx.sign(signerA);
  medTx.sign(signerB);
  const medResponse = await server.submitTransaction(medTx);
  console.log(
    `Accepted with weight 1+1 >= med threshold ${MED_THRESHOLD}. Hash: ${medResponse.hash}`,
  );

  // --- Step 4: failure with insufficient signatures ---
  console.log('\nStep 4: Attempting a high-threshold operation signed only by SignerB...');
  account = await server.loadAccount(master.publicKey());
  const underSignedTx = buildTx(account, [
    Operation.setOptions({
      signer: { ed25519PublicKey: signerD.publicKey(), weight: 2 },
    }),
  ]);
  underSignedTx.sign(signerB);

  try {
    await server.submitTransaction(underSignedTx);
    throw new Error('Expected the under-signed transaction to be rejected.');
  } catch (error: any) {
    const codes = error.response?.data?.extras?.result_codes;
    const opCodes: string[] = codes?.operations ?? [];
    // valid-but-insufficient signatures fail per operation: tx_failed / op_bad_auth
    if (codes?.transaction !== 'tx_bad_auth' && !opCodes.includes('op_bad_auth')) {
      throw error;
    }
    console.log(
      `Rejected as expected: ${codes.transaction} [${opCodes.join(', ')}] ` +
        `(weight 1 < high threshold ${HIGH_THRESHOLD}).`,
    );
  }

  // --- Step 5: signer rotation ---
  console.log('\nStep 5: Rotating signers (add SignerD, remove SignerA) with Master + SignerC...');
  account = await server.loadAccount(master.publicKey());
  // weight 0 removes a signer
  const rotationTx = buildTx(account, [
    Operation.setOptions({
      signer: { ed25519PublicKey: signerD.publicKey(), weight: 2 },
    }),
    Operation.setOptions({
      signer: { ed25519PublicKey: signerA.publicKey(), weight: 0 },
    }),
  ]);
  rotationTx.sign(master);
  rotationTx.sign(signerC);
  const rotationResponse = await server.submitTransaction(rotationTx);
  console.log(
    `Accepted with weight 1+2 >= high threshold ${HIGH_THRESHOLD}. Hash: ${rotationResponse.hash}`,
  );

  account = await server.loadAccount(master.publicKey());
  printSigners(account);

  const signerKeys = account.signers.map((s) => s.key);
  if (signerKeys.includes(signerA.publicKey()) || !signerKeys.includes(signerD.publicKey())) {
    throw new Error('Signer rotation did not produce the expected signer set.');
  }
  console.log('Rotation verified: SignerA removed, SignerD active.');

  // --- Step 6: rotated-in signer authorizes on its own ---
  console.log('\nStep 6: Medium-threshold operation signed by rotated-in SignerD alone...');
  const cleanupTx = buildTx(account, [
    Operation.manageData({ name: 'wallet_policy', value: null }),
  ]);
  cleanupTx.sign(signerD);
  const cleanupResponse = await server.submitTransaction(cleanupTx);
  console.log(
    `Accepted with weight 2 >= med threshold ${MED_THRESHOLD}. Hash: ${cleanupResponse.hash}`,
  );

  console.log('\nAdvanced multisig workflow completed successfully.');
}
