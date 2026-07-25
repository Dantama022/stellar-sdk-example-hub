import { Horizon } from '@stellar/stellar-sdk';
import type { ServerApi } from '@stellar/stellar-sdk/lib/horizon/server_api';
import chalk from 'chalk';

type PaymentStreamRecord =
  | ServerApi.PaymentOperationRecord
  | ServerApi.CreateAccountOperationRecord
  | ServerApi.AccountMergeOperationRecord
  | ServerApi.PathPaymentOperationRecord
  | ServerApi.PathPaymentStrictSendOperationRecord
  | ServerApi.InvokeHostFunctionOperationRecord;

interface ResilientStreamParams {
  horizonUrl?: string;
  maxEvents?: string | number;
  streamDurationSeconds?: string | number;
  baseRetryDelayMs?: string | number;
  maxRetryDelayMs?: string | number;
}

const DEFAULT_BASE_RETRY_MS = 2_000;
const DEFAULT_MAX_RETRY_MS = 30_000;

export function computeReconnectDelay(
  attempt: number,
  baseDelayMs = DEFAULT_BASE_RETRY_MS,
  maxDelayMs = DEFAULT_MAX_RETRY_MS,
): number {
  if (attempt < 1) {
    return baseDelayMs;
  }

  const exponential = baseDelayMs * 2 ** (attempt - 1);
  return Math.min(maxDelayMs, exponential);
}

export function formatConnectionStatus(
  state: 'connected' | 'reconnecting' | 'closed',
  details: { cursor: string; attempt?: number; delayMs?: number },
): string {
  switch (state) {
    case 'connected':
      return `Connected (cursor=${details.cursor})`;
    case 'reconnecting':
      return `Reconnecting (attempt ${details.attempt ?? 0}, delay ${details.delayMs ?? 0}ms, resume cursor=${details.cursor})`;
    case 'closed':
      return `Closed (last cursor=${details.cursor})`;
    default:
      return state;
  }
}

function readPositiveNumber(value: string | number | undefined, label: string): number | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(chalk.yellow(`Ignoring invalid ${label}: ${value}`));
    return undefined;
  }

  return parsed;
}

function describeStreamError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'object' && error !== null) {
    const maybeEvent = error as { message?: string; type?: string };
    return maybeEvent.message ?? maybeEvent.type ?? JSON.stringify(error);
  }

  return String(error);
}

function formatRecordSummary(record: PaymentStreamRecord, eventNumber: number): string {
  return [
    chalk.bold.cyan(`\nStream event #${eventNumber}`),
    `  Type:          ${record.type}`,
    `  Operation ID:  ${record.id}`,
    `  Cursor:        ${record.paging_token}`,
    `  Transaction:   ${record.transaction_hash}`,
  ].join('\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function run(params: ResilientStreamParams = {}): Promise<void> {
  const horizonUrl =
    params.horizonUrl || process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const maxEvents = readPositiveNumber(
    params.maxEvents ?? process.env.STREAM_MAX_EVENTS,
    'STREAM_MAX_EVENTS',
  );
  const streamDurationSeconds = readPositiveNumber(
    params.streamDurationSeconds ?? process.env.STREAM_DURATION_SECONDS,
    'STREAM_DURATION_SECONDS',
  );
  const baseRetryDelayMs =
    readPositiveNumber(
      params.baseRetryDelayMs ?? process.env.STREAM_BASE_RETRY_MS,
      'STREAM_BASE_RETRY_MS',
    ) ?? DEFAULT_BASE_RETRY_MS;
  const maxRetryDelayMs =
    readPositiveNumber(
      params.maxRetryDelayMs ?? process.env.STREAM_MAX_RETRY_MS,
      'STREAM_MAX_RETRY_MS',
    ) ?? DEFAULT_MAX_RETRY_MS;

  const server = new Horizon.Server(horizonUrl);

  console.log(chalk.bold('Resilient Horizon payment stream'));
  console.log(`Horizon URL: ${horizonUrl}`);
  console.log(
    'This example tracks the last processed paging token and resumes from that cursor after interruptions.',
  );
  console.log('Press Ctrl+C to shut down cleanly.\n');

  await server.root();
  console.log(chalk.green(formatConnectionStatus('connected', { cursor: 'now' })));

  let cursor = 'now';
  let closeStream: (() => void) | undefined;
  let eventCount = 0;
  let reconnectAttempt = 0;
  let shutdown = false;
  let durationTimer: NodeJS.Timeout | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;

  const cleanup = (): void => {
    process.off('SIGINT', handleSigint);
    process.off('SIGTERM', handleSigterm);

    if (durationTimer) {
      clearTimeout(durationTimer);
    }

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }

    if (closeStream) {
      closeStream();
      closeStream = undefined;
    }
  };

  const stop = async (reason: string): Promise<void> => {
    if (shutdown) {
      return;
    }

    shutdown = true;
    cleanup();
    console.log(chalk.green(`\n${formatConnectionStatus('closed', { cursor })}`));
    console.log(chalk.green(`Stream stopped: ${reason}`));
  };

  function handleSigint(): void {
    void stop('received SIGINT (Ctrl+C)');
  }

  function handleSigterm(): void {
    void stop('received SIGTERM');
  }

  process.once('SIGINT', handleSigint);
  process.once('SIGTERM', handleSigterm);

  const openStream = (): void => {
    if (shutdown) {
      return;
    }

    console.log(chalk.blue(formatConnectionStatus('connected', { cursor })));

    closeStream = server
      .payments()
      .cursor(cursor)
      .stream({
        // Keep the SDK from auto-reconnecting; this example owns backoff and cursor resume.
        reconnectTimeout: 24 * 60 * 60 * 1000,
        onmessage: (record: PaymentStreamRecord) => {
          reconnectAttempt = 0;
          cursor = record.paging_token;
          eventCount += 1;
          console.log(formatRecordSummary(record, eventCount));

          if (maxEvents !== undefined && eventCount >= maxEvents) {
            void stop(`received ${eventCount} event(s)`);
          }
        },
        onerror: (error: unknown) => {
          console.error(chalk.red(`Stream error: ${describeStreamError(error)}`));
          if (closeStream) {
            closeStream();
            closeStream = undefined;
          }
          scheduleReconnect();
        },
      });
  };

  const scheduleReconnect = (): void => {
    if (shutdown) {
      return;
    }

    reconnectAttempt += 1;
    const delayMs = computeReconnectDelay(reconnectAttempt, baseRetryDelayMs, maxRetryDelayMs);
    console.log(
      chalk.yellow(
        formatConnectionStatus('reconnecting', {
          cursor,
          attempt: reconnectAttempt,
          delayMs,
        }),
      ),
    );

    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      openStream();
    }, delayMs);
  };

  openStream();

  if (streamDurationSeconds !== undefined) {
    durationTimer = setTimeout(() => {
      void stop(`sample duration reached (${streamDurationSeconds}s)`);
    }, streamDurationSeconds * 1000);
  }

  while (!shutdown) {
    await sleep(250);
  }
}
