import {
  Account,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const FRIENDBOT_URL = 'https://friendbot.stellar.org';
const BASE_FEE = '100';

const FIRST_DATA_NAME = 'sequence-example-first';
const STALE_DATA_NAME = 'sequence-example-stale';
const SECOND_DATA_NAME = 'sequence-example-second';
const THIRD_DATA_NAME = 'sequence-example-third';

interface UnknownRecord {
  [key: string]: unknown;
}

/**
 * Checks whether an unknown value is a non-null object.
 */
function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

/**
 * Calculates the next Stellar sequence number without converting the value to
 * a JavaScript number.
 *
 * Stellar sequence numbers are 64-bit integers, so BigInt avoids precision
 * loss for values larger than Number.MAX_SAFE_INTEGER.
 */
export function nextSequenceNumber(sequence: string): string {
  try {
    return (BigInt(sequence) + 1n).toString();
  } catch {
    throw new Error(`Invalid Stellar sequence number: ${sequence}`);
  }
}

/**
 * Reads a Horizon transaction result code from an unknown error object.
 *
 * Depending on the SDK transport, Horizon response details are normally
 * available through error.response.data.extras.result_codes.transaction.
 */
export function getTransactionResultCode(error: unknown): string | null {
  if (!isRecord(error) || !isRecord(error.response)) {
    return null;
  }

  const response = error.response;
  const responseData = isRecord(response.data) ? response.data : response;

  if (!isRecord(responseData.extras) || !isRecord(responseData.extras.result_codes)) {
    return null;
  }

  const transactionCode = responseData.extras.result_codes.transaction;

  return typeof transactionCode === 'string' ? transactionCode : null;
}

/**
 * Returns a readable message for an unknown caught value.
 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Verifies that an account or transaction has the expected sequence number.
 */
export function verifySequenceNumber(label: string, actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label} sequence verification failed. ` + `Expected ${expected}, received ${actual}.`,
    );
  }
}

/**
 * Prints a sequence number in a consistent format.
 */
export function displaySequenceNumber(label: string, sequence: string): void {
  console.log(`${label}: ${sequence}`);
}

/**
 * Funds a temporary account through Stellar Testnet Friendbot.
 */
async function fundTestnetAccount(publicKey: string): Promise<void> {
  const response = await fetch(`${FRIENDBOT_URL}/?addr=${encodeURIComponent(publicKey)}`);

  if (!response.ok) {
    const responseBody = await response.text();

    throw new Error(
      `Friendbot could not fund account ${publicKey}. ` +
        `HTTP ${response.status}: ${responseBody}`,
    );
  }
}

/**
 * Builds and signs a manageData transaction.
 *
 * TransactionBuilder uses sourceAccount.sequenceNumber() as the account's
 * current on-ledger sequence, assigns current + 1 to the new transaction, and
 * then increments the supplied Account object.
 *
 * This means the same Account object can be used to prepare several ordered
 * transactions, but an abandoned transaction creates a gap unless the account
 * state is reloaded from Horizon.
 */
export function buildManageDataTransaction(
  sourceAccount: Account,
  signer: Keypair,
  name: string,
  value: string,
) {
  const transaction = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.manageData({
        name,
        value,
      }),
    )
    .setTimeout(30)
    .build();

  transaction.sign(signer);

  return transaction;
}

/**
 * Demonstrates how Stellar sequence numbers are retrieved, consumed, reused
 * incorrectly, refreshed, and managed for sequential transactions.
 */
export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const server = new Horizon.Server(horizonUrl);
  const accountKeypair = Keypair.random();
  const accountId = accountKeypair.publicKey();

  console.log('Starting Account Sequence Number Management Example...');
  console.log(`Using Horizon: ${horizonUrl}`);
  console.log(`Temporary Testnet account: ${accountId}`);

  console.log('\nSequence-number overview:');
  console.log('- Every Stellar transaction has a source-account sequence number.');
  console.log(
    '- Under the default rules, the transaction sequence must be exactly one greater than the account sequence.',
  );
  console.log(
    '- A successfully applied transaction updates the account to the transaction sequence.',
  );
  console.log('- Reusing a consumed sequence number normally produces tx_bad_seq.');
  console.log(
    '- Concurrent applications should coordinate transaction ordering or reload current account state before rebuilding.',
  );

  console.log('\nFunding the temporary account through Friendbot...');
  await fundTestnetAccount(accountId);

  const initialAccount = await server.loadAccount(accountId);
  const initialSequence = initialAccount.sequenceNumber();

  console.log('\n--- Initial Account State ---');
  displaySequenceNumber('Current account sequence from Horizon', initialSequence);

  /*
   * Two independent Account objects are created from the same Horizon sequence.
   * Both builders therefore create transactions with the same next sequence.
   *
   * The first transaction will consume that sequence. Submitting the second
   * afterward demonstrates why a previously consumed sequence cannot be reused.
   */
  const firstTransactionSource = new Account(accountId, initialSequence);

  const staleTransactionSource = new Account(accountId, initialSequence);

  const firstTransaction = buildManageDataTransaction(
    firstTransactionSource,
    accountKeypair,
    FIRST_DATA_NAME,
    'First sequence transaction',
  );

  const staleTransaction = buildManageDataTransaction(
    staleTransactionSource,
    accountKeypair,
    STALE_DATA_NAME,
    'This transaction intentionally reuses a sequence',
  );

  const expectedFirstSequence = nextSequenceNumber(initialSequence);

  verifySequenceNumber('First transaction', firstTransaction.sequence, expectedFirstSequence);

  verifySequenceNumber(
    'Intentionally stale transaction',
    staleTransaction.sequence,
    expectedFirstSequence,
  );

  console.log('\n--- First Transaction Construction ---');
  displaySequenceNumber('Account sequence used by the builder', initialSequence);
  displaySequenceNumber('First transaction sequence', firstTransaction.sequence);
  displaySequenceNumber('Duplicate transaction sequence', staleTransaction.sequence);

  console.log('\nSubmitting the first transaction...');

  const firstSubmission = await server.submitTransaction(firstTransaction);

  console.log(`First transaction hash: ${firstSubmission.hash}`);

  const accountAfterFirstSubmission = await server.loadAccount(accountId);

  const sequenceAfterFirstSubmission = accountAfterFirstSubmission.sequenceNumber();

  console.log('\n--- Account State After First Submission ---');
  displaySequenceNumber('Updated sequence returned by Horizon', sequenceAfterFirstSubmission);

  verifySequenceNumber(
    'Account after first transaction',
    sequenceAfterFirstSubmission,
    firstTransaction.sequence,
  );

  console.log('\nSubmitting the transaction that reuses the consumed sequence...');

  try {
    await server.submitTransaction(staleTransaction);

    throw new Error(
      'The reused transaction unexpectedly succeeded. A tx_bad_seq response was expected.',
    );
  } catch (error: unknown) {
    const resultCode = getTransactionResultCode(error);

    if (resultCode !== 'tx_bad_seq') {
      throw new Error(
        'Expected Horizon to reject the reused sequence with ' +
          `tx_bad_seq, but received ${resultCode ?? getErrorMessage(error)}.`,
      );
    }

    console.log('Reused transaction rejected as expected.');
    console.log(`Horizon transaction result code: ${resultCode}`);
    console.log('Reason: its sequence number was already consumed by the first transaction.');
  }

  const accountAfterRejectedTransaction = await server.loadAccount(accountId);

  const sequenceAfterRejectedTransaction = accountAfterRejectedTransaction.sequenceNumber();

  verifySequenceNumber(
    'Account after rejected transaction',
    sequenceAfterRejectedTransaction,
    sequenceAfterFirstSubmission,
  );

  console.log('The rejected transaction did not advance the account sequence number.');

  /*
   * Reloading provides a fresh account object with the latest on-ledger
   * sequence number.
   *
   * Building two transactions from the same fresh object prepares consecutive
   * values because TransactionBuilder increments that object after each build.
   */
  console.log('\nReloading the account before preparing sequential transactions...');

  const sequentialSourceAccount = await server.loadAccount(accountId);

  const sequenceBeforeSequentialPreparation = sequentialSourceAccount.sequenceNumber();

  const secondTransaction = buildManageDataTransaction(
    sequentialSourceAccount,
    accountKeypair,
    SECOND_DATA_NAME,
    'Second correctly ordered transaction',
  );

  const thirdTransaction = buildManageDataTransaction(
    sequentialSourceAccount,
    accountKeypair,
    THIRD_DATA_NAME,
    'Third correctly ordered transaction',
  );

  const expectedSecondSequence = nextSequenceNumber(sequenceBeforeSequentialPreparation);

  const expectedThirdSequence = nextSequenceNumber(expectedSecondSequence);

  verifySequenceNumber('Second transaction', secondTransaction.sequence, expectedSecondSequence);

  verifySequenceNumber('Third transaction', thirdTransaction.sequence, expectedThirdSequence);

  verifySequenceNumber(
    'In-memory source account after two builds',
    sequentialSourceAccount.sequenceNumber(),
    expectedThirdSequence,
  );

  console.log('\n--- Sequential Transaction Preparation ---');
  displaySequenceNumber('Fresh Horizon account sequence', sequenceBeforeSequentialPreparation);
  displaySequenceNumber('Second transaction sequence', secondTransaction.sequence);
  displaySequenceNumber('Third transaction sequence', thirdTransaction.sequence);
  displaySequenceNumber(
    'In-memory account sequence after both builds',
    sequentialSourceAccount.sequenceNumber(),
  );

  console.log('\nSubmitting the sequential transactions in sequence-number order...');

  const secondSubmission = await server.submitTransaction(secondTransaction);

  console.log(`Second transaction hash: ${secondSubmission.hash}`);

  const accountAfterSecondSubmission = await server.loadAccount(accountId);

  verifySequenceNumber(
    'Account after second transaction',
    accountAfterSecondSubmission.sequenceNumber(),
    secondTransaction.sequence,
  );

  displaySequenceNumber(
    'Sequence after second submission',
    accountAfterSecondSubmission.sequenceNumber(),
  );

  const thirdSubmission = await server.submitTransaction(thirdTransaction);

  console.log(`Third transaction hash: ${thirdSubmission.hash}`);

  const finalAccount = await server.loadAccount(accountId);
  const finalSequence = finalAccount.sequenceNumber();

  verifySequenceNumber('Final account', finalSequence, thirdTransaction.sequence);

  console.log('\n--- Final Account State ---');
  displaySequenceNumber('Final Horizon sequence', finalSequence);

  console.log('\nSequence-management lessons:');
  console.log('- Fetch the latest account state before beginning a new transaction series.');
  console.log(
    '- Transactions prepared from one account object receive consecutive sequence numbers.',
  );
  console.log('- Submit prebuilt transactions in the same order as their sequence numbers.');
  console.log(
    '- If a prepared transaction is abandoned, reload the account before building its replacement.',
  );
  console.log(
    '- Do not automatically retry a payment or other value-moving operation without confirming that repeating the operation is intended.',
  );

  console.log('\nAccount sequence number demonstration completed successfully.');
}
