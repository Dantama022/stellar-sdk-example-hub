/**
 * 141-sequence-number-management: Stellar Account Sequence Number Management
 *
 * OVERVIEW
 * --------
 * Every Stellar transaction must carry a sequence number that is exactly one
 * greater than the submitting account's current on-ledger sequence. The ledger
 * rejects any transaction whose sequence number does not meet this requirement.
 *
 * WHY SEQUENCE NUMBERS MATTER
 * ---------------------------
 *   • Replay prevention — each sequence number can only be used once. Once a
 *     transaction is applied, that exact number cannot be reused.
 *   • Ordering guarantee — transactions from the same account are applied
 *     strictly in sequence-number order. You cannot skip a number.
 *   • Concurrency risk — if two parts of an application independently build
 *     transactions from the same snapshot, they will produce conflicting
 *     sequence numbers. Only one will succeed; the other will receive
 *     tx_bad_seq.
 *
 * LOCAL SEQUENCE MANAGEMENT
 * -------------------------
 * For applications that prepare several pending transactions before submitting,
 * a LocalSequenceManager tracks allocations in memory:
 *
 *   1. Fetch the current on-ledger sequence once (or on explicit refresh).
 *   2. Allocate numbers locally by incrementing the in-memory counter.
 *   3. Submit allocated transactions in strict sequence-number order.
 *   4. If a transaction is abandoned or the application restarts, reload the
 *      account from Horizon to re-synchronise.
 *
 * STALE SEQUENCE DETECTION
 * ------------------------
 * A sequence is stale when the in-memory counter diverges from the on-ledger
 * state because another process submitted a transaction in the meantime.
 * The manager detects staleness by comparing its last-known Horizon sequence
 * with a fresh reload.
 *
 * DIFFERENCE FROM OPERATION BATCHING
 * ------------------------------------
 *   • Operation batching — multiple operations inside ONE transaction.
 *     They share a single sequence number and are atomic (all succeed or
 *     none apply).
 *   • Transaction batching — multiple INDEPENDENT transactions from the same
 *     source account, each with its own sequence number. They are NOT atomic.
 */

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

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface AllocatedSequence {
  index: number;
  sequence: string;
}

export interface SequenceStatus {
  onChainSequence: string;
  nextAvailableSequence: string;
  allocatedSequences: AllocatedSequence[];
  pendingCount: number;
  isStale: boolean;
}

export interface RunParams {
  accountId?: string;
  transactionCount?: number;
  json?: boolean;
}

// ──────────────────────────────────────────────────────────────────────────────
// Sequence helpers (exported for unit testing)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Returns the next Stellar sequence number using BigInt to avoid precision
 * loss for values larger than Number.MAX_SAFE_INTEGER.
 */
export function nextSequence(sequence: string): string {
  try {
    return (BigInt(sequence) + 1n).toString();
  } catch {
    throw new Error(`Invalid sequence number: ${sequence}`);
  }
}

/**
 * Returns true when two sequence strings represent the same value.
 */
export function sequencesEqual(a: string, b: string): boolean {
  return BigInt(a) === BigInt(b);
}

// ──────────────────────────────────────────────────────────────────────────────
// Local sequence manager
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Manages sequence-number allocation for a single source account without
 * requiring a Horizon round-trip for every new transaction.
 *
 * The manager holds an in-memory cursor that starts at the on-ledger sequence
 * retrieved during initialisation. Each call to `allocate()` advances the
 * cursor and returns the next available number.
 *
 * Call `refresh()` to reload the on-ledger state and detect staleness.
 */
export class LocalSequenceManager {
  private readonly accountId: string;
  private readonly server: Horizon.Server;

  /** Sequence number as reported by Horizon at last sync. */
  private lastKnownChainSequence: string;

  /** In-memory cursor: the last number we handed out. */
  private cursor: string;

  /** All sequences that have been allocated but not yet confirmed submitted. */
  private readonly allocated: AllocatedSequence[] = [];

  constructor(accountId: string, server: Horizon.Server, chainSequence: string) {
    this.accountId = accountId;
    this.server = server;
    this.lastKnownChainSequence = chainSequence;
    this.cursor = chainSequence;
  }

  /**
   * Allocates the next sequence number and returns it.
   * The returned sequence = cursor + 1, and the cursor advances.
   */
  allocate(): string {
    const seq = nextSequence(this.cursor);
    this.cursor = seq;
    this.allocated.push({ index: this.allocated.length, sequence: seq });
    return seq;
  }

  /**
   * Reloads the on-ledger sequence from Horizon and reports whether the
   * in-memory state is stale (i.e., another process submitted transactions
   * since we last synchronised).
   */
  async refresh(): Promise<boolean> {
    const freshAccount = await this.server.loadAccount(this.accountId);
    const freshSequence = freshAccount.sequenceNumber();
    const isStale = !sequencesEqual(freshSequence, this.lastKnownChainSequence);

    if (isStale) {
      // Re-anchor cursor to the fresh chain sequence so future allocations
      // start from the correct position.
      this.lastKnownChainSequence = freshSequence;
      this.cursor = freshSequence;
      this.allocated.length = 0; // previously allocated sequences are now invalid
    }

    return isStale;
  }

  /**
   * Returns a snapshot of the current sequence status.
   */
  status(): SequenceStatus {
    return {
      onChainSequence: this.lastKnownChainSequence,
      nextAvailableSequence: nextSequence(this.cursor),
      allocatedSequences: [...this.allocated],
      pendingCount: this.allocated.length,
      isStale: false, // only known after calling refresh()
    };
  }

  get chainSequence(): string {
    return this.lastKnownChainSequence;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Transaction helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Builds a manageData transaction with the given name/value using a pre-created
 * Account object that already carries the correct sequence number.
 *
 * Using a pre-built Account rather than reloading from Horizon lets the caller
 * control the exact sequence number assigned to each transaction.
 */
export function buildSequencedTransaction(
  sourceAccount: Account,
  signer: Keypair,
  dataName: string,
  dataValue: string,
) {
  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.manageData({ name: dataName, value: dataValue }))
    .setTimeout(30)
    .build();

  tx.sign(signer);
  return tx;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

async function fundAccount(publicKey: string): Promise<void> {
  const response = await fetch(
    `${FRIENDBOT_URL}/?addr=${encodeURIComponent(publicKey)}`,
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Friendbot could not fund ${publicKey}. HTTP ${response.status}: ${body}`,
    );
  }
}

function getResultCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const e = error as Record<string, unknown>;
  const resp = e['response'] as Record<string, unknown> | undefined;
  if (!resp) return null;
  const data = (resp['data'] ?? resp) as Record<string, unknown>;
  const extras = data['extras'] as Record<string, unknown> | undefined;
  const codes = extras?.['result_codes'] as Record<string, unknown> | undefined;
  const tx = codes?.['transaction'];
  return typeof tx === 'string' ? tx : null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Demonstrates Stellar sequence number management:
 *   1. Retrieve the on-ledger sequence number.
 *   2. Allocate multiple pending sequences locally.
 *   3. Detect and handle a stale sequence (tx_bad_seq).
 *   4. Refresh from Horizon and rebuild correctly.
 *   5. Submit sequential transactions in order.
 */
export async function run(params: RunParams = {}): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL ?? DEFAULT_HORIZON_URL;
  const outputJson =
    params.json === true ||
    process.env.OUTPUT_JSON === 'true' ||
    process.argv.includes('--json');

  const txCount = params.transactionCount ?? 3;
  const server = new Horizon.Server(horizonUrl);

  const keypair = Keypair.random();
  const accountId = keypair.publicKey();

  console.log('Starting Sequence Number Management Example...');
  console.log(`Using Horizon: ${horizonUrl}`);
  console.log(`Temporary account: ${accountId}`);

  console.log('\n── Sequence Number Concepts ──────────────────────────────');
  console.log('  • Every transaction must carry a sequence = accountSequence + 1.');
  console.log('  • Each successfully applied transaction increments the account sequence.');
  console.log('  • Reusing a consumed sequence → tx_bad_seq rejection.');
  console.log('  • Two builders starting from the same snapshot produce conflicting sequences.');
  console.log('  • Always submit pre-built transactions in sequence-number order.');

  // ── Fund and load ─────────────────────────────────────────────────────────
  console.log('\nFunding temporary account via Friendbot...');
  await fundAccount(accountId);

  const initialAccount = await server.loadAccount(accountId);
  const initialSequence = initialAccount.sequenceNumber();

  console.log(`\nOn-ledger sequence after funding: ${initialSequence}`);
  console.log(`Next available sequence:          ${nextSequence(initialSequence)}`);

  // ── Local sequence manager ────────────────────────────────────────────────
  const manager = new LocalSequenceManager(accountId, server, initialSequence);

  const allocations: AllocatedSequence[] = [];
  for (let i = 0; i < txCount; i++) {
    const seq = manager.allocate();
    allocations.push({ index: i, sequence: seq });
  }

  console.log(`\n── Locally Allocated Sequences (${txCount} transactions) ─`);
  allocations.forEach(({ index, sequence }) => {
    console.log(`  Transaction #${index + 1}: sequence ${sequence}`);
  });

  // Detect duplicates (invariant check)
  const seqSet = new Set(allocations.map((a) => a.sequence));
  if (seqSet.size !== allocations.length) {
    throw new Error('Duplicate sequence numbers detected — this is a bug in the local manager.');
  }
  console.log('  ✓ All allocated sequence numbers are unique.');

  // ── Demonstrate stale-sequence detection ─────────────────────────────────
  console.log('\n── Stale Sequence Detection ──────────────────────────────');

  // Build a transaction from a stale snapshot (same starting sequence as the manager)
  const staleSource = new Account(accountId, initialSequence);
  const staleTransaction = buildSequencedTransaction(
    staleSource,
    keypair,
    'seq-stale-test',
    'intentional stale sequence',
  );

  console.log(`Stale transaction sequence: ${staleTransaction.sequence}`);

  // Build and submit the first legitimate transaction to consume that sequence
  const firstSource = new Account(accountId, initialSequence);
  const firstTx = buildSequencedTransaction(
    firstSource,
    keypair,
    'seq-example-1',
    'first transaction',
  );

  console.log(`\nSubmitting transaction #1 (sequence ${firstTx.sequence})...`);
  const firstResult = await server.submitTransaction(firstTx);
  console.log(`Transaction #1 accepted — hash: ${firstResult.hash}`);

  // Now submit the stale transaction, which reuses the already-consumed sequence
  console.log(
    `\nAttempting stale transaction (sequence ${staleTransaction.sequence}) — expected rejection...`,
  );
  try {
    await server.submitTransaction(staleTransaction);
    throw new Error('Expected tx_bad_seq but the submission succeeded — unexpected.');
  } catch (err: unknown) {
    const code = getResultCode(err);
    if (code === 'tx_bad_seq') {
      console.log(`Stale transaction rejected as expected. Result code: ${code}`);
      console.log('Reason: its sequence number was already consumed by transaction #1.');
    } else {
      // Re-throw unexpected errors so they surface clearly
      throw err;
    }
  }

  // ── Refresh the manager after external activity ───────────────────────────
  console.log('\n── Refreshing Sequence State from Horizon ─────────────────');
  const wasStale = await manager.refresh();
  console.log(`Stale-sequence detected on refresh: ${wasStale}`);

  const freshStatus = manager.status();
  console.log(`Refreshed on-chain sequence:        ${freshStatus.onChainSequence}`);
  console.log(`Next available sequence:             ${freshStatus.nextAvailableSequence}`);

  // ── Submit remaining transactions in order ────────────────────────────────
  const remainingCount = txCount - 1;
  console.log(`\n── Submitting Remaining ${remainingCount} Transactions in Order ──`);

  // Build all transactions from a fresh Account object (ensures contiguous sequences)
  const freshAccount = await server.loadAccount(accountId);
  const freshSource = new Account(accountId, freshAccount.sequenceNumber());

  const pendingTransactions = [];
  for (let i = 0; i < remainingCount; i++) {
    const tx = buildSequencedTransaction(
      freshSource,
      keypair,
      `seq-example-${i + 2}`,
      `transaction ${i + 2} of ${txCount}`,
    );
    pendingTransactions.push(tx);
    console.log(`  Prepared transaction #${i + 2}: sequence ${tx.sequence}`);
  }

  // Verify sequences are consecutive
  for (let i = 1; i < pendingTransactions.length; i++) {
    const prev = pendingTransactions[i - 1].sequence;
    const curr = pendingTransactions[i].sequence;
    if (!sequencesEqual(nextSequence(prev), curr)) {
      throw new Error(
        `Sequence gap detected between transaction ${i + 1} (${prev}) and ${i + 2} (${curr}).`,
      );
    }
  }
  console.log('  ✓ All pending transactions have consecutive, conflict-free sequence numbers.');

  const submittedHashes: string[] = [];
  for (let i = 0; i < pendingTransactions.length; i++) {
    const tx = pendingTransactions[i];
    const result = await server.submitTransaction(tx);
    submittedHashes.push(result.hash);
    console.log(`  Transaction #${i + 2} accepted — hash: ${result.hash}`);
  }

  // ── Final status ──────────────────────────────────────────────────────────
  const finalAccount = await server.loadAccount(accountId);
  const finalSequence = finalAccount.sequenceNumber();

  const statusSnapshot: SequenceStatus = {
    onChainSequence: finalSequence,
    nextAvailableSequence: nextSequence(finalSequence),
    allocatedSequences: [],
    pendingCount: 0,
    isStale: false,
  };

  if (outputJson) {
    console.log('\nJSON Output:');
    console.log(
      JSON.stringify(
        {
          accountId,
          initialSequence,
          staleDetected: true,
          submittedTransactions: [firstResult.hash, ...submittedHashes],
          finalStatus: statusSnapshot,
        },
        null,
        2,
      ),
    );
  } else {
    console.log('\n── Final Account State ───────────────────────────────────');
    console.log(`  On-chain sequence:     ${statusSnapshot.onChainSequence}`);
    console.log(`  Next available:        ${statusSnapshot.nextAvailableSequence}`);
    console.log(`  Transactions submitted: ${1 + submittedHashes.length}`);
  }

  console.log('\n── Key Takeaways ─────────────────────────────────────────');
  console.log('  • Fetch the latest account state before beginning a new transaction series.');
  console.log('  • Use a single Account object for all transactions in one batch; the builder');
  console.log('    increments the in-memory cursor after each build.');
  console.log('  • Submit pre-built transactions strictly in sequence-number order.');
  console.log('  • Abandon a built transaction only after reloading the account from Horizon;');
  console.log('    otherwise the skipped sequence will block all subsequent submissions.');
  console.log('  • Never retry a value-moving transaction without confirming the original failed.');

  console.log('\nSequence number management example completed successfully.');
}
