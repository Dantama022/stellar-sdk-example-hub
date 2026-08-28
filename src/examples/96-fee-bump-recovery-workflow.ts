import {
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  Asset,
} from '@stellar/stellar-sdk';

const HORIZON_URL = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
const FRIENDBOT_URL = 'https://friendbot.stellar.org';
const DEFAULT_INNER_BASE_FEE = 10; // intentionally below current network base fee
const DEFAULT_BUMP_BASE_FEE = 500;
const CONFIRMATION_CHECK_DELAY_MS = 1500;

async function fundAccount(publicKey: string): Promise<void> {
  const response = await fetch(`${FRIENDBOT_URL}/?addr=${encodeURIComponent(publicKey)}`);
  if (!response.ok) {
    throw new Error(`Friendbot funding failed for ${publicKey}: ${response.statusText}`);
  }
}

function stroopsToXlm(stroops: number): string {
  return (stroops / 1e7).toFixed(7);
}

function normalizeFee(value: string | number | undefined, fallback: number): number {
  if (value === undefined || value === '') {
    return fallback;
  }
  const fee = Number(value);
  if (!Number.isInteger(fee) || fee < 1) {
    throw new Error(`Fee must be a positive integer stroop value, got: ${value}`);
  }
  return fee;
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'response' in error &&
    (error as any).response?.status === 404
  );
}

function getHorizonTransactionErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const extras = (error as any).response?.data?.extras;
  return extras?.result_codes?.transaction;
}

async function isTransactionConfirmed(server: Horizon.Server, hash: string): Promise<boolean> {
  try {
    await server.transactions().transaction(hash).call();
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

async function waitForTransactionConfirmation(
  server: Horizon.Server,
  hash: string,
  waitMs: number,
): Promise<boolean> {
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  return isTransactionConfirmed(server, hash);
}

export async function run(params?: { innerBaseFee?: string; bumpBaseFee?: string }): Promise<void> {
  const server = new Horizon.Server(HORIZON_URL);
  const innerBaseFee = normalizeFee(
    params?.innerBaseFee || process.env.INNER_BASE_FEE,
    DEFAULT_INNER_BASE_FEE,
  );
  const bumpBaseFee = normalizeFee(
    params?.bumpBaseFee || process.env.BUMP_BASE_FEE,
    DEFAULT_BUMP_BASE_FEE,
  );

  if (bumpBaseFee < innerBaseFee) {
    throw new Error(
      `Invalid recovery configuration: bumpBaseFee (${bumpBaseFee}) must be greater than or equal to innerBaseFee (${innerBaseFee})`,
    );
  }

  console.log('=== Transaction Fee Bump Recovery Workflow ===\n');
  console.log(`Configured original fee       : ${innerBaseFee} stroops/op`);
  console.log(`Configured replacement fee    : ${bumpBaseFee} stroops/op`);
  console.log();

  const source = Keypair.random();
  const feePayer = Keypair.random();
  const destination = Keypair.random();

  console.log('Generating and funding test accounts...');
  console.log(`  Transaction source : ${source.publicKey()}`);
  console.log(`  Fee payer         : ${feePayer.publicKey()}`);
  console.log(`  Destination        : ${destination.publicKey()}`);
  await Promise.all([
    fundAccount(source.publicKey()),
    fundAccount(feePayer.publicKey()),
    fundAccount(destination.publicKey()),
  ]);
  console.log('Accounts funded via Friendbot.');

  const sourceAccount = await server.loadAccount(source.publicKey());
  console.log();

  console.log('Step 1: Build and sign the original low-fee transaction...');
  const innerTransaction = new TransactionBuilder(sourceAccount, {
    fee: innerBaseFee.toString(),
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: destination.publicKey(),
        asset: Asset.native(),
        amount: '5',
      }),
    )
    .setTimeout(30)
    .build();

  innerTransaction.sign(source);
  const originalHash = innerTransaction.hash().toString('hex');
  console.log(`  Original transaction hash: ${originalHash}`);
  console.log(`  Original transaction fee : ${innerBaseFee} stroops/op`);
  console.log();

  console.log('Step 2: Submit the original transaction to Horizon...');
  let originalConfirmed = false;

  try {
    const response = await server.submitTransaction(innerTransaction);
    console.log('  Horizon accepted the original transaction.');
    console.log(`  Ledger: ${response.ledger}`);
    originalConfirmed = true;
  } catch (error) {
    const code = getHorizonTransactionErrorCode(error);
    console.log(`  Original submission failed with Horizon code: ${code ?? 'unknown'}`);

    if (code === 'tx_bad_fee' || code === 'tx_failed' || code === 'tx_bad_auth') {
      console.log('  This is a candidate for fee-bump recovery.');
    } else {
      console.log('  Checking whether the original transaction may still have been included...');
      originalConfirmed = await waitForTransactionConfirmation(
        server,
        originalHash,
        CONFIRMATION_CHECK_DELAY_MS,
      );
    }
  }

  if (originalConfirmed) {
    console.log('\nOriginal transaction is confirmed on ledger. No recovery needed.');
    console.log(
      'If you want to retry with a higher fee, create a new inner transaction and fee bump.',
    );
    return;
  }

  console.log('\nStep 3: Verify whether the original transaction is present in Horizon...');
  const alreadyConfirmed = await isTransactionConfirmed(server, originalHash);
  if (alreadyConfirmed) {
    console.log('  The original transaction was confirmed after all. No replacement needed.');
    return;
  }

  console.log('  Original transaction is not found in Horizon. Proceeding with fee-bump recovery.');

  const innerOps = innerTransaction.operations.length;
  const totalReplacementFee = bumpBaseFee * (innerOps + 1);
  console.log();
  console.log('Step 4: Build the fee-bump transaction using the original inner transaction...');
  console.log(`  Inner operation count : ${innerOps}`);
  console.log(`  Fee-bump base fee     : ${bumpBaseFee} stroops/op`);
  console.log(
    `  Total fee charged     : ${totalReplacementFee} stroops (${stroopsToXlm(totalReplacementFee)} XLM)`,
  );

  const feeBumpTransaction = TransactionBuilder.buildFeeBumpTransaction(
    feePayer.publicKey(),
    bumpBaseFee.toString(),
    innerTransaction,
    Networks.TESTNET,
  );

  feeBumpTransaction.sign(feePayer);
  console.log('  Fee-bump transaction signed by the fee payer.');

  console.log('\nStep 5: Submit the fee-bump replacement transaction...');
  const replacementResult = await server.submitTransaction(feeBumpTransaction);
  const replacementHash = replacementResult.hash;
  console.log(`  Replacement transaction hash: ${replacementHash}`);
  console.log(`  Fee source                 : ${feePayer.publicKey()}`);
  console.log();

  console.log('Step 6: Confirm the replacement transaction through Horizon...');
  const replacementRecord = await server.transactions().transaction(replacementHash).call();
  console.log('  Replacement transaction confirmed.');
  console.log(`  Fee charged (stroops): ${replacementRecord.fee_charged}`);
  console.log(`  Max fee (stroops)    : ${replacementRecord.max_fee}`);
  console.log(`  Fee account          : ${replacementRecord.fee_account}`);

  if (replacementRecord.inner_transaction) {
    console.log(`  Inner transaction hash : ${replacementRecord.inner_transaction.hash}`);
  }

  console.log();
  console.log('=== Recovery Summary ===');
  console.log(
    '  • Original transaction was built with a low fee and could not be confirmed immediately.',
  );
  console.log('  • The replacement fee-bump transaction preserved the signed inner transaction.');
  console.log(
    '  • A separate fee payer paid the higher fee without re-signing the inner transaction.',
  );
  console.log('  • Original and replacement hashes are shown for audit and tracing.');
}
