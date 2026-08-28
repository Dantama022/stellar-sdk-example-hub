import { Horizon } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const TRANSACTION_HASH_PATTERN = /^[0-9a-fA-F]{64}$/;

export type ResultCodeCategory =
  | 'Account errors'
  | 'Transaction errors'
  | 'Operation errors'
  | 'Payment errors'
  | 'Offer errors'
  | 'Trustline errors'
  | 'Asset errors';

export interface DecodedOperationResult {
  operation: number;
  resultCode: string;
  category: ResultCodeCategory;
  explanation: string;
  failed: boolean;
}

export interface ResultCodeDiagnosticReport {
  transactionHash: string;
  status: 'SUCCESS' | 'FAILED';
  resultCode: string;
  category: ResultCodeCategory;
  explanation: string;
  troubleshooting: string[];
  operations: DecodedOperationResult[];
}

export interface ResultCodeDecoderParams {
  transactionHash?: string;
  json?: boolean | string;
}

const EXPLANATIONS: Record<string, string> = {
  tx_success: 'The transaction was applied successfully.',
  tx_failed: 'One or more operations failed, so the transaction was rolled back.',
  tx_bad_seq: 'The transaction sequence number is invalid or already used.',
  tx_bad_auth: 'The transaction did not contain enough valid signatures.',
  tx_insufficient_balance: 'The source account cannot pay the transaction fee.',
  tx_insufficient_fee: 'The transaction fee is below the network minimum.',
  tx_no_source_account: 'The transaction source account does not exist.',
  tx_too_early: 'The transaction was submitted before its time bounds began.',
  tx_too_late: 'The transaction was submitted after its time bounds expired.',
  tx_missing_operation: 'The transaction contains no operations.',
  tx_bad_auth_extra: 'The transaction contains an unexpected extra signature.',
  tx_bad_min_seq_age: 'The source account sequence age is below the required minimum.',
  tx_bad_min_seq_ledger_gap: 'The source account ledger gap is below the required minimum.',
  op_success: 'The operation was applied successfully.',
  op_underfunded: 'The source account does not have enough balance for this operation.',
  op_no_destination: 'The destination account does not exist for this payment.',
  op_no_trust: 'The destination account has no trustline for this asset.',
  op_src_no_trust: 'The source account has no trustline for this asset.',
  op_line_full: 'The destination trustline cannot hold the requested additional balance.',
  op_not_authorized: 'The trustline is not authorized to hold this asset.',
  op_no_issuer: 'The asset issuer account does not exist.',
  op_low_reserve: 'The operation would leave an account below its minimum reserve.',
  op_bad_auth: 'The operation source account does not satisfy its signature threshold.',
  op_cross_self: 'The offer would cross another offer from the same account.',
  op_offer_not_found: 'The offer to update or remove was not found.',
  op_sell_no_trust: 'The seller has no trustline for the asset being sold.',
  op_buy_no_trust: 'The buyer has no trustline for the asset being bought.',
  op_sell_not_authorized: 'The seller is not authorized to transfer the asset.',
  op_buy_not_authorized: 'The buyer is not authorized to receive the asset.',
  op_malformed: 'The operation parameters are malformed or invalid.',
};

const CATEGORY_BY_CODE: Record<string, ResultCodeCategory> = {
  op_no_destination: 'Payment errors',
  op_underfunded: 'Payment errors',
  op_no_trust: 'Trustline errors',
  op_src_no_trust: 'Trustline errors',
  op_line_full: 'Trustline errors',
  op_not_authorized: 'Trustline errors',
  op_sell_no_trust: 'Trustline errors',
  op_buy_no_trust: 'Trustline errors',
  op_sell_not_authorized: 'Asset errors',
  op_buy_not_authorized: 'Asset errors',
  op_no_issuer: 'Asset errors',
  op_cross_self: 'Offer errors',
  op_offer_not_found: 'Offer errors',
  op_invalid_limit: 'Offer errors',
  op_invalid_price: 'Offer errors',
  op_low_reserve: 'Account errors',
  op_bad_auth: 'Account errors',
};

const SUGGESTIONS_BY_CODE: Record<string, string> = {
  tx_bad_seq: 'Refresh the source account and submit using its latest sequence number.',
  tx_bad_auth: 'Check signer keys and account thresholds before resubmitting.',
  tx_insufficient_balance: 'Fund the source account or reduce the fee and operation amounts.',
  tx_insufficient_fee: 'Use the current network base fee when rebuilding the transaction.',
  tx_no_source_account: 'Verify the source account address and fund it before submitting.',
  op_underfunded: 'Check the source balance, minimum reserve, and amount being sent.',
  op_no_destination: 'Create the destination account before using a payment operation.',
  op_no_trust: 'Create or authorize the destination trustline for the asset.',
  op_src_no_trust: 'Create a source trustline and ensure it has sufficient balance.',
  op_line_full: 'Increase the destination trust limit or send a smaller amount.',
  op_no_issuer: 'Verify that the asset issuer address is correct and exists.',
  op_cross_self: 'Change the price or cancel the existing opposing offer.',
  op_offer_not_found: 'Refresh the account offers and use the current offer ID.',
  op_low_reserve: 'Add XLM reserve or remove a sponsored/subentry resource first.',
};

function normalizeCode(code: unknown, fallback: string): string {
  return typeof code === 'string' && code.trim() ? code.trim().toLowerCase() : fallback;
}

export function classifyResultCode(code: string): ResultCodeCategory {
  const normalized = code.toLowerCase();
  if (CATEGORY_BY_CODE[normalized]) return CATEGORY_BY_CODE[normalized];
  if (normalized.startsWith('tx_')) return 'Transaction errors';
  if (normalized.startsWith('op_')) return 'Operation errors';
  return 'Operation errors';
}

export function explainResultCode(code: string): string {
  const normalized = code.toLowerCase();
  return (
    EXPLANATIONS[normalized] ||
    `Unknown result code (${code}). Check the current Stellar protocol documentation.`
  );
}

export function troubleshootingFor(code: string, category: ResultCodeCategory): string[] {
  const normalized = code.toLowerCase();
  const specific = SUGGESTIONS_BY_CODE[normalized];
  if (specific) return [specific];
  if (normalized.startsWith('tx_'))
    return ['Inspect the transaction envelope, signatures, fee, sequence, and time bounds.'];
  if (category === 'Offer errors')
    return ['Inspect the account offers and verify asset pairs, price, amount, and offer IDs.'];
  if (category === 'Trustline errors')
    return ['Verify trustline limits, authorization flags, and the asset issuer.'];
  if (category === 'Asset errors')
    return ['Verify the asset code, issuer account, and authorization state.'];
  if (category === 'Payment errors')
    return ['Verify the source balance, destination account, asset, and trustlines.'];
  return ['Look up the result code in the current Stellar protocol documentation before retrying.'];
}

export function decodeTransactionResultCodes(record: {
  hash: string;
  successful?: boolean;
  result_code?: string;
  result_codes?: { transaction?: string; operations?: string[] };
}): ResultCodeDiagnosticReport {
  const successful = record.successful === true;
  const transactionCode = normalizeCode(
    record.result_codes?.transaction || record.result_code,
    successful ? 'tx_success' : 'tx_failed',
  );
  const transactionCategory = classifyResultCode(transactionCode);
  const operations = (record.result_codes?.operations || []).map((rawCode, index) => {
    const resultCode = normalizeCode(rawCode, 'op_unknown');
    const category = classifyResultCode(resultCode);
    return {
      operation: index + 1,
      resultCode,
      category,
      explanation: explainResultCode(resultCode),
      failed: resultCode !== 'op_success',
    };
  });
  return {
    transactionHash: record.hash,
    status: successful ? 'SUCCESS' : 'FAILED',
    resultCode: transactionCode,
    category: transactionCategory,
    explanation: explainResultCode(transactionCode),
    troubleshooting: troubleshootingFor(transactionCode, transactionCategory),
    operations,
  };
}

export function formatDiagnosticReport(report: ResultCodeDiagnosticReport): string {
  const lines = [
    '=== Stellar Transaction Result-Code Diagnostic ===',
    `Transaction hash: ${report.transactionHash}`,
    `Status: ${report.status}`,
    `Result code: ${report.resultCode}`,
    `Category: ${report.category}`,
    `Explanation: ${report.explanation}`,
    '',
    'Operations:',
  ];

  if (report.operations.length === 0) {
    lines.push('  No operation result codes were returned.');
  } else {
    for (const operation of report.operations) {
      lines.push(
        `  Operation #${operation.operation}: ${operation.resultCode} [${operation.category}]${
          operation.failed ? ' FAILED' : ''
        }`,
      );
      lines.push(`    ${operation.explanation}`);
    }
  }

  lines.push('', 'Troubleshooting suggestions:');
  for (const suggestion of report.troubleshooting) lines.push(`  - ${suggestion}`);
  return lines.join('\n');
}

function wantsJson(params: ResultCodeDecoderParams): boolean {
  return (
    params.json === true ||
    params.json === 'true' ||
    process.env.JSON_OUTPUT === 'true' ||
    process.argv.includes('--json')
  );
}

export async function run(params: ResultCodeDecoderParams = {}): Promise<void> {
  const transactionHash =
    params.transactionHash?.trim() ||
    process.env.TRANSACTION_HASH?.trim() ||
    process.argv[3]?.trim();
  if (!transactionHash || !TRANSACTION_HASH_PATTERN.test(transactionHash)) {
    throw new Error(
      'Provide a 64-character hexadecimal transaction hash. Use --json for JSON output.',
    );
  }

  const horizonUrl = process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const server = new Horizon.Server(horizonUrl);
  const transaction = await server.transactions().transaction(transactionHash).call();
  const report = decodeTransactionResultCodes(
    transaction as typeof transaction & {
      result_codes?: { transaction?: string; operations?: string[] };
    },
  );

  if (wantsJson(params)) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatDiagnosticReport(report));
  }
}
