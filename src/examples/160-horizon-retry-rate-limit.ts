import { Horizon } from '@stellar/stellar-sdk';
import chalk from 'chalk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 8_000;

export interface RetryRequestOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  requestTimeoutMs?: number;
}

export interface RetryDiagnostics {
  attempts: number;
  retried: boolean;
  lastStatus?: number;
  lastRetryAfterMs?: number;
  errorType?: 'network' | 'rate_limit' | 'server' | 'client' | 'unknown';
  message?: string;
}

export interface RetryRateLimitParams {
  horizonUrl?: string;
  accountId?: string;
  maxRetries?: string | number;
  baseDelayMs?: string | number;
  maxDelayMs?: string | number;
  requestTimeoutMs?: string | number;
  json?: boolean | string;
}

export interface RetryRateLimitReport {
  horizonUrl: string;
  accountId: string;
  diagnostics: RetryDiagnostics[];
  stats: {
    totalRequests: number;
    successfulRequests: number;
    retriedRequests: number;
    failedRequests: number;
    rateLimitHits: number;
  };
}

export class HorizonRequestError extends Error {
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;
  readonly errorType: RetryDiagnostics['errorType'];

  constructor(
    message: string,
    options: {
      status?: number;
      retryAfterMs?: number;
      retryable: boolean;
      errorType: RetryDiagnostics['errorType'];
    },
  ) {
    super(message);
    this.name = 'HorizonRequestError';
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.retryable = options.retryable;
    this.errorType = options.errorType;
  }
}

function wantsJson(params: RetryRateLimitParams = {}): boolean {
  return (
    params.json === true ||
    params.json === 'true' ||
    process.env.JSON_OUTPUT === 'true' ||
    process.argv.includes('--json')
  );
}

function readPositiveInt(
  value: string | number | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(chalk.yellow(`Ignoring invalid ${label}: ${value}. Using ${fallback}.`));
    return fallback;
  }

  return Math.floor(parsed);
}

export function parseRetryAfterMs(headerValue: string | null | undefined): number | undefined {
  if (!headerValue) {
    return undefined;
  }

  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const dateMs = Date.parse(headerValue);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return undefined;
}

export function classifyHorizonError(error: unknown): HorizonRequestError {
  if (error instanceof HorizonRequestError) {
    return error;
  }

  const response = (error as { response?: { status?: number; headers?: Record<string, string> } })
    .response;
  const status = response?.status;
  const retryAfterMs = parseRetryAfterMs(response?.headers?.['retry-after']);

  if (status === 429) {
    return new HorizonRequestError('Horizon rate limit exceeded', {
      status,
      retryAfterMs,
      retryable: true,
      errorType: 'rate_limit',
    });
  }

  if (status !== undefined && status >= 500) {
    return new HorizonRequestError(`Horizon server error (${status})`, {
      status,
      retryable: true,
      errorType: 'server',
    });
  }

  if (status !== undefined && status >= 400) {
    return new HorizonRequestError(`Horizon client error (${status})`, {
      status,
      retryable: false,
      errorType: 'client',
    });
  }

  const message = error instanceof Error ? error.message : String(error);
  const networkLike =
    message.includes('ECONNRESET') ||
    message.includes('ENOTFOUND') ||
    message.includes('ETIMEDOUT') ||
    message.includes('network') ||
    message.includes('timeout');

  return new HorizonRequestError(message, {
    retryable: networkLike,
    errorType: networkLike ? 'network' : 'unknown',
  });
}

export function computeRetryDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  retryAfterMs?: number,
): number {
  if (retryAfterMs !== undefined) {
    return retryAfterMs;
  }

  const exponential = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(maxDelayMs, exponential);
}

export function isRetryableError(error: unknown): boolean {
  return classifyHorizonError(error).retryable;
}

export function isRateLimitError(error: unknown): boolean {
  return classifyHorizonError(error).errorType === 'rate_limit';
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function executeWithRetry<T>(
  operation: () => Promise<T>,
  options: RetryRequestOptions = {},
): Promise<{ value: T; diagnostics: RetryDiagnostics }> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  let attempt = 0;
  let lastDiagnostics: RetryDiagnostics = {
    attempts: 0,
    retried: false,
  };

  while (attempt <= maxRetries) {
    attempt += 1;

    try {
      const value = await operation();
      return {
        value,
        diagnostics: {
          attempts: attempt,
          retried: attempt > 1,
        },
      };
    } catch (error) {
      const classified = classifyHorizonError(error);
      lastDiagnostics = {
        attempts: attempt,
        retried: attempt > 1,
        lastStatus: classified.status,
        lastRetryAfterMs: classified.retryAfterMs,
        errorType: classified.errorType,
        message: classified.message,
      };

      if (!classified.retryable || attempt > maxRetries) {
        throw classified;
      }

      const delayMs = computeRetryDelay(attempt, baseDelayMs, maxDelayMs, classified.retryAfterMs);
      await sleep(delayMs);
    }
  }

  throw new HorizonRequestError(lastDiagnostics.message ?? 'Request failed after retries', {
    status: lastDiagnostics.lastStatus,
    retryable: false,
    errorType: lastDiagnostics.errorType ?? 'unknown',
  });
}

async function resolveAccountId(server: Horizon.Server, accountId?: string): Promise<string> {
  if (accountId?.trim()) {
    return accountId.trim();
  }

  const recent = await server.operations().order('desc').limit(1).call();
  if (recent.records.length > 0) {
    return recent.records[0].source_account;
  }

  return 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
}

export async function run(params: RetryRateLimitParams = {}): Promise<RetryRateLimitReport> {
  const horizonUrl = params.horizonUrl || process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const maxRetries = readPositiveInt(
    params.maxRetries ?? process.env.MAX_RETRIES,
    DEFAULT_MAX_RETRIES,
    'maxRetries',
  );
  const baseDelayMs = readPositiveInt(
    params.baseDelayMs ?? process.env.BASE_DELAY_MS,
    DEFAULT_BASE_DELAY_MS,
    'baseDelayMs',
  );
  const maxDelayMs = readPositiveInt(
    params.maxDelayMs ?? process.env.MAX_DELAY_MS,
    DEFAULT_MAX_DELAY_MS,
    'maxDelayMs',
  );
  const json = wantsJson(params);

  const server = new Horizon.Server(horizonUrl);
  const accountId = await resolveAccountId(server, params.accountId || process.env.ACCOUNT_ID);

  if (!json) {
    console.log(chalk.bold('Horizon request retry and rate-limit handling example'));
    console.log(`Horizon URL: ${horizonUrl}`);
    console.log(`Account ID: ${accountId}`);
    console.log(`Max retries: ${maxRetries}`);
    console.log('');
  }

  const diagnostics: RetryDiagnostics[] = [];
  const stats = {
    totalRequests: 0,
    successfulRequests: 0,
    retriedRequests: 0,
    failedRequests: 0,
    rateLimitHits: 0,
  };

  const requestPlans: Array<{ label: string; operation: () => Promise<unknown> }> = [
    {
      label: 'account-load',
      operation: () => server.loadAccount(accountId),
    },
    {
      label: 'payments-page',
      operation: () => server.payments().forAccount(accountId).order('desc').limit(3).call(),
    },
    {
      label: 'operations-page',
      operation: () => server.operations().forAccount(accountId).order('desc').limit(3).call(),
    },
  ];

  for (const plan of requestPlans) {
    stats.totalRequests += 1;

    try {
      const { diagnostics: attemptDiagnostics } = await executeWithRetry(plan.operation, {
        maxRetries,
        baseDelayMs,
        maxDelayMs,
      });

      diagnostics.push({ ...attemptDiagnostics, message: `${plan.label}: success` });
      stats.successfulRequests += 1;
      if (attemptDiagnostics.retried) {
        stats.retriedRequests += 1;
      }

      if (!json) {
        console.log(
          chalk.green(
            `${plan.label}: success after ${attemptDiagnostics.attempts} attempt(s)${
              attemptDiagnostics.retried ? ' with retries' : ''
            }`,
          ),
        );
      }
    } catch (error) {
      const classified = classifyHorizonError(error);
      diagnostics.push({
        attempts: maxRetries + 1,
        retried: true,
        lastStatus: classified.status,
        lastRetryAfterMs: classified.retryAfterMs,
        errorType: classified.errorType,
        message: `${plan.label}: ${classified.message}`,
      });
      stats.failedRequests += 1;
      if (classified.errorType === 'rate_limit') {
        stats.rateLimitHits += 1;
      }

      if (!json) {
        console.log(
          chalk.red(`${plan.label}: failed (${classified.errorType}) - ${classified.message}`),
        );
      }
    }
  }

  // Demonstrate non-retryable client error classification without submitting a transaction.
  try {
    await executeWithRetry(
      () => server.operations().forAccount('not-a-valid-account').limit(1).call(),
      {
        maxRetries,
        baseDelayMs,
        maxDelayMs,
      },
    );
  } catch (error) {
    const classified = classifyHorizonError(error);
    diagnostics.push({
      attempts: 1,
      retried: false,
      lastStatus: classified.status,
      errorType: classified.errorType,
      message: `invalid-account: ${classified.message}`,
    });

    if (!json) {
      console.log(
        chalk.yellow(
          `invalid-account: classified as ${classified.errorType} (retryable=${classified.retryable})`,
        ),
      );
    }
  }

  const report: RetryRateLimitReport = {
    horizonUrl,
    accountId,
    diagnostics,
    stats,
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }

  console.log('\n--- Request Diagnostics ---');
  for (const entry of diagnostics) {
    console.log(
      `  attempts=${entry.attempts} retried=${entry.retried} type=${entry.errorType ?? 'success'} message=${entry.message ?? 'ok'}`,
    );
  }

  console.log('\n--- Summary Stats ---');
  console.log(`Total requests:      ${stats.totalRequests}`);
  console.log(`Successful requests: ${stats.successfulRequests}`);
  console.log(`Retried requests:    ${stats.retriedRequests}`);
  console.log(`Failed requests:     ${stats.failedRequests}`);
  console.log(`Rate-limit hits:     ${stats.rateLimitHits}`);
  console.log('\n=== Example Complete ===\n');

  return report;
}
