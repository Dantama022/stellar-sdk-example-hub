import { Horizon } from '@stellar/stellar-sdk';

/**
 * Example 62: Horizon Payment History Inspection
 *
 * Horizon exposes both generic operations and payment records:
 *
 *   server.operations().forAccount(accountId)
 *     Returns every successful operation involving the account, including
 *     manage-data, trustline, offer, sponsorship, payment, and other operation
 *     types.
 *
 *   server.payments().forAccount(accountId)
 *     Returns only successful payment-related operations. Depending on account
 *     activity, this can include:
 *
 *       - create_account
 *       - payment
 *       - path_payment_strict_receive
 *       - path_payment_strict_send
 *       - account_merge
 *
 * The payments resource is therefore more convenient for wallet history and
 * transfer inspection because applications do not need to retrieve every
 * operation and manually discard unrelated operation types.
 *
 * This example is read-only. It does not build, sign, or submit transactions.
 */

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 200;
const LEDGER_LOOKUP_CONCURRENCY = 5;

const DEFAULT_ACCOUNT_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

export type PaymentDirection = 'incoming' | 'outgoing' | 'self' | 'related';

export interface PaymentHistoryParams {
  /**
   * Stellar account to inspect.
   *
   * The runner, ACCOUNT_ID environment variable, and CLI argument are also
   * supported.
   */
  accountId?: string;

  /**
   * Number of recent payment records to retrieve, from 1 through 200.
   */
  limit?: number | string;

  /**
   * Horizon URL override. Defaults to Stellar Testnet Horizon.
   */
  horizonUrl?: string;
}

/**
 * Common fields across Horizon's payment-related operation records.
 *
 * The payment endpoint returns a union of operation shapes. For example,
 * create_account uses `funder`, `account`, and `starting_balance`, while a
 * normal payment uses `from`, `to`, `amount`, and asset fields.
 */
export interface RawPaymentRecord {
  id?: string;
  paging_token?: string;
  type?: string;
  source_account?: string;
  created_at?: string;
  transaction_hash?: string;
  transaction_successful?: boolean;
  ledger?: number;

  from?: string;
  from_muxed?: string;
  to?: string;
  to_muxed?: string;
  amount?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;

  source_amount?: string;
  source_asset_type?: string;
  source_asset_code?: string;
  source_asset_issuer?: string;

  destination_amount?: string;
  destination_asset_type?: string;
  destination_asset_code?: string;
  destination_asset_issuer?: string;

  funder?: string;
  account?: string;
  starting_balance?: string;

  into?: string;
  into_muxed?: string;

  _links?: {
    self?: {
      href?: string;
    };
    transaction?: {
      href?: string;
    };
  };
}

export interface ParsedPayment {
  operationId: string;
  operationType: string;
  direction: PaymentDirection;
  amount: string | null;
  asset: string;
  sourceAccount: string;
  destinationAccount: string;
  counterparty: string;
  transactionHash: string;
  ledgerSequence?: number;
  createdAt: string;
}

export interface PaymentHistorySummary {
  totalPayments: number;
  incomingPayments: number;
  outgoingPayments: number;
  selfPayments: number;
  relatedPayments: number;
  paymentsByAsset: Record<string, number>;
}

/**
 * Normalizes the configurable history limit to Horizon's supported 1–200
 * record range.
 */
export function normalizePaymentLimit(value?: number | string): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value.trim(), 10) : value;

  if (parsed === undefined || parsed === null || Number.isNaN(parsed)) {
    return DEFAULT_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_LIMIT);
}

/**
 * Formats an asset from Horizon record fields.
 *
 * Native XLM has no code or issuer in Horizon responses. Issued assets are
 * identified by both code and issuer because the same code can be issued by
 * multiple Stellar accounts.
 */
export function formatPaymentAsset(
  assetType?: string,
  assetCode?: string,
  assetIssuer?: string,
): string {
  if (!assetType || assetType === 'native') {
    return 'XLM (native)';
  }

  if (assetCode && assetIssuer) {
    return `${assetCode}:${assetIssuer}`;
  }

  if (assetCode) {
    return `${assetCode} (${assetType})`;
  }

  return assetType;
}

/**
 * Determines payment direction relative to the inspected account.
 */
export function determinePaymentDirection(
  inspectedAccount: string,
  sourceAccount: string,
  destinationAccount: string,
): PaymentDirection {
  const isSource = sourceAccount === inspectedAccount;
  const isDestination = destinationAccount === inspectedAccount;

  if (isSource && isDestination) {
    return 'self';
  }

  if (isDestination) {
    return 'incoming';
  }

  if (isSource) {
    return 'outgoing';
  }

  return 'related';
}

/**
 * Returns the other participant in the payment relative to the inspected
 * account.
 */
export function determineCounterparty(
  inspectedAccount: string,
  sourceAccount: string,
  destinationAccount: string,
  direction: PaymentDirection,
): string {
  if (direction === 'incoming') {
    return sourceAccount;
  }

  if (direction === 'outgoing') {
    return destinationAccount;
  }

  if (direction === 'self') {
    return inspectedAccount;
  }

  return [sourceAccount, destinationAccount].filter(Boolean).join(' → ') || 'Unknown';
}

/**
 * Extracts the source address used by each payment-related operation shape.
 */
export function getPaymentSource(record: RawPaymentRecord): string {
  return record.from_muxed || record.from || record.funder || record.source_account || 'Unknown';
}

/**
 * Extracts the destination address used by each payment-related operation
 * shape.
 */
export function getPaymentDestination(record: RawPaymentRecord): string {
  return (
    record.to_muxed || record.to || record.account || record.into_muxed || record.into || 'Unknown'
  );
}

/**
 * Extracts the transferred amount from each payment-related operation shape.
 *
 * For path payments, the destination amount is shown because it represents
 * what the recipient received. Account creation uses the starting balance.
 * Horizon account-merge payment records may not include the transferred amount,
 * so those records are displayed with an unavailable amount rather than an
 * invented value.
 */
export function getPaymentAmount(record: RawPaymentRecord): string | null {
  return record.amount || record.destination_amount || record.starting_balance || null;
}

/**
 * Determines the asset received by the destination.
 *
 * Normal payments use `asset_*`. Path payments may expose separate source and
 * destination asset fields, so the destination asset is preferred.
 */
export function getPaymentAsset(record: RawPaymentRecord): string {
  const assetType = record.destination_asset_type || record.asset_type;
  const assetCode = record.destination_asset_code || record.asset_code;
  const assetIssuer = record.destination_asset_issuer || record.asset_issuer;

  return formatPaymentAsset(assetType, assetCode, assetIssuer);
}

/**
 * Converts a Horizon payment record into the consistent representation printed
 * by this example.
 */
export function parsePaymentRecord(
  record: RawPaymentRecord,
  inspectedAccount: string,
): ParsedPayment {
  const sourceAccount = getPaymentSource(record);
  const destinationAccount = getPaymentDestination(record);
  const direction = determinePaymentDirection(inspectedAccount, sourceAccount, destinationAccount);

  return {
    operationId: record.id || record.paging_token || '',
    operationType: record.type || 'payment',
    direction,
    amount: getPaymentAmount(record),
    asset: getPaymentAsset(record),
    sourceAccount,
    destinationAccount,
    counterparty: determineCounterparty(
      inspectedAccount,
      sourceAccount,
      destinationAccount,
      direction,
    ),
    transactionHash: record.transaction_hash || '',
    ledgerSequence: record.ledger,
    createdAt: record.created_at || '',
  };
}

/**
 * Summarizes payment directions and asset usage within the retrieved page.
 */
export function summarizePayments(payments: ParsedPayment[]): PaymentHistorySummary {
  const summary: PaymentHistorySummary = {
    totalPayments: payments.length,
    incomingPayments: 0,
    outgoingPayments: 0,
    selfPayments: 0,
    relatedPayments: 0,
    paymentsByAsset: {},
  };

  for (const payment of payments) {
    if (payment.direction === 'incoming') {
      summary.incomingPayments += 1;
    } else if (payment.direction === 'outgoing') {
      summary.outgoingPayments += 1;
    } else if (payment.direction === 'self') {
      summary.selfPayments += 1;
    } else {
      summary.relatedPayments += 1;
    }

    summary.paymentsByAsset[payment.asset] = (summary.paymentsByAsset[payment.asset] || 0) + 1;
  }

  return summary;
}

/**
 * Retrieves recent payment records for one account.
 */
export async function fetchPaymentRecords(
  server: Horizon.Server,
  accountId: string,
  limit: number,
): Promise<RawPaymentRecord[]> {
  const page = await server.payments().forAccount(accountId).order('desc').limit(limit).call();

  return page.records as unknown as RawPaymentRecord[];
}

/**
 * Retrieves the ledger sequence for one transaction.
 *
 * Payment records already include the transaction hash and timestamp, but the
 * ledger sequence is resolved from the linked transaction resource.
 */
export async function resolveTransactionLedger(
  server: Horizon.Server,
  transactionHash: string,
): Promise<number | undefined> {
  if (!transactionHash) {
    return undefined;
  }

  try {
    const transaction = await server.transactions().transaction(transactionHash).call();
    const transactionRecord = transaction as unknown as {
      ledger?: number;
      ledger_attr?: number;
    };

    const ledger = transactionRecord.ledger_attr ?? transactionRecord.ledger;

    return typeof ledger === 'number' ? ledger : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Attaches ledger sequences to payment records while limiting concurrent
 * Horizon requests.
 *
 * Multiple payment operations can belong to the same transaction, so the
 * function performs one lookup per unique transaction hash and reuses it.
 */
export async function attachLedgerSequences(
  server: Horizon.Server,
  payments: ParsedPayment[],
  concurrency = LEDGER_LOOKUP_CONCURRENCY,
): Promise<ParsedPayment[]> {
  const unresolvedHashes = Array.from(
    new Set(
      payments
        .filter(
          (payment) => payment.ledgerSequence === undefined && Boolean(payment.transactionHash),
        )
        .map((payment) => payment.transactionHash),
    ),
  );

  const ledgerByTransaction = new Map<string, number | undefined>();
  const safeConcurrency = Math.max(1, Math.trunc(concurrency));

  for (let index = 0; index < unresolvedHashes.length; index += safeConcurrency) {
    const batch = unresolvedHashes.slice(index, index + safeConcurrency);

    const results = await Promise.all(
      batch.map(async (transactionHash) => ({
        transactionHash,
        ledgerSequence: await resolveTransactionLedger(server, transactionHash),
      })),
    );

    for (const result of results) {
      ledgerByTransaction.set(result.transactionHash, result.ledgerSequence);
    }
  }

  return payments.map((payment) => ({
    ...payment,
    ledgerSequence: payment.ledgerSequence ?? ledgerByTransaction.get(payment.transactionHash),
  }));
}

/**
 * Produces the console report for the payment-history inspection.
 */
export function formatPaymentHistoryReport(
  accountId: string,
  limit: number,
  payments: ParsedPayment[],
  summary: PaymentHistorySummary = summarizePayments(payments),
): string {
  const lines: string[] = [];

  lines.push('=== Stellar Horizon Payment History ===');
  lines.push(`Account:        ${accountId}`);
  lines.push(`History Limit:  ${limit}`);
  lines.push(`Records Found:  ${payments.length}`);

  if (payments.length === 0) {
    lines.push('');
    lines.push('No payment history was found for this account.');
    lines.push('');
    lines.push('This is a valid empty result. It can mean that:');
    lines.push('  - the account exists but has not sent or received a payment,');
    lines.push('  - its payment activity is outside Horizon retention, or');
    lines.push('  - the selected network does not contain the expected account activity.');
    lines.push('');
    lines.push('Payment records are narrower than generic operations: unrelated operations');
    lines.push('such as trustlines, offers, and manage-data entries do not appear here.');

    return lines.join('\n');
  }

  lines.push('');
  lines.push('Recent Payments (newest first):');

  payments.forEach((payment, index) => {
    const amountLabel = payment.amount
      ? `${payment.amount} ${payment.asset}`
      : `Unavailable (${payment.asset})`;

    lines.push('');
    lines.push(`  [${index + 1}] ${payment.createdAt || 'Unknown timestamp'}`);
    lines.push(`      Direction:        ${payment.direction.toUpperCase()}`);
    lines.push(`      Operation Type:   ${payment.operationType}`);
    lines.push(`      Amount:           ${amountLabel}`);
    lines.push(`      Source:           ${payment.sourceAccount}`);
    lines.push(`      Destination:      ${payment.destinationAccount}`);
    lines.push(`      Counterparty:     ${payment.counterparty}`);
    lines.push(`      Operation ID:     ${payment.operationId || 'Unavailable'}`);
    lines.push(`      Transaction Hash: ${payment.transactionHash || 'Unavailable'}`);
    lines.push(`      Ledger Sequence:  ${payment.ledgerSequence ?? 'Unavailable'}`);
  });

  lines.push('');
  lines.push('History Summary:');
  lines.push(`  Total records: ${summary.totalPayments}`);
  lines.push(`  Incoming:      ${summary.incomingPayments}`);
  lines.push(`  Outgoing:      ${summary.outgoingPayments}`);
  lines.push(`  Self-payments: ${summary.selfPayments}`);

  if (summary.relatedPayments > 0) {
    lines.push(`  Other related: ${summary.relatedPayments}`);
  }

  lines.push('');
  lines.push('Records by asset:');

  for (const [asset, count] of Object.entries(summary.paymentsByAsset)) {
    lines.push(`  - ${asset}: ${count}`);
  }

  lines.push('');
  lines.push('Payment records versus generic operations:');
  lines.push('  - Payment records contain successful balance-transfer operations.');
  lines.push('  - Generic operations include all operation types involving the account.');
  lines.push('  - One transaction may contain several operations and payment records.');
  lines.push('  - The transaction hash links each payment to its containing transaction.');
  lines.push('');
  lines.push('This summary covers only the retrieved page, not the account’s full history.');

  return lines.join('\n');
}

/**
 * Selects an account from a recent global payment record when no account was
 * supplied through configuration.
 */
export function findAccountFromPayment(record: RawPaymentRecord | undefined): string | undefined {
  if (!record) {
    return undefined;
  }

  const candidates = [
    record.to,
    record.account,
    record.into,
    record.from,
    record.funder,
    record.source_account,
  ];

  return candidates.find(
    (candidate): candidate is string =>
      typeof candidate === 'string' && candidate.trim().length > 0,
  );
}

/**
 * Finds a recently active account so the example can run without configuration.
 */
export async function discoverPaymentAccount(server: Horizon.Server): Promise<string | undefined> {
  try {
    const page = await server.payments().order('desc').limit(1).call();
    const record = page.records[0] as unknown as RawPaymentRecord | undefined;

    return findAccountFromPayment(record);
  } catch {
    return undefined;
  }
}

/**
 * Runs the payment-history example.
 *
 * Configuration options:
 *
 *   Interactive runner:
 *     npm run run-example 62-payment-history
 *
 *   CLI:
 *     npm run run-example -- 62-payment-history GACCOUNT... 20
 *
 *   Environment:
 *     ACCOUNT_ID=GACCOUNT...
 *     PAYMENT_HISTORY_LIMIT=20
 *     HORIZON_URL=https://horizon-testnet.stellar.org
 */
export async function run(params: PaymentHistoryParams = {}): Promise<void> {
  const horizonUrl = params.horizonUrl || process.env.HORIZON_URL || DEFAULT_HORIZON_URL;

  const server = new Horizon.Server(horizonUrl);
  const limit = normalizePaymentLimit(
    params.limit ?? process.env.PAYMENT_HISTORY_LIMIT ?? process.argv[4],
  );

  let accountId: string | undefined =
    params.accountId?.trim() || process.env.ACCOUNT_ID?.trim() || process.argv[3]?.trim();

  console.log('Starting Horizon Payment History Inspection Example...');
  console.log(`Using Horizon: ${horizonUrl}`);
  console.log(
    'The payments resource returns successful transfer-related operations rather than every operation type.',
  );

  if (!accountId) {
    console.log('\nNo account ID supplied. Looking for a recently active payment account...');

    accountId = await discoverPaymentAccount(server);

    if (accountId) {
      console.log(`Discovered account: ${accountId}`);
    }
  }

  if (!accountId) {
    accountId = DEFAULT_ACCOUNT_ID;
    console.log(`Using fallback account: ${accountId}`);
  }

  console.log(`\nInspecting account: ${accountId}`);
  console.log(`Payment history limit: ${limit}`);

  try {
    await server.loadAccount(accountId);
  } catch (error: any) {
    if (error?.response?.status === 404) {
      console.log(`\nAccount ${accountId} does not exist on this Horizon network.`);
      console.log('\n' + formatPaymentHistoryReport(accountId, limit, [], summarizePayments([])));
      console.log('\nPayment history inspection completed (missing account handled).');
      return;
    }

    console.log(`\nCould not load account ${accountId}: ${error?.message || error}`);
    return;
  }

  let records: RawPaymentRecord[];

  try {
    records = await fetchPaymentRecords(server, accountId, limit);
  } catch (error: any) {
    console.log(`\nCould not retrieve payment history: ${error?.message || error}`);
    return;
  }

  const parsedPayments = records.map((record) => parsePaymentRecord(record, accountId));

  const paymentsWithLedgers = await attachLedgerSequences(server, parsedPayments);
  const summary = summarizePayments(paymentsWithLedgers);

  console.log('\n' + formatPaymentHistoryReport(accountId, limit, paymentsWithLedgers, summary));

  console.log('\nPayment history inspection completed successfully.');
}
