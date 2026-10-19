/**
 * Example 261: Stellar Transaction Submission Diagnostics and Failure Analysis
 * (ISSUE-310).
 *
 * Submitting a transaction is where most Stellar failures surface. The
 * interesting part is not the failure itself but *how certain* we are about it:
 *
 *   - a `400 Bad Request` is definitive - the network rejected the envelope and
 *     nothing was applied;
 *   - a `429` or a `503` is a transport problem - the transaction may or may not
 *     have been recorded;
 *   - a socket timeout is the dangerous case: the request left the machine but
 *     the response never came back, so the transaction may already be on the
 *     ledger. Resubmitting blindly creates a duplicate payment.
 *
 * This example turns those raw signals into a structured, machine-readable
 * diagnostic report and shows how to settle an uncertain outcome by looking the
 * transaction hash up instead of resubmitting.
 *
 * Safety properties:
 *   - the example NEVER calls `submitTransaction`;
 *   - the only network calls it makes are read-only (`loadAccount`,
 *     `fetchBaseFee`, `transactions().transaction(hash)`);
 *   - the transaction it builds is left unsigned and printed as XDR for
 *     inspection only.
 */

import { Asset, Horizon, Operation, TransactionBuilder } from '@stellar/stellar-sdk';

import { accountId, asset } from '../utils/example-input';
import { resolveNetworkConfiguration } from './60-network-configuration';

/**
 * What we know about the submission once it returns (or fails to return).
 *
 * `applied` and `rejected` are *definite*: the ledger state is known.
 * `rate-limited`, `unavailable`, `malformed` and `uncertain` are transport-level
 * outcomes where a resubmission must not be attempted blindly.
 */
export type SubmissionOutcome =
  'applied' | 'rejected' | 'malformed' | 'rate-limited' | 'unavailable' | 'uncertain';

export interface SubmissionDiagnostic {
  outcome: SubmissionOutcome;
  /** True when the on-chain outcome is known with certainty. */
  definite: boolean;
  /** True when retrying the identical request is safe and useful. */
  retryable: boolean;
  transactionHash?: string;
  httpStatus?: number;
  resultCode?: string;
  /** 1-based index of the first operation that failed, when reported. */
  failedOperation?: number;
  summary: string;
  nextSteps: string[];
}

function normalizeHash(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/i.test(trimmed) ? trimmed : undefined;
}

/**
 * Map an HTTP status returned by Horizon onto a submission outcome.
 *
 * `409 Conflict` is treated as uncertain rather than rejected: Horizon uses it
 * for duplicate submissions and slow-ledger races where the original envelope
 * may still be applied.
 */
export function classifyHttpStatus(status: number): SubmissionDiagnostic {
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error(`HTTP status ${status} is not a valid status code`);
  }
  if (status === 200 || status === 201) {
    return {
      outcome: 'applied',
      definite: true,
      retryable: false,
      httpStatus: status,
      summary: 'Horizon accepted and applied the transaction envelope.',
      nextSteps: ['Confirm the result codes before treating the payment as final.'],
    };
  }
  if (status === 400) {
    return {
      outcome: 'rejected',
      definite: true,
      retryable: false,
      httpStatus: status,
      summary: 'Horizon rejected the envelope; nothing was applied to the ledger.',
      nextSteps: [
        'Decode the result codes and fix the reported cause before rebuilding.',
        'Never resubmit the same envelope: its sequence number is now consumed.',
      ],
    };
  }
  if (status === 404) {
    return {
      outcome: 'malformed',
      definite: true,
      retryable: false,
      httpStatus: status,
      summary: 'Horizon could not find the endpoint or referenced resource.',
      nextSteps: ['Check the Horizon URL, the resource path and every referenced account ID.'],
    };
  }
  if (status === 429) {
    return {
      outcome: 'rate-limited',
      definite: false,
      retryable: true,
      httpStatus: status,
      summary: 'Horizon is rate limiting this client; the envelope was not processed.',
      nextSteps: [
        'Back off for at least one full second and increase the wait between attempts.',
        'Look the hash up after the backoff in case an earlier attempt did land.',
      ],
    };
  }
  if (status >= 500) {
    return {
      outcome: 'unavailable',
      definite: false,
      retryable: true,
      httpStatus: status,
      summary: 'Horizon reported a server-side failure; the envelope may be unprocessed.',
      nextSteps: [
        'Retry with exponential backoff and jitter.',
        'Confirm the outcome by hash lookup before sending anything twice.',
      ],
    };
  }
  if (status === 409) {
    return {
      outcome: 'uncertain',
      definite: false,
      retryable: false,
      httpStatus: status,
      summary: 'Horizon reported a conflict; the original envelope may still apply.',
      nextSteps: ['Resolve by hash lookup instead of resubmitting the same envelope.'],
    };
  }
  return {
    outcome: 'uncertain',
    definite: false,
    retryable: false,
    httpStatus: status,
    summary: `Unexpected HTTP status ${status}; the submission outcome is unknown.`,
    nextSteps: ['Resolve the outcome by hash lookup before retrying.'],
  };
}

/**
 * Interpret a Horizon submission response body.
 *
 * Accepts both the success payload (`{ hash, ledger, successful, result_codes }`)
 * and the Problem Details error payload (`{ type, title, status, detail, extras }`).
 * Anything else is reported as malformed rather than guessed at.
 */
export function diagnoseSubmissionResponse(payload: unknown): SubmissionDiagnostic {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      outcome: 'malformed',
      definite: true,
      retryable: false,
      summary: 'Horizon returned a body that is not a transaction object.',
      nextSteps: ['Verify that HORIZON_URL points at a Horizon server.'],
    };
  }

  const body = payload as Record<string, unknown>;
  const hash = normalizeHash(body.hash);
  const extras =
    body.extras && typeof body.extras === 'object'
      ? (body.extras as Record<string, unknown>)
      : undefined;

  const transactionCode =
    typeof body.result_code === 'string'
      ? body.result_code
      : extras && typeof extras.result_code === 'string'
        ? extras.result_code
        : undefined;

  const operationCodes: string[] = [];
  const resultCodes = body.result_codes as { operations?: string[] } | undefined;
  if (resultCodes?.operations?.length) {
    operationCodes.push(...resultCodes.operations);
  }
  const extrasCodes = extras?.result_codes as { operations?: string[] } | undefined;
  if (extrasCodes?.operations?.length) {
    operationCodes.push(...extrasCodes.operations);
  }

  const failedOperation =
    operationCodes.length > 0
      ? operationCodes.findIndex((code) => code.toLowerCase() !== 'op_success') + 1
      : undefined;
  const resultCode = transactionCode?.toLowerCase();

  // Success payload: Horizon echoes the hash back only for processed envelopes.
  if (hash && (body.successful === true || resultCode === 'tx_success')) {
    return {
      outcome: 'applied',
      definite: true,
      retryable: false,
      transactionHash: hash,
      resultCode,
      summary: 'Horizon applied the transaction envelope.',
      nextSteps: ['Inspect the operation result codes before treating the effect as final.'],
    };
  }

  if (hash && (body.successful === false || resultCode)) {
    return {
      outcome: 'rejected',
      definite: true,
      retryable: false,
      transactionHash: hash,
      resultCode,
      failedOperation,
      summary: `The envelope reached the ledger and failed with ${resultCode ?? 'tx_failed'}.`,
      nextSteps: [
        'Rebuild the transaction with a fresh sequence number after fixing the cause.',
        'A failed envelope still consumes its sequence number.',
      ],
    };
  }

  // Problem Details payload.
  const status = typeof body.status === 'number' ? body.status : undefined;
  if (status !== undefined) {
    const base = classifyHttpStatus(status);
    const detail = typeof body.detail === 'string' ? body.detail : undefined;
    const title = typeof body.title === 'string' ? body.title : undefined;
    return {
      ...base,
      transactionHash: hash,
      resultCode,
      failedOperation,
      summary: [title, detail].filter(Boolean).join(' - ') || base.summary,
    };
  }

  return {
    outcome: 'malformed',
    definite: true,
    retryable: false,
    transactionHash: hash,
    resultCode,
    failedOperation,
    summary: 'Horizon returned a body without a status, hash or result code.',
    nextSteps: ['Verify that HORIZON_URL points at a Horizon server.'],
  };
}

/**
 * Interpret a thrown submission error.
 *
 * Anything that happened before a response was received leaves the outcome
 * unknown, which is the case that causes duplicate payments when handled
 * carelessly.
 */
export function classifySubmissionError(error: unknown): SubmissionDiagnostic {
  const candidate = (error ?? {}) as {
    response?: { status?: unknown };
    code?: unknown;
    message?: unknown;
  };
  const status = candidate.response?.status;
  if (typeof status === 'number') {
    const base = classifyHttpStatus(status);
    return {
      ...base,
      summary:
        typeof candidate.message === 'string' && candidate.message.trim()
          ? `${base.summary} (${candidate.message.trim()})`
          : base.summary,
    };
  }

  const code = typeof candidate.code === 'string' ? candidate.code.toUpperCase() : undefined;
  const message =
    typeof candidate.message === 'string' && candidate.message.trim()
      ? candidate.message.trim()
      : 'The request failed before a response was received.';
  const timedOut = code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT';
  const uncertain = code !== undefined && /ETIMEDOUT|ECONNRESET|EAI_AGAIN/.test(code);

  return {
    outcome: uncertain || timedOut ? 'uncertain' : 'malformed',
    definite: false,
    retryable: false,
    httpStatus: undefined,
    summary: uncertain || timedOut ? `Submission outcome unknown: ${message}` : message,
    nextSteps: [
      'Do NOT resubmit the same envelope - it may already be on the ledger.',
      'Look the transaction hash up and let the ledger decide the outcome.',
      'Only rebuild after the hash lookup reports the envelope as missing.',
    ],
  };
}

/**
 * Settle an uncertain submission by looking the hash up on the ledger.
 *
 * `lookup` is injected so the decision logic can be tested without a network:
 * it resolves with the Horizon record, or with `null` when the hash is unknown
 * to the ledger (HTTP 404).
 */
export async function resolveUncertainOutcome(
  transactionHash: string,
  lookup: (hash: string) => Promise<Record<string, unknown> | null>,
): Promise<{
  diagnostic: SubmissionDiagnostic;
  transaction?: Record<string, unknown>;
}> {
  const hash = normalizeHash(transactionHash);
  if (!hash) throw new Error('Expected a 64-character hexadecimal transaction hash');

  let record: Record<string, unknown> | null;
  try {
    record = await lookup(hash);
  } catch (error) {
    return {
      diagnostic: {
        outcome: 'uncertain',
        definite: false,
        retryable: false,
        transactionHash: hash,
        summary: `Ledger lookup failed, so the outcome is still unknown: ${
          error instanceof Error ? error.message : String(error)
        }`,
        nextSteps: ['Retry the lookup later; do not resubmit the envelope in the meantime.'],
      },
    };
  }

  if (!record) {
    return {
      diagnostic: {
        outcome: 'rejected',
        definite: true,
        retryable: false,
        transactionHash: hash,
        summary: 'The ledger has no record of this hash, so the envelope was never applied.',
        nextSteps: ['Rebuild the transaction with a fresh sequence number before retrying.'],
      },
    };
  }

  const operationCodes = (record.result_codes as { operations?: string[] } | undefined)?.operations;
  const succeeded =
    record.successful === true &&
    (operationCodes === undefined ||
      operationCodes.every((code) => code.toLowerCase() === 'op_success'));

  return {
    diagnostic: {
      outcome: succeeded ? 'applied' : 'rejected',
      definite: true,
      retryable: false,
      transactionHash: hash,
      resultCode: (record.result_code as string | undefined)?.toLowerCase(),
      failedOperation: undefined,
      summary: succeeded ? 'Transaction applied successfully' : 'Transaction failed',
      nextSteps: ['Inspect result codes before treating the effect as final.'],
    },
    transaction: record,
  };
}

/**
 * Read-only checks that catch the failures a submission would otherwise report
 * as a `400`. Nothing here mutates the network.
 */
export async function preflight(
  server: Horizon.Server,
  sourceAccountId: string,
  destinationId: string,
  paymentAsset: Asset,
  amountValue: string,
): Promise<{ check: string; ok: boolean; detail: string }[]> {
  const findings: {
    check: string;
    ok: boolean;
    detail: string;
  }[] = [];

  const source = await server.loadAccount(sourceAccountId).catch(() => null);
  if (!source) {
    findings.push({
      check: 'source-account',
      ok: false,
      detail: 'The source account does not exist or is not funded.',
    });
  } else {
    findings.push({
      check: 'source-account',
      ok: true,
      detail: `Sequence ${source.sequenceNumber()}, subentries ${source.subentry_count}.`,
    });
  }

  const destination = await server.loadAccount(destinationId).catch(() => null);
  findings.push({
    check: 'destination-account',
    ok: Boolean(destination),
    detail: destination
      ? 'The destination account exists.'
      : 'The destination account does not exist; a payment would fail with op_no_destination.',
  });

  if (!paymentAsset.isNative()) {
    const issuer = await server.loadAccount(paymentAsset.getIssuer()).catch(() => null);
    findings.push({
      check: 'issuer',
      ok: Boolean(issuer),
      detail: issuer
        ? 'The asset issuer exists.'
        : 'The asset issuer could not be loaded; the payment would fail with op_no_issuer.',
    });
  }

  findings.push({
    check: 'amount',
    ok: /^0*\.\d{1,7}$/.test(amountValue) || /^\d+(\.\d{1,7})?$/.test(amountValue),
    detail: `Payment amount ${amountValue} uses at most seven decimal places.`,
  });

  return findings;
}

/** Render a submission diagnostic as human-readable text. */
export function formatSubmissionReport(
  diagnostic: SubmissionDiagnostic,
  findings: {
    check: string;
    ok: boolean;
    detail: string;
  }[],
): string {
  const lines = [
    '=== Stellar Submission Diagnostics ===',
    `Outcome: ${diagnostic.outcome}`,
    `Definite: ${diagnostic.definite ? 'yes' : 'no'}`,
    `Safe to retry the same envelope: ${diagnostic.retryable ? 'yes' : 'no'}`,
    `Summary: ${diagnostic.summary}`,
  ];
  if (diagnostic.transactionHash) lines.push(`Transaction hash: ${diagnostic.transactionHash}`);
  if (diagnostic.httpStatus !== undefined) lines.push(`HTTP status: ${diagnostic.httpStatus}`);
  if (diagnostic.resultCode) lines.push(`Result code: ${diagnostic.resultCode}`);
  if (diagnostic.failedOperation !== undefined)
    lines.push(`First failing operation: #${diagnostic.failedOperation}`);

  lines.push('');
  lines.push('Checks:');
  for (const f of findings) lines.push(`  [${f.ok ? 'ok' : '!!'}] ${f.check}: ${f.detail}`);

  lines.push('');
  lines.push('Next steps:');
  for (const step of diagnostic.nextSteps) lines.push(`  - ${step}`);

  return lines.join('\n');
}

/**
 * Run the diagnostics. No transaction is ever submitted: the example builds an
 * unsigned envelope for inspection and then explains what each possible
 * submission outcome would mean.
 */
export async function run(): Promise<void> {
  const config = resolveNetworkConfiguration();
  const sourceAccountId = accountId(process.env.SOURCE_ACCOUNT);
  const destinationId = accountId(process.env.DESTINATION_ACCOUNT);
  const paymentAsset = asset(process.env.PAYMENT_ASSET);
  const amountValue = process.env.PAYMENT_AMOUNT || '1';
  const server = new Horizon.Server(config.horizonUrl);

  // Unsigned and unsubmitted: printed so the envelope can be inspected offline.
  const account = await server.loadAccount(sourceAccountId).catch(() => {
    throw new Error('The source account could not be loaded from Horizon');
  });

  const transaction = new TransactionBuilder(account, {
    fee: String(await server.fetchBaseFee().catch(() => 100)),
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: destinationId,
        asset: paymentAsset,
        amount: amountValue,
      }),
    )
    .setTimeout(180)
    .build();

  const findings = await preflight(
    server,
    sourceAccountId,
    destinationId,
    paymentAsset,
    amountValue,
  );

  const diagnostic = classifySubmissionError({
    message: 'No submission was attempted; this is a pre-submission diagnostic.',
  });

  const report = formatSubmissionReport(diagnostic, findings);

  console.log('Unsigned envelope below. It is never signed or submitted by this example.');
  console.log(report);
  console.log('Unsigned XDR:', transaction.toXDR());
}

if (require.main === module) {
  run().catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
