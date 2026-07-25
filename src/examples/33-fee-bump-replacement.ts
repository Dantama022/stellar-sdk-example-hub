/**
 * 33-fee-bump-replacement: Fee Bump Replacement Workflow
 *
 * OVERVIEW
 * --------
 * When a transaction is stuck in the network's queue because its fee is too
 * low (e.g. during fee surges), an application can "bump" the fee by wrapping
 * the already-signed inner transaction in a fee-bump envelope. The fee-bump
 * transaction:
 *
 *   • Preserves the original inner transaction and all its signatures unchanged.
 *   • Introduces a separate "fee source" account that pays the higher fee.
 *   • Allows the fee to be raised without invalidating the inner transaction's
 *     signatures — the inner transaction source is not asked to re-sign.
 *
 * This is the canonical "replace-by-fee" pattern on Stellar.
 *
 * FEE CALCULATION
 * ---------------
 * The total fee deducted from the fee source account is:
 *
 *   total_fee = bump_base_fee × (number_of_inner_operations + 1)
 *
 * The "+1" counts the fee-bump envelope itself as an implicit operation.
 * The bump_base_fee must be at least as large as the inner transaction's
 * per-operation base fee rate (inner_fee / inner_operations).
 *
 * Example:
 *   inner_fee       = 100 stroops, inner_ops = 1
 *   inner_fee_rate  = 100 stroops/op
 *   bump_base_fee   = 500 stroops   (5× the inner rate)
 *   total_fee       = 500 × (1 + 1) = 1 000 stroops
 *
 * ACCOUNT ROLES
 * -------------
 *   Inner transaction source  – Signs the payment operation. Sequence number
 *                               is consumed from this account. Fee is NOT
 *                               deducted from this account.
 *   Fee source                – Signs the fee-bump envelope. Pays the full
 *                               fee. Sequence number is NOT consumed from
 *                               this account.
 *
 * WORKFLOW DEMONSTRATED
 * ----------------------
 *  1. Build and sign an inner transaction at a low base fee (100 stroops).
 *  2. Inspect the inner transaction XDR and fee.
 *  3. Wrap the signed inner transaction in a fee-bump at a higher fee (500 stroops).
 *  4. Sign the fee-bump envelope with the fee-source account.
 *  5. Submit the fee-bump envelope to Horizon.
 *  6. Query Horizon by hash and verify fee_account, inner_transaction details,
 *     and confirm balances reflect which account paid the fee.
 */

import {
  Asset,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

const HORIZON_URL = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
const FRIENDBOT_URL = 'https://friendbot.stellar.org';

/** Fee for the inner transaction — intentionally low to simulate a "stuck" tx. */
const INNER_BASE_FEE = '100'; // 100 stroops per operation

/**
 * Bump fee applied by the fee source. Must be >= INNER_BASE_FEE.
 * Total deducted from fee source = BUMP_BASE_FEE × (ops + 1).
 */
const BUMP_BASE_FEE = '500'; // 500 stroops per operation

async function fundAccount(publicKey: string): Promise<void> {
  const response = await fetch(`${FRIENDBOT_URL}/?addr=${encodeURIComponent(publicKey)}`);
  if (!response.ok) {
    throw new Error(`Friendbot funding failed for ${publicKey}: ${response.statusText}`);
  }
}

/** Convert stroops (integer string) to XLM for display. */
function stroopsToXlm(stroops: string | number): string {
  return (Number(stroops) / 1e7).toFixed(7);
}

/** Read the XLM balance from a loaded account record. */
function xlmBalance(account: Horizon.AccountResponse): string {
  return account.balances.find((b) => b.asset_type === 'native')?.balance ?? 'unknown';
}

export async function run(): Promise<void> {
  const server = new Horizon.Server(HORIZON_URL);

  console.log('=== Fee Bump Replacement Workflow ===\n');

  // -----------------------------------------------------------------------
  // Step 1 – Generate accounts
  // -----------------------------------------------------------------------
  console.log('Step 1: Generating account keypairs...');

  const innerSource = Keypair.random(); // Signs the inner transaction
  const feeSource = Keypair.random(); // Pays the bumped fee
  const destination = Keypair.random(); // Receives the payment

  console.log(`  Inner transaction source : ${innerSource.publicKey()}`);
  console.log(`  Fee source               : ${feeSource.publicKey()}`);
  console.log(`  Destination              : ${destination.publicKey()}`);
  console.log();

  // -----------------------------------------------------------------------
  // Step 2 – Fund accounts
  // -----------------------------------------------------------------------
  console.log('Step 2: Funding accounts via Friendbot...');
  await Promise.all([
    fundAccount(innerSource.publicKey()),
    fundAccount(feeSource.publicKey()),
    fundAccount(destination.publicKey()),
  ]);
  console.log('  All accounts funded (10 000 XLM each on Testnet).\n');

  // Capture pre-submission balances for comparison
  const [innerSourcePre, feeSourcePre] = await Promise.all([
    server.loadAccount(innerSource.publicKey()),
    server.loadAccount(feeSource.publicKey()),
  ]);
  console.log('  Pre-submission balances:');
  console.log(`    Inner source : ${xlmBalance(innerSourcePre)} XLM`);
  console.log(`    Fee source   : ${xlmBalance(feeSourcePre)} XLM\n`);

  // -----------------------------------------------------------------------
  // Step 3 – Build and sign the inner transaction
  //
  // This simulates the original transaction that is already in the queue but
  // needs a higher fee to be processed promptly.
  // -----------------------------------------------------------------------
  console.log('Step 3: Building and signing the inner transaction...');
  console.log(`  Inner base fee : ${INNER_BASE_FEE} stroops/op`);

  const innerSourceAccount = await server.loadAccount(innerSource.publicKey());

  const innerTx = new TransactionBuilder(innerSourceAccount, {
    fee: INNER_BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: destination.publicKey(),
        asset: Asset.native(),
        amount: '10',
      }),
    )
    // Use setTimeout(0) so the inner transaction has no time-based expiry.
    // In practice, you would set a reasonable timeout.
    .setTimeout(0)
    .build();

  // The inner transaction is signed by its own source account.
  // This signature must not change once the fee-bump wraps the transaction.
  innerTx.sign(innerSource);

  const innerTxXdr = innerTx.toEnvelope().toXDR('base64');
  const innerOps = innerTx.operations.length;
  const innerFeeStroops = Number(innerTx.fee);

  console.log(`  Inner tx hash       : ${innerTx.hash().toString('hex')}`);
  console.log(`  Inner tx operations : ${innerOps}`);
  console.log(
    `  Inner tx fee        : ${innerFeeStroops} stroops (${stroopsToXlm(innerFeeStroops)} XLM)`,
  );
  console.log(`  Inner tx source seq : ${innerTx.sequence}`);
  console.log();
  console.log('  Inner transaction XDR (first 80 chars):');
  console.log(`    ${innerTxXdr.substring(0, 80)}...`);
  console.log();

  // -----------------------------------------------------------------------
  // Step 4 – Construct the fee-bump envelope
  //
  // TransactionBuilder.buildFeeBumpTransaction wraps the signed inner
  // transaction without altering it. The fee source provides the higher fee.
  // -----------------------------------------------------------------------
  console.log('Step 4: Wrapping the inner transaction in a fee-bump envelope...');

  // Fee calculation explanation:
  //   bump_base_fee (per-op rate) × (inner_ops + 1) = total_fee
  //   500 × (1 + 1) = 1 000 stroops
  const totalFeeStroops = Number(BUMP_BASE_FEE) * (innerOps + 1);

  console.log(`  Bump base fee     : ${BUMP_BASE_FEE} stroops/op`);
  console.log(`  Inner operations  : ${innerOps}`);
  console.log(
    `  Fee calculation   : ${BUMP_BASE_FEE} × (${innerOps} + 1) = ${totalFeeStroops} stroops`,
  );
  console.log(
    `  Total fee         : ${totalFeeStroops} stroops (${stroopsToXlm(totalFeeStroops)} XLM)`,
  );
  console.log(`  Fee payer         : ${feeSource.publicKey()}`);
  console.log();

  const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
    feeSource.publicKey(), // Account that will pay the fee
    BUMP_BASE_FEE, // New per-operation base fee rate
    innerTx, // Already-signed inner transaction (untouched)
    Networks.TESTNET,
  );

  // -----------------------------------------------------------------------
  // Step 5 – Sign the fee-bump envelope with the fee source
  //
  // Only the fee source needs to sign the outer fee-bump envelope.
  // The inner transaction's signatures remain intact and unchanged.
  // -----------------------------------------------------------------------
  console.log('Step 5: Signing the fee-bump envelope with the fee source account...');
  feeBumpTx.sign(feeSource);

  const feeBumpXdr = feeBumpTx.toEnvelope().toXDR('base64');
  console.log('  Fee-bump envelope signed.');
  console.log(`  Fee-bump XDR (first 80 chars):`);
  console.log(`    ${feeBumpXdr.substring(0, 80)}...`);
  console.log();

  // -----------------------------------------------------------------------
  // Step 6 – Submit the fee-bump transaction
  // -----------------------------------------------------------------------
  console.log('Step 6: Submitting fee-bump transaction to Horizon Testnet...');

  const submitResult = await server.submitTransaction(feeBumpTx);

  console.log('  Submission successful!\n');

  // -----------------------------------------------------------------------
  // Step 7 – Verify via Horizon
  //
  // Horizon returns the fee-bump hash in the submit response. The transaction
  // record includes both fee_bump_transaction and inner_transaction fields
  // so we can confirm the fee source, inner hash, and max_fee.
  // -----------------------------------------------------------------------
  console.log('Step 7: Querying Horizon to verify the transaction...');

  const txRecord = await server.transactions().transaction(submitResult.hash).call();

  console.log('\n  --- Horizon Transaction Record ---');
  console.log(`  Fee-bump tx hash     : ${txRecord.hash}`);
  console.log(`  Fee account          : ${txRecord.fee_account}`);
  console.log(`  Fee charged (stroops): ${txRecord.fee_charged}`);
  console.log(`  Max fee (stroops)    : ${txRecord.max_fee}`);
  // ledger_attr holds the sequence number; txRecord.ledger is a link function
  console.log(
    `  Ledger               : ${(txRecord as unknown as { ledger_attr: number }).ledger_attr}`,
  );
  console.log(`  Source account       : ${txRecord.source_account}`);
  console.log();

  if (txRecord.inner_transaction) {
    console.log('  --- Inner Transaction ---');
    console.log(`  Inner tx hash  : ${txRecord.inner_transaction.hash}`);
    console.log(`  Inner max_fee  : ${txRecord.inner_transaction.max_fee} stroops`);
    console.log(`  Signatures     : ${txRecord.inner_transaction.signatures.length} signature(s)`);
  }

  if (txRecord.fee_bump_transaction) {
    console.log('\n  --- Fee-Bump Envelope ---');
    console.log(`  Fee-bump hash  : ${txRecord.fee_bump_transaction.hash}`);
    console.log(
      `  Signatures     : ${txRecord.fee_bump_transaction.signatures.length} signature(s)`,
    );
  }

  // -----------------------------------------------------------------------
  // Step 8 – Compare balances
  // -----------------------------------------------------------------------
  console.log('\nStep 8: Comparing account balances to confirm who paid the fee...');

  const [innerSourcePost, feeSourcePost] = await Promise.all([
    server.loadAccount(innerSource.publicKey()),
    server.loadAccount(feeSource.publicKey()),
  ]);

  const innerSourcePreBal = parseFloat(xlmBalance(innerSourcePre));
  const innerSourcePostBal = parseFloat(xlmBalance(innerSourcePost));
  const feeSourcePreBal = parseFloat(xlmBalance(feeSourcePre));
  const feeSourcePostBal = parseFloat(xlmBalance(feeSourcePost));

  const innerSourceDelta = (innerSourcePostBal - innerSourcePreBal).toFixed(7);
  const feeSourceDelta = (feeSourcePostBal - feeSourcePreBal).toFixed(7);

  console.log();
  console.log('  Account              Before (XLM)        After (XLM)         Delta');
  console.log('  -------              ------------        -----------         -----');
  console.log(
    `  Inner source         ${innerSourcePreBal.toFixed(7).padEnd(20)}${innerSourcePostBal.toFixed(7).padEnd(20)}${innerSourceDelta}`,
  );
  console.log(
    `  Fee source           ${feeSourcePreBal.toFixed(7).padEnd(20)}${feeSourcePostBal.toFixed(7).padEnd(20)}${feeSourceDelta}`,
  );

  console.log();
  console.log('  Observations:');
  console.log('  • Inner source paid 10 XLM (the payment operation).');
  console.log('    Its balance was NOT debited for the transaction fee.');
  console.log('  • Fee source paid the transaction fee in stroops.');
  console.log('    Its sequence number was NOT consumed.');

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  console.log('\n=== Summary ===');
  console.log('');
  console.log('Fee-bump transaction workflow completed successfully.');
  console.log('');
  console.log('Key points:');
  console.log('  1. The inner transaction was signed by its source account and left unchanged.');
  console.log('  2. The fee-bump envelope was built around the signed inner transaction.');
  console.log('  3. A separate fee source signed the outer envelope and paid the fee.');
  console.log('  4. The total fee formula: bump_base_fee × (inner_ops + 1)');
  console.log(`     = ${BUMP_BASE_FEE} × (${innerOps} + 1) = ${totalFeeStroops} stroops`);
  console.log('  5. Horizon records both fee_bump_transaction and inner_transaction hashes.');
  console.log('  6. This pattern allows fee replacement without re-signing the inner tx.');
  console.log('');
  console.log('When to use fee bumps:');
  console.log('  • Transaction stuck in mempool due to low fee during network congestion.');
  console.log('  • Application wants to sponsor fees on behalf of users.');
  console.log('  • Need to increase priority without obtaining new signatures.');
}
