/**
 * 143-transaction-time-bounds: Stellar Transaction Time Bounds
 *
 * OVERVIEW
 * --------
 * A Stellar transaction can include time bounds that restrict the Unix-time
 * window in which it is valid. A transaction submitted outside its window is
 * rejected without any effect on the account.
 *
 * TIME BOUNDS FIELDS
 * ------------------
 *   minTime  – Earliest Unix timestamp (seconds) at which the transaction
 *               is valid. Set to 0 to mean "immediately valid".
 *   maxTime  – Latest Unix timestamp (seconds) at which the transaction is
 *               valid. Set to 0 to mean "never expires" (use with caution —
 *               a signed transaction with no expiry remains valid indefinitely).
 *
 * VALIDITY STATES
 * ---------------
 *   NOT_YET_VALID — current time < minTime.  Result code: txTOO_EARLY.
 *   VALID         — minTime ≤ current time ≤ maxTime (or maxTime = 0).
 *   EXPIRED       — current time > maxTime.  Result code: txTOO_LATE.
 *
 * COMMON PATTERNS
 * ---------------
 *   Expiration only:   minTime = 0,   maxTime = now + N seconds
 *   Future window:     minTime = T,   maxTime = T + N
 *   No expiry (caution): minTime = 0, maxTime = 0
 *
 * TIME BOUNDS vs LEDGER BOUNDS
 * ----------------------------
 * Both preconditions limit a transaction's lifetime, but they use different
 * coordinate systems:
 *
 *   • Time bounds   — Unix timestamps. Convenient for human-readable TTLs
 *                     but subject to minor clock-skew between validators.
 *   • Ledger bounds — Ledger sequence numbers. Fully deterministic: every
 *                     validator agrees on the current ledger sequence. Use
 *                     ledger bounds when you need exact, clock-independent
 *                     validity windows.
 *
 * PRACTICAL GUIDANCE
 * ------------------
 *   • Always set a maxTime on any transaction that will be signed and stored.
 *     A transaction with no expiry could be submitted years later.
 *   • The Stellar SDK's setTimeout() helper converts a relative timeout in
 *     seconds to an absolute maxTime. Use it when you want a simple TTL.
 *   • For escrow, multi-sig flows, or time-locked assets, use an explicit
 *     minTime so the transaction cannot be submitted until the intended moment.
 *   • Invalid ranges (minTime > maxTime) are rejected before submission.
 */

import {
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

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export type TimeBoundStatus = 'NOT_YET_VALID' | 'VALID' | 'EXPIRED' | 'NO_BOUNDS';

export interface TimeBoundsInspection {
  minTime: number | null;
  maxTime: number | null;
  currentTime: number;
  status: TimeBoundStatus;
  remainingSeconds: number | null;
  secondsUntilValid: number | null;
  expiredAgoSeconds: number | null;
}

export interface TimeBoundsScenario {
  label: string;
  minTime: number;
  maxTime: number;
  description: string;
  envelopeXdr: string;
  inspection: TimeBoundsInspection;
}

export interface RunParams {
  json?: boolean;
}

// ──────────────────────────────────────────────────────────────────────────────
// Core helpers (exported for unit testing)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Determines the validity status of a transaction relative to the supplied
 * current Unix timestamp (seconds).
 *
 * When maxTime is 0 the transaction never expires after minTime is satisfied.
 * When minTime is 0 the transaction is valid as soon as it is signed.
 */
export function evaluateTimeBounds(
  minTime: number,
  maxTime: number,
  nowSeconds: number,
): TimeBoundStatus {
  if (minTime === 0 && maxTime === 0) return 'NO_BOUNDS';
  if (minTime > 0 && nowSeconds < minTime) return 'NOT_YET_VALID';
  if (maxTime > 0 && nowSeconds > maxTime) return 'EXPIRED';
  return 'VALID';
}

/**
 * Builds a full TimeBoundsInspection for display purposes.
 */
export function inspectTimeBounds(
  minTime: number,
  maxTime: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): TimeBoundsInspection {
  const status = evaluateTimeBounds(minTime, maxTime, nowSeconds);

  const remainingSeconds =
    maxTime > 0 && status !== 'EXPIRED' ? Math.max(0, maxTime - nowSeconds) : null;

  const secondsUntilValid =
    status === 'NOT_YET_VALID' ? Math.max(0, minTime - nowSeconds) : null;

  const expiredAgoSeconds =
    status === 'EXPIRED' ? Math.max(0, nowSeconds - maxTime) : null;

  return {
    minTime: minTime > 0 ? minTime : null,
    maxTime: maxTime > 0 ? maxTime : null,
    currentTime: nowSeconds,
    status,
    remainingSeconds,
    secondsUntilValid,
    expiredAgoSeconds,
  };
}

/**
 * Validates that a time-bound configuration is logically sound.
 *
 * Returns null on success or an error message on failure.
 */
export function validateTimeBounds(minTime: number, maxTime: number): string | null {
  if (minTime < 0 || maxTime < 0) return 'minTime and maxTime must be non-negative.';
  if (maxTime > 0 && minTime > maxTime) {
    return `Invalid range: minTime (${minTime}) is greater than maxTime (${maxTime}).`;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Transaction construction
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Builds a transaction with explicit time bounds.
 *
 * The transaction contains a single manageData operation to keep the example
 * self-contained; any real operation could be substituted.
 */
function buildTimeBoundedTransaction(
  sourceAccount: { id: string; incrementSequenceNumber(): void; sequenceNumber(): string },
  signer: Keypair,
  minTime: number,
  maxTime: number,
  label: string,
): Transaction {
  const builder = new TransactionBuilder(sourceAccount as any, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  });

  builder.addOperation(
    Operation.manageData({
      name: `timebounds-${label.replace(/\s+/g, '-').toLowerCase()}`,
      value: label,
    }),
  );

  // Use setTimebounds for explicit min/max control.
  // setTimeout() is a convenience wrapper that sets maxTime = now + seconds.
  builder.setTimebounds(minTime, maxTime);

  const tx = builder.setTimeout(0).build();
  tx.sign(signer);
  return tx;
}

// ──────────────────────────────────────────────────────────────────────────────
// Display helpers
// ──────────────────────────────────────────────────────────────────────────────

function formatTimestamp(ts: number | null): string {
  if (ts === null) return '(none / never expires)';
  return `${ts}  (${new Date(ts * 1000).toISOString()})`;
}

function printInspection(label: string, inspection: TimeBoundsInspection): void {
  const statusIcon: Record<TimeBoundStatus, string> = {
    VALID: '✓ VALID',
    EXPIRED: '✗ EXPIRED',
    NOT_YET_VALID: '⏳ NOT YET VALID',
    NO_BOUNDS: '∞ NO BOUNDS',
  };

  console.log(`\n  ── ${label} ──`);
  console.log(`    minTime (earliest valid):    ${formatTimestamp(inspection.minTime)}`);
  console.log(`    maxTime (latest valid):      ${formatTimestamp(inspection.maxTime)}`);
  console.log(`    Current time:                ${inspection.currentTime} (${new Date(inspection.currentTime * 1000).toISOString()})`);
  console.log(`    Status:                      ${statusIcon[inspection.status]}`);

  if (inspection.remainingSeconds !== null) {
    console.log(`    Remaining validity:          ${inspection.remainingSeconds} seconds`);
  }
  if (inspection.secondsUntilValid !== null) {
    console.log(`    Seconds until valid:         ${inspection.secondsUntilValid} seconds`);
  }
  if (inspection.expiredAgoSeconds !== null) {
    console.log(`    Expired this many seconds ago: ${inspection.expiredAgoSeconds}`);
  }
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
    throw new Error(`Friendbot funding failed for ${publicKey}. HTTP ${response.status}: ${body}`);
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
 * Demonstrates Stellar transaction time bounds:
 *   1. Constructs transactions covering multiple time-bound scenarios.
 *   2. Evaluates each transaction's validity status against the current time.
 *   3. Submits a currently-valid transaction and observes the accepted result.
 *   4. Submits an already-expired transaction and observes the txTOO_LATE rejection.
 *   5. Submits a not-yet-valid transaction and observes the txTOO_EARLY rejection.
 *   6. Demonstrates invalid-range detection (minTime > maxTime).
 */
export async function run(params: RunParams = {}): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL ?? DEFAULT_HORIZON_URL;
  const outputJson =
    params.json === true ||
    process.env.OUTPUT_JSON === 'true' ||
    process.argv.includes('--json');

  const server = new Horizon.Server(horizonUrl);
  const nowSeconds = Math.floor(Date.now() / 1000);

  console.log('Starting Transaction Time Bounds Example...');
  console.log(`Using Horizon: ${horizonUrl}`);
  console.log(`Current Unix time: ${nowSeconds}  (${new Date(nowSeconds * 1000).toISOString()})`);

  // ── Fund a temporary account ──────────────────────────────────────────────
  const keypair = Keypair.random();
  const accountId = keypair.publicKey();
  console.log(`\nTemporary account: ${accountId}`);
  console.log('Funding via Friendbot...');
  await fundAccount(accountId);

  const horizonAccount = await server.loadAccount(accountId);

  // ── Scenario definitions ──────────────────────────────────────────────────
  const scenarios: Array<{
    label: string;
    minTime: number;
    maxTime: number;
    description: string;
  }> = [
    {
      label: 'Expiration Only',
      minTime: 0,
      maxTime: nowSeconds + 300, // valid for 5 more minutes
      description: 'Transaction is immediately valid and expires in 5 minutes.',
    },
    {
      label: 'Already Expired',
      minTime: 0,
      maxTime: nowSeconds - 60, // expired 60 seconds ago
      description: 'Transaction expired 60 seconds ago — Horizon returns txTOO_LATE.',
    },
    {
      label: 'Not Yet Valid',
      minTime: nowSeconds + 3600, // valid starting 1 hour from now
      maxTime: nowSeconds + 7200, // expires 2 hours from now
      description: 'Transaction is not yet valid — Horizon returns txTOO_EARLY.',
    },
    {
      label: 'Fixed Window (currently valid)',
      minTime: nowSeconds - 60, // opened 1 minute ago
      maxTime: nowSeconds + 600, // closes in 10 minutes
      description: 'Transaction is inside its fixed validity window.',
    },
    {
      label: 'No Bounds',
      minTime: 0,
      maxTime: 0,
      description: 'No time bounds set — transaction never expires (use with caution).',
    },
  ];

  // ── Build and inspect all scenarios ──────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Time Bounds Scenarios');
  console.log('═══════════════════════════════════════════════════════════');

  const results: TimeBoundsScenario[] = [];

  for (const scenario of scenarios) {
    // Validate range before building
    const rangeError = validateTimeBounds(scenario.minTime, scenario.maxTime);
    if (rangeError) {
      console.log(`\n  [${scenario.label}] Skipped — ${rangeError}`);
      continue;
    }

    const tx = buildTimeBoundedTransaction(
      horizonAccount,
      keypair,
      scenario.minTime,
      scenario.maxTime,
      scenario.label,
    );

    const inspection = inspectTimeBounds(scenario.minTime, scenario.maxTime, nowSeconds);

    results.push({
      label: scenario.label,
      minTime: scenario.minTime,
      maxTime: scenario.maxTime,
      description: scenario.description,
      envelopeXdr: tx.toEnvelope().toXDR('base64'),
      inspection,
    });

    printInspection(scenario.label, inspection);
    console.log(`    Description: ${scenario.description}`);
  }

  // ── Demonstrate invalid range detection ──────────────────────────────────
  console.log('\n── Invalid Range Detection ────────────────────────────────');
  const badMinTime = nowSeconds + 600;
  const badMaxTime = nowSeconds + 60; // maxTime < minTime → invalid
  const rangeErr = validateTimeBounds(badMinTime, badMaxTime);
  console.log(`  minTime = ${badMinTime}, maxTime = ${badMaxTime}`);
  console.log(`  Validation result: ${rangeErr ?? '(no error)'}`);
  console.log('  ✓ Invalid range correctly identified before any network call.');

  // ── Live submission demonstrations ───────────────────────────────────────
  // Re-load the account to get the latest sequence for fresh transactions
  const freshAccount = await server.loadAccount(accountId);

  console.log('\n── Live Submission Demonstrations ─────────────────────────');

  // 1. Submit a currently-valid transaction
  console.log('\n  [1] Submitting a currently-valid transaction...');
  const validTx = buildTimeBoundedTransaction(
    freshAccount,
    keypair,
    nowSeconds - 60,   // opened 1 minute ago
    nowSeconds + 600,  // closes in 10 minutes
    'valid-submission',
  );
  const validResult = await server.submitTransaction(validTx);
  console.log(`      ✓ Accepted — hash: ${validResult.hash}`);

  // Reload to get the incremented sequence
  const accountAfterValid = await server.loadAccount(accountId);

  // 2. Submit an expired transaction
  console.log('\n  [2] Submitting an already-expired transaction (expect txTOO_LATE)...');
  const expiredTx = buildTimeBoundedTransaction(
    accountAfterValid,
    keypair,
    0,
    nowSeconds - 30,  // expired 30 seconds ago
    'expired-submission',
  );
  try {
    await server.submitTransaction(expiredTx);
    throw new Error('Expected txTOO_LATE but submission succeeded — unexpected.');
  } catch (err: unknown) {
    const code = getResultCode(err);
    if (code === 'txTOO_LATE') {
      console.log(`      ✓ Rejected as expected. Result code: ${code}`);
    } else {
      throw err;
    }
  }

  // 3. Submit a not-yet-valid transaction
  // Reload to get a fresh sequence (expired tx did not consume one)
  const accountForEarly = await server.loadAccount(accountId);
  console.log('\n  [3] Submitting a not-yet-valid transaction (expect txTOO_EARLY)...');
  const earlyTx = buildTimeBoundedTransaction(
    accountForEarly,
    keypair,
    nowSeconds + 3600, // valid 1 hour from now
    nowSeconds + 7200,
    'early-submission',
  );
  try {
    await server.submitTransaction(earlyTx);
    throw new Error('Expected txTOO_EARLY but submission succeeded — unexpected.');
  } catch (err: unknown) {
    const code = getResultCode(err);
    if (code === 'txTOO_EARLY') {
      console.log(`      ✓ Rejected as expected. Result code: ${code}`);
    } else {
      throw err;
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n── Summary ────────────────────────────────────────────────');
  console.log('  Status  | Count');
  const statusCounts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.inspection.status] = (acc[r.inspection.status] ?? 0) + 1;
    return acc;
  }, {});
  Object.entries(statusCounts).forEach(([status, count]) => {
    console.log(`  ${status.padEnd(14)} | ${count}`);
  });

  // ── JSON output ───────────────────────────────────────────────────────────
  if (outputJson) {
    console.log('\nJSON Output:');
    console.log(
      JSON.stringify(
        {
          currentTime: nowSeconds,
          scenarios: results,
          liveSubmissions: {
            validTransactionHash: validResult.hash,
            expiredRejected: true,
            earlyRejected: true,
          },
        },
        null,
        2,
      ),
    );
  }

  // ── Educational notes ─────────────────────────────────────────────────────
  console.log('\n── Key Points ─────────────────────────────────────────────');
  console.log('  • Set maxTime on every signed transaction you store — a never-expiring');
  console.log('    signed transaction is a security risk.');
  console.log('  • Use setTimeout(N) for a simple N-second TTL from build time.');
  console.log('  • Use setTimebounds(minTime, maxTime) for precise control.');
  console.log('  • minTime > 0 lets you pre-sign a transaction to be submitted in the future.');
  console.log('  • minTime > maxTime is always rejected — validate before building.');
  console.log('  • Time bounds use Unix timestamps; ledger bounds use ledger sequences.');
  console.log('    Ledger bounds are clock-skew-free; use them when exact windows matter.');

  console.log('\nTransaction time bounds example completed successfully.');
}
