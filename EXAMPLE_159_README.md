# Example 159: Concurrent Sequence Coordination

## Quick Start

```bash
# Run with defaults (5 concurrent tasks)
npm run run-example 159-concurrent-sequence-coordination

# Run with 10 concurrent tasks
CONCURRENT_TASKS=10 npm run run-example 159-concurrent-sequence-coordination

# Simulate network errors
MOCK_FAILURE_MODE=network_error npm run run-example 159-concurrent-sequence-coordination

# Output as JSON
JSON_OUTPUT=true npm run run-example 159-concurrent-sequence-coordination

# Run tests
npm test -- tests/159-concurrent-sequence-coordination.test.ts
```

## What This Example Does

This example demonstrates how to **safely coordinate Stellar transaction sequence numbers when multiple concurrent asynchronous tasks need to submit transactions from the same account**.

### The Problem

When multiple tasks independently fetch the same Stellar account and build transactions:
- All tasks see the same sequence number (e.g., 100)
- Each task builds a transaction with sequence 101
- Only one transaction succeeds with `tx_bad_seq` for the others

### The Solution

1. **Load the account sequence once** before concurrent work begins
2. **Create a SequenceCoordinator** that allocates unique sequences in memory
3. **Each concurrent task gets a unique sequence** from the coordinator (101, 102, 103, ...)
4. **Tasks submit transactions sequentially** in ascending sequence order
5. **Validate** that sequences form a contiguous, gap-free sequence

## Key Features

✅ **Mocked Submission** - No private keys or real network calls
✅ **Concurrent Tasks** - Simulates 5-20+ concurrent operations
✅ **BigInt Safe** - Handles large sequence numbers without precision loss
✅ **Retry Logic** - Exponential backoff for transient failures
✅ **Failure Modes** - Test network errors, conflicts, duplicates
✅ **Comprehensive Validation** - Detects gaps and contiguity issues
✅ **Detailed Reporting** - JSON or text output with full diagnostics

## Example Output

```
Sequence Allocations:
---------------------
  Task: task-0 → Sequence: 101
  Task: task-1 → Sequence: 102
  Task: task-2 → Sequence: 103
  Task: task-3 → Sequence: 104
  Task: task-4 → Sequence: 105

Submission Results:
-------------------
  ✓ task-0 (seq 101): success - Submitted successfully in 1 attempt(s)
  ✓ task-1 (seq 102): success - Submitted successfully in 1 attempt(s)
  ✓ task-2 (seq 103): success - Submitted successfully in 1 attempt(s)
  ✓ task-3 (seq 104): success - Submitted successfully in 1 attempt(s)
  ✓ task-4 (seq 105): success - Submitted successfully in 1 attempt(s)

Validation Results:
-------------------
  ✓ All sequences are contiguous with no gaps.

Summary:
  Successful: 5/5
  Failed: 0/5
  Validation: PASSED
```

## File Structure

| File | Purpose |
|------|---------|
| `src/examples/159-concurrent-sequence-coordination.ts` | Main example with SequenceCoordinator, MockHorizonServer, and coordination logic |
| `tests/159-concurrent-sequence-coordination.test.ts` | Comprehensive test suite with 12+ test cases |
| `docs/159-concurrent-sequence-coordination.md` | Detailed documentation with usage guide and real-world adaptation |
| `IMPLEMENTATION_SUMMARY.md` | High-level overview of design and implementation |
| `EXAMPLE_159_CREATION.md` | Complete creation notes and verification checklist |

## Core Components

### SequenceCoordinator
```typescript
const coordinator = new SequenceCoordinator('100'); // base sequence

// Each task calls this to get a unique sequence
const seq = coordinator.allocateNextSequence('task-0'); // Returns '101'
const seq = coordinator.allocateNextSequence('task-1'); // Returns '102'
```

### MockHorizonServer
```typescript
const server = new MockHorizonServer({
  failureMode: 'network_error', // Simulate failures
  failureTaskId: 'task-0',      // Which task experiences the failure
  delayMs: 10                   // Network latency
});

const result = await server.submitTransaction(tx, 'task-id');
```

## Error Handling

The example gracefully handles:

| Error | Handling |
|-------|----------|
| Network timeout | Retry with exponential backoff (500ms, 1s, 2s) |
| Sequence conflict (`tx_bad_seq`) | Detect and report diagnostic info |
| Duplicate submission | Treat as success (transaction already on-ledger) |
| Terminal error | Abandon transaction and continue |

## Real-World Usage

To adapt this pattern for a live Stellar account:

1. Replace `MockHorizonServer` with `Horizon.Server('https://horizon-testnet.stellar.org')`
2. Load account from Horizon: `const account = await server.loadAccount(accountId)`
3. Implement persistence (save allocations to database for recovery)
4. Add reconciliation (verify on-chain status after submission)
5. Handle rate limiting and implement backoff strategies

## When to Use

✅ **Good for:**
- Batch payment processing (multiple payments from one account)
- Scheduled transaction queues
- Offline transaction preparation with online submission
- Applications submitting many transactions from the same account

❌ **Not ideal for:**
- One-off transactions (simpler approaches exist)
- Multi-account transactions (no coordination needed)
- Real-time streaming (allocation overhead)

## Testing

Run the full test suite:
```bash
npm test -- tests/159-concurrent-sequence-coordination.test.ts
```

Tests cover:
- Sequence allocation uniqueness
- Large sequence number handling (BigInt)
- MockHorizonServer functionality
- Failure mode injection
- Sequence contiguity validation
- Report structure verification

## Documentation

For detailed information, see:
- **`docs/159-concurrent-sequence-coordination.md`** - Full usage guide with examples
- **`IMPLEMENTATION_SUMMARY.md`** - Design principles and components
- **`EXAMPLE_159_CREATION.md`** - Implementation notes and checklist

## Related Examples

- **141-sequence-number-management** - Basic sequence management for single tasks
- **142-batch-transaction-construction** - Building a batch of transactions upfront
- **174-transaction-preflight-validation** - Validating transactions before submission
- **120-transaction-lifecycle-monitor** - Monitoring transaction confirmation

## Key Takeaways

1. **Sequence allocation is the bottleneck** - Must be unique and sequential
2. **Allocation and submission are separate** - Allocation is instant; submission is network I/O
3. **Validation is crucial** - Always verify sequences are contiguous and gaps-free
4. **Error handling matters** - Distinguish transient from terminal failures
5. **Testing with mocks is powerful** - Can test all code paths without real network

## Security Notes

- ✅ **No private keys exposed** - All submission mocked
- ✅ **No network credentials required** - Safe for CI/CD
- ✅ **Safe for automated testing** - No Testnet account needed
- ⚠️ **Signing not shown** - Real implementations should separate signing from submission
- ⚠️ **Idempotency matters** - Store transaction hashes to detect duplicates

---

**Try it now:**
```bash
npm run run-example 159-concurrent-sequence-coordination
```
