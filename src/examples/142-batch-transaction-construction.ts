/**
 * 142-batch-transaction-construction: Stellar Batch Transaction Construction
 *
 * OVERVIEW
 * --------
 * Applications often need to prepare several independent Stellar transactions
 * from the same source account — for example, a payment batch, a scheduled
 * series of operations, or a queue of transactions to be signed offline.
 *
 * Because each transaction from the same account consumes a unique, sequential
 * sequence number, the batch must be constructed carefully:
 *
 *   1. Fetch the current on-ledger sequence once.
 *   2. Wrap it in an Account object.
 *   3. Pass that same Account object to each TransactionBuilder call.
 *      The builder increments the in-memory counter after every build, so
 *      consecutive calls automatically produce consecutive sequence numbers.
 *   4. Store the built (and signed) transactions.
 *   5. Submit them in strict sequence-number order.
 *
 * OPERATION BATCHING vs TRANSACTION BATCHING
 * ------------------------------------------
 *   • Operation batching  — multiple operations inside ONE transaction.
 *     They are atomic: all succeed together or none are applied.
 *     The batch shares a single sequence number.
 *
 *   • Transaction batching — multiple INDEPENDENT transactions, each with its
 *     own sequence number. They are NOT atomic. A later transaction can still
 *     succeed even if an earlier one fails (as long as the sequence is intact),
 *     but a gap in submitted sequences blocks everything that comes after it.
 *
 * DRY-RUN MODE
 * ------------
 * When dry-run is enabled, every transaction is built and inspected but none
 * is submitted to the network. Use this to validate the batch before committing.
 *
 * SEQUENCE CONFLICT DETECTION
 * ----------------------------
 * Before submission, the example verifies that:
 *   • Every transaction in the batch has a unique sequence number.
 *   • Sequence numbers are contiguous (no gaps).
 *   • The first sequence equals the account's current on-ledger sequence + 1.
 */

import {
  Account,
  Asset,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  Transaction,
} from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const FRIENDBOT_URL = 'https://friendbot.stellar.org';
const BASE_FEE = '100';
const DEFAULT_BATCH_SIZE = 3;

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface BatchTransactionSummary {
  index: number;
  sequenceNumber: string;
  operationCount: number;
  fee: string;
  hash: string;
  envelopeXdr: string;
}

export interface BatchReport {
  accountId: string;
  baseSequence: string;
  batchSize: number;
  transactions: BatchTransactionSummary[];
  sequencesValid: boolean;
  dryRun: boolean;
  submittedHashes: string[];
}

export interface RunParams {
  accountId?: string;
  batchSize?: number;
  dryRun?: boolean;
  json?: boolean;
}

// ──────────────────────────────────────────────────────────────────────────────
// Sequence helpers (exported for unit testing)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Returns the next Stellar sequence number using BigInt to avoid precision
 * loss on values larger than Number.MAX_SAFE_INTEGER.
 */
export function nextSeq(sequence: string): string {
  return (BigInt(sequence) + 1n).toString();
}

/**
 * Validates that the supplied transactions form a contiguous, gap-free
 * sequence starting from baseSequence + 1.
 *
 * Returns null on success, or an error description on failure.
 */
export function validateBatchSequences(
  baseSequence: string,
  transactions: Transaction[],
): string | null {
  if (transactions.length === 0) return null;

  const seqSet = new Set<string>();

  let expected = nextSeq(baseSequence);

  for (let i = 0; i < transactions.length; i++) {
    const actual = transactions[i].sequence;

    if (seqSet.has(actual)) {
      return `Duplicate sequence number ${actual} found at index ${i}.`;
    }

    if (actual !== expected) {
      return (
        `Sequence gap at index ${i}: expected ${expected}, found ${actual}. ` +
        'Ensure all transactions were built from the same Account object in order.'
      );
    }

    seqSet.add(actual);
    expected = nextSeq(actual);
  }

  return null; // valid
}

// ──────────────────────────────────────────────────────────────────────────────
// Transaction construction helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Builds one transaction in the batch.
 *
 * The operation type varies by index to illustrate that independent transactions
 * in a batch can perform different work:
 *   - even indices: manageData (store a metadata key-value pair)
 *   - odd indices:  a self-payment of 0.0000001 XLM (the smallest amount)
 *
 * In a real application every transaction would contain the business operation
 * it needs; the variety here is purely for demonstration.
 */
function buildBatchTransaction(
  sourceAccount: Account,
  signer: Keypair,
  index: number,
): Transaction {
  const builder = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  });

  if (index % 2 === 0) {
    builder.addOperation(
      Operation.manageData({
        name: `batch-entry-${index}`,
        value: `Batch transaction ${index} value`,
      }),
    );
  } else {
    // Minimal self-payment to demonstrate a payment operation in the batch
    builder.addOperation(
      Operation.payment({
        destination: signer.publicKey(),
        asset: Asset.native(),
        amount: '0.0000001',
      }),
    );
  }

  const tx = builder.setTimeout(30).build();
  tx.sign(signer);
  return tx;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

async function fundAccount(publicKey: string): Promise<void> {
  const response = await fetch(`${FRIENDBOT_URL}/?addr=${encodeURIComponent(publicKey)}`);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Friendbot funding failed for ${publicKey}. HTTP ${response.status}: ${body}`);
  }
}

function summariseTransaction(tx: Transaction, index: number): BatchTransactionSummary {
  const envelope = tx.toEnvelope().toXDR('base64');
  return {
    index,
    sequenceNumber: tx.sequence,
    operationCount: tx.operations.length,
    fee: tx.fee,
    hash: tx.hash().toString('hex'),
    envelopeXdr: envelope,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Constructs and (optionally) submits a batch of independent transactions from
 * the same source account, demonstrating correct sequential sequence management.
 */
export async function run(params: RunParams = {}): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL ?? DEFAULT_HORIZON_URL;
  const dryRun =
    params.dryRun === true || process.env.DRY_RUN === 'true' || process.argv.includes('--dry-run');
  const outputJson =
    params.json === true || process.env.OUTPUT_JSON === 'true' || process.argv.includes('--json');
  const batchSize =
    params.batchSize ??
    (process.env.BATCH_SIZE ? parseInt(process.env.BATCH_SIZE, 10) : undefined) ??
    DEFAULT_BATCH_SIZE;

  const server = new Horizon.Server(horizonUrl);

  console.log('Starting Batch Transaction Construction Example...');
  console.log(`Using Horizon: ${horizonUrl}`);
  console.log(`Batch size:    ${batchSize} transactions`);
  console.log(`Dry-run mode:  ${dryRun}`);

  // ── Fund a fresh account ──────────────────────────────────────────────────
  const keypair = Keypair.random();
  const accountId = keypair.publicKey();
  console.log(`\nTemporary account: ${accountId}`);
  console.log('Funding via Friendbot...');
  await fundAccount(accountId);

  // ── Load initial account state ────────────────────────────────────────────
  const horizonAccount = await server.loadAccount(accountId);
  const baseSequence = horizonAccount.sequenceNumber();
  console.log(`On-ledger sequence: ${baseSequence}`);

  // ── Construct the batch ───────────────────────────────────────────────────
  console.log(`\n── Constructing ${batchSize} Transactions ─────────────────────`);

  // Use ONE Account object for the entire batch so TransactionBuilder
  // auto-increments the sequence for each successive transaction.
  const sourceAccount = new Account(accountId, baseSequence);
  const transactions: Transaction[] = [];

  for (let i = 0; i < batchSize; i++) {
    const tx = buildBatchTransaction(sourceAccount, keypair, i);
    transactions.push(tx);

    const summary = summariseTransaction(tx, i);
    console.log(`  Transaction #${i + 1}:`);
    console.log(`    Sequence:   ${summary.sequenceNumber}`);
    console.log(`    Operations: ${summary.operationCount}`);
    console.log(`    Fee:        ${summary.fee} stroops`);
    console.log(`    Hash:       ${summary.hash}`);
  }

  // ── Validate sequences ────────────────────────────────────────────────────
  console.log('\n── Sequence Validation ────────────────────────────────────');
  const validationError = validateBatchSequences(baseSequence, transactions);

  if (validationError) {
    throw new Error(`Batch sequence validation failed: ${validationError}`);
  }

  console.log('  ✓ All sequence numbers are unique and contiguous.');
  console.log(
    `  ✓ Sequence range: ${transactions[0].sequence} → ${transactions[transactions.length - 1].sequence}`,
  );

  // ── Explain the distinction ───────────────────────────────────────────────
  console.log('\n── Operation Batching vs Transaction Batching ─────────────');
  console.log('  Operation batching:');
  console.log('    • Multiple operations in ONE transaction envelope.');
  console.log('    • Atomic — all succeed or none are applied.');
  console.log('    • Uses a single sequence number.');
  console.log('    • Best for tightly coupled actions (e.g., create + fund + trustline).');
  console.log('  Transaction batching:');
  console.log('    • Multiple independent transactions from the same account.');
  console.log('    • NOT atomic — each transaction succeeds or fails independently.');
  console.log('    • Each transaction has its own sequence number.');
  console.log('    • A gap in submitted sequences blocks all later transactions.');
  console.log('    • Best for scheduled, sequential, or offline-signed work queues.');

  // ── Dry-run / submit ──────────────────────────────────────────────────────
  const submittedHashes: string[] = [];

  if (dryRun) {
    console.log('\n── Dry-Run Mode (no transactions submitted) ───────────────');
    transactions.forEach((tx, i) => {
      console.log(`  Transaction #${i + 1}: sequence ${tx.sequence} — ready to submit.`);
    });
  } else {
    console.log(`\n── Submitting ${batchSize} Transactions in Order ──────────────`);
    for (let i = 0; i < transactions.length; i++) {
      const tx = transactions[i];
      try {
        const result = await server.submitTransaction(tx);
        submittedHashes.push(result.hash);
        console.log(
          `  Transaction #${i + 1} (sequence ${tx.sequence}) accepted — hash: ${result.hash}`,
        );
      } catch (err: any) {
        const code = err?.response?.data?.extras?.result_codes?.transaction ?? 'unknown';
        // A failed transaction does not advance the sequence counter, so a gap
        // would block all subsequent transactions in this batch.
        throw new Error(
          `Transaction #${i + 1} (sequence ${tx.sequence}) failed with ${code}. ` +
            'Remaining batch transactions cannot be submitted until this gap is resolved.',
        );
      }
    }
    console.log(`\n  ✓ All ${batchSize} transactions submitted successfully.`);
  }

  // ── Build report ──────────────────────────────────────────────────────────
  const report: BatchReport = {
    accountId,
    baseSequence,
    batchSize,
    transactions: transactions.map((tx, i) => summariseTransaction(tx, i)),
    sequencesValid: validationError === null,
    dryRun,
    submittedHashes,
  };

  if (outputJson) {
    console.log('\nJSON Output:');
    console.log(JSON.stringify(report, null, 2));
  }

  console.log('\nBatch transaction construction example completed successfully.');
}
