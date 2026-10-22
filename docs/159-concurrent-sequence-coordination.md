# 159-concurrent-sequence-coordination: Coordinating Transaction Sequence Numbers for Concurrent Tasks

## Overview

This example demonstrates how to safely coordinate Stellar transaction sequence numbers when multiple asynchronous tasks need to submit transactions concurrently from the same account.

**Problem:** Stellar transactions require unique, strictly-ordered sequence numbers. When multiple tasks independently fetch the same account state and build transactions, they all see the same sequence number, leading to sequence conflicts (`tx_bad_seq`). Only one transaction succeeds; the others fail.

**Solution:** This example implements an application-level sequence coordinator that:
1. Loads the account sequence once, before concurrent work begins
2. Allocates unique sequence numbers to each concurrent task in-memory
3. Ensures transactions are submitted in strict ascending sequence order
4. Handles network failures and sequence conflicts gracefully
5. Validates that sequences form a contiguous gap-free sequence

## Key Concepts

### Sequence Coordination Strategy

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Load Account Sequence (100)                              │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. Create SequenceCoordinator(baseSeq=100)                  │
└─────────────────────────────────────────────────────────────┘
                          ↓
        ┌─────────────────┼─────────────────┐
        ↓                 ↓                 ↓
    ┌───────┐         ┌───────┐         ┌───────┐
    │Task 1 │         │Task 2 │         │Task 3 │
    │Alloc  │         │Alloc  │         │Alloc  │
    │Seq101 │         │Seq102 │         │Seq103 │
    └───────┘         └───────┘         └───────┘
        ↓                 ↓                 ↓
    ┌───────┐         ┌───────┐         ┌───────┐
    │Build  │         │Build  │         │Build  │
    │TxnSeq1│         │TxnSeq2│         │TxnSeq3│
    └───────┘         └───────┘         └───────┘
        ↓                 ↓                 ↓
        └─────────────────┼─────────────────┘
                          ↓
        ┌─────────────────┼─────────────────┐
        │ Submit in Order │                 │
        │ Seq101 → Seq102 → Seq103          │
        └─────────────────┼─────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. Validate: Sequences = [101, 102, 103]                   │
│    ✓ No gaps, no duplicates, contiguous                     │
└─────────────────────────────────────────────────────────────┘
```

### Why Mocking Is Important

This example uses `MockHorizonServer` instead of real network calls because:

1. **Security:** We don't need to handle real private keys or funded accounts
2. **Determinism:** We can test all code paths (network errors, sequence conflicts) without relying on external state
3. **Speed:** Tests run instantly without network latency
4. **Reproducibility:** We can simulate specific failure modes consistently

To test against a real network, replace `MockHorizonServer` with a real `Horizon.Server` instance.

### Sequence Allocation vs Submission

These are separate concerns:

**Allocation (concurrent):**
- Multiple tasks call `allocateNextSequence()` concurrently
- Each gets a unique sequence number
- All allocations are instant, in-memory, and safe

**Submission (sequential):**
- Transactions are submitted in ascending sequence order
- This ensures the network accepts each without `tx_bad_seq` conflicts
- Retries and error handling are applied per submission

## Core Components

### SequenceCoordinator

Manages allocation of unique sequence numbers:

```typescript
const coordinator = new SequenceCoordinator('100'); // baseSequence

// Concurrent tasks call this
const seq = coordinator.allocateNextSequence('task-id');
// Returns: '101', '102', '103', ... (unique for each task)

// Query state later
const allocations = coordinator.getAllocations();
const currentSeq = coordinator.getCurrentSequence();
```

**Thread Safety:** In single-threaded JavaScript (Node.js), this is safe. For multi-threaded environments, wrap with a mutex or use a distributed lock.

### MockHorizonServer

Simulates Horizon submission responses for testing:

```typescript
const server = new MockHorizonServer({
  failureMode: 'network_error', // or 'sequence_conflict', 'duplicate', 'none'
  failureTaskId: 'task-0',       // Which task experiences the failure
  delayMs: 10,                   // Simulate network latency
});

const result = await server.submitTransaction(tx, 'task-id');
// Returns: { hash: '...', ledger: 12345 }
```

### Concurrent Task Execution

Each task:

```typescript
// 1. Allocate a unique sequence
const seq = coordinator.allocateNextSequence('task-id');

// 2. Build a transaction with that sequence
const tx = new TransactionBuilder(
  new Account(accountId, seq),
  { fee, networkPassphrase }
).addOperation(...).build();

// 3. Submit with retry logic
for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
  try {
    const result = await horizon.submitTransaction(tx, taskId);
    return { status: 'success', hash: result.hash };
  } catch (error) {
    // Handle errors (retry or fail)
  }
}
```

## Usage

### Run with Default Settings

```bash
npm run run-example 159-concurrent-sequence-coordination
```

Output:
```
Concurrent Sequence Coordination Example
========================================

Account ID: GDZST3XVCDTUJ76ZAV2HA72KYRTM5XD7GDXCNKGD5SVHSMDCX3ZPHMFT
Base Sequence: 100
Concurrent Tasks: 5
Failure Mode: none

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

### Run with Failure Simulation

```bash
# Simulate network errors
MOCK_FAILURE_MODE=network_error npm run run-example 159-concurrent-sequence-coordination

# Simulate sequence conflicts
MOCK_FAILURE_MODE=sequence_conflict npm run run-example 159-concurrent-sequence-coordination

# Simulate duplicate submissions
MOCK_FAILURE_MODE=duplicate npm run run-example 159-concurrent-sequence-coordination
```

### Run with Custom Parameters

```bash
# 10 concurrent tasks
CONCURRENT_TASKS=10 npm run run-example 159-concurrent-sequence-coordination

# JSON output
JSON_OUTPUT=true npm run run-example 159-concurrent-sequence-coordination
```

### Output as JSON

```bash
JSON_OUTPUT=true npm run run-example 159-concurrent-sequence-coordination
```

Example JSON output:
```json
{
  "accountId": "GDZST3XVCDTUJ76ZAV2HA72KYRTM5XD7GDXCNKGD5SVHSMDCX3ZPHMFT",
  "baseSequence": "100",
  "allocations": [
    {
      "taskId": "task-0",
      "sequenceNumber": "101",
      "allocationTime": 1697973000000
    },
    {
      "taskId": "task-1",
      "sequenceNumber": "102",
      "allocationTime": 1697973000001
    }
  ],
  "submissions": [
    {
      "taskId": "task-0",
      "sequenceNumber": "101",
      "hash": "abc123...",
      "submittedTime": 1697973000050,
      "resultStatus": "success",
      "resultMessage": "Submitted successfully in 1 attempt(s)"
    }
  ],
  "sequenceGaps": [],
  "validationPassed": true
}
```

## Handling Different Failure Scenarios

### 1. Network Errors (Transient)

```
Task submits → Network timeout
→ Retry with exponential backoff (500ms, 1s, 2s)
→ Success on retry → Record hash
→ OR All retries fail → Mark as network_error
```

**Recovery:** Reconciliation process checks Horizon later for the transaction hash.

### 2. Sequence Conflicts (tx_bad_seq)

```
Task submits seq=102 → tx_bad_seq error
→ Check if another task already submitted seq=102
→ OR another process/instance submitted this account's sequence
→ Mark as sequence_conflict with diagnostic info
```

**Recovery:** Reload the account from Horizon, detect which sequence was accepted, and retry remaining transactions.

### 3. Duplicate Submissions

```
Task submits same TX twice → tx_duplicate error
→ This is OK: the transaction is already on-ledger
→ Treat as success (the first submission went through)
```

### 4. Terminal Errors (Invalid operations, etc.)

```
Task submits with invalid operation → Operation error
→ Cannot retry (will always fail with same error)
→ Mark as terminal_error
→ Continue to next transaction
```

## Validation

After all submissions complete, the example validates:

1. **Contiguity:** Sequences form an unbroken sequence [101, 102, 103, ...]
2. **No duplicates:** Each sequence is unique
3. **All allocations submitted:** Every allocated sequence has a corresponding submission attempt
4. **Gap detection:** If gaps are found, they're reported with diagnostic info

Example gap detection:
```
✗ Sequence gaps detected:
  - Expected 105, got 106 (task: task-4)
  - Allocation 103 (task: task-2) was not submitted
```

## Implementation Details

### BigInt for Sequence Numbers

Stellar sequence numbers can exceed `Number.MAX_SAFE_INTEGER` (2^53 - 1). This example uses `BigInt` to avoid precision loss:

```typescript
const baseSeq = BigInt('9223372036854775000');
const nextSeq = baseSeq + 1n;
// Safe: no precision loss
```

### Retry Strategy

Submissions retry with bounded exponential backoff:

```
Attempt 1: Immediate
Attempt 2: 500ms delay
Attempt 3: 1000ms delay (2 × previous)
Attempt 4: Fail (max retries exceeded)
```

This prevents overwhelming the network while giving transient failures time to recover.

### Submission Order

Transactions are submitted in strict ascending sequence order:

```
Submitted in order: seq=101, seq=102, seq=103, seq=104, seq=105
NOT in allocation order (could be: task-2, task-0, task-3, task-1, task-4)
```

This ensures the network accepts each transaction without sequence gaps.

## Testing

Run the test suite:

```bash
npm test -- tests/159-concurrent-sequence-coordination.test.ts
```

Tests cover:

- **Sequence allocation:** Unique, sequential numbers
- **Large sequence numbers:** No precision loss with BigInt
- **Submission tracking:** Results captured correctly
- **Failure modes:** Sequence conflicts, network errors, duplicates
- **Validation:** Gap detection, contiguity checks
- **Report structure:** All required fields present

## Real-World Adaptation

To use this pattern with a real Stellar account:

1. **Replace MockHorizonServer with Horizon.Server:**

```typescript
const server = new Horizon.Server('https://horizon-testnet.stellar.org');
const result = await server.submitTransaction(tx);
```

2. **Load account from Horizon:**

```typescript
const account = await server.loadAccount(accountId);
const coordinator = new SequenceCoordinator(account.sequenceNumber());
```

3. **Handle real network errors:**

```typescript
if (error.response?.status === 503) {
  // Service unavailable: retry
} else if (error.response?.status === 404) {
  // Not found: terminal error
}
```

4. **Add persistence for recovery:**

```typescript
// Save allocations and submissions to a durable store
saveToDatabase({
  allocations: coordinator.getAllocations(),
  submissions: results,
});

// On restart, reload and reconcile with Horizon
```

5. **Implement reconciliation:**

```typescript
// After all submissions, verify on-chain status
for (const { hash } of submissions) {
  const tx = await horizon.transactions().transaction(hash);
  if (tx.successful) {
    // Confirmed on-ledger
  } else {
    // Failed or not yet confirmed
  }
}
```

## Security Considerations

- **No Private Keys:** This example does not handle secret keys or sign transactions (mocking only).
- **Allocation is Not Submission:** Allocating a sequence does not submit to the network.
- **Verify Signatures:** In a real implementation, verify that all signatures are from authorized signers before submission.
- **Rate Limiting:** Be aware of Horizon rate limits when submitting many concurrent requests.
- **Idempotency:** Store transaction hashes and check for duplicates to ensure idempotent retries.

## When to Use This Pattern

✅ **Good for:**
- Batch payment processing (multiple payments from one account)
- Scheduled transaction queues
- Offline transaction preparation followed by online submission
- Applications that need to submit many transactions from the same account

❌ **Not ideal for:**
- One-off transactions (simpler approaches exist)
- Multi-account transactions (no coordination needed)
- Real-time streaming transactions (sequence allocation overhead)

## Related Examples

- **141-sequence-number-management:** Basic sequence management for one task
- **142-batch-transaction-construction:** Building a batch of transactions upfront
- **174-transaction-preflight-validation:** Validating transactions before submission
- **120-transaction-lifecycle-monitor:** Monitoring transaction status after submission

## Further Reading

- [Stellar Transaction Documentation](https://developers.stellar.org/learn/building-blocks/transactions)
- [Sequence Numbers](https://developers.stellar.org/learn/glossary#sequence-number)
- [Horizon API Reference](https://developers.stellar.org/api/introduction/next/)
- [JavaScript SDK TransactionBuilder](https://js.stellar.org/reference/classes/TransactionBuilder.html)
