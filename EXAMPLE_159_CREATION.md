# Example 159: Concurrent Sequence Coordination - Creation Complete

## Summary

A comprehensive TypeScript example demonstrating safe coordination of Stellar transaction sequence numbers when multiple asynchronous tasks need to submit transactions concurrently from the same account.

## Problem Addressed

**Scenario:** An application needs to submit multiple Stellar transactions from the same account concurrently. If each task independently fetches the account state and constructs a transaction, all tasks see the same sequence number. Only one transaction succeeds; the rest receive `tx_bad_seq` errors.

**Solution:** Implement application-level sequence coordination using:
- A shared `SequenceCoordinator` that allocates unique sequences in memory
- Concurrent task execution with independent sequence allocation
- Sequential submission in ascending sequence order
- Comprehensive validation and error handling

## Files Created

### 1. Main Example Implementation
**File:** `src/examples/159-concurrent-sequence-coordination.ts` (535 lines)

**Exports:**
- `SequenceCoordinator` - Thread-safe sequence allocation manager
- `MockHorizonServer` - Simulates Horizon submission for testing
- `runExample()` - Core logic returning detailed report
- `run()` - Public entry point for example runner
- Supporting types: `SequenceAllocation`, `TransactionSubmission`, `CoordinationReport`

**Key Features:**
- Mocked submission (no private keys required)
- Concurrent task simulation
- BigInt-safe sequence handling
- Retry logic with exponential backoff
- Multiple failure mode injection
- Comprehensive validation
- JSON and text output options

### 2. Test Suite
**File:** `tests/159-concurrent-sequence-coordination.test.ts` (221 lines)

**Coverage:**
- SequenceCoordinator uniqueness and tracking
- Large sequence number handling (BigInt safety)
- MockHorizonServer functionality
- Integration tests (default, custom parameters, failure modes)
- Sequence contiguity validation
- Report structure verification

**Test Scenarios Covered:**
✅ Normal operation
✅ Network error recovery
✅ Sequence conflict handling
✅ Duplicate submission detection
✅ Gap detection and reporting
✅ Large concurrent task counts (20+)

### 3. Documentation
**File:** `docs/159-concurrent-sequence-coordination.md` (442 lines)

**Sections:**
1. Overview with problem/solution statement
2. Coordination strategy with ASCII diagrams
3. Core components (SequenceCoordinator, MockHorizonServer, task execution)
4. Usage examples (default, with failure modes, custom parameters)
5. Failure scenario handling (network errors, conflicts, duplicates)
6. Validation and gap detection
7. Implementation details (BigInt, retry strategy, submission ordering)
8. Testing approach and coverage
9. Real-world adaptation guide
10. Security considerations
11. When to use this pattern
12. Related examples in repository

### 4. Implementation Summary
**File:** `IMPLEMENTATION_SUMMARY.md` (271 lines)

Comprehensive overview of the implementation including:
- Design principles
- Component descriptions
- Running instructions
- Output examples
- Key learnings
- Limitations and caveats
- Future enhancements
- Verification checklist

## Usage

### Run with Defaults
```bash
npm run run-example 159-concurrent-sequence-coordination
```

### Run with Custom Parameters
```bash
# 10 concurrent tasks
CONCURRENT_TASKS=10 npm run run-example 159-concurrent-sequence-coordination

# Simulate network errors
MOCK_FAILURE_MODE=network_error npm run run-example 159-concurrent-sequence-coordination

# JSON output
JSON_OUTPUT=true npm run run-example 159-concurrent-sequence-coordination
```

### Run Tests
```bash
npm test -- tests/159-concurrent-sequence-coordination.test.ts
```

## Example Output

### Console Output (Default)
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

### JSON Output
```json
{
  "accountId": "GDZST3XVCDTUJ76ZAV2HA72KYRTM5XD7GDXCNKGD5SVHSMDCX3ZPHMFT",
  "baseSequence": "100",
  "allocations": [
    {"taskId": "task-0", "sequenceNumber": "101", ...},
    {"taskId": "task-1", "sequenceNumber": "102", ...}
  ],
  "submissions": [...],
  "sequenceGaps": [],
  "validationPassed": true
}
```

## Design Principles

1. **Separation of Concerns** - Allocation (memory), Submission (I/O), Validation (verification)
2. **No Private Keys** - All submission mocked for safety
3. **Deterministic Behavior** - Testable without external state
4. **BigInt Safety** - No precision loss with large sequence numbers
5. **Graceful Error Handling** - Distinguished transient vs terminal errors
6. **Comprehensive Validation** - Gap and contiguity detection

## Key Components

### SequenceCoordinator
```typescript
const coordinator = new SequenceCoordinator('100');
const seq = coordinator.allocateNextSequence('task-id'); // Returns '101', '102', ...
const allocations = coordinator.getAllocations();
```

### MockHorizonServer
```typescript
const server = new MockHorizonServer({
  failureMode: 'network_error',
  failureTaskId: 'task-0',
  delayMs: 10
});
```

### Concurrent Task
```typescript
const seq = coordinator.allocateNextSequence(taskId);
const tx = buildTransaction(seq);
const result = await submitWithRetry(tx);
```

## Integration with Example Runner

The example follows the standard runner pattern:

1. **Exports `run()` function** - Entry point for the runner
2. **Reads environment variables** - `CONCURRENT_TASKS`, `MOCK_FAILURE_MODE`, `JSON_OUTPUT`
3. **Outputs to console** - Human-readable text by default
4. **Supports JSON output** - Programmatic parsing with `JSON_OUTPUT=true`
5. **No network requirements** - Uses mocked Horizon server

## Real-World Adaptation

To use this pattern with a live Stellar account:

1. Replace `MockHorizonServer` with `Horizon.Server`
2. Load account from Horizon: `const account = await server.loadAccount(accountId)`
3. Handle real network errors (retries, rate limiting)
4. Implement persistence (save allocations to database)
5. Add reconciliation (verify on-chain status after submission)

## Verification

✅ Compiles without TypeScript errors
✅ Mocked submission works correctly
✅ Sequence allocation is unique and sequential
✅ Concurrent tasks execute properly
✅ Validation detects gaps and duplicates
✅ Failure modes inject errors as expected
✅ Retry logic with exponential backoff works
✅ JSON output is structurally valid
✅ No private keys or network credentials required
✅ Runs successfully with environment variable combinations

## Repository Integration

To register in the example runner catalog (`src/runner/catalog.ts`), add:

```typescript
'159-concurrent-sequence-coordination': {
  name: '159-concurrent-sequence-coordination',
  description: 'Coordinate transaction sequence numbers for concurrent asynchronous tasks',
  run: loadExample('../examples/159-concurrent-sequence-coordination'),
  params: [
    {
      type: 'number',
      name: 'concurrentTasks',
      message: 'Number of concurrent tasks to simulate:',
      default: 5,
    },
    {
      type: 'list',
      name: 'mockFailureMode',
      message: 'Failure mode to simulate:',
      choices: ['none', 'network_error', 'sequence_conflict', 'duplicate'],
      default: 'none',
    },
  ],
},
```

## Limitations

1. **Single-Process Only** - Not distributed; use database or distributed lock for multi-process
2. **Signing Not Shown** - Transactions built but not signed (intentional for safety)
3. **No Persistence** - Allocations held in memory only
4. **Mock Only** - Doesn't submit to real Horizon (by design for this example)
5. **Simple Failure Detection** - Known error codes only

## Future Enhancements

- [ ] Database-backed sequence persistence
- [ ] Distributed coordination (Redis, ZooKeeper)
- [ ] Reconciliation against Horizon
- [ ] Fee-bump transaction support
- [ ] Metrics and observability
- [ ] Timeout and cancellation support
- [ ] Soroban contract invocation integration

## Related Examples

- **141-sequence-number-management** - Basic sequence management
- **142-batch-transaction-construction** - Building transaction batches
- **174-transaction-preflight-validation** - Transaction validation
- **120-transaction-lifecycle-monitor** - Monitoring transactions

## Success Criteria Met

✅ Demonstrates safe sequence coordination for concurrent tasks
✅ Uses mocked submission (no private keys)
✅ No network dependency required
✅ Comprehensive error handling
✅ Detailed validation and reporting
✅ Well-documented with examples
✅ Fully tested with multiple failure modes
✅ Follows repository patterns and conventions
✅ Ready for CI/CD inclusion
