import { Horizon } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';

export const COMMON_RESULT_CODE_EXPLANATIONS: Record<string, string> = {
  // Transaction-level codes
  tx_failed: 'One or more operations in the transaction failed.',
  tx_bad_seq: 'The sequence number for the source account is invalid or out of order.',
  tx_bad_auth: 'Too few valid signatures were provided, or signatures do not meet thresholds.',
  tx_insufficient_balance: 'The source account cannot cover the minimum transaction fee.',
  tx_insufficient_fee: 'The fee provided is lower than the minimum network base fee.',
  tx_no_source_account: 'The source account specified does not exist on-ledger.',
  tx_too_early: 'The transaction was submitted before the valid time window specified in time bounds.',
  tx_too_late: 'The transaction was submitted after the expiry time specified in time bounds.',

  // Operation-level codes
  op_underfunded: 'Source account has insufficient balance to complete the operation.',
  op_no_destination: 'Destination account does not exist. (Consider createAccount instead of payment).',
  op_low_reserve: 'Account balance would drop below the required minimum XLM reserve.',
  op_no_trust: 'Destination account does not have a trustline for the specified asset.',
  op_line_full: 'Destination trustline balance limit would be exceeded.',
  op_not_authorized: 'Trustline is not authorized by the asset issuer.',
  op_bad_auth: 'Operation source account signature is invalid or insufficient.',
  op_no_issuer: 'The specified asset issuer account does not exist.',
  op_src_no_trust: 'Source account does not hold a trustline for the asset being sent.',
  op_cross_self: 'Order cannot be placed because it would cross an existing offer from the same account.',
};

export interface ParsedTxAnalysis {
  hash: string;
  successful: boolean;
  transactionResultCode: string;
  transactionExplanation: string;
  operationResultCodes: string[];
  failingOperationIndex: number | null;
  operationExplanations: Array<{ code: string; explanation: string }>;
}

export interface FailedTxParams {
  transactionHash?: string;
}

/**
 * Maps a Stellar transaction or operation result code to a human-readable explanation.
 */
export function mapResultCodeToExplanation(code: string): string {
  if (!code) {
    return 'Unknown or unspecified result code.';
  }

  const normalized = code.trim().toLowerCase();
  return (
    COMMON_RESULT_CODE_EXPLANATIONS[normalized] ||
    `Unrecognized result code (${code}). Refer to Stellar Protocol specifications.`
  );
}

/**
 * Identifies the 0-based index of the first failing operation.
 */
export function identifyFailingOperationIndex(operationResultCodes: string[]): number | null {
  if (!operationResultCodes || operationResultCodes.length === 0) {
    return null;
  }

  for (let i = 0; i < operationResultCodes.length; i++) {
    const code = operationResultCodes[i].toLowerCase();
    if (code !== 'op_success') {
      return i;
    }
  }

  return null;
}

/**
 * Parses Horizon transaction record or mock result into structured failure analysis.
 */
export function parseTransactionResult(txRecord: {
  hash: string;
  successful?: boolean;
  result_code?: string;
  result_codes?: {
    transaction?: string;
    operations?: string[];
  };
}): ParsedTxAnalysis {
  const hash = txRecord.hash;
  const successful = txRecord.successful ?? false;
  const txCode =
    txRecord.result_code || txRecord.result_codes?.transaction || (successful ? 'tx_success' : 'tx_failed');

  const txExplanation = mapResultCodeToExplanation(txCode);
  const opCodes = txRecord.result_codes?.operations || [];
  const failingIndex = identifyFailingOperationIndex(opCodes);

  const opExplanations = opCodes.map((code) => ({
    code,
    explanation: mapResultCodeToExplanation(code),
  }));

  return {
    hash,
    successful,
    transactionResultCode: txCode,
    transactionExplanation: txExplanation,
    operationResultCodes: opCodes,
    failingOperationIndex: failingIndex,
    operationExplanations: opExplanations,
  };
}

/**
 * Formats analysis into a structured developer report string.
 */
export function formatAnalysisSummary(analysis: ParsedTxAnalysis): string {
  const lines: string[] = [];

  lines.push(`=== Stellar Failed Transaction Result Analysis ===`);
  lines.push(`Transaction Hash:  ${analysis.hash}`);
  lines.push(`Status:            ${analysis.successful ? 'SUCCESS' : 'FAILED'}`);

  lines.push(`\n1. Transaction-Level Diagnostics:`);
  lines.push(`  - Result Code:   ${analysis.transactionResultCode}`);
  lines.push(`  - Explanation:   ${analysis.transactionExplanation}`);

  lines.push(`\n2. Operation-Level Diagnostics:`);
  if (analysis.operationResultCodes.length === 0) {
    lines.push(`  - No operation-level result codes available (failure occurred before operation evaluation).`);
  } else {
    lines.push(`  - Total Operations Evaluated: ${analysis.operationResultCodes.length}`);
    lines.push(
      `  - Failing Operation Index:    ${
        analysis.failingOperationIndex !== null ? `Operation #${analysis.failingOperationIndex + 1} (index ${analysis.failingOperationIndex})` : 'None (all succeeded)'
      }`,
    );

    analysis.operationExplanations.forEach((op, idx) => {
      lines.push(`  - Op #${idx + 1} Result [${op.code}]: ${op.explanation}`);
    });
  }

  lines.push(`\n3. Troubleshooting Guidance:`);
  lines.push(`  - Transaction-level failures (e.g. tx_bad_seq, tx_bad_auth) invalidate the entire envelope.`);
  lines.push(
    `  - Operation-level failures occur after transaction validation and identify specific failed actions.`,
  );

  return lines.join('\n');
}

/**
 * Runs the failed transaction result analysis example.
 */
export async function run(params: FailedTxParams = {}): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const server = new Horizon.Server(horizonUrl);

  const hash =
    params.transactionHash?.trim() ||
    process.env.TRANSACTION_HASH?.trim() ||
    process.argv[3]?.trim();

  console.log('Starting Failed Transaction Result Analysis Example...');
  console.log(`Using Horizon: ${horizonUrl}`);

  if (hash) {
    console.log(`Analyzing provided transaction hash: ${hash}`);
    try {
      const tx = await server.transactions().transaction(hash).call();
      const analysis = parseTransactionResult(tx as any);
      console.log('\n' + formatAnalysisSummary(analysis));
      return;
    } catch (error: any) {
      console.log(`Could not load transaction ${hash} from Horizon: ${error.message || error}`);
    }
  }

  // If no hash provided or query failed, attempt to find a failed transaction from recent Horizon records
  console.log('Searching recent Horizon transactions for a failed transaction...');
  try {
    const page = await server.transactions().order('desc').limit(50).call();
    const failedTx = page.records.find((r: any) => r.successful === false);

    if (failedTx) {
      console.log(`Found failed transaction on Testnet: ${failedTx.hash}`);
      const analysis = parseTransactionResult(failedTx as any);
      console.log('\n' + formatAnalysisSummary(analysis));
      return;
    }
  } catch (err) {
    console.log('Could not search recent transactions on Horizon:', err);
  }

  // Fallback to a mock/simulated failed transaction analysis to demonstrate feature
  console.log('\nNo failed transaction found on-chain. Demonstrating analysis on simulated failed transaction response:');
  const mockFailedRecord = {
    hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    successful: false,
    result_code: 'tx_failed',
    result_codes: {
      transaction: 'tx_failed',
      operations: ['op_success', 'op_underfunded'],
    },
  };

  const mockAnalysis = parseTransactionResult(mockFailedRecord);
  console.log('\n' + formatAnalysisSummary(mockAnalysis));

  console.log('\nFailed transaction result analysis completed successfully.');
}
