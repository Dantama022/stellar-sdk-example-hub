export interface ResultAnalysisParams {
  result?: unknown;
  jsonOutput?: boolean;
}

export type FailureStage = 'none' | 'transaction' | 'operation' | 'soroban' | 'rpc';

export interface AnalyzedResult {
  successful: boolean;
  stage: FailureStage;
  hash?: string;
  ledger?: number;
  feeCharged?: string;
  resultCode: string;
  explanation: string;
  operationResults: Array<{ index: number; code: string; explanation: string; failed: boolean }>;
  failingOperationIndex: number | null;
  diagnosticEvents: string[];
  remediation: string[];
}

const TRANSACTION_CODES: Record<string, string> = {
  tx_success: 'The transaction was applied successfully.',
  tx_failed: 'One or more operations failed — inspect the operation result codes.',
  tx_bad_seq: 'The sequence number did not match the source account.',
  tx_insufficient_fee: 'The fee was below the network minimum for the current ledger.',
  tx_insufficient_balance: 'The source account cannot cover the fee and reserves.',
  tx_too_late: 'The transaction time bounds expired before inclusion.',
  tx_no_source_account: 'The source account does not exist on this network.',
};

const OPERATION_CODES: Record<string, string> = {
  op_success: 'The operation succeeded.',
  op_underfunded: 'The source account balance is too low for this operation.',
  op_no_destination: 'The destination account does not exist.',
  op_no_trust: 'The destination lacks a trustline for the asset.',
  op_line_full: 'The destination trustline limit would be exceeded.',
  op_low_reserve: 'The resulting balance would fall below the minimum reserve.',
  op_malformed: 'The operation parameters are malformed.',
};

const REMEDIATION: Record<string, string> = {
  tx_bad_seq: 'Reload the account from Horizon and rebuild with a fresh sequence number.',
  tx_insufficient_fee: 'Raise the base fee or wrap the transaction in a fee-bump envelope.',
  tx_too_late: 'Rebuild the transaction with new time bounds.',
  op_underfunded: 'Fund the source account or reduce the payment amount.',
  op_no_trust: 'Ask the destination to establish a trustline for the asset first.',
  op_no_destination: 'Create the destination account with a create_account operation.',
};

function explainTransaction(code: string): string {
  return TRANSACTION_CODES[code] || `Unrecognized transaction result code "${code}" — preserved as-is.`;
}

function explainOperation(code: string): string {
  return OPERATION_CODES[code] || `Unrecognized operation result code "${code}" — preserved as-is.`;
}

/**
 * Turns a Horizon or Soroban RPC transaction response into a structured
 * diagnostic report. Unknown codes are preserved rather than rejected.
 */
export function analyzeResult(raw: unknown): AnalyzedResult {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Expected a transaction result object');
  }

  const result = raw as Record<string, any>;

  if (result.type === 'rpc_error' || result.rpcError) {
    return {
      successful: false,
      stage: 'rpc',
      resultCode: String(result.rpcError || result.message || 'rpc_error'),
      explanation: 'The request never reached the ledger — this is a transport or RPC failure.',
      operationResults: [],
      failingOperationIndex: null,
      diagnosticEvents: [],
      remediation: ['Retry the request or switch to a healthy RPC endpoint.'],
    };
  }

  const extras = result.extras || {};
  const codes = extras.result_codes || result.result_codes || {};
  const transactionCode: string = codes.transaction || (result.successful ? 'tx_success' : 'tx_failed');
  const operationCodes: string[] = codes.operations || [];
  const diagnosticEvents: string[] = result.diagnosticEventsXdr || result.diagnostic_events || [];

  const operationResults = operationCodes.map((code, index) => ({
    index,
    code,
    explanation: explainOperation(code),
    failed: code !== 'op_success',
  }));

  const failing = operationResults.find((op) => op.failed) || null;
  const successful = transactionCode === 'tx_success' && !failing;

  let stage: FailureStage = 'none';
  if (!successful) {
    if (diagnosticEvents.length > 0) stage = 'soroban';
    else if (failing) stage = 'operation';
    else stage = 'transaction';
  }

  const remediation = [transactionCode, failing?.code]
    .filter((code): code is string => Boolean(code))
    .map((code) => REMEDIATION[code])
    .filter((hint): hint is string => Boolean(hint));

  return {
    successful,
    stage,
    hash: result.hash,
    ledger: result.ledger,
    feeCharged: result.fee_charged !== undefined ? String(result.fee_charged) : undefined,
    resultCode: transactionCode,
    explanation: explainTransaction(transactionCode),
    operationResults,
    failingOperationIndex: failing ? failing.index : null,
    diagnosticEvents,
    remediation,
  };
}

export function formatAnalysis(analysis: AnalyzedResult): string {
  const lines = [
    `Status:      ${analysis.successful ? 'SUCCESS' : 'FAILED'}`,
    `Stage:       ${analysis.stage}`,
    `Hash:        ${analysis.hash || 'n/a'}`,
    `Ledger:      ${analysis.ledger ?? 'n/a'}`,
    `Fee charged: ${analysis.feeCharged ?? 'n/a'}`,
    `Result code: ${analysis.resultCode}`,
    `             ${analysis.explanation}`,
  ];

  if (analysis.operationResults.length > 0) {
    lines.push('', 'Operations:');
    for (const op of analysis.operationResults) {
      lines.push(`  [${op.index}] ${op.code} — ${op.explanation}`);
    }
  }

  if (analysis.failingOperationIndex !== null) {
    lines.push('', `Failing operation index: ${analysis.failingOperationIndex}`);
  }

  if (analysis.diagnosticEvents.length > 0) {
    lines.push('', `Soroban diagnostic events: ${analysis.diagnosticEvents.length}`);
  }

  if (analysis.remediation.length > 0) {
    lines.push('', 'Remediation hints:', ...analysis.remediation.map((hint) => `  - ${hint}`));
  }

  return lines.join('\n');
}

const SAMPLE_RESULT = {
  hash: '8f2a4d0c1b9e7a6f5d4c3b2a1908f7e6d5c4b3a2190807f6e5d4c3b2a1908f7e',
  ledger: 51234567,
  successful: false,
  fee_charged: '300',
  extras: {
    result_codes: {
      transaction: 'tx_failed',
      operations: ['op_success', 'op_underfunded'],
    },
  },
};

/**
 * Runs the transaction result and diagnostic analysis example.
 */
export async function run(params: ResultAnalysisParams = {}): Promise<void> {
  const raw = params.result || SAMPLE_RESULT;
  const analysis = analyzeResult(raw);

  if (params.jsonOutput) {
    console.log(JSON.stringify(analysis, null, 2));
    return;
  }

  console.log('Analyzing transaction result (no transaction is submitted)...\n');
  console.log(formatAnalysis(analysis));
}
