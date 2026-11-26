/** #580: read-only, XDR-backed transaction operation/fee attribution. */
import { FeeBumpTransaction, Networks, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { JsonFetcher, Network, getJson, pages } from '../_shared/horizon';

export interface TransactionRecord {
  hash: string;
  source_account: string;
  fee_account?: string;
  fee_charged?: string | number;
  fee_paid?: string | number;
  ledger?: number;
  created_at?: string;
  operation_count?: number;
  successful?: boolean;
  envelope_xdr?: string;
}
export interface OperationRecord {
  id?: string;
  type: string;
  source_account?: string;
  from?: string;
  to?: string;
  into?: string;
  account?: string;
  destination?: string;
  amount?: string;
  starting_balance?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
}

export interface EnvelopeSources {
  /** null = inherits transaction source; string = explicit operation source. */
  sources: Array<string | null>;
  feeSource: string;
  innerSource: string;
  feeBump: boolean;
}

function networkPassphrase(network: Network): string {
  if (network === 'testnet') return Networks.TESTNET;
  if (network === 'public') return Networks.PUBLIC;
  throw new Error('Unsupported network');
}

/** Only envelope XDR can confirm if a source was explicitly specified. */
export function decodeEnvelopeSources(xdr: string, network: Network): EnvelopeSources {
  const envelope = TransactionBuilder.fromXDR(xdr, networkPassphrase(network));
  const isFeeBump = envelope instanceof FeeBumpTransaction;
  const inner: Transaction = isFeeBump ? envelope.innerTransaction : envelope as Transaction;
  return {
    sources: inner.operations.map((op) => op.source ?? null),
    feeSource: isFeeBump ? envelope.feeSource : inner.source,
    innerSource: inner.source,
    feeBump: isFeeBump,
  };
}

const categories: Record<string, string> = {
  create_account: 'asset_transfer', payment: 'asset_transfer',
  path_payment_strict_send: 'asset_transfer', path_payment_strict_receive: 'asset_transfer',
  clawback: 'asset_transfer',
  change_trust: 'trustline_management', allow_trust: 'trustline_management',
  set_trust_line_flags: 'trustline_management',
  manage_buy_offer: 'trading', manage_sell_offer: 'trading', create_passive_sell_offer: 'trading',
  set_options: 'account_configuration', manage_data: 'account_configuration',
  bump_sequence: 'account_configuration', account_merge: 'account_configuration',
  begin_sponsoring_future_reserves: 'sponsorship', end_sponsoring_future_reserves: 'sponsorship',
  revoke_sponsorship: 'sponsorship', create_claimable_balance: 'claimable_balances',
  claim_claimable_balance: 'claimable_balances', clawback_claimable_balance: 'claimable_balances',
  liquidity_pool_deposit: 'liquidity_pool', liquidity_pool_withdraw: 'liquidity_pool',
  invoke_host_function: 'smart_contract', extend_footprint_ttl: 'smart_contract',
  restore_footprint: 'smart_contract',
};

export function attributeTransaction(
  transaction: TransactionRecord,
  operations: OperationRecord[],
  envelope?: EnvelopeSources,
) {
  if (!/^[a-f0-9]{64}$/i.test(transaction.hash)) throw new Error('Invalid transaction hash');
  if (!transaction.source_account) throw new Error('Missing transaction source account');
  const rawFee = transaction.fee_charged ?? transaction.fee_paid;
  const feeString = rawFee === undefined ? undefined : String(rawFee);
  if (feeString === undefined || !/^\d+$/.test(feeString)) throw new Error('Missing or invalid fee charged in stroops');
  if (envelope && envelope.sources.length !== operations.length) {
    throw new Error('Envelope operation count does not match Horizon records');
  }
  const warnings: string[] = [];
  if (!envelope) warnings.push('Envelope XDR unavailable; explicit versus inherited sources cannot be proven.');
  if (envelope && envelope.innerSource !== transaction.source_account) {
    warnings.push('Horizon source differs from the decoded inner transaction source.');
  }
  if (transaction.operation_count !== undefined && transaction.operation_count !== operations.length) {
    warnings.push('Operation listing is incomplete or inconsistent with transaction operation count.');
  }
  if (transaction.successful === false) warnings.push('Transaction failed: listed operations had no successful ledger effects.');
  const sources = operations.map((operation, index) => {
    const explicit = envelope?.sources[index];
    const effectiveSource = explicit ?? transaction.source_account;
    const status = envelope ? explicit === null ? 'inherited' : 'explicit' : 'unverified';
    if (envelope && operation.source_account && operation.source_account !== effectiveSource) {
      warnings.push(`Operation ${index} Horizon source disagrees with envelope source.`);
    }
    if (!envelope && operation.source_account && operation.source_account !== transaction.source_account) {
      warnings.push(`Operation ${index} uses a distinct Horizon-reported source; explicitness unverified.`);
    }
    const category = categories[operation.type] ?? 'unsupported';
    if (category === 'unsupported') warnings.push(`Unsupported operation ${index}: ${operation.type}`);
    const isTransfer = category === 'asset_transfer';
    const amount = operation.type === 'create_account' ? operation.starting_balance : operation.amount;
    if (isTransfer && amount !== undefined && !/^(?:0|[1-9]\d*)(?:\.\d{1,7})?$/.test(amount)) {
      warnings.push(`Malformed transfer amount in operation ${index}.`);
    }
    if (category === 'smart_contract') {
      warnings.push(`Operation ${index}: smart contract may transfer value, not inferred from operation type alone.`);
    }
    return {
      index, type: operation.type, category,
      transactionSource: transaction.source_account,
      effectiveSource: envelope ? effectiveSource : operation.source_account ?? transaction.source_account,
      sourceStatus: status,
      destination: operation.to ?? operation.destination ?? operation.into ?? operation.account ?? null,
      asset: operation.asset_type === 'native' ? 'XLM'
        : operation.asset_code && operation.asset_issuer
          ? `${operation.asset_code}:${operation.asset_issuer}` : null,
      amount: isTransfer ? amount ?? null : null,
      directlyTransfersAssets: isTransfer ? 'possible' : category === 'smart_contract' ? 'unknown' : 'no',
      applied: transaction.successful === true,
    };
  });
  const feePayer = envelope?.feeSource ?? transaction.fee_account ?? transaction.source_account;
  if (!envelope && !transaction.fee_account) warnings.push('Fee payer inferred as transaction source; fee-bump envelope was not verified.');
  return {
    hash: transaction.hash,
    transactionSource: transaction.source_account,
    feePayingAccount: feePayer,
    feeChargedStroops: feeString,
    feeBump: envelope?.feeBump ?? null,
    ledger: transaction.ledger ?? null,
    timestamp: transaction.created_at ?? null,
    successful: transaction.successful ?? null,
    operationCount: operations.length,
    operations: sources,
    assetTransfers: sources.filter((s) => s.category === 'asset_transfer'),
    nonTransfers: sources.filter((s) => s.category !== 'asset_transfer'),
    warnings,
    note: 'Fee is charged once to the fee payer, not once per operation. Failed transactions still incur fees.',
  };
}

export async function analyzeTransaction(
  hash: string, network: Network, fetcher: JsonFetcher = fetch,
) {
  if (!/^[a-f0-9]{64}$/i.test(hash)) throw new Error('Invalid 64-character transaction hash');
  const tx = await getJson<TransactionRecord>(network, `/transactions/${hash}`, fetcher);
  if (tx.hash.toLowerCase() !== hash.toLowerCase()) throw new Error('Horizon transaction hash mismatch');
  const ops = await pages<OperationRecord>(network,
    `/transactions/${hash}/operations?limit=200&order=asc`, 10, fetcher);
  let envelope: EnvelopeSources | undefined;
  let xdrWarning: string | undefined;
  if (tx.envelope_xdr) {
    try { envelope = decodeEnvelopeSources(tx.envelope_xdr, network); }
    catch (error) { xdrWarning = `Could not decode envelope XDR: ${String(error)}`; }
  }
  const report = attributeTransaction(tx, ops.records, envelope);
  return { network, ...report, warnings: [
    ...report.warnings,
    ...(!ops.complete ? ['Operation history incomplete due to pagination limit.'] : []),
    ...(xdrWarning ? [xdrWarning] : []),
  ] };
}

if (require.main === module) {
  const [hash, network = 'testnet'] = process.argv.slice(2);
  analyzeTransaction(hash ?? '', network as Network)
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
