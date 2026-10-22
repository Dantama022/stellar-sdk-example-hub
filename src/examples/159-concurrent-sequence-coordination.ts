/**
 * 159-concurrent-sequence-coordination: Coordinating Transaction Sequence Numbers
 * for Concurrent Asynchronous Tasks
 *
 * OVERVIEW
 * --------
 * Stellar transactions use account sequence numbers to enforce strict ordering.
 * Applications that build transactions concurrently face a critical challenge:
 *
 *   • If multiple tasks independently fetch the same account state, they all see
 *     the same sequence number.
 *   • When each task constructs a transaction using that sequence, sequence conflicts
 *     arise: only one transaction succeeds; others receive tx_bad_seq.
 *   • Network failures or temporary unavailability can make it impossible to distinguish
 *     between "the transaction was not accepted" and "the transaction was accepted
 *     but we didn't receive the confirmation".
 *
 * COORDINATION STRATEGY
 * --------------------
 * This example demonstrates a safe application-level strategy:
 *
 *   1. Load the account's current sequence once, before any concurrent work.
 *   2. Create a shared SequenceCoordinator that tracks allocated sequences in memory.
 *   3. Each concurrent task calls allocateNextSequence() to get a unique sequence number.
 *      The coordinator increments an in-memory counter, guaranteeing uniqueness.
 *   4. Tasks construct and prepare (but do not sign) their transactions with allocated numbers.
 *   5. Tasks submit transactions sequentially, in strict ascending sequence order.
 *   6. For each submission result:
 *      • Success → record the hash and sequence.
 *      • Temporary network error → retry with bounded backoff.
 *      • Sequence conflict (tx_bad_seq) → detect and diagnose the cause.
 *      • Terminal error → abandon the transaction and continue.
 *   7. After all submissions, verify that sequences have no gaps.
 *   8. If a gap is detected, it indicates an unrecovered sequence conflict; log it.
 *
 * MOCK SUBMISSION vs REAL NETWORK
 * ------
 * This example uses mocked submission responses (MockHorizonServer) and does not
 * submit real transactions. Replace MockHorizonServer with a real Horizon instance
 * to test against a live network.
 *
 * WHY MOCKING IS IMPORTANT
 * ------
 * Mocking allows us to simulate:
 *   • Network transients (timeout, 503).
 *   • Sequence conflicts (tx_bad_seq).
 *   • Duplicate submissions (hash already known).
 *   • Concurrent task scheduling edge cases.
 *
 * WITHOUT MOCKING
 * ------
 * This example would require:
 *   • A funded Stellar account and secret key (security risk for automated tests).
 *   • A live Horizon instance (potentially slow, network-dependent).
 *   • Real transaction fees (resource consumption).
 * Testing coordination logic against a real network is best done in a controlled
 * integration-test environment, not in a runnable example.
 *
 * SEQUENCE ALLOCATION vs SUBMISSION ORDERING
 * ------
 * Allocation and submission are separate concerns:
 *   • Allocation: Tasks call allocateNextSequence() concurrently.
 *     Each gets a unique sequence; all allocations are in-memory, instant.
 *   • Submission: Transactions are submitted sequentially, in ascending sequence order.
 *     This ensures the network accepts each transaction without tx_bad_seq conflicts.
 *
 * HANDLING SEQUENCE CONFLICTS
 * ------
 * If a transaction returns tx_bad_seq:
 *   • Check if the transaction was already accepted on-chain (by querying Horizon).
 *   • If yes, treat it as success (the previous result was lost due to network).
 *   • If no, the sequence number is truly in conflict; log it as an unrecoverable error.
 *
 * RECOVERY FROM NETWORK FAILURES
 * ------
 * Network failures (timeouts, 5xx) should trigger retries with bounded backoff.
 * After exhausting retries, treat the failure as terminal and continue to the next
 * transaction. Later, a reconciliation process should check Horizon for each
 * transaction hash to verify on-chain status.
 */

import {
  Account,
  Horizon,
  TransactionBuilder,
  Networks,
  Operation,
  Transaction,
  FeeBumpTransaction,
} from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const BASE_FEE = '100';
const DEFAULT_CONCURRENT_TASKS = 5;
const SUBMIT_RETRY_MAX = 3;
const SUBMIT_RETRY_DELAY_MS = 500;

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface SequenceAllocation {
  taskId: string;
  sequenceNumber: string;
  allocationTime: number;
}

export interface TransactionSubmission {
  taskId: string;
  sequenceNumber: string;
  hash: string;
  submittedTime: number;
  resultStatus: 'success' | 'network_error' | 'sequence_conflict' | 'terminal_error';
  resultMessage: string;
}

export interface CoordinationReport {
  accountId: string;
  baseSequence: string;
  allocations: SequenceAllocation[];
  submissions: TransactionSubmission[];
  sequenceGaps: string[];
  validationPassed: boolean;
}

// ──────────────────────────────────────────────────────────────────────────────
// Sequence Coordinator
// ──────────────────────────────────────────────────────────────────────────────

/**
 * SequenceCoordinator manages thread-safe sequence allocation for concurrent tasks.
 * It maintains an in-memory counter that is incremented for each allocation,
 * guaranteeing unique sequence numbers without requiring network calls.
 */
export class SequenceCoordinator {
  private currentSequence: bigint;
  private allocations: Map<string, string> = new Map();

  constructor(baseSequence: string) {
    this.currentSequence = BigInt(baseSequence);
  }

  /**
   * Allocates the next sequence number for a task.
   * This is a synchronous operation and is thread-safe in a single-threaded
   * runtime (e.g., Node.js). For multi-threaded scenarios, use a mutex or
   * distributed lock.
   */
  allocateNextSequence(taskId: string): string {
    this.currentSequence = this.currentSequence + 1n;
    const allocated = this.currentSequence.toString();
    this.allocations.set(taskId, allocated);
    return allocated;
  }

  getAllocations(): SequenceAllocation[] {
    return Array.from(this.allocations.entries()).map(([taskId, sequence]) => ({
      taskId,
      sequenceNumber: sequence,
      allocationTime: Date.now(),
    }));
  }

  getCurrentSequence(): string {
    return this.currentSequence.toString();
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Mock Horizon Server (for testing without network)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * MockHorizonServer simulates Horizon submission responses.
 * It can be configured to inject network errors or sequence conflicts
 * for testing resilience.
 */
export interface MockHorizonConfig {
  failureMode?: 'none' | 'network_error' | 'sequence_conflict' | 'duplicate';
  failureTaskId?: string; // Task that experiences the failure
  delayMs?: number; // Simulate network latency
}

export class MockHorizonServer {
  private submittedHashes: Set<string> = new Set();
  private sequenceConflictSet: Set<string> = new Set();
  private config: MockHorizonConfig;

  constructor(config: MockHorizonConfig = {}) {
    this.config = config;
  }

  async submitTransaction(
    tx: Transaction | FeeBumpTransaction,
    taskId: string
  ): Promise<{ hash: string; ledger?: number }> {
    if (this.config.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.config.delayMs));
    }

    const hash = tx.hash().toString('hex');

    // Simulate failure modes
    if (this.config.failureMode === 'network_error' && this.config.failureTaskId === taskId) {
      throw new Error('Network error: ECONNREFUSED');
    }

    if (
      this.config.failureMode === 'sequence_conflict' &&
      this.config.failureTaskId === taskId
    ) {
      this.sequenceConflictSet.add(hash);
      const err = new Error('Sequence conflict detected') as any;
      err.response = { status: 400, data: { extras: { result_codes: { transaction: 'tx_bad_seq' } } } };
      throw err;
    }

    if (this.config.failureMode === 'duplicate' && this.submittedHashes.has(hash)) {
      const err = new Error('Duplicate submission') as any;
      err.response = { status: 400, data: { extras: { result_codes: { transaction: 'tx_duplicate' } } } };
      throw err;
    }

    this.submittedHashes.add(hash);
    return { hash, ledger: 12345 };
  }

  getSubmittedHashes(): string[] {
    return Array.from(this.submittedHashes);
  }

  getSequenceConflicts(): string[] {
    return Array.from(this.sequenceConflictSet);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Concurrent Task Simulator
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Simulates a concurrent task that:
 *   1. Allocates a sequence number.
 *   2. Builds an unsigned transaction.
 *   3. Submits it (with retry logic).
 *   4. Reports the result.
 */
async function runConcurrentTask(
  taskId: string,
  coordinator: SequenceCoordinator,
  account: Account,
  horizon: MockHorizonServer,
  networkPassphrase: string
): Promise<TransactionSubmission> {
  const sequenceNumber = coordinator.allocateNextSequence(taskId);

  // Build a transaction with the allocated sequence
  const tx = new TransactionBuilder(
    new Account(account.accountId(), sequenceNumber),
    {
      fee: BASE_FEE,
      networkPassphrase: networkPassphrase,
    }
  )
    .addOperation(
      Operation.payment({
        destination: 'GDZST3XVCDTUJ76ZAV2HA72KYRTM5XD7GDXCNKGD5SVHSMDCX3ZPHMFT',
        asset: { code: 'native' },
        amount: '1.0',
      })
    )
    .setTimeout(30)
    .build();

  // Simulate retry loop
  for (let attempt = 0; attempt < SUBMIT_RETRY_MAX; attempt++) {
    try {
      const result = await horizon.submitTransaction(tx, taskId);
      return {
        taskId,
        sequenceNumber,
        hash: result.hash,
        submittedTime: Date.now(),
        resultStatus: 'success',
        resultMessage: `Submitted successfully in ${attempt + 1} attempt(s)`,
      };
    } catch (error: any) {
      const errorMessage = error.message || 'Unknown error';

      // Check for sequence conflict
      if (
        error.response?.data?.extras?.result_codes?.transaction === 'tx_bad_seq'
      ) {
        return {
          taskId,
          sequenceNumber,
          hash: '',
          submittedTime: Date.now(),
          resultStatus: 'sequence_conflict',
          resultMessage: `Sequence conflict after ${attempt + 1} attempt(s): ${errorMessage}`,
        };
      }

      // Check for terminal errors
      if (errorMessage.includes('tx_duplicate')) {
        return {
          taskId,
          sequenceNumber,
          hash: '',
          submittedTime: Date.now(),
          resultStatus: 'terminal_error',
          resultMessage: 'Duplicate submission (transaction already on ledger)',
        };
      }

      // Network error: retry
      if (attempt < SUBMIT_RETRY_MAX - 1 && errorMessage.includes('Network error')) {
        const backoff = SUBMIT_RETRY_DELAY_MS * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, backoff));
        continue;
      }

      // Final attempt failed or terminal error
      return {
        taskId,
        sequenceNumber,
        hash: '',
        submittedTime: Date.now(),
        resultStatus: attempt === SUBMIT_RETRY_MAX - 1 ? 'network_error' : 'terminal_error',
        resultMessage: `Failed after ${attempt + 1} attempt(s): ${errorMessage}`,
      };
    }
  }

  return {
    taskId,
    sequenceNumber,
    hash: '',
    submittedTime: Date.now(),
    resultStatus: 'network_error',
    resultMessage: 'Failed after all retries',
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Validation and Reporting
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Validates that sequences have no gaps and all allocations were submitted.
 */
function validateSequences(
  baseSequence: string,
  allocations: SequenceAllocation[],
  submissions: TransactionSubmission[]
): { valid: boolean; gaps: string[] } {
  const gaps: string[] = [];

  if (allocations.length === 0) {
    return { valid: true, gaps: [] };
  }

  // Sort allocations by sequence
  const sorted = [...allocations].sort((a, b) =>
    BigInt(a.sequenceNumber) < BigInt(b.sequenceNumber) ? -1 : 1
  );

  let expected = BigInt(baseSequence) + 1n;
  for (const alloc of sorted) {
    const seq = BigInt(alloc.sequenceNumber);
    if (seq !== expected) {
      gaps.push(
        `Expected ${expected.toString()}, got ${seq.toString()} (task: ${alloc.taskId})`
      );
    }
    expected = seq + 1n;
  }

  // Check that all allocations have corresponding submissions
  const submittedSequences = new Set(submissions.map((s) => s.sequenceNumber));
  for (const alloc of allocations) {
    if (!submittedSequences.has(alloc.sequenceNumber)) {
      gaps.push(`Allocation ${alloc.sequenceNumber} (task: ${alloc.taskId}) was not submitted`);
    }
  }

  return { valid: gaps.length === 0, gaps };
}

// ──────────────────────────────────────────────────────────────────────────────
// Main Example (Internal - returns report)
// ──────────────────────────────────────────────────────────────────────────────

export async function runExample(params: {
  accountId?: string;
  concurrentTasks?: number;
  mockFailureMode?: string;
  json?: boolean;
} = {}): Promise<CoordinationReport> {
  const accountId = params.accountId || 'GDZST3XVCDTUJ76ZAV2HA72KYRTM5XD7GDXCNKGD5SVHSMDCX3ZPHMFT';
  const concurrentTasks = params.concurrentTasks || DEFAULT_CONCURRENT_TASKS;
  const failureMode = params.mockFailureMode || 'none';

  // Use mocked Horizon for this example
  const mockHorizon = new MockHorizonServer({
    failureMode: failureMode as any,
    failureTaskId: failureMode !== 'none' ? 'task-0' : undefined,
    delayMs: 10, // Simulate 10ms network latency
  });

  // Create a mock account with a base sequence
  const baseSequence = '100';
  const account = new Account(accountId, baseSequence);

  // Create the sequence coordinator
  const coordinator = new SequenceCoordinator(baseSequence);

  if (!params.json) {
    console.log('Concurrent Sequence Coordination Example');
    console.log('========================================\n');
    console.log(`Account ID: ${accountId}`);
    console.log(`Base Sequence: ${baseSequence}`);
    console.log(`Concurrent Tasks: ${concurrentTasks}`);
    console.log(`Failure Mode: ${failureMode}`);
    console.log('');
  }

  // Spawn concurrent tasks
  const taskPromises = [];
  for (let i = 0; i < concurrentTasks; i++) {
    taskPromises.push(
      runConcurrentTask(`task-${i}`, coordinator, account, mockHorizon, Networks.TESTNET_PASSPHRASE)
    );
  }

  // Wait for all tasks to complete
  const submissions = await Promise.all(taskPromises);

  // Sort submissions by sequence number for consistent output
  submissions.sort((a, b) =>
    BigInt(a.sequenceNumber) < BigInt(b.sequenceNumber) ? -1 : 1
  );

  // Get allocations for reporting
  const allocations = coordinator.getAllocations();

  // Validate sequences
  const validation = validateSequences(baseSequence, allocations, submissions);

  // Build report
  const report: CoordinationReport = {
    accountId,
    baseSequence,
    allocations,
    submissions,
    sequenceGaps: validation.gaps,
    validationPassed: validation.valid,
  };

  // Print results
  if (!params.json) {
    console.log('Sequence Allocations:');
    console.log('---------------------');
    for (const alloc of allocations) {
      console.log(
        `  Task: ${alloc.taskId} → Sequence: ${alloc.sequenceNumber}`
      );
    }
    console.log('');

    console.log('Submission Results:');
    console.log('-------------------');
    for (const sub of submissions) {
      const icon =
        sub.resultStatus === 'success'
          ? '✓'
          : sub.resultStatus === 'network_error'
            ? '⏱'
            : sub.resultStatus === 'sequence_conflict'
              ? '✗'
              : '⚠';
      console.log(
        `  ${icon} ${sub.taskId} (seq ${sub.sequenceNumber}): ${sub.resultStatus} - ${sub.resultMessage}`
      );
    }
    console.log('');

    console.log('Validation Results:');
    console.log('-------------------');
    if (validation.valid) {
      console.log('  ✓ All sequences are contiguous with no gaps.');
    } else {
      console.log('  ✗ Sequence gaps detected:');
      for (const gap of validation.gaps) {
        console.log(`    - ${gap}`);
      }
    }
    console.log('');

    const successCount = submissions.filter((s) => s.resultStatus === 'success').length;
    const failureCount = submissions.length - successCount;
    console.log('Summary:');
    console.log(`  Successful: ${successCount}/${submissions.length}`);
    console.log(`  Failed: ${failureCount}/${submissions.length}`);
    console.log(`  Validation: ${validation.valid ? 'PASSED' : 'FAILED'}`);
  }

  return report;
}

// ──────────────────────────────────────────────────────────────────────────────
// CLI Entry Point
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Public run function exported for the example runner.
 * Wraps runExample() to provide console output and handle the void return type.
 */
export async function run(params: {
  accountId?: string;
  concurrentTasks?: number;
  mockFailureMode?: string;
  json?: boolean;
} = {}): Promise<void> {
  const report = await runExample(params);
  if (params.json) {
    console.log(JSON.stringify(report, null, 2));
  }
}

if (require.main === module) {
  const params = {
    concurrentTasks: parseInt(process.env.CONCURRENT_TASKS || `${DEFAULT_CONCURRENT_TASKS}`),
    mockFailureMode: process.env.MOCK_FAILURE_MODE || 'none',
    json: process.env.JSON_OUTPUT === 'true',
  };

  run(params)
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error('Example failed:', err);
      process.exit(1);
    });
}

export default run;
