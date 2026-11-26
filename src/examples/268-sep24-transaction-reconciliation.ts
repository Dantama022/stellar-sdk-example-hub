export type Sep24TransactionKind = 'deposit' | 'withdrawal';

export type Sep24TransactionStatus =
  | 'incomplete'
  | 'pending_user_transfer_start'
  | 'pending_user_transfer_complete'
  | 'pending_external'
  | 'pending_anchor'
  | 'pending_stellar'
  | 'pending_trust'
  | 'pending_user'
  | 'completed'
  | 'refunded'
  | 'expired'
  | 'error';

export interface Sep24TransactionRecord {
  id: string;
  kind: Sep24TransactionKind;
  status: Sep24TransactionStatus | string;
  started_at?: string;
  updated_at?: string;
  completed_at?: string;
  stellar_transaction_id?: string;
  amount_in?: string;
  amount_in_asset?: string;
  amount_out?: string;
  amount_out_asset?: string;
  amount_fee?: string;
  amount_fee_asset?: string;
  from?: string;
  to?: string;
  status_eta?: number;
}

export interface OnChainPaymentRecord {
  transactionHash: string;
  successful: boolean;
  sourceAccount: string;
  destinationAccount: string;
  assetCode: string;
  assetIssuer: string | null;
  amount: string;
}

export interface Sep24AnchorClient {
  fetchTransactions(params?: {
    assetCode?: string;
    id?: string;
    noOlderThan?: string;
    limit?: number;
    pagingId?: string;
  }): Promise<Sep24TransactionRecord[]>;
}

export interface StellarTransactionLookup {
  findPaymentByTxHash(txHash: string): Promise<OnChainPaymentRecord | null>;
}

export interface ReconciliationOptions {
  anchorService?: string;
  nowMs?: number;
  pendingWarningThresholdMs?: number;
  observedOnChainPayments?: OnChainPaymentRecord[];
}

export interface ReconciledTransactionItem {
  sep24Id: string;
  kind: Sep24TransactionKind | string;
  anchorStatus: string;
  stellarTransactionHash: string | null;
  onChainVerificationStatus:
    | 'verified'
    | 'mismatch'
    | 'not_found'
    | 'missing_tx_hash'
    | 'lookup_error'
    | 'not_applicable';
  expectedAsset: string | null;
  observedAsset: string | null;
  expectedAmount: string | null;
  observedAmount: string | null;
  expectedDestination: string | null;
  observedDestination: string | null;
  pendingDurationMs: number | null;
  anomalies: string[];
  reconciled: boolean;
}

export interface Sep24ReconciliationReport {
  anchorService: string;
  totalAnchorRecords: number;
  reconciledCount: number;
  unresolvedOrMismatchedCount: number;
  duplicateTxHashes: string[];
  unmatchedOnChainHashes: string[];
  items: ReconciledTransactionItem[];
  disclaimer: string;
}

const STROOPS_SCALE = 10_000_000n;

const PENDING_STATUSES = new Set<string>([
  'incomplete',
  'pending_user_transfer_start',
  'pending_user_transfer_complete',
  'pending_external',
  'pending_anchor',
  'pending_stellar',
  'pending_trust',
  'pending_user',
]);

function decimalToStroops(value: string): bigint {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,7})?$/.test(trimmed)) {
    throw new Error(`Invalid Stellar decimal amount: "${value}"`);
  }
  const [whole, frac = ''] = trimmed.split('.');
  return BigInt(whole) * STROOPS_SCALE + BigInt(frac.padEnd(7, '0'));
}

function normalizeSep24Asset(assetIdentifier: string | undefined): string | null {
  if (!assetIdentifier) return null;
  const trimmed = assetIdentifier.trim();
  if (trimmed === 'native' || trimmed === 'XLM' || trimmed === 'stellar:native') return 'XLM';
  if (trimmed.startsWith('stellar:')) {
    return trimmed.slice('stellar:'.length);
  }
  return trimmed;
}

function formatOnChainAsset(payment: OnChainPaymentRecord): string {
  if (!payment.assetIssuer || payment.assetCode === 'XLM' || payment.assetCode === 'native') {
    return 'XLM';
  }
  return `${payment.assetCode}:${payment.assetIssuer}`;
}

export function createHttpSep24Client(
  baseUrl: string,
  authToken: string,
  fetcher: (url: string, init: { method: string; headers: Record<string, string> }) => Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }> = (url, init) => fetch(url, init),
): Sep24AnchorClient {
  const cleanBase = baseUrl.replace(/\/+$/, '');
  return {
    async fetchTransactions(params = {}) {
      const search = new URLSearchParams();
      if (params.assetCode) search.set('asset_code', params.assetCode);
      if (params.id) search.set('id', params.id);
      if (params.noOlderThan) search.set('no_older_than', params.noOlderThan);
      if (params.limit !== undefined) search.set('limit', String(params.limit));
      if (params.pagingId) search.set('paging_id', params.pagingId);

      const query = search.toString();
      const url = `${cleanBase}/transactions${query ? `?${query}` : ''}`;
      const res = await fetcher(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
      });

      if (!res.ok) {
        throw new Error(`SEP-24 anchor returned HTTP ${res.status}`);
      }
      const body = (await res.json()) as { transactions?: unknown };
      if (!body || typeof body !== 'object' || !Array.isArray(body.transactions)) {
        throw new Error('Malformed SEP-24 /transactions response: missing transactions array.');
      }
      return body.transactions as Sep24TransactionRecord[];
    },
  };
}

export async function reconcileSep24Transactions(
  anchorRecords: Sep24TransactionRecord[],
  stellarLookup: StellarTransactionLookup,
  options: ReconciliationOptions = {},
): Promise<Sep24ReconciliationReport> {
  const anchorService = options.anchorService ?? 'unspecified-anchor';
  const nowMs = options.nowMs ?? Date.now();
  const pendingThresholdMs = options.pendingWarningThresholdMs ?? 3_600_000;

  const hashCounts = new Map<string, number>();
  for (const rec of anchorRecords) {
    const hash = rec.stellar_transaction_id?.trim();
    if (hash) {
      hashCounts.set(hash, (hashCounts.get(hash) ?? 0) + 1);
    }
  }
  const duplicateTxHashes = Array.from(hashCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([hash]) => hash);
  const duplicateSet = new Set(duplicateTxHashes);

  const items: ReconciledTransactionItem[] = [];
  const matchedHashes = new Set<string>();

  for (const rec of anchorRecords) {
    const anomalies: string[] = [];
    const txHash = rec.stellar_transaction_id?.trim() || null;

    if (txHash && duplicateSet.has(txHash)) {
      anomalies.push(`Duplicate stellar_transaction_id "${txHash}" referenced by multiple anchor records.`);
    }

    let pendingDurationMs: number | null = null;
    if (PENDING_STATUSES.has(rec.status) && rec.started_at) {
      const started = Date.parse(rec.started_at);
      if (!Number.isNaN(started)) {
        pendingDurationMs = Math.max(0, nowMs - started);
        if (pendingDurationMs > pendingThresholdMs) {
          anomalies.push(
            `Transaction has remained in "${rec.status}" for ${pendingDurationMs} ms (exceeds ${pendingThresholdMs} ms threshold).`,
          );
        }
      }
    }

    if (rec.status === 'refunded' || rec.status === 'expired' || rec.status === 'error') {
      anomalies.push(`Anchor reported terminal non-completed status "${rec.status}".`);
    }

    const expectedAsset =
      rec.kind === 'deposit'
        ? normalizeSep24Asset(rec.amount_out_asset ?? rec.amount_in_asset)
        : normalizeSep24Asset(rec.amount_in_asset ?? rec.amount_out_asset);
    const expectedAmount =
      rec.kind === 'deposit' ? rec.amount_out ?? null : rec.amount_in ?? null;
    const expectedDestination = rec.to ?? null;

    if (!txHash) {
      if (rec.status === 'completed') {
        anomalies.push('Anchor marked transaction completed, but stellar_transaction_id is missing.');
      }
      items.push({
        sep24Id: rec.id,
        kind: rec.kind,
        anchorStatus: rec.status,
        stellarTransactionHash: null,
        onChainVerificationStatus: rec.status === 'completed' ? 'missing_tx_hash' : 'not_applicable',
        expectedAsset,
        observedAsset: null,
        expectedAmount,
        observedAmount: null,
        expectedDestination,
        observedDestination: null,
        pendingDurationMs,
        anomalies,
        reconciled: false,
      });
      continue;
    }

    if (!/^[0-9a-fA-F]{64}$/.test(txHash)) {
      anomalies.push(`Malformed stellar_transaction_id format: "${txHash}".`);
      items.push({
        sep24Id: rec.id,
        kind: rec.kind,
        anchorStatus: rec.status,
        stellarTransactionHash: txHash,
        onChainVerificationStatus: 'mismatch',
        expectedAsset,
        observedAsset: null,
        expectedAmount,
        observedAmount: null,
        expectedDestination,
        observedDestination: null,
        pendingDurationMs,
        anomalies,
        reconciled: false,
      });
      continue;
    }

    let onChain: OnChainPaymentRecord | null = null;
    try {
      onChain = await stellarLookup.findPaymentByTxHash(txHash);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      anomalies.push(`Stellar transaction lookup failed for ${txHash}: ${msg}`);
      items.push({
        sep24Id: rec.id,
        kind: rec.kind,
        anchorStatus: rec.status,
        stellarTransactionHash: txHash,
        onChainVerificationStatus: 'lookup_error',
        expectedAsset,
        observedAsset: null,
        expectedAmount,
        observedAmount: null,
        expectedDestination,
        observedDestination: null,
        pendingDurationMs,
        anomalies,
        reconciled: false,
      });
      continue;
    }

    if (!onChain) {
      anomalies.push(`No matching on-chain Stellar transaction found for hash ${txHash}.`);
      items.push({
        sep24Id: rec.id,
        kind: rec.kind,
        anchorStatus: rec.status,
        stellarTransactionHash: txHash,
        onChainVerificationStatus: 'not_found',
        expectedAsset,
        observedAsset: null,
        expectedAmount,
        observedAmount: null,
        expectedDestination,
        observedDestination: null,
        pendingDurationMs,
        anomalies,
        reconciled: false,
      });
      continue;
    }

    matchedHashes.add(txHash);
    const observedAsset = formatOnChainAsset(onChain);
    const observedAmount = onChain.amount;
    const observedDestination = onChain.destinationAccount;

    if (!onChain.successful) {
      anomalies.push(`On-chain transaction ${txHash} failed on Stellar.`);
    }

    if (expectedAsset && observedAsset !== expectedAsset) {
      anomalies.push(`Asset mismatch: expected "${expectedAsset}", observed "${observedAsset}".`);
    }

    if (expectedAmount) {
      try {
        if (decimalToStroops(expectedAmount) !== decimalToStroops(observedAmount)) {
          anomalies.push(`Amount discrepancy: expected ${expectedAmount}, observed ${observedAmount}.`);
        }
      } catch (error) {
        anomalies.push(
          `Could not compare amounts (${expectedAmount} vs ${observedAmount}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (expectedDestination && observedDestination !== expectedDestination) {
      anomalies.push(
        `Destination mismatch: expected ${expectedDestination}, observed ${observedDestination}.`,
      );
    }

    const hasMismatch = anomalies.length > 0;
    items.push({
      sep24Id: rec.id,
      kind: rec.kind,
      anchorStatus: rec.status,
      stellarTransactionHash: txHash,
      onChainVerificationStatus: hasMismatch ? 'mismatch' : 'verified',
      expectedAsset,
      observedAsset,
      expectedAmount,
      observedAmount,
      expectedDestination,
      observedDestination,
      pendingDurationMs,
      anomalies,
      reconciled: rec.status === 'completed' && !hasMismatch,
    });
  }

  const unmatchedOnChainHashes = (options.observedOnChainPayments ?? [])
    .map((p) => p.transactionHash)
    .filter((h) => !matchedHashes.has(h));

  const reconciledCount = items.filter((i) => i.reconciled).length;
  return {
    anchorService,
    totalAnchorRecords: anchorRecords.length,
    reconciledCount,
    unresolvedOrMismatchedCount: items.length - reconciledCount,
    duplicateTxHashes,
    unmatchedOnChainHashes,
    items,
    disclaimer:
      'Reconciliation only: anchor-reported completion is tracked separately from independent on-chain verification. No transactions are initiated or retried.',
  };
}

export function formatSep24ReconciliationReport(report: Sep24ReconciliationReport): string {
  const lines = [
    '=== Stellar SEP-24 Transaction Reconciliation Report ===',
    `Anchor: ${report.anchorService}`,
    `Total anchor records: ${report.totalAnchorRecords}`,
    `Reconciled: ${report.reconciledCount} | Unresolved/Mismatched: ${report.unresolvedOrMismatchedCount}`,
  ];
  for (const item of report.items) {
    lines.push(
      `  - [${item.sep24Id}] ${item.kind} | anchor=${item.anchorStatus} | onChain=${item.onChainVerificationStatus} | tx=${item.stellarTransactionHash ?? 'none'}`,
    );
    for (const a of item.anomalies) {
      lines.push(`      ! ${a}`);
    }
  }
  lines.push('', `Disclaimer: ${report.disclaimer}`);
  return lines.join('\n');
}

export async function run(params: { json?: boolean | string } = {}): Promise<void> {
  const sampleHash = 'a'.repeat(64);
  const report = await reconcileSep24Transactions(
    [
      {
        id: 'sep24-dep-1',
        kind: 'deposit',
        status: 'completed',
        stellar_transaction_id: sampleHash,
        amount_out: '100.0000000',
        amount_out_asset: 'stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        to: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7',
      },
    ],
    {
      async findPaymentByTxHash(hash) {
        return {
          transactionHash: hash,
          successful: true,
          sourceAccount: 'GBBM6BKZPEHWYO3E3YKREDPQXMS4VK35YLNU7NFBRI26RAN7GI5POFBB',
          destinationAccount: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7',
          assetCode: 'USDC',
          assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
          amount: '100.0000000',
        };
      },
    },
    { anchorService: 'https://anchor.example.com' },
  );
  const json = params.json === true || params.json === 'true';
  console.log(json ? JSON.stringify(report, null, 2) : formatSep24ReconciliationReport(report));
}
