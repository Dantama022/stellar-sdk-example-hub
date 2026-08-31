import { BASE_FEE, Networks, StrKey, TransactionBuilder } from '@stellar/stellar-sdk';

export interface PreflightParams {
  envelopeXdr?: string;
  networkPassphrase?: string;
  expectedSequence?: string;
  jsonOutput?: boolean;
}

export type CheckLevel = 'pass' | 'warning' | 'error';

export interface PreflightCheck {
  name: string;
  level: CheckLevel;
  detail: string;
}

export type PreflightStatus = 'ready' | 'warning' | 'failed';

export interface PreflightReport {
  status: PreflightStatus;
  checks: PreflightCheck[];
  passed: number;
  warnings: number;
  errors: number;
}

function check(name: string, level: CheckLevel, detail: string): PreflightCheck {
  return { name, level, detail };
}

/**
 * Runs read-only structural checks on a decoded transaction envelope.
 *
 * The transaction is never signed or submitted — every check is either
 * offline or based on state supplied by the caller.
 */
export function validateEnvelope(
  envelopeXdr: string,
  networkPassphrase: string,
  expectedSequence?: string,
): PreflightReport {
  const checks: PreflightCheck[] = [];

  let tx;
  try {
    tx = TransactionBuilder.fromXDR(envelopeXdr, networkPassphrase);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return buildReport([check('envelope', 'error', `Envelope could not be decoded: ${message}`)]);
  }

  if ('innerTransaction' in tx) {
    checks.push(check('envelope', 'pass', 'Fee-bump envelope decoded'));
    tx = tx.innerTransaction;
  } else {
    checks.push(check('envelope', 'pass', 'Transaction envelope decoded'));
  }

  checks.push(
    StrKey.isValidEd25519PublicKey(tx.source) || tx.source.startsWith('M')
      ? check('source', 'pass', `Source account ${tx.source}`)
      : check('source', 'error', `Invalid source account ${tx.source}`),
  );

  checks.push(check('network', 'pass', `Network passphrase: ${networkPassphrase}`));

  const operationCount = tx.operations.length;
  checks.push(
    operationCount > 0
      ? check('operations', 'pass', `${operationCount} operation(s) present`)
      : check('operations', 'error', 'Transaction contains no operations'),
  );

  const fee = Number(tx.fee);
  const minimumFee = Number(BASE_FEE) * Math.max(operationCount, 1);
  if (fee < minimumFee) {
    checks.push(check('fee', 'error', `Fee ${fee} is below the minimum ${minimumFee} stroops`));
  } else if (fee === minimumFee) {
    checks.push(check('fee', 'warning', `Fee ${fee} equals the minimum and may be crowded out`));
  } else {
    checks.push(check('fee', 'pass', `Fee ${fee} stroops covers ${operationCount} operation(s)`));
  }

  if (expectedSequence) {
    const expectedNext = (BigInt(expectedSequence) + BigInt(1)).toString();
    checks.push(
      tx.sequence === expectedNext
        ? check('sequence', 'pass', `Sequence ${tx.sequence} follows account sequence`)
        : check('sequence', 'error', `Sequence ${tx.sequence} should be ${expectedNext}`),
    );
  } else {
    checks.push(check('sequence', 'warning', 'Account sequence unavailable — skipped comparison'));
  }

  const timeBounds = tx.timeBounds;
  if (!timeBounds) {
    checks.push(check('timeBounds', 'warning', 'No time bounds set — transaction never expires'));
  } else if (Number(timeBounds.maxTime) !== 0 && Number(timeBounds.maxTime) < Date.now() / 1000) {
    checks.push(check('timeBounds', 'error', 'Time bounds have already expired'));
  } else {
    checks.push(check('timeBounds', 'pass', 'Time bounds are valid'));
  }

  checks.push(
    check('memo', 'pass', `Memo type: ${tx.memo.type}`),
  );

  return buildReport(checks);
}

function buildReport(checks: PreflightCheck[]): PreflightReport {
  const errors = checks.filter((c) => c.level === 'error').length;
  const warnings = checks.filter((c) => c.level === 'warning').length;
  const passed = checks.filter((c) => c.level === 'pass').length;
  const status: PreflightStatus = errors > 0 ? 'failed' : warnings > 0 ? 'warning' : 'ready';

  return { status, checks, passed, warnings, errors };
}

export function formatReport(report: PreflightReport): string {
  const icon: Record<CheckLevel, string> = { pass: '✔', warning: '⚠', error: '✖' };

  return [
    ...report.checks.map((c) => `${icon[c.level]} ${c.name}: ${c.detail}`),
    '',
    `Passed: ${report.passed} | Warnings: ${report.warnings} | Errors: ${report.errors}`,
    `Preflight status: ${report.status.toUpperCase()}`,
    'The transaction was NOT submitted.',
  ].join('\n');
}

/**
 * Runs the transaction preflight validation example.
 */
export async function run(params: PreflightParams = {}): Promise<void> {
  const envelopeXdr = params.envelopeXdr || process.env.TRANSACTION_XDR;
  const networkPassphrase = params.networkPassphrase || Networks.TESTNET;

  if (!envelopeXdr) {
    throw new Error('Provide a transaction envelope XDR via the envelopeXdr parameter or TRANSACTION_XDR');
  }

  const report = validateEnvelope(envelopeXdr, networkPassphrase, params.expectedSequence);

  if (params.jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(formatReport(report));
}
