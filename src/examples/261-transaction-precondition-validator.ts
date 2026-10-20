/**
 * 261-transaction-precondition-validator: Stellar Transaction Preconditions and Time-Bound Execution Validator
 *
 * OVERVIEW
 * --------
 * Read-only example that inspects a Stellar transaction envelope's preconditions
 * (time bounds, ledger bounds, and sequence-related constraints) and reports
 * whether a supplied reference time or ledger satisfies them.
 *
 * It never signs or submits transactions. Local checks only describe how the
 * transaction *appears* today; they do not guarantee network acceptance, since
 * ledger state and wall-clock time may change between inspection and submission.
 *
 * SUPPORTED PRECONDITION FAMILIES (@stellar/stellar-sdk v13)
 * ---------------------------------------------------------
 *   Time bounds        - minTime / maxTime (Unix timestamps, seconds)
 *   Ledger bounds      - minLedger / maxLedger (ledger sequence numbers)
 *   Minimum sequence   - minSeqNum (account sequence floor)
 *   Minimum sequence   - minSeqAge (seconds since last sequence bump)
 *   Minimum seq ledger - minSeqLedgerGap (ledgers since last sequence bump)
 *
 * When a transaction carries no explicit preconditions the precondition type is
 * reported as "none" and every constraint check is reported as PASS with an
 * explanatory note, never as a silent pass.
 */

import {
  Account,
  FeeBumpTransaction,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const BASE_FEE = '100';
const DEFAULT_SCENARIO = 'none';

export type CheckStatus = 'PASS' | 'FAIL' | 'UNKNOWN';

export interface PreconditionCheck {
  constraint: string;
  status: CheckStatus;
  reference?: string;
  detail: string;
  reason: string;
}

export interface PreconditionsSnapshot {
  preconditionType: 'none' | 'time' | 'ledger' | 'sequence' | 'v2-combined';
  timeBounds: { minTime: number; maxTime: number } | null;
  ledgerBounds: { minLedger: number; maxLedger: number } | null;
  minAccountSequence: string | null;
  minAccountSequenceAgeSeconds: number | null;
  minAccountSequenceLedgerGap: number | null;
  hasExtraSigners: boolean;
}

export interface ValidationContext {
  referenceTimeSeconds: number | null;
  referenceLedger: number | null;
  accountSequence: string | null;
  accountSequenceTime: string | null;
  accountSequenceLedger: number | null;
}

export interface PreconditionReport {
  envelopeXdr: string;
  isFeeBump: boolean;
  sourceAccount: string | null;
  sequence: string;
  preconditionType: string;
  checks: PreconditionCheck[];
  overall: CheckStatus;
  notes: string[];
}

export interface RunParams {
  envelopeXdr?: string;
  referenceTime?: string; // Unix seconds or ISO-8601
  referenceLedger?: string;
  accountSequence?: string;
  accountSequenceTime?: string; // ISO-8601
  accountSequenceLedger?: string;
  horizonUrl?: string;
  network?: 'testnet' | 'public';
  json?: boolean | string;
  scenario?:
    | 'none'
    | 'time-valid'
    | 'time-expired'
    | 'time-not-yet'
    | 'ledger-valid'
    | 'ledger-outside'
    | 'sequence';
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/** Parses a reference time supplied as Unix seconds or an ISO-8601 string. */
export function parseReferenceTime(input?: string): {
  value: number | null;
  iso: string;
  source: string;
} {
  const now = Math.floor(Date.now() / 1000);
  if (input === undefined || input === '') {
    return { value: now, iso: new Date(now * 1000).toISOString(), source: 'current system time' };
  }

  const trimmed = input.trim();
  const asSeconds = Number(trimmed);
  if (!Number.isNaN(asSeconds) && trimmed === String(Math.trunc(asSeconds))) {
    return {
      value: asSeconds,
      iso: new Date(asSeconds * 1000).toISOString(),
      source: 'supplied Unix timestamp',
    };
  }

  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) {
    const seconds = Math.floor(parsed / 1000);
    return {
      value: seconds,
      iso: new Date(parsed).toISOString(),
      source: 'supplied ISO-8601 timestamp',
    };
  }

  return {
    value: null,
    iso: new Date(now * 1000).toISOString(),
    source: 'current system time (input unparseable)',
  };
}

/** Normalizes a 64-bit time-bound value returned by the SDK to a number. */
function timeValue(value: string | number | null): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Determines which precondition families are present on a transaction. */
export function inspectPreconditions(transaction: {
  timeBounds: { minTime: string; maxTime: string } | undefined;
  ledgerBounds: { minLedger: number; maxLedger: number } | undefined;
  minAccountSequence: string | undefined;
  minAccountSequenceAge: { toString(): string } | undefined;
  minAccountSequenceLedgerGap: number | undefined;
  extraSigners: unknown[];
}): PreconditionsSnapshot {
  const timeBounds =
    transaction.timeBounds !== undefined
      ? {
          minTime: timeValue(transaction.timeBounds.minTime) ?? 0,
          maxTime: timeValue(transaction.timeBounds.maxTime) ?? 0,
        }
      : null;

  const ledgerBounds =
    transaction.ledgerBounds !== undefined
      ? {
          minLedger: transaction.ledgerBounds.minLedger ?? 0,
          maxLedger: transaction.ledgerBounds.maxLedger ?? 0,
        }
      : null;

  const minAccountSequence = transaction.minAccountSequence ?? null;
  const minAccountSequenceAgeSeconds =
    transaction.minAccountSequenceAge !== undefined
      ? Number(transaction.minAccountSequenceAge.toString())
      : null;
  const minAccountSequenceLedgerGap =
    transaction.minAccountSequenceLedgerGap !== undefined
      ? transaction.minAccountSequenceLedgerGap
      : null;

  const families: string[] = [];
  if (timeBounds) families.push('time');
  if (ledgerBounds) families.push('ledger');
  if (minAccountSequence !== null) families.push('sequence');
  if (minAccountSequenceAgeSeconds !== null) families.push('sequence-age');
  if (minAccountSequenceLedgerGap !== null) families.push('sequence-ledger-gap');

  let preconditionType: PreconditionsSnapshot['preconditionType'] = 'none';
  if (families.length === 0) preconditionType = 'none';
  else if (families.length === 1)
    preconditionType = families[0] as PreconditionsSnapshot['preconditionType'];
  else preconditionType = 'v2-combined';

  return {
    preconditionType,
    timeBounds,
    ledgerBounds,
    minAccountSequence,
    minAccountSequenceAgeSeconds,
    minAccountSequenceLedgerGap,
    hasExtraSigners: Array.isArray(transaction.extraSigners) && transaction.extraSigners.length > 0,
  };
}

/** Evaluates time bounds against a reference Unix timestamp (seconds). */
export function evaluateTimeBounds(
  timeBounds: { minTime: number; maxTime: number } | null,
  referenceTimeSeconds: number | null,
): PreconditionCheck {
  if (timeBounds === null) {
    return {
      constraint: 'time bounds',
      status: 'PASS',
      detail: 'No time bounds configured',
      reason: 'The transaction carries no minTime/maxTime, so time does not restrict validity.',
    };
  }

  if (referenceTimeSeconds === null) {
    return {
      constraint: 'time bounds',
      status: 'UNKNOWN',
      reference: '(none supplied)',
      detail: `minTime=${timeBounds.minTime}, maxTime=${timeBounds.maxTime}`,
      reason: 'No reference time was supplied, so time-window validity cannot be evaluated.',
    };
  }

  const { minTime, maxTime } = timeBounds;
  const min = Number.isFinite(minTime) ? minTime : 0;
  const max = Number.isFinite(maxTime) ? maxTime : 0;

  if (min > 0 && max > 0 && min > max) {
    return {
      constraint: 'time bounds',
      status: 'FAIL',
      reference: new Date(referenceTimeSeconds * 1000).toISOString(),
      detail: `minTime=${min} is greater than maxTime=${max}`,
      reason: 'Inconsistent time bounds: the earliest-valid time is after the expiry time.',
    };
  }

  const nowIso = new Date(referenceTimeSeconds * 1000).toISOString();

  if (min > 0 && referenceTimeSeconds < min) {
    return {
      constraint: 'time bounds',
      status: 'FAIL',
      reference: nowIso,
      detail: `minTime=${min}, maxTime=${max === 0 ? 'never' : max}`,
      reason: `Reference time ${nowIso} is before minTime; transaction is not yet valid (risk of txTOO_EARLY).`,
    };
  }

  if (max > 0 && referenceTimeSeconds > max) {
    return {
      constraint: 'time bounds',
      status: 'FAIL',
      reference: nowIso,
      detail: `minTime=${min}, maxTime=${max}`,
      reason: `Reference time ${nowIso} is after maxTime; maximum time bound has passed (risk of txTOO_LATE).`,
    };
  }

  return {
    constraint: 'time bounds',
    status: 'PASS',
    reference: nowIso,
    detail: `minTime=${min}, maxTime=${max === 0 ? 'never' : max}`,
    reason: 'Reference time falls within the configured time-bound interval.',
  };
}

/** Evaluates ledger bounds against a reference ledger sequence. */
export function evaluateLedgerBounds(
  ledgerBounds: { minLedger: number; maxLedger: number } | null,
  referenceLedger: number | null,
): PreconditionCheck {
  if (ledgerBounds === null) {
    return {
      constraint: 'ledger bounds',
      status: 'PASS',
      detail: 'No ledger bounds configured',
      reason:
        'The transaction carries no minLedger/maxLedger, so ledger state does not restrict validity.',
    };
  }

  if (referenceLedger === null) {
    return {
      constraint: 'ledger bounds',
      status: 'UNKNOWN',
      reference: '(none supplied)',
      detail: `minLedger=${ledgerBounds.minLedger}, maxLedger=${ledgerBounds.maxLedger}`,
      reason:
        'No reference ledger sequence was supplied, so ledger-window validity cannot be evaluated.',
    };
  }

  const { minLedger, maxLedger } = ledgerBounds;

  if (referenceLedger < minLedger) {
    return {
      constraint: 'ledger bounds',
      status: 'FAIL',
      reference: String(referenceLedger),
      detail: `minLedger=${minLedger}, maxLedger=${maxLedger === 0 ? 'never' : maxLedger}`,
      reason: `Reference ledger ${referenceLedger} is below minLedger ${minLedger}; transaction is not yet valid.`,
    };
  }

  if (maxLedger > 0 && referenceLedger > maxLedger) {
    return {
      constraint: 'ledger bounds',
      status: 'FAIL',
      reference: String(referenceLedger),
      detail: `minLedger=${minLedger}, maxLedger=${maxLedger}`,
      reason: `Reference ledger ${referenceLedger} is above maxLedger ${maxLedger}; ledger bound has expired.`,
    };
  }

  return {
    constraint: 'ledger bounds',
    status: 'PASS',
    reference: String(referenceLedger),
    detail: `minLedger=${minLedger}, maxLedger=${maxLedger === 0 ? 'never' : maxLedger}`,
    reason: 'Reference ledger satisfies the configured ledger-bound constraints.',
  };
}

/** Evaluates sequence-related preconditions when reference account data is available. */
export function evaluateSequencePreconditions(
  snapshot: PreconditionsSnapshot,
  context: ValidationContext,
  nowSeconds: number,
): PreconditionCheck[] {
  const checks: PreconditionCheck[] = [];

  // Minimum sequence number: the account's current sequence must be >= minSeqNum.
  if (snapshot.minAccountSequence !== null) {
    const minSeq = snapshot.minAccountSequence;
    const detail = `minSeqNum=${minSeq}`;
    if (context.accountSequence === null) {
      checks.push({
        constraint: 'minimum sequence number',
        status: 'UNKNOWN',
        detail,
        reason:
          'No account sequence number was supplied, so the minimum sequence requirement cannot be validated.',
      });
    } else {
      const accountSeq = BigInt(context.accountSequence);
      const minSeqBig = BigInt(minSeq);
      if (accountSeq >= minSeqBig) {
        checks.push({
          constraint: 'minimum sequence number',
          status: 'PASS',
          reference: context.accountSequence,
          detail,
          reason: `Account sequence ${context.accountSequence} satisfies the minimum ${minSeq}.`,
        });
      } else {
        checks.push({
          constraint: 'minimum sequence number',
          status: 'FAIL',
          reference: context.accountSequence,
          detail,
          reason: `Account sequence ${context.accountSequence} is below the required minimum ${minSeq}; the account sequence must advance first.`,
        });
      }
    }
  } else {
    checks.push({
      constraint: 'minimum sequence number',
      status: 'PASS',
      detail: 'Not configured',
      reason: 'No minimum sequence number precondition is set on the transaction.',
    });
  }

  // Minimum sequence age: seconds since the account's last sequence-increasing transaction.
  if (snapshot.minAccountSequenceAgeSeconds !== null) {
    const minAge = snapshot.minAccountSequenceAgeSeconds;
    const detail = `minSeqAge=${minAge} seconds`;
    if (context.accountSequenceTime === null) {
      checks.push({
        constraint: 'minimum sequence age',
        status: 'UNKNOWN',
        detail,
        reason:
          'No account sequence time was supplied, so the sequence-age requirement cannot be validated.',
      });
    } else {
      const lastBump = Date.parse(context.accountSequenceTime);
      const ageSeconds = Number.isFinite(lastBump)
        ? nowSeconds - Math.floor(lastBump / 1000)
        : null;
      if (ageSeconds === null || ageSeconds < 0) {
        checks.push({
          constraint: 'minimum sequence age',
          status: 'UNKNOWN',
          detail,
          reason: 'Unable to derive sequence age from the supplied account sequence time.',
        });
      } else if (ageSeconds >= minAge) {
        checks.push({
          constraint: 'minimum sequence age',
          status: 'PASS',
          detail,
          reason: `${ageSeconds} seconds have elapsed since the last sequence bump (required: ${minAge}s).`,
        });
      } else {
        checks.push({
          constraint: 'minimum sequence age',
          status: 'FAIL',
          detail,
          reason: `Only ${ageSeconds}s have elapsed since the last sequence bump; ${minAge}s required. Transaction is not yet valid.`,
        });
      }
    }
  } else {
    checks.push({
      constraint: 'minimum sequence age',
      status: 'PASS',
      detail: 'Not configured',
      reason: 'No minimum sequence-age precondition is set on the transaction.',
    });
  }

  // Minimum sequence ledger gap: ledgers since the last sequence-increasing transaction.
  if (snapshot.minAccountSequenceLedgerGap !== null) {
    const minGap = snapshot.minAccountSequenceLedgerGap;
    const detail = `minSeqLedgerGap=${minGap} ledgers`;
    if (context.accountSequenceLedger === null || context.referenceLedger === null) {
      checks.push({
        constraint: 'minimum sequence ledger gap',
        status: 'UNKNOWN',
        detail,
        reason:
          'Both the account sequence ledger and a reference ledger are required to validate the ledger gap.',
      });
    } else {
      const gap = context.referenceLedger - context.accountSequenceLedger;
      if (gap >= minGap) {
        checks.push({
          constraint: 'minimum sequence ledger gap',
          status: 'PASS',
          reference: String(context.referenceLedger),
          detail,
          reason: `${gap} ledger(s) have passed since the last sequence bump (required: ${minGap}).`,
        });
      } else {
        checks.push({
          constraint: 'minimum sequence ledger gap',
          status: 'FAIL',
          reference: String(context.referenceLedger),
          detail,
          reason: `Only ${gap} ledger(s) have passed since the last sequence bump; ${minGap} required.`,
        });
      }
    }
  } else {
    checks.push({
      constraint: 'minimum sequence ledger gap',
      status: 'PASS',
      detail: 'Not configured',
      reason: 'No minimum sequence-ledger-gap precondition is set on the transaction.',
    });
  }

  return checks;
}

/** Combines individual check statuses into one overall status. */
export function overallStatus(checks: PreconditionCheck[]): CheckStatus {
  if (checks.some((check) => check.status === 'FAIL')) return 'FAIL';
  if (checks.some((check) => check.status === 'UNKNOWN')) return 'UNKNOWN';
  return 'PASS';
}

// ──────────────────────────────────────────────────────────────────────────────
// Report assembly
// ──────────────────────────────────────────────────────────────────────────────

export function buildReport(
  transaction: {
    timeBounds: { minTime: string; maxTime: string } | undefined;
    ledgerBounds: { minLedger: number; maxLedger: number } | undefined;
    minAccountSequence: string | undefined;
    minAccountSequenceAge: { toString(): string } | undefined;
    minAccountSequenceLedgerGap: number | undefined;
    extraSigners: unknown[];
    source: string;
    sequence: string;
  },
  envelopeXdr: string,
  isFeeBump: boolean,
  context: ValidationContext,
  nowSeconds: number,
): PreconditionReport {
  const snapshot = inspectPreconditions(transaction);

  const checks: PreconditionCheck[] = [
    evaluateTimeBounds(snapshot.timeBounds, context.referenceTimeSeconds),
    evaluateLedgerBounds(snapshot.ledgerBounds, context.referenceLedger),
    ...evaluateSequencePreconditions(snapshot, context, nowSeconds),
  ];

  const notes: string[] = [
    'This is a local, read-only inspection. No transaction was signed or submitted.',
    'Passing local checks does not guarantee network acceptance: the network evaluates',
    'preconditions against its own clock and ledger state at processing time.',
    'Clock skew between your system and validator nodes can change time-bound results.',
    'Ledger state may advance between inspection and submission, changing ledger-bound results.',
  ];

  if (snapshot.preconditionType === 'none') {
    notes.unshift('No explicit preconditions are configured on this transaction.');
  } else {
    notes.unshift(
      `Precondition type detected: ${snapshot.preconditionType} (${[
        snapshot.timeBounds ? 'time bounds' : null,
        snapshot.ledgerBounds ? 'ledger bounds' : null,
        snapshot.minAccountSequence !== null ? 'minimum sequence' : null,
        snapshot.minAccountSequenceAgeSeconds !== null ? 'minimum sequence age' : null,
        snapshot.minAccountSequenceLedgerGap !== null ? 'minimum sequence ledger gap' : null,
      ]
        .filter(Boolean)
        .join(', ')})`,
    );
  }

  if (isFeeBump) {
    notes.push('This is a fee-bump envelope; preconditions below describe the inner transaction.');
  }

  return {
    envelopeXdr,
    isFeeBump,
    sourceAccount: transaction.source ?? null,
    sequence: transaction.sequence,
    preconditionType: snapshot.preconditionType,
    checks,
    overall: overallStatus(checks),
    notes,
  };
}

export function formatReport(report: PreconditionReport): string {
  const lines: string[] = [];
  const icon: Record<CheckStatus, string> = { PASS: '✓', FAIL: '✗', UNKNOWN: '?' };
  const overallIcon: Record<CheckStatus, string> = {
    PASS: '✓ PASS',
    FAIL: '✗ FAIL',
    UNKNOWN: '? UNKNOWN',
  };

  lines.push('══════════════════════════════════════════════════════════');
  lines.push('  Stellar Transaction Precondition Validation Report');
  lines.push('══════════════════════════════════════════════════════════');
  lines.push(
    `  Envelope type:        ${report.isFeeBump ? 'Fee-bump (inner transaction inspected)' : 'Transaction'}`,
  );
  lines.push(`  Source account:       ${report.sourceAccount ?? '(unavailable)'}`);
  lines.push(`  Transaction sequence: ${report.sequence}`);
  lines.push(`  Precondition type:    ${report.preconditionType}`);
  lines.push(`  Overall result:       ${overallIcon[report.overall]}`);
  lines.push('');

  lines.push('  Individual checks:');
  for (const check of report.checks) {
    lines.push(`    ${icon[check.status]} ${check.constraint}`);
    lines.push(`        Status:   ${check.status}`);
    if (check.reference) lines.push(`        Reference: ${check.reference}`);
    lines.push(`        Detail:   ${check.detail}`);
    lines.push(`        Reason:   ${check.reason}`);
    lines.push('');
  }

  lines.push('  Notes:');
  for (const note of report.notes) {
    lines.push(`  - ${note}`);
  }

  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────────
// Transaction construction (offline samples only — never submitted)
// ──────────────────────────────────────────────────────────────────────────────

function buildSampleTransaction(
  scenario: string,
  ledgerReference?: number,
): { transaction: TransactionLike; envelopeXdr: string } {
  const keypair = Keypair.random();
  const account = new Account(keypair.publicKey(), '1');
  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  });

  builder.addOperation(Operation.manageData({ name: 'precondition-demo', value: scenario }));

  const now = Math.floor(Date.now() / 1000);
  const minLedger = ledgerReference ?? 100000;

  switch (scenario) {
    case 'time-valid':
      builder.setTimebounds(now - 60, now + 600);
      break;
    case 'time-expired':
      builder.setTimebounds(0, now - 30);
      break;
    case 'time-not-yet':
      builder.setTimebounds(now + 3600, now + 7200);
      break;
    case 'ledger-valid':
      builder.setLedgerbounds(minLedger - 10, minLedger + 1000);
      break;
    case 'ledger-outside':
      builder.setLedgerbounds(minLedger + 5000, minLedger + 6000);
      break;
    case 'sequence':
      builder.setTimebounds(0, 0); // no preconditions besides the sequence itself
      break;
    default:
      builder.setTimebounds(0, 0); // 'none' scenario: no time-based expiry
      break;
  }

  const tx = builder.build();
  return {
    transaction: tx as unknown as TransactionLike,
    envelopeXdr: tx.toEnvelope().toXDR('base64'),
  };
}

interface TransactionLike {
  timeBounds: { minTime: string; maxTime: string } | undefined;
  ledgerBounds: { minLedger: number; maxLedger: number } | undefined;
  minAccountSequence: string | undefined;
  minAccountSequenceAge: { toString(): string } | undefined;
  minAccountSequenceLedgerGap: number | undefined;
  extraSigners: unknown[];
  source: string;
  sequence: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────────

export async function run(params: RunParams = {}): Promise<void> {
  const outputJson =
    params.json === true || params.json === 'true' || process.env.OUTPUT_JSON === 'true';
  const networkPassphrase = params.network === 'public' ? Networks.PUBLIC : Networks.TESTNET;
  const horizonUrl = params.horizonUrl || DEFAULT_HORIZON_URL;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const time = parseReferenceTime(params.referenceTime);

  console.log('Starting Transaction Precondition Validator...');
  console.log(`Network passphrase: ${networkPassphrase}`);
  console.log(`Reference time: ${time.iso} (${time.source})`);
  console.log(
    `Reference ledger: ${params.referenceLedger ?? '(not supplied — will query Horizon if needed)'}`,
  );

  // ── Obtain envelope (demo path builds an unsigned sample locally) ──
  let envelopeXdr: string;
  const scenario = params.scenario ?? DEFAULT_SCENARIO;

  if (params.envelopeXdr) {
    envelopeXdr = params.envelopeXdr;
  } else {
    console.log(
      `\nNo envelope supplied — building an unsigned local sample (scenario: ${scenario})...`,
    );
    const ledgerRef = params.referenceLedger ? Number(params.referenceLedger) : undefined;
    const sample = buildSampleTransaction(scenario, ledgerRef);
    envelopeXdr = sample.envelopeXdr;
  }

  // ── Parse envelope ──
  let transaction: {
    timeBounds: { minTime: string; maxTime: string } | undefined;
    ledgerBounds: { minLedger: number; maxLedger: number } | undefined;
    minAccountSequence: string | undefined;
    minAccountSequenceAge: { toString(): string } | undefined;
    minAccountSequenceLedgerGap: number | undefined;
    extraSigners: unknown[];
    source: string;
    sequence: string;
  };
  let isFeeBump = false;

  try {
    const parsed = TransactionBuilder.fromXDR(envelopeXdr, networkPassphrase);
    if (parsed instanceof FeeBumpTransaction) {
      isFeeBump = true;
      // Inspect the inner transaction; the outer fee-bump envelope carries the fees.
      transaction = parsed.innerTransaction as unknown as typeof transaction;
    } else {
      transaction = parsed as unknown as typeof transaction;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nFailed to parse transaction envelope: ${message}`);
    console.error('Ensure the input is base64-encoded transaction XDR for the selected network.');
    process.exitCode = 1;
    return;
  }

  // ── Resolve reference ledger from Horizon when not supplied ──
  let referenceLedger = params.referenceLedger ? Number(params.referenceLedger) : null;
  if (
    referenceLedger === null &&
    (transaction.ledgerBounds !== undefined ||
      scenario === 'ledger-valid' ||
      scenario === 'ledger-outside')
  ) {
    try {
      const server = new Horizon.Server(horizonUrl);
      const page = await server.ledgers().limit(1).order('desc').call();
      const latest = page.records[0];
      if (latest && typeof latest.sequence === 'number') {
        referenceLedger = latest.sequence;
        console.log(`Latest ledger from Horizon: ${referenceLedger}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`\nCould not query Horizon for the latest ledger: ${message}`);
      console.log(
        'Ledger-bound checks will be reported as UNKNOWN unless --reference-ledger is supplied.',
      );
    }
  }

  const context: ValidationContext = {
    referenceTimeSeconds: time.value,
    referenceLedger,
    accountSequence: params.accountSequence ?? null,
    accountSequenceTime: params.accountSequenceTime ?? null,
    accountSequenceLedger: params.accountSequenceLedger
      ? Number(params.accountSequenceLedger)
      : null,
  };

  const report = buildReport(transaction, envelopeXdr, isFeeBump, context, nowSeconds);

  // ── Output ──
  if (outputJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('\n' + formatReport(report));
  }

  console.log('\nTransaction precondition validation completed.');
  console.log('Remember: this was a read-only local inspection only.');
}
