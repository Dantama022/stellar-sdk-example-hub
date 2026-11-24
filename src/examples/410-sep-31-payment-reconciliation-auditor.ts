import { Horizon } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const SCALE = 1_000_000_000n; // up to 9 decimal places, enough for Stellar's 7

export interface Discrepancy {
  field: string;
  expected: string | null;
  actual: string | null;
  detail: string;
}

export interface FeeBreakdown {
  reportedFee: string | null;
  fixedFee: string | null;
  percentageFee: string | null;
  effectiveFee: string | null;
  complete: boolean;
  notes: string[];
}

export interface Sep31Payment {
  transactionId: string;
  status: string;
  sendingAsset: string | null;
  receivingAsset: string | null;
  requestedSendingAmount: string | null;
  reportedSendingAmount: string | null;
  expectedReceivingAmount: string | null;
  reportedDeliveredAmount: string | null;
  stellarTransactionHash: string | null;
  externalTransactionId: string | null;
  exchangeRate: string | null;
  fees: FeeBreakdown;
  warnings: string[];
}

export interface OnChainCheck {
  status: 'verified' | 'mismatch' | 'unavailable' | 'no-hash';
  detail: string;
}

export interface AuditReport {
  anchorService: string;
  payment: Sep31Payment;
  onChain: OnChainCheck;
  discrepancies: Discrepancy[];
  reconciliationStatus: 'matched' | 'mismatch' | 'incomplete' | 'pending';
  limitations: string[];
}

export interface Sep31Record {
  [key: string]: unknown;
}

export interface HorizonTransactionLike {
  hash?: string;
  successful?: boolean;
  operations?: Array<{ type?: string; asset?: string; amount?: string }>;
}

/** Converts a decimal string to a scaled integer without floating-point math. */
export function parseAmount(value: unknown): bigint | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > 9) return null;
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(9, '0') || '0');
}

export function formatAmount(units: bigint): string {
  const whole = units / SCALE;
  const fraction = (units % SCALE).toString().padStart(9, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function read(record: Sep31Record, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function readNested(record: Sep31Record, parent: string, key: string): string | null {
  const nested = record[parent];
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return read(nested as Sep31Record, key);
  }
  return null;
}

/** Extracts the SEP-31 fields used by the audit, preserving raw values. */
export function extractSep31Payment(record: Sep31Record): Sep31Payment {
  const warnings: string[] = [];
  const requested = read(record, 'quote_amount_in', 'requested_amount') ??
    readNested(record, 'quote', 'amount_in');
  const expectedOut = read(record, 'quote_amount_out', 'expected_amount') ??
    readNested(record, 'quote', 'amount_out');
  const rawFee = record.fee ?? record.fee_details;
  const feeObject: Sep31Record | null =
    rawFee && typeof rawFee === 'object' && !Array.isArray(rawFee)
      ? (rawFee as Sep31Record)
      : null;
  const reportedFee = read(record, 'fee') ?? readNested(record, 'fee_details', 'total');
  const fixedFee = feeObject ? read(feeObject, 'fixed', 'fixed_fee') : null;
  const percentageFee = feeObject ? read(feeObject, 'percentage', 'percent', 'percent_fee') : null;
  const sendingAmount = read(record, 'amount_in');
  const deliveredAmount = read(record, 'amount_out');

  if (requested === null) warnings.push('Requested sending amount was not reported.');
  if (expectedOut === null) warnings.push('Expected receiving amount was not reported.');
  if (deliveredAmount === null) warnings.push('Delivered amount was not reported.');
  if (reportedFee === null && fixedFee === null && percentageFee === null) {
    warnings.push('No fee information was reported; fees cannot be evaluated.');
  }

  const sendingUnits = parseAmount(sendingAmount);
  const feeUnits = parseAmount(reportedFee) ?? parseAmount(fixedFee);
  const effectiveFee =
    sendingUnits !== null && feeUnits !== null && percentageFee === null
      ? formatAmount(feeUnits)
      : null;

  return {
    transactionId: read(record, 'id', 'transaction_id') ?? 'unknown',
    status: read(record, 'status') ?? 'unknown',
    sendingAsset: read(record, 'asset_in', 'source_asset'),
    receivingAsset: read(record, 'asset_out', 'destination_asset'),
    requestedSendingAmount: requested,
    reportedSendingAmount: sendingAmount,
    expectedReceivingAmount: expectedOut,
    reportedDeliveredAmount: deliveredAmount,
    stellarTransactionHash: read(record, 'stellar_transaction_id', 'stellar_transaction_hash'),
    externalTransactionId: read(record, 'external_transaction_id'),
    exchangeRate: read(record, 'exchange_rate') ?? readNested(record, 'quote', 'exchange_rate'),
    fees: {
      reportedFee,
      fixedFee,
      percentageFee,
      effectiveFee,
      complete: reportedFee !== null || (fixedFee !== null && percentageFee !== null),
      notes:
        percentageFee !== null
          ? ['Percentage-based fees cannot be resolved without the base and rate used by the anchor.']
          : [],
    },
    warnings,
  };
}

/** Compares requested/reported amounts using integer arithmetic. */
export function findAmountDiscrepancies(payment: Sep31Payment): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];
  const compare = (field: string, expected: string | null, actual: string | null): void => {
    if (expected === null || actual === null) return;
    const left = parseAmount(expected);
    const right = parseAmount(actual);
    if (left === null || right === null || left !== right) {
      discrepancies.push({
        field,
        expected,
        actual,
        detail: 'Values differ or cannot be represented as exact decimals.',
      });
    }
  };
  compare('sending amount', payment.requestedSendingAmount, payment.reportedSendingAmount);
  compare('receiving amount', payment.expectedReceivingAmount, payment.reportedDeliveredAmount);

  if (payment.exchangeRate) {
    const rate = parseAmount(payment.exchangeRate);
    const sending = parseAmount(payment.reportedSendingAmount);
    const received = parseAmount(payment.reportedDeliveredAmount);
    if (rate !== null && rate > 0n && sending !== null && received !== null) {
      const expected = (sending * SCALE) / rate;
      // Allow one scaled unit of rounding tolerance for anchor arithmetic.
      if (expected > received + 1n || expected < received - 1n) {
        discrepancies.push({
          field: 'exchange rate',
          expected: formatAmount(expected),
          actual: payment.reportedDeliveredAmount,
          detail: 'Delivered amount does not match the reported exchange rate.',
        });
      }
    }
  }

  return discrepancies;
}

/**
 * Compares an anchor-reported Stellar payment with an on-chain transaction.
 * This verifies settlement on Stellar only, never an external bank payout.
 */
export function verifyOnChain(
  payment: Sep31Payment,
  transaction: HorizonTransactionLike | null,
): OnChainCheck {
  if (!payment.stellarTransactionHash) {
    return { status: 'no-hash', detail: 'No Stellar transaction hash was reported by the anchor.' };
  }
  if (!transaction) {
    return { status: 'unavailable', detail: 'The reported Stellar transaction could not be retrieved.' };
  }
  if (transaction.successful === false) {
    return { status: 'mismatch', detail: 'The Stellar transaction is recorded as failed.' };
  }

  const amount = parseAmount(payment.reportedSendingAmount);
  const matching = (transaction.operations ?? []).some((operation) => {
    if (!['payment', 'path_payment_strict_send', 'path_payment_strict_receive'].includes(operation.type ?? '')) {
      return false;
    }
    const onChainAmount = parseAmount(operation.amount);
    const assetMatches =
      operation.asset === undefined ||
      operation.asset === null ||
      operation.asset === payment.sendingAsset;
    return assetMatches && amount !== null && onChainAmount === amount;
  });

  return matching
    ? { status: 'verified', detail: 'A matching Stellar payment operation was found on-chain.' }
    : {
        status: 'mismatch',
        detail: 'No payment operation matches the anchor-reported asset and amount.',
      };
}

export function buildAuditReport(
  anchorService: string,
  payment: Sep31Payment,
  onChain: OnChainCheck,
): AuditReport {
  const discrepancies = findAmountDiscrepancies(payment);
  let status: AuditReport['reconciliationStatus'];
  if (payment.status === 'pending') status = 'pending';
  else if (discrepancies.length > 0 || onChain.status === 'mismatch') status = 'mismatch';
  else if (
    payment.warnings.length > 0 ||
    !payment.fees.complete ||
    onChain.status !== 'verified'
  ) {
    status = 'incomplete';
  } else {
    status = 'matched';
  }

  return {
    anchorService,
    payment,
    onChain,
    discrepancies,
    reconciliationStatus: status,
    limitations: [
      'On-chain settlement does not prove an external bank payout.',
      'Anchors do not expose identical fee fields; absent fees remain unknown, not zero.',
      'Exchange-rate comparisons are approximate where rounding rules are not published.',
    ],
  };
}

export function formatTextReport(report: AuditReport): string {
  const payment = report.payment;
  const lines = [
    '=== SEP-31 Payment Reconciliation Auditor ===',
    `Anchor service: ${report.anchorService}`,
    `SEP-31 transaction: ${payment.transactionId}`,
    `Status: ${payment.status}`,
    `Sending asset: ${payment.sendingAsset ?? 'unavailable'}`,
    `Receiving asset: ${payment.receivingAsset ?? 'unavailable'}`,
    `Requested sending amount: ${payment.requestedSendingAmount ?? 'unavailable'}`,
    `Reported sending amount: ${payment.reportedSendingAmount ?? 'unavailable'}`,
    `Expected receiving amount: ${payment.expectedReceivingAmount ?? 'unavailable'}`,
    `Reported delivered amount: ${payment.reportedDeliveredAmount ?? 'unavailable'}`,
    `Fee: ${payment.fees.reportedFee ?? 'unavailable'} (fixed: ${payment.fees.fixedFee ?? 'n/a'}, percentage: ${payment.fees.percentageFee ?? 'n/a'}, effective: ${payment.fees.effectiveFee ?? 'n/a'})`,
    `Exchange rate: ${payment.exchangeRate ?? 'unavailable'}`,
    `Stellar transaction hash: ${payment.stellarTransactionHash ?? 'unavailable'}`,
    `On-chain verification: ${report.onChain.status} - ${report.onChain.detail}`,
    `Reconciliation status: ${report.reconciliationStatus}`,
    '',
    'Discrepancies:',
    ...(report.discrepancies.length
      ? report.discrepancies.map((item) => `  - ${item.field}: expected ${item.expected ?? 'n/a'}, actual ${item.actual ?? 'n/a'}`)
      : ['  none']),
    '',
    'Limitations:',
    ...report.limitations.map((item) => `  - ${item}`),
  ];
  return lines.join('\n');
}

export function toJson(report: AuditReport): string {
  return JSON.stringify(report, null, 2);
}

export async function run(
  params: { anchorUrl?: string; transactionId?: string; authToken?: string; json?: boolean } = {},
): Promise<void> {
  const anchorUrl = (params.anchorUrl ?? process.env.SEP31_ANCHOR_URL ?? '').replace(/\/$/, '');
  const transactionId = params.transactionId ?? process.env.SEP31_TRANSACTION_ID;
  if (!anchorUrl) throw new Error('An anchor service URL is required (SEP31_ANCHOR_URL).');
  if (!transactionId) throw new Error('A SEP-31 transaction ID is required.');

  const token = params.authToken ?? process.env.SEP31_AUTH_TOKEN;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${anchorUrl}/sep31/transactions/${encodeURIComponent(transactionId)}`, {
    headers,
  });
  if (!response.ok) {
    throw new Error(`Anchor service returned HTTP ${response.status} for transaction ${transactionId}.`);
  }

  const raw = (await response.json()) as Sep31Record;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Anchor service returned a malformed SEP-31 transaction response.');
  }

  const payment = extractSep31Payment(raw);
  let transaction: HorizonTransactionLike | null = null;
  if (payment.stellarTransactionHash) {
    const server = new Horizon.Server(process.env.HORIZON_URL ?? DEFAULT_HORIZON_URL);
    try {
      const result = (await server
        .transactions()
        .transaction(payment.stellarTransactionHash)
        .call()) as HorizonTransactionLike & {
        operations?: Array<{ type?: string; amount?: string; asset?: string }>;
      };
      transaction = {
        hash: result.hash,
        successful: result.successful,
        operations: (result.operations ?? []).map((operation) => ({
          type: operation.type,
          amount: operation.amount,
          asset: operation.asset,
        })),
      };
    } catch {
      // Report unavailable on-chain data explicitly instead of failing the audit.
      transaction = null;
    }
  }

  const report = buildAuditReport(anchorUrl, payment, verifyOnChain(payment, transaction));
  const asJson = params.json === true || process.env.JSON_OUTPUT === 'true';
  console.log(asJson ? toJson(report) : formatTextReport(report));
}
