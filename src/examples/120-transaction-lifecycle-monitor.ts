import { Horizon } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface TransactionLifecycleParams {
  transactionHash?: string;
  pollIntervalMs?: string | number;
  timeoutMs?: string | number;
  horizonUrl?: string;
  json?: boolean | string;
}

export type TransactionLifecycleStatus = 'pending' | 'confirmed' | 'failed' | 'timeout';

export interface TransactionLifecycleReport {
  transactionHash: string;
  status: TransactionLifecycleStatus;
  ledgerSequence: number | null;
  ledgerCloseTime: string | null;
  successfulOperationCount: number;
  feeCharged: string | null;
  resultCode: string | null;
  polls: number;
  elapsedMs: number;
}

export interface RawTransactionRecord {
  hash?: string;
  successful?: boolean;
  ledger?: number;
  ledger_attr?: number;
  created_at?: string;
  operation_count?: number;
  fee_charged?: string;
  result_code?: string;
}

export interface MonitorOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function wantsJson(params: TransactionLifecycleParams): boolean {
  return (
    params.json === true ||
    params.json === 'true' ||
    process.env.JSON_OUTPUT === 'true' ||
    process.argv.includes('--json')
  );
}

function readNonNegativeInt(
  value: string | number | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number.`);
  }
  return Math.floor(parsed);
}

export function validateTransactionHash(value: string): string {
  const hash = value.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error('Transaction hash must be exactly 64 hexadecimal characters.');
  }
  return hash.toLowerCase();
}

export function getHorizonErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('response' in error)) {
    return undefined;
  }
  const response = (error as { response?: { status?: unknown } }).response;
  return typeof response?.status === 'number' ? response.status : undefined;
}

export function getRetryAfterMs(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('response' in error)) {
    return undefined;
  }
  const response = (
    error as {
      response?: {
        headers?: Record<string, unknown> & { get?: (name: string) => string | null };
      };
    }
  ).response;
  const headers = response?.headers;
  if (!headers) {
    return undefined;
  }

  const raw =
    typeof headers.get === 'function'
      ? headers.get('retry-after')
      : (headers['retry-after'] ?? headers['Retry-After']);

  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return undefined;
  }

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const dateMs = Date.parse(String(raw));
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now());
}

export function parseTransactionRecord(
  transactionHash: string,
  record: RawTransactionRecord,
  polls: number,
  elapsedMs: number,
): TransactionLifecycleReport {
  const successful = record.successful === true;
  const operationCount = Number(record.operation_count ?? 0);

  return {
    transactionHash: record.hash ?? transactionHash,
    status: successful ? 'confirmed' : 'failed',
    ledgerSequence: record.ledger_attr ?? record.ledger ?? null,
    ledgerCloseTime: record.created_at ?? null,
    successfulOperationCount:
      successful && Number.isFinite(operationCount) ? Math.max(0, operationCount) : 0,
    feeCharged: record.fee_charged ?? null,
    resultCode: record.result_code ?? (successful ? 'tx_success' : 'tx_failed'),
    polls,
    elapsedMs,
  };
}

export async function monitorTransaction(
  transactionHash: string,
  fetchTransaction: () => Promise<RawTransactionRecord>,
  options: MonitorOptions = {},
): Promise<TransactionLifecycleReport> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const now = options.now ?? Date.now;
  const startedAt = now();
  let polls = 0;

  while (now() - startedAt <= timeoutMs) {
    polls += 1;
    try {
      const record = await fetchTransaction();
      return parseTransactionRecord(transactionHash, record, polls, now() - startedAt);
    } catch (error) {
      const status = getHorizonErrorStatus(error);
      if (status !== 404 && status !== 429) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Horizon transaction lookup failed: ${message}`);
      }

      const delay =
        status === 429
          ? Math.max(pollIntervalMs, getRetryAfterMs(error) ?? pollIntervalMs)
          : pollIntervalMs;

      if (now() - startedAt + delay > timeoutMs) {
        break;
      }
      await sleep(delay);
    }
  }

  return {
    transactionHash,
    status: 'timeout',
    ledgerSequence: null,
    ledgerCloseTime: null,
    successfulOperationCount: 0,
    feeCharged: null,
    resultCode: null,
    polls,
    elapsedMs: now() - startedAt,
  };
}

async function discoverLatestTransactionHash(server: Horizon.Server): Promise<string | null> {
  const page = await server.transactions().order('desc').limit(1).call();
  const record = page.records[0] as unknown as RawTransactionRecord | undefined;
  return record?.hash ?? null;
}

export async function run(params: TransactionLifecycleParams = {}): Promise<void> {
  const horizonUrl = params.horizonUrl || process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const pollIntervalMs = readNonNegativeInt(
    params.pollIntervalMs ?? process.env.POLL_INTERVAL_MS,
    DEFAULT_POLL_INTERVAL_MS,
    'pollIntervalMs',
  );
  const timeoutMs = readNonNegativeInt(
    params.timeoutMs ?? process.env.POLL_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    'timeoutMs',
  );
  const server = new Horizon.Server(horizonUrl);
  const json = wantsJson(params);

  let input = params.transactionHash?.trim() || process.env.TRANSACTION_HASH?.trim();
  if (!input) {
    if (!json) {
      console.log('No transaction hash supplied; using the latest Horizon transaction.');
    }
    input = (await discoverLatestTransactionHash(server)) ?? undefined;
  }
  if (!input) {
    throw new Error('No transaction is currently available to monitor.');
  }

  const transactionHash = validateTransactionHash(input);
  const report = await monitorTransaction(
    transactionHash,
    async () =>
      (await server
        .transactions()
        .transaction(transactionHash)
        .call()) as unknown as RawTransactionRecord,
    { pollIntervalMs, timeoutMs },
  );

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('\n=== Stellar Transaction Lifecycle Monitor ===');
  console.log(`Transaction hash:          ${report.transactionHash}`);
  console.log(`Current status:            ${report.status}`);
  console.log(`Ledger sequence:           ${report.ledgerSequence ?? 'Unavailable'}`);
  console.log(`Ledger close time:         ${report.ledgerCloseTime ?? 'Unavailable'}`);
  console.log(`Successful operation count:${report.successfulOperationCount}`);
  console.log(`Fee charged:               ${report.feeCharged ?? 'Unavailable'}`);
  console.log(`Result code:               ${report.resultCode ?? 'Unavailable'}`);
  console.log(`Poll attempts:             ${report.polls}`);
  if (report.status === 'timeout') {
    console.log('The transaction was not available in Horizon before the polling timeout.');
  }
}
