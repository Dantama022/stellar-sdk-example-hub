import { assertAccount, fromUnits, getJson, horizonEndpoint, readPages, toUnits } from '../_multi-analyzer/common';
import type { FlowEdge, FlowOptions, FlowReport, RawOperation } from './types';

export function assetIdentity(type?: string, code?: string, issuer?: string): string {
  if (type === 'native') return 'XLM';
  if ((type === 'credit_alphanum4' || type === 'credit_alphanum12') && code && issuer) {
    assertAccount(issuer);
    return `${code}:${issuer}`;
  }
  throw new Error('Missing or unsupported asset identity');
}

/** A Horizon operation is a ledger fact; a graph edge is only its simplified representation. */
export function operationToEdge(op: RawOperation, ledger: number | null): FlowEdge | null {
  if (op.transaction_successful !== true) return null;
  if (!op.transaction_hash || op.id === undefined) throw new Error('Operation has no auditable ID/hash');
  let from: string | undefined; let to: string | undefined;
  let sentAmount: string | undefined; let receivedAmount: string | undefined;
  let sentAsset: string; let receivedAsset: string;
  let kind: FlowEdge['kind']; let interpretation: string;
  if (op.type === 'payment') {
    from = op.from ?? op.source_account; to = op.to;
    sentAmount = receivedAmount = op.amount;
    sentAsset = receivedAsset = assetIdentity(op.asset_type, op.asset_code, op.asset_issuer);
    kind = 'direct'; interpretation = 'Direct payment operation (not a claim about real-world purpose)';
  } else if (op.type === 'create_account') {
    from = op.source_account; to = op.account;
    sentAmount = receivedAmount = op.starting_balance;
    sentAsset = receivedAsset = 'XLM'; kind = 'account_funding';
    interpretation = 'Account creation funding, distinct from an ordinary payment';
  } else if (op.type === 'path_payment_strict_send' || op.type === 'path_payment_strict_receive') {
    from = op.from ?? op.source_account; to = op.to;
    sentAmount = op.source_amount; receivedAmount = op.amount;
    sentAsset = assetIdentity(op.source_asset_type, op.source_asset_code, op.source_asset_issuer);
    receivedAsset = assetIdentity(op.asset_type, op.asset_code, op.asset_issuer);
    kind = 'path'; interpretation = 'Path payment: source and destination amounts/assets may differ; intermediate trades are not separate user payments';
  } else return null;
  if (!from || !to || !sentAmount || !receivedAmount) throw new Error('Incomplete operation participants or amounts');
  assertAccount(from); assertAccount(to);
  toUnits(sentAmount); toUnits(receivedAmount);
  return {
    operationId: String(op.id), transactionHash: op.transaction_hash, ledger,
    timestamp: op.created_at ?? null, kind, from, to,
    sentAsset, sentAmount, receivedAsset, receivedAmount, interpretation,
  };
}

export function summarizeFlows(
  network: FlowOptions['network'], accounts: string[], ops: RawOperation[],
  options: Pick<FlowOptions, 'fromLedger' | 'toLedger' | 'fromTime' | 'toTime'>,
  extra: { complete: boolean; pages: number; accountPages: Record<string, number>; warnings: string[] },
): FlowReport {
  const accountSet = new Set(accounts);
  const balances = new Map<string, { in: Map<string, bigint>; out: Map<string, bigint>; n: number }>();
  for (const account of accounts) balances.set(account, { in: new Map(), out: new Map(), n: 0 });
  const edges: FlowEdge[] = []; const unsupported: Record<string, number> = {};
  const warnings = [...extra.warnings]; const transactionOps = new Map<string, string[]>();
  const participants = new Map<string, number>();
  const seen = new Set<string>();
  const sorted = [...ops].sort((a, b) => {
    const aa = BigInt(String(a.paging_token ?? a.id)); const bb = BigInt(String(b.paging_token ?? b.id));
    return aa < bb ? -1 : aa > bb ? 1 : 0;
  });
  let inspected = 0;
  for (const op of sorted) {
    const id = String(op.id);
    if (seen.has(id)) continue;
    seen.add(id);
    const ledger = op.ledger ?? null;
    const inLedgerRange = options.fromLedger !== undefined || options.toLedger !== undefined;
    if (inLedgerRange && ledger === null) {
      warnings.push(`Operation ${id}: ledger unavailable; excluded from ledger-filtered results`);
      continue;
    }
    if (ledger !== null && (ledger < (options.fromLedger ?? 0) || ledger > (options.toLedger ?? Infinity))) continue;
    if (options.fromTime && (!op.created_at || op.created_at < options.fromTime)) continue;
    if (options.toTime && (!op.created_at || op.created_at > options.toTime)) continue;
    inspected++;
    if (!op.transaction_hash) { warnings.push(`Operation ${id} missing transaction hash`); continue; }
    const transactionOpIds = transactionOps.get(op.transaction_hash) ?? [];
    transactionOpIds.push(id); transactionOps.set(op.transaction_hash, transactionOpIds);
    if (op.transaction_successful !== true) {
      if (op.transaction_successful === undefined) warnings.push(`Operation ${id}: transaction success could not be verified`);
      continue;
    }
    try {
      const edge = operationToEdge(op, ledger);
      if (!edge) { unsupported[op.type] = (unsupported[op.type] ?? 0) + 1; continue; }
      if (!accountSet.has(edge.from) && !accountSet.has(edge.to)) continue;
      edges.push(edge);
      for (const [account, key, asset, amount] of [
        [edge.from, 'out', edge.sentAsset, edge.sentAmount],
        [edge.to, 'in', edge.receivedAsset, edge.receivedAmount],
      ] as const) {
        const item = balances.get(account);
        if (!item) continue;
        item.n++;
        const store = item[key]; store.set(asset, (store.get(asset) ?? 0n) + toUnits(amount));
      }
      participants.set(edge.from, (participants.get(edge.from) ?? 0) + 1);
      participants.set(edge.to, (participants.get(edge.to) ?? 0) + 1);
    } catch (error) { warnings.push(`Operation ${id}: ${String(error)}`); }
  }
  const accountsSummary: FlowReport['accountsSummary'] = {};
  for (const [account, balance] of balances) {
    accountsSummary[account] = {
      incoming: Object.fromEntries([...balance.in].map(([asset, value]) => [asset, fromUnits(value)])),
      outgoing: Object.fromEntries([...balance.out].map(([asset, value]) => [asset, fromUnits(value)])),
      relatedOperations: balance.n,
    };
  }
  return {
    network, accounts, range: { fromLedger: options.fromLedger ?? null, toLedger: options.toLedger ?? null,
      fromTime: options.fromTime ?? null, toTime: options.toTime ?? null },
    inspectedOperations: inspected, transactions: [...transactionOps].map(([hash, operations]) => ({ hash, operations })),
    relationships: edges, accountsSummary,
    repeatParticipants: [...participants].filter(([, n]) => n > 1)
      .map(([account, observations]) => ({ account, observations })).sort((a, b) => b.observations - a.observations),
    pagination: { complete: extra.complete, pages: extra.pages, accountPages: extra.accountPages },
    unsupportedOperations: unsupported, warnings,
  };
}

export async function analyzeFlows(options: FlowOptions): Promise<FlowReport> {
  const accounts = [...new Set(options.accounts)];
  if (!accounts.length || accounts.length > 20) throw new Error('Specify 1..20 public accounts');
  accounts.forEach(assertAccount);
  if (options.fromLedger !== undefined && (!Number.isSafeInteger(options.fromLedger) || options.fromLedger < 1)) throw new Error('Invalid fromLedger');
  if (options.toLedger !== undefined && (!Number.isSafeInteger(options.toLedger) || options.toLedger < 1)) throw new Error('Invalid toLedger');
  if (options.fromLedger !== undefined && options.toLedger !== undefined && options.fromLedger > options.toLedger) throw new Error('Invalid ledger range');
  for (const date of [options.fromTime, options.toTime]) if (date && !/^\d{4}-\d\d-\d\dT/.test(date) || date && !Number.isFinite(Date.parse(date))) throw new Error('Invalid ISO timestamp');
  if (options.fromTime && options.toTime && options.fromTime > options.toTime) throw new Error('Invalid time range');
  if (options.fromLedger === undefined && options.toLedger === undefined && !options.fromTime && !options.toTime) {
    throw new Error('Specify a bounded ledger or time range');
  }
  const horizon = horizonEndpoint(options.network, options.horizonUrl);
  const operations: RawOperation[] = []; let complete = true; let pages = 0;
  const accountPages: Record<string, number> = {}; const warnings: string[] = [];
  for (const account of accounts) {
    const response = await readPages<RawOperation>(horizon, `/accounts/${account}/operations`, options.maxPages ?? 5, options.fetcher);
    operations.push(...response.records); complete = complete && response.complete;
    pages += response.pages; accountPages[account] = response.pages;
    warnings.push(...response.warnings.map(w => `${account}: ${w}`));
  }
  // Operation objects expose the success flag. Resolve ledger numbers only when
  // needed and absent; transactions are cached and fetched with bounded fan-out.
  const lookup = [...new Set(operations.filter(o => (o.ledger === undefined || o.transaction_successful === undefined) && o.transaction_hash)
    .map(o => o.transaction_hash as string))];
  const meta = new Map<string, { ledger: number; successful: boolean; created_at?: string }>();
  for (let i = 0; i < lookup.length; i += 5) {
    await Promise.all(lookup.slice(i, i + 5).map(async hash => {
      try {
        const tx = await getJson<{ ledger: number; successful: boolean; created_at?: string }>(
          horizon, `/transactions/${hash}`, options.fetcher);
        if (!Number.isSafeInteger(tx.ledger)) throw new Error('Missing ledger');
        meta.set(hash, tx);
      } catch (error) { complete = false; warnings.push(`Transaction ${hash}: ${String(error)}`); }
    }));
  }
  for (const op of operations) {
    const tx = meta.get(op.transaction_hash ?? '');
    if (tx) { op.ledger ??= tx.ledger; op.transaction_successful ??= tx.successful; op.created_at ??= tx.created_at; }
  }
  return summarizeFlows(options.network, accounts, operations, options, { complete, pages, accountPages, warnings });
}
