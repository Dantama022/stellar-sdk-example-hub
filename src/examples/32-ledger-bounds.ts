/**
 * 32-ledger-bounds: Transaction Ledger Bounds
 *
 * OVERVIEW
 * --------
 * Stellar transactions support a "ledger bounds" precondition that restricts
 * the ledger sequence range in which a transaction may be accepted. The
 * network validates that the current ledger sequence falls within
 * [minLedger, maxLedger] before processing the transaction.
 *
 *   minLedger  – The first ledger sequence at which the transaction is valid.
 *                Set to 0 (or omit) to mean "from now".
 *   maxLedger  – The last ledger sequence at which the transaction is valid.
 *                Set to 0 to mean "never expires" (use with caution).
 *
 * HOW LEDGER BOUNDS DIFFER FROM TIMEBOUNDS
 * -----------------------------------------
 * Both preconditions limit the lifetime of a transaction, but they use
 * different units:
 *
 *   • Timebounds  – Unix timestamps (seconds). Subject to clock skew between
 *                   the client and individual validators.
 *   • Ledger bounds – Ledger sequence numbers. Fully deterministic: every
 *                   validator agrees on what the current ledger number is.
 *
 * Ledger bounds are therefore preferred when an application needs a
 * predictable, exact validity window without relying on wall-clock time.
 * Because Stellar Testnet produces roughly one ledger every ~5 seconds,
 * a window of 20 ledgers is approximately 100 seconds.
 *
 * REJECTION BEHAVIOUR
 * -------------------
 * If the transaction is submitted outside its ledger window the network
 * returns result code `txBAD_SEQ` or `txTOO_EARLY` / `txTOO_LATE` depending
 * on which boundary is crossed. This example demonstrates both cases:
 *
 *   1. A "future-only" transaction whose minLedger is far ahead is submitted
 *      immediately and rejected with txTOO_EARLY.
 *   2. A "valid-window" transaction whose window covers the current ledger is
 *      submitted and succeeds.
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
const BASE_FEE = '100';

/**
 * Funds a new account via Friendbot and throws if the request fails.
 */
async function fundAccount(publicKey: string): Promise<void> {
  const response = await fetch(`${FRIENDBOT_URL}/?addr=${encodeURIComponent(publicKey)}`);
  if (!response.ok) {
    throw new Error(`Friendbot funding failed for ${publicKey}: ${response.statusText}`);
  }
}

/**
 * Extracts a human-readable Horizon result code from an unknown error.
 */
function extractResultCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const err = error as Record<string, unknown>;
    const response = err['response'] as Record<string, unknown> | undefined;
    if (response) {
      const data = response['data'] as Record<string, unknown> | undefined;
      const extras = data?.['extras'] as Record<string, unknown> | undefined;
      const resultCodes = extras?.['result_codes'] as Record<string, unknown> | undefined;
      if (resultCodes?.['transaction']) {
        return String(resultCodes['transaction']);
      }
    }
    if (typeof err['message'] === 'string') {
      return err['message'];
    }
  }
  return String(error);
}

/**
 * Fetches the most recently closed ledger sequence number from Horizon.
 */
async function getCurrentLedger(server: Horizon.Server): Promise<number> {
  const ledgerPage = await server.ledgers().order('desc').limit(1).call();
  const record = ledgerPage.records[0];
  return record.sequence;
}

/**
 * Inspects and logs the ledger bounds encoded inside a transaction envelope.
 *
 * The stellar-base Transaction class stores ledger bounds in the private
 * `_ledgerBounds` field, which is set to null when no bounds are configured.
 */
function printTransactionLedgerBounds(tx: ReturnType<TransactionBuilder['build']>): void {
  // Access the private field via a type cast; this is safe for inspection only.
  const lb = (tx as unknown as { _ledgerBounds: { minLedger: number; maxLedger: number } | null })
    ._ledgerBounds;

  if (lb) {
    console.log(
      `  Encoded minLedger : ${lb.minLedger === 0 ? '0 (no lower bound)' : lb.minLedger}`,
    );
    console.log(
      `  Encoded maxLedger : ${lb.maxLedger === 0 ? '0 (no upper limit)' : lb.maxLedger}`,
    );
  } else {
    console.log('  (no ledger bounds encoded)');
  }
}

export async function run(): Promise<void> {
  const server = new Horizon.Server(HORIZON_URL);

  console.log('=== Ledger Bounds Example ===\n');

  // -----------------------------------------------------------------------
  // Step 1 – Create and fund accounts
  // -----------------------------------------------------------------------
  console.log('Step 1: Generating and funding accounts...');

  const source = Keypair.random();
  const destination = Keypair.random();

  console.log(`  Source account      : ${source.publicKey()}`);
  console.log(`  Destination account : ${destination.publicKey()}`);

  await Promise.all([fundAccount(source.publicKey()), fundAccount(destination.publicKey())]);
  console.log('  Both accounts funded via Friendbot.\n');

  // -----------------------------------------------------------------------
  // Step 2 – Query the current ledger sequence
  // -----------------------------------------------------------------------
  console.log('Step 2: Querying current ledger sequence from Horizon...');

  const currentLedger = await getCurrentLedger(server);
  console.log(`  Current ledger sequence : ${currentLedger}\n`);

  // -----------------------------------------------------------------------
  // Step 3 – Demonstrate: rejected transaction (minLedger in the future)
  //
  // Build a transaction that is only valid starting 500 ledgers from now.
  // Submitting it immediately must be rejected by the network.
  // -----------------------------------------------------------------------
  console.log('Step 3: Building a transaction with minLedger far in the future...');
  console.log('  (This transaction should be rejected as txTOO_EARLY.)\n');

  // minLedger is 500 ledgers ahead — well outside the current ledger
  const futureMinLedger = currentLedger + 500;
  const futureMaxLedger = currentLedger + 1000;

  console.log(`  Ledger validity range : [${futureMinLedger}, ${futureMaxLedger}]`);
  console.log(`  Current ledger        : ${currentLedger}  (before the window)\n`);

  const sourceAccount = await server.loadAccount(source.publicKey());

  const futureTx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: destination.publicKey(),
        asset: Asset.native(),
        amount: '1',
      }),
    )
    // setTimeout(0) disables the time-based validity check so the only
    // active precondition is the ledger bounds we set below.
    .setTimeout(0)
    .setLedgerbounds(futureMinLedger, futureMaxLedger)
    .build();

  futureTx.sign(source);

  console.log('  Transaction envelope ledger bounds:');
  printTransactionLedgerBounds(futureTx);
  console.log();

  try {
    await server.submitTransaction(futureTx);
    // The network should reject this; reaching here would be unexpected.
    console.log('  WARNING: Expected a rejection but the transaction was accepted.');
  } catch (error: unknown) {
    const code = extractResultCode(error);
    console.log(`  Submission correctly rejected. Result code: ${code}`);
    console.log(
      '  Explanation: The network refuses the transaction because the current\n' +
        `  ledger (${currentLedger}) is less than minLedger (${futureMinLedger}).\n`,
    );
  }

  // -----------------------------------------------------------------------
  // Step 4 – Demonstrate: accepted transaction within ledger bounds
  //
  // Build a transaction with a window that comfortably spans the current
  // ledger. minLedger is set to 0 (no lower bound) and maxLedger is set to
  // current + 100, giving a ~8-minute window at ~5 s/ledger.
  // -----------------------------------------------------------------------
  console.log('Step 4: Building a transaction valid within the current ledger window...');

  // Reload the account to get the updated sequence number
  const freshSourceAccount = await server.loadAccount(source.publicKey());

  // Window: from ledger 0 (open lower bound) to current + 100
  const validMinLedger = 0; // 0 means no minimum restriction
  const validMaxLedger = currentLedger + 100;

  console.log(`  Ledger validity range : [${validMinLedger} (open), ${validMaxLedger}]`);
  console.log(`  Current ledger        : ${currentLedger}  (inside the window)\n`);

  const validTx = new TransactionBuilder(freshSourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: destination.publicKey(),
        asset: Asset.native(),
        amount: '1',
      }),
    )
    .setTimeout(0)
    .setLedgerbounds(validMinLedger, validMaxLedger)
    .build();

  validTx.sign(source);

  console.log('  Transaction envelope ledger bounds:');
  printTransactionLedgerBounds(validTx);
  console.log();

  const result = await server.submitTransaction(validTx);
  console.log('  Transaction submitted successfully!');
  console.log(`  Transaction hash     : ${result.hash}`);
  console.log(`  Closed in ledger     : ${result.ledger}`);
  console.log(`  Ledger bounds window : [${validMinLedger} (open), ${validMaxLedger}]`);
  console.log(`  Accepted because ledger ${result.ledger} is within the valid range.\n`);

  // -----------------------------------------------------------------------
  // Step 5 – Demonstrate: building a 32-ledger window (the task title)
  //
  // A compact 32-ledger window anchored to the current ledger, illustrating
  // the deterministic, ledger-count-based approach.
  // -----------------------------------------------------------------------
  console.log('Step 5: Building a transaction with a 32-ledger validity window...');

  const thirdAccount = await server.loadAccount(source.publicKey());

  const windowMin = currentLedger;
  const windowMax = currentLedger + 32;

  console.log(`  Window start (minLedger) : ${windowMin}  (current ledger)`);
  console.log(`  Window end   (maxLedger) : ${windowMax}  (current + 32)`);
  console.log(`  Approximate wall-clock duration: ~${32 * 5} seconds at 5 s/ledger\n`);

  const windowTx = new TransactionBuilder(thirdAccount, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: destination.publicKey(),
        asset: Asset.native(),
        amount: '1',
      }),
    )
    .setTimeout(0)
    .setLedgerbounds(windowMin, windowMax)
    .build();

  windowTx.sign(source);

  console.log('  Transaction envelope ledger bounds:');
  printTransactionLedgerBounds(windowTx);
  console.log();

  const windowResult = await server.submitTransaction(windowTx);
  console.log('  32-ledger-window transaction submitted successfully!');
  console.log(`  Transaction hash : ${windowResult.hash}`);
  console.log(`  Closed in ledger : ${windowResult.ledger}`);
  console.log(
    `  The transaction was accepted at ledger ${windowResult.ledger}, within [${windowMin}, ${windowMax}].\n`,
  );

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  console.log('=== Summary ===');
  console.log('');
  console.log('Ledger bounds are a Stellar transaction precondition that restricts');
  console.log('which ledger sequences may include the transaction.');
  console.log('');
  console.log('  setLedgerbounds(minLedger, maxLedger)');
  console.log('    minLedger = 0  → no lower bound (valid from genesis)');
  console.log('    maxLedger = 0  → no upper bound (never expires — use carefully)');
  console.log('');
  console.log('Key differences vs. timebounds:');
  console.log('  • Ledger bounds are fully deterministic (no clock skew risk).');
  console.log('  • Each ledger is ~5 s on Testnet and ~5 s on Mainnet.');
  console.log('  • Useful when you need an exact, agreed-upon validity window.');
  console.log('');
  console.log('Rejection result codes:');
  console.log('  txTOO_EARLY  – current ledger < minLedger');
  console.log('  txTOO_LATE   – current ledger > maxLedger');
}
