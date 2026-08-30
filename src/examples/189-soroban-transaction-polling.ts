import { rpc } from '@stellar/stellar-sdk';

const HASH_PATTERN = /^[0-9a-f]{64}$/i;

export type TransactionStatus = 'NOT_FOUND' | 'PENDING' | 'SUCCESS' | 'FAILED';

export interface PollingOptions {
  initialIntervalMs?: number;
  backoffMultiplier?: number;
  maxIntervalMs?: number;
  timeoutMs?: number;
  maxRpcRetries?: number;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  onUpdate?: (update: PollingUpdate) => void;
}

export interface PollingUpdate {
  attempt: number;
  status: string;
  waitMs: number;
  elapsedMs: number;
  ledger?: number;
  rpcRetry?: boolean;
}

export interface PollingResult {
  status: TransactionStatus;
  response?: unknown;
  attempts: number;
  elapsedMs: number;
}

export function validateTransactionHash(hash: string): string {
  const normalizedHash = hash.trim();
  if (!HASH_PATTERN.test(normalizedHash)) {
    throw new Error('Transaction hash must be exactly 64 hexadecimal characters.');
  }
  return normalizedHash;
}

export function calculatePollDelay(
  initialIntervalMs: number,
  multiplier: number,
  maxIntervalMs: number,
  attempt: number,
): number {
  return Math.min(maxIntervalMs, initialIntervalMs * multiplier ** Math.max(0, attempt - 1));
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Polling canceled.'));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('Polling canceled.'));
    }, { once: true });
  });
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  const status = candidate.status ?? candidate.statusCode ?? candidate.response?.status;
  return typeof status === 'number' ? status : undefined;
}

export function isPermanentRpcError(error: unknown): boolean {
  const status = errorStatus(error);
  if (status !== undefined) return status >= 400 && status < 500 && status !== 408 && status !== 429;
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'number' && code >= -32099 && code <= -32000;
  }
  return false;
}

function getStatus(response: unknown): TransactionStatus {
  const status = (response as { status?: unknown })?.status;
  if (status === 'NOT_FOUND' || status === 'PENDING' || status === 'SUCCESS' || status === 'FAILED') return status;
  throw new Error(`Unexpected Soroban transaction status: ${String(status)}`);
}

function getLedger(response: unknown): number | undefined {
  const ledger = (response as { ledger?: unknown })?.ledger;
  return typeof ledger === 'number' ? ledger : undefined;
}

export async function pollTransactionStatus(
  getTransaction: (hash: string) => Promise<unknown>,
  hash: string,
  options: PollingOptions = {},
): Promise<PollingResult> {
  const transactionHash = validateTransactionHash(hash);
  const initialIntervalMs = options.initialIntervalMs ?? 1_000;
  const backoffMultiplier = options.backoffMultiplier ?? 2;
  const maxIntervalMs = options.maxIntervalMs ?? 10_000;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxRpcRetries = options.maxRpcRetries ?? 3;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const startedAt = now();
  let attempt = 0;
  let intervalMs = initialIntervalMs;

  if (initialIntervalMs <= 0 || maxIntervalMs < initialIntervalMs || backoffMultiplier < 1 || timeoutMs <= 0) {
    throw new Error('Polling intervals, multiplier, and timeout must be valid positive values.');
  }

  while (now() - startedAt < timeoutMs) {
    if (options.signal?.aborted) throw new Error('Polling canceled.');
    attempt += 1;
    let response: unknown;
    let retry = 0;
    while (true) {
      try {
        response = await getTransaction(transactionHash);
        break;
      } catch (error) {
        if (isPermanentRpcError(error) || retry >= maxRpcRetries) {
          throw new Error(`Soroban RPC status query failed permanently: ${error instanceof Error ? error.message : String(error)}`);
        }
        retry += 1;
        const retryDelay = Math.min(maxIntervalMs, intervalMs * 2 ** retry);
        options.onUpdate?.({ attempt, status: 'RPC_ERROR_RETRYING', waitMs: retryDelay, elapsedMs: now() - startedAt, rpcRetry: true });
        await sleep(retryDelay, options.signal);
      }
    }

    const status = getStatus(response);
    const elapsedMs = now() - startedAt;
    options.onUpdate?.({ attempt, status, waitMs: 0, elapsedMs, ledger: getLedger(response) });
    if (status === 'SUCCESS' || status === 'FAILED') return { status, response, attempts: attempt, elapsedMs };

    const waitMs = Math.min(intervalMs, timeoutMs - elapsedMs);
    options.onUpdate?.({ attempt, status, waitMs, elapsedMs, ledger: getLedger(response) });
    await sleep(waitMs, options.signal);
    intervalMs = Math.min(maxIntervalMs, intervalMs * backoffMultiplier);
  }
  throw new Error(`Polling timed out after ${timeoutMs}ms for transaction ${transactionHash}.`);
}

function outputUpdate(update: PollingUpdate, json: boolean): void {
  const payload = { ...update, elapsedSeconds: Number((update.elapsedMs / 1000).toFixed(1)) };
  if (json) console.log(JSON.stringify(payload));
  else {
    const ledger = update.ledger === undefined ? '' : ` ledger=${update.ledger}`;
    console.log(`Attempt ${update.attempt}: ${update.status}${ledger} | wait ${update.waitMs}ms | elapsed ${payload.elapsedSeconds}s`);
  }
}

function parameter(params: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = params?.[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export async function run(params?: Record<string, unknown>): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const rpcUrl = parameter(params, 'rpcUrl') ?? process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org';
  const hash = parameter(params, 'transactionHash') ?? process.env.TRANSACTION_HASH ?? args[1];
  if (!hash) throw new Error('Provide a transaction hash through the runner, command line, or TRANSACTION_HASH.');
  const json = parameter(params, 'json') === 'true' || process.env.JSON_OUTPUT === 'true' || process.argv.includes('--json');
  const server = new rpc.Server(rpcUrl);
  const controller = new AbortController();
  const handleSigint = (): void => controller.abort();
  process.once('SIGINT', handleSigint);
  try {
    if (!json) console.log(`Polling ${validateTransactionHash(hash)} using ${rpcUrl}`);
    const result = await pollTransactionStatus(server.getTransaction.bind(server), hash, {
      initialIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 1_000),
      backoffMultiplier: Number(process.env.POLL_BACKOFF_MULTIPLIER ?? 2),
      maxIntervalMs: Number(process.env.POLL_MAX_INTERVAL_MS ?? 10_000),
      timeoutMs: Number(process.env.POLL_TIMEOUT_MS ?? 120_000),
      maxRpcRetries: Number(process.env.POLL_RPC_RETRIES ?? 3),
      signal: controller.signal,
      onUpdate: (update) => outputUpdate(update, json),
    });
    if (json) console.log(JSON.stringify(result));
    else console.log(`Final status: ${result.status} after ${result.attempts} attempt(s).`);
  } finally {
    process.off('SIGINT', handleSigint);
  }
}

if (require.main === module) run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});