import { Horizon } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';

/**
 * The four observation stages a transaction submission can end up in:
 * - local_validation:   the SDK rejected the request before anything left the
 *                       application (bad hash/XDR shape, invalid sequence, etc.)
 * - network_submission: the network reacted without giving a ledger outcome
 *                       (transport error, 429 rate limit, malformed envelope)
 * - confirmed_ledger:   a transaction hash has a terminal result on a ledger
 * - ambiguous_outcome:  submission timed out or the connection died; the
 *                       transaction may or may not still be included
 */
export type SubmissionStage =
  | 'local_validation'
  | 'network_submission'
  | 'confirmed_ledger'
  | 'ambiguous_outcome';

export type Disposition =
  | 'fix_and_rebuild'
  | 'lookup_by_hash'
  | 'wait_and_lookup'
  | 'review_and_correct'
  | 'nothing_to_do';

export interface FeeSummary {
  requestedMaxFee: string | null;
  feeCharged: string | null;
  feePayingAccount: string | null;
  feeBump: boolean;
}

export interface OperationOutcome {
  index: number;
  code: string;
  failed: boolean;
  explanation: string;
}

export interface SubmissionDiagnosticsReport {
  stage: SubmissionStage;
  terminal: boolean;
  disposition: Disposition;
  headline: string;
  summary: string;
  hash: string | null;
  ledgerSequence: number | null;
  ledgerClosedAt: string | null;
  fee: FeeSummary | null;
  resultCode: string | null;
  operationResults: OperationOutcome[];
  errorDetail: string | null;
  recoverySteps: string[];
  safetyNotes: string[];
  observed: string;
}

export interface SubmissionDiagnosticsParams {
  transactionHash?: string;
  horizonUrl?: string;
  json?: boolean | string;
}

const STAGE_SUMMARY: Record<SubmissionStage, string> = {
  local_validation:
    'The transaction never left this application, so no network state was touched.',
  network_submission:
    'The network rejected or failed the request without providing a ledger outcome; ' +
    'the transaction is not knowably on a ledger, and it may or may not have been received.',
  confirmed_ledger:
    'A transaction hash exists with a terminal result on a closed ledger.',
  ambiguous_outcome:
    'The submission returned no usable response. The transaction may still be pending ' +
    'inclusion, or it may have been dropped; only a hash lookup can resolve this.',
};

const TX_CODE_EXPLANATIONS: Record<string, string> = {
  tx_success: 'The transaction was applied to the ledger.',
  tx_failed: 'One or more operations failed — inspect the per-operation results.',
  tx_bad_seq: 'The transaction sequence number did not match the source account.',
  tx_insufficient_fee: 'The declared fee was below the ledger minimum at inclusion time.',
  tx_insufficient_balance:
    'The source account could not cover the fee plus its minimum reserve.',
  tx_too_early: 'The current ledger is earlier than the transaction time bounds allow.',
  tx_too_late: 'The transaction time bounds expired before inclusion.',
  tx_no_source_account: 'The source account does not exist on this network.',
  tx_bad_auth: 'The combined signature weight is below the required threshold.',
  tx_bad_auth_extra: 'There are more signatures than possible signers on the account.',
  tx_missing_operation: 'The transaction envelope contains no operations.',
  tx_internal_error: 'An unexpected internal error occurred while applying the transaction.',
};

const OP_CODE_EXPLANATIONS: Record<string, string> = {
  op_success: 'The operation succeeded.',
  op_underfunded: 'The source balance is too low to fund this operation.',
  op_no_destination: 'The destination account does not exist.',
  op_no_trust: 'The destination has no trustline for this asset.',
  op_line_full: 'The destination trustline limit would be exceeded.',
  op_low_reserve: 'The result would drop the destination below the minimum reserve.',
  op_insufficient_balance: 'The account balance cannot cover the amount plus reserves.',
  op_malformed: 'The operation parameters are malformed or out of range.',
  op_bad_auth: 'The operation is not authorized by the required signers.',
  op_no_issuer: 'The asset issuer account does not exist.',
  op_expired: 'The operation referenced lapsed claimable or ledger state.',
};

const TX_REMEDIATION: Record<string, string> = {
  tx_bad_seq:
    'Reload the source account from Horizon and rebuild with the current sequence number.',
  tx_insufficient_fee:
    'Raise the declared fee (or wrap the envelope in a fee-bump) and rebuild from scratch.',
  tx_insufficient_balance:
    'Fund the source account, drop unneeded subentries, or lower the requested amount.',
  tx_too_early:
    'Rebuild with time bounds whose earliest bound is at or before the current ledger time.',
  tx_too_late: 'Rebuild with a fresh, longer time-bounds window before resubmitting.',
  tx_no_source_account:
    'Verify the account exists on the selected network and that the passphrase matches.',
  tx_bad_auth:
    'Collect the missing co-signer signatures and reassemble the envelope before resubmitting.',
  tx_missing_operation: 'Rebuild the transaction with at least one operation.',
};

const OP_REMEDIATION: Record<string, string> = {
  op_underfunded: 'Fund the source account or reduce the operation amount.',
  op_no_destination: 'First create the destination with a create_account operation.',
  op_no_trust: 'The destination must establish a trustline for this asset before receiving it.',
  op_line_full:
    'The destination must raise its trustline limit or hold less of the asset first.',
  op_low_reserve:
    'The destination must hold the subentry reserves before this operation can land.',
  op_bad_auth: 'Attach signatures for every account and signer this operation requires.',
  op_malformed: 'Correct the operation parameters (asset, amounts, address shapes) and rebuild.',
};

const DISPOSITION_STEPS: Record<Disposition, string[]> = {
  fix_and_rebuild: [
    'Resolve the reported local problem (hash/XDR shape, sequence data, builder settings).',
    'Rebuild the transaction from a fresh Horizon account view and rebuild its signatures.',
    'Resubmitting after a rebuild is safe here because nothing was ever broadcast.',
  ],
  lookup_by_hash: [
    'Query Horizon (or Soroban RPC) by transaction hash and classify its terminal status.',
    'If the record is confirmed, use its fee, ledger sequence, and operation results as the diagnosis.',
    'If still not found, treat the outcome as unresolved and continue with the wait-and-lookup plan.',
  ],
  wait_and_lookup: [
    'Do not blindly resubmit: the original transaction may still be pending inclusion.',
    'Poll every reachable endpoint by transaction hash on an interval until a terminal result appears.',
    'Only after the polling window is exhausted, rebuild with a fresh sequence number so the old envelope can never be replayed.',
  ],
  review_and_correct: [
    'Start from the failing operation index and its result code, not from the top-level transaction status.',
    'Apply the per-code remediation to the failing operation and correct the transaction inputs.',
    'Rebuild with the current sequence number so the corrected envelope cannot collide with the failed one.',
  ],
  nothing_to_do: [
    'Record the transaction hash and the ledger sequence as the final source of truth.',
    'Confirm the intended side effects (balances, contract state) match the operation results.',
  ],
};

const SAFETY_NOTES: Record<SubmissionStage, string[]> = {
  local_validation: [
    'No transaction was broadcast, so there is no double-submission risk to evaluate.',
    'Secret keys are never printed or persisted by this diagnostic flow.',
  ],
  network_submission: [
    'A submission rejection with no hash is definitive: the envelope was not accepted for inclusion.',
    'Entering a resubmit loop while a submission is still in flight can double-charge fees or repeat effects.',
  ],
  confirmed_ledger: [
    'A confirmed result is authoritative; success and failure cannot later change.',
    'XDR and hashes are safe to share; secret keys are never part of this report.',
  ],
  ambiguous_outcome: [
    'Never resubmit the same sequence envelope while the original may still be pending.',
    'The hash may be unknown when the connection died before a response was produced; keep the envelope for correlation.',
  ],
};

const HASH_PATTERN = /^[0-9a-fA-F]{64}$/;

export function isValidTransactionHash(hash: string): boolean {
  return HASH_PATTERN.test(hash);
}

function explainTxCode(code: string): string {
  return (
    TX_CODE_EXPLANATIONS[code] || `Unrecognized transaction result code "${code}" — preserved as-is.`
  );
}

function explainOpCode(code: string): string {
  return (
    OP_CODE_EXPLANATIONS[code] || `Unrecognized operation result code "${code}" — preserved as-is.`
  );
}

function remediationFor(
  txCode: string | null,
  operationResults: OperationOutcome[],
): string[] {
  const hints: string[] = [];
  const apply = (code: string, map: Record<string, string>) => {
    const hint = map[code];
    if (hint && !hints.includes(hint)) hints.push(hint);
  };
  if (txCode) apply(txCode, TX_REMEDIATION);
  const failing = operationResults.filter((op) => op.failed).map((op) => op.code);
  for (const code of failing) apply(code, OP_REMEDIATION);
  return hints;
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

function pickNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value;
  return undefined;
}

export interface OutcomeObservation {
  stage: SubmissionStage;
  hash?: string;
  successful?: boolean;
  ledger?: number;
  createdAt?: string;
  feeCharged?: string;
  maxFee?: string;
  feePayingAccount?: string;
  resultCode?: string;
  operationCodes?: string[];
  errorDetail?: string;
  source?: string;
}

function normalizeResultCodes(record: Record<string, any>): {
  transaction: string | null;
  operations: string[];
} {
  const extras = record.extras || {};
  const bundled = extras.result_codes || record.result_codes || {};
  const transaction = pickString(
    bundled.transaction,
    record.result_code,
    record.transactionResultCode,
  );
  const operations = (
    record.operation_codes ||
    record.operationCodes ||
    bundled.operations ||
    []
  )
    .map((code: unknown) => (typeof code === 'string' ? code : null))
    .filter((code: string | null): code is string => code !== null);
  return { transaction, operations };
}

/**
 * Classifies an observation into one of the four submission stages and
 * produces a structured diagnostic report. Unknown codes are preserved
 * rather than rejected, so never-before-seen results remain auditable.
 */
export function buildSubmissionDiagnostics(
  observation: OutcomeObservation,
): SubmissionDiagnosticsReport {
  const stage = observation.stage;
  const summary = STAGE_SUMMARY[stage];

  let terminal = false;
  let disposition: Disposition;
  let headline: string;
  let hash: string | null = null;
  let ledgerSequence: number | null = null;
  let ledgerClosedAt: string | null = null;
  let fee: FeeSummary | null = null;
  let resultCode: string | null = null;
  let operationResults: OperationOutcome[] = [];
  let errorDetail = pickString(observation.errorDetail);

  if (stage === 'local_validation') {
    disposition = 'fix_and_rebuild';
    headline = 'Local validation failed before submission';
    if (!errorDetail) errorDetail = 'The SDK rejected the request locally; no error detail was supplied.';
  } else if (stage === 'network_submission') {
    disposition = errorDetail ? 'lookup_by_hash' : 'review_and_correct';
    // A transport-level timeout with no usable response is ambiguous, not a rejection.
    if (/timeout|timed out|504|connection (lost|reset|closed)/i.test(errorDetail || '')) {
      disposition = 'wait_and_lookup';
    }
    headline = 'Network submission did not produce a ledger outcome';
    if (!errorDetail) errorDetail = 'The submission endpoint rejected the request without detail.';
  } else if (stage === 'ambiguous_outcome') {
    disposition = 'wait_and_lookup';
    headline = 'Submission outcome is unresolved (timeout or dropped connection)';
    if (!errorDetail) errorDetail = 'No response was received before the submission window closed.';
  } else {
    terminal = true;
    hash = pickString(observation.hash);
    ledgerSequence = pickNumber(observation.ledger);
    ledgerClosedAt = pickString(observation.createdAt);
    const successful = observation.successful === true;
    resultCode = pickString(observation.resultCode);
    disposition = successful ? 'nothing_to_do' : 'review_and_correct';
    headline = successful
      ? 'Transaction confirmed successful on a closed ledger'
      : 'Transaction confirmed failed on a closed ledger';
    fee = {
      requestedMaxFee: pickString(observation.maxFee),
      feeCharged: pickString(observation.feeCharged),
      feePayingAccount: pickString(observation.feePayingAccount),
      feeBump: Boolean(observation.feePayingAccount),
    };
    operationResults = (observation.operationCodes || []).map((code, index) => ({
      index,
      code,
      failed: code !== 'op_success',
      explanation: explainOpCode(code),
    }));
    errorDetail = null;
  }

  const appliedRemediation = terminal ? remediationFor(resultCode, operationResults) : [];
  const recoverySteps =
    appliedRemediation.length > 0
      ? [...DISPOSITION_STEPS[disposition], ...appliedRemediation]
      : DISPOSITION_STEPS[disposition];

  return {
    stage,
    terminal,
    disposition,
    headline,
    summary,
    hash,
    ledgerSequence,
    ledgerClosedAt,
    fee,
    resultCode,
    operationResults,
    errorDetail,
    recoverySteps,
    safetyNotes: SAFETY_NOTES[stage],
    observed: observation.source || (hash ? `hash:${hash}` : 'local observation'),
  };
}

/**
 * Turns a Horizon transaction record (or a submission response body) into the
 * confirmed-ledger observation shape used by buildSubmissionDiagnostics.
 */
export function observationFromHorizonRecord(record: unknown): OutcomeObservation {
  if (!record || typeof record !== 'object') {
    throw new Error('Expected a Horizon transaction record object');
  }
  const raw = record as Record<string, any>;
  const codes = normalizeResultCodes(raw);
  const extras = raw.extras || {};
  return {
    stage: 'confirmed_ledger',
    hash: asString(raw.hash),
    successful: raw.successful === true,
    ledger: Number.isSafeInteger(Number(raw.ledger)) ? Number(raw.ledger) : undefined,
    createdAt: asString(raw.created_at),
    feeCharged: asString(raw.fee_charged),
    maxFee: asString(raw.max_fee),
    feePayingAccount: undefined,
    resultCode: codes.transaction || (raw.successful === true ? 'tx_success' : 'tx_failed'),
    operationCodes: codes.operations,
    errorDetail: asString(extras.envelope_xdr) ? `envelope_xdr: ${extras.envelope_xdr}` : undefined,
    source: 'horizon_lookup',
  };
}

export function lookupObservationForUnknownHash(horizonUrl: string): OutcomeObservation {
  return {
    stage: 'network_submission',
    errorDetail: `Horizon at ${horizonUrl} has no record for the supplied hash. The transaction may still be pending, was never accepted, or has been pruned from history.`,
    source: 'hash_not_found',
  };
}

export function formatSubmissionDiagnostics(report: SubmissionDiagnosticsReport): string {
  const lines = [
    '=== Stellar Transaction Submission Diagnostics ===',
    `Stage:        ${report.stage}`,
    `Terminal:     ${report.terminal ? 'yes' : 'no'}`,
    `Disposition:  ${report.disposition}`,
    `Headline:     ${report.headline}`,
    `Hash:         ${report.hash || 'unknown'}`,
    `Ledger:       ${report.ledgerSequence ?? 'unknown'}`,
    `Closed at:    ${report.ledgerClosedAt ?? 'unknown'}`,
  ];

  if (report.fee) {
    lines.push(
      `Requested max fee: ${report.fee.requestedMaxFee ?? 'unknown'}`,
      `Fee charged:       ${report.fee.feeCharged ?? 'unknown'}`,
      report.fee.feeBump ? 'Fee source:        fee-bump envelope' : 'Fee source:        transaction source account',
    );
  }

  lines.push('', `Summary: ${report.summary}`);
  if (report.resultCode) {
    lines.push(`Result code:  ${report.resultCode} — ${explainTxCode(report.resultCode)}`);
  }
  if (report.errorDetail) lines.push(`Detail:       ${report.errorDetail}`);

  if (report.operationResults.length > 0) {
    lines.push('', 'Operation results:');
    for (const op of report.operationResults) {
      lines.push(
        `  [${op.index}] ${op.failed ? 'FAILED' : 'ok     '} ${op.code} — ${op.explanation}`,
      );
    }
  }

  lines.push('', 'Recovery guidance:');
  for (const step of report.recoverySteps) lines.push(`  - ${step}`);
  lines.push('', 'Safety notes:');
  for (const note of report.safetyNotes) lines.push(`  - ${note}`);
  return lines.join('\n');
}

interface OutcomeSample {
  label: string;
  observation: OutcomeObservation;
}

/**
 * Illustrative submissions for the four stages. These are deliberately
 * synthetic observation shapes; no keys, no real network access.
 */
export const OUTCOME_SAMPLES: OutcomeSample[] = [
  {
    label: 'local validation error (SDK threw before any request)',
    observation: {
      stage: 'local_validation',
      errorDetail: 'Transaction XDR failed to parse: base64 buffer is not a valid envelope',
      source: 'sdk_parse_error',
    },
  },
  {
    label: 'network submission rejection (rate limited)',
    observation: {
      stage: 'network_submission',
      resultCode: 'tx_insufficient_fee',
      errorDetail: 'HTTP 400: tx_insufficient_fee — fee 100 is below ledger minimum 100000',
      source: 'horizon_400',
    },
  },
  {
    label: 'confirmed ledger result (success)',
    observation: {
      stage: 'confirmed_ledger',
      hash: '8f2a4d0c1b9e7a6f5d4c3b2a1908f7e6d5c4b3a2190807f6e5d4c3b2a1908f7e',
      successful: true,
      ledger: 51234567,
      createdAt: '2026-10-22T14:03:12Z',
      maxFee: '100000',
      feeCharged: '300',
      resultCode: 'tx_success',
      operationCodes: ['op_success', 'op_success'],
      source: 'horizon_lookup:sample',
    },
  },
  {
    label: 'confirmed ledger result (operation failure)',
    observation: {
      stage: 'confirmed_ledger',
      hash: 'b7c1e9f2a4d6c8e0f2a4b6d8c0e2f4a6b8d0c2e4f6a8b0c2d4e6f8a0b2c4d6e8f',
      successful: false,
      ledger: 51234568,
      createdAt: '2026-10-22T14:05:40Z',
      maxFee: '100000',
      feeCharged: '300',
      resultCode: 'tx_failed',
      operationCodes: ['op_success', 'op_no_destination'],
      source: 'horizon_lookup:sample',
    },
  },
  {
    label: 'ambiguous timeout (connection dropped, hash known)',
    observation: {
      stage: 'ambiguous_outcome',
      hash: '4d0c1b2a3f4e5d6c7b8a9f0e1d2c3b4a5f6e7d8c9b0a1f2e3d4c5b6a7f8e9d0c',
      errorDetail: 'Submission socket closed after 30 s without a response',
      source: 'submission_timeout',
    },
  },
];

function normalizeTransactionHash(value: unknown): string {
  const hash = asString(value);
  if (!hash) {
    throw new Error('transactionHash is required when running network diagnostics.');
  }
  const trimmed = hash.trim();
  if (!isValidTransactionHash(trimmed)) {
    throw new Error(
      'transactionHash must be a 64-character hexadecimal transaction hash (local validation stage).',
    );
  }
  return trimmed;
}

/**
 * Runs the transaction submission diagnostics example.
 *
 * Without a transaction hash, it runs an offline demonstration that classifies
 * all five modelled outcomes and prints the structured recovery guidance.
 * With a hash, it performs a read-only Horizon lookup and reports fee
 * information, ledger sequence, and operation-level results for the confirmed
 * record. It never signs, submits, resubmits, or requests secret keys.
 */
export async function run(params: SubmissionDiagnosticsParams = {}): Promise<void> {
  const horizonUrl = params.horizonUrl || process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const json = params.json === true || params.json === 'true' || process.env.JSON_OUTPUT === 'true';

  const reports: Array<{ label: string } & SubmissionDiagnosticsReport> = [];

  try {
    if (params.transactionHash?.trim() || process.env.TRANSACTION_HASH) {
      const hash = normalizeTransactionHash(params.transactionHash || process.env.TRANSACTION_HASH);
      const server = new Horizon.Server(horizonUrl);
      try {
        const record = await (server as any)
          .transactions()
          .transaction(hash)
          .call();
        reports.push({
          label: `Horizon lookup for ${hash}`,
          ...buildSubmissionDiagnostics(observationFromHorizonRecord(record)),
        });
      } catch (lookupError) {
        const wasNotFound = /404|not_found|Not Found/i.test(String((lookupError as Error).message || lookupError));
        if (wasNotFound) {
          reports.push({
            label: `Horizon lookup for ${hash} (not found)`,
            ...buildSubmissionDiagnostics(lookupObservationForUnknownHash(horizonUrl)),
          });
        } else {
          throw lookupError;
        }
      }
    } else {
      for (const sample of OUTCOME_SAMPLES) {
        reports.push({
          label: sample.label,
          ...buildSubmissionDiagnostics(sample.observation),
        });
      }
    }

    if (json) {
      console.log(JSON.stringify({ horizonUrl, reports }, null, 2));
      return;
    }

    console.log('Stellar transaction submission diagnostics (read-only, nothing is submitted)...\n');
    for (const report of reports) {
      console.log(`--- ${report.label} ---`);
      console.log(formatSubmissionDiagnostics(report));
      console.log('');
    }
    console.log(
      'Diagnostics are advisory. Inspect the reported hash on Horizon or a Soroban RPC ' +
        'endpoint before taking any recovery action, and never resubmit an envelope whose ' +
        'outcome is still unresolved.',
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) console.log(JSON.stringify({ horizonUrl, error: message }, null, 2));
    else console.error(`Submission diagnostics failed: ${message}`);
  }
}
