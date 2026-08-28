import { Horizon } from '@stellar/stellar-sdk';
import type { ServerApi } from '@stellar/stellar-sdk/lib/horizon/server_api';
import chalk from 'chalk';

type StreamRecord = ServerApi.OperationRecord | ServerApi.TransactionRecord;

export interface ResilientStreamingParams {
  horizonUrl?: string;
  resource?: 'payments' | 'transactions' | 'operations';
  cursor?: string;
  maxEvents?: string | number;
  streamDurationSeconds?: string | number;
  baseRetryDelayMs?: string | number;
  maxRetryDelayMs?: string | number;
  json?: boolean | string;
}

export interface StreamStats {
  processed: number;
  duplicatesIgnored: number;
  malformedIgnored: number;
  reconnectAttempts: number;
  uptimeMs: number;
  lastCursor: string;
  status: 'running' | 'stopped' | 'error';
}

export interface ResilientStreamingReport {
  horizonUrl: string;
  resource: string;
  cursor: string;
  stats: StreamStats;
}

const DEFAULT_BASE_RETRY_MS = 2_000;
const DEFAULT_MAX_RETRY_MS = 30_000;

function wantsJson(params: ResilientStreamingParams = {}): boolean {
  return (
    params.json === true ||
    params.json === 'true' ||
    process.env.JSON_OUTPUT === 'true' ||
    process.argv.includes('--json')
  );
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

export function isMalformedStreamRecord(record: unknown): boolean {
  if (!record || typeof record !== 'object') {
    return true;
  }

  const candidate = record as Record<string, unknown>;
  return typeof candidate.paging_token !== 'string' || candidate.paging_token.length === 0;
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

function formatRecordSummary(record: StreamRecord, eventNumber: number): string {
  if ('transaction_hash' in record) {
    return [
      chalk.bold.cyan(`\nStream event #${eventNumber}`),
      `  Type:          ${record.type}`,
      `  Record ID:     ${record.id}`,
      `  Cursor:        ${record.paging_token}`,
      `  Transaction:   ${record.transaction_hash}`,
    ].join('\n');
  }

  const transaction = record as ServerApi.TransactionRecord;
  return [
    chalk.bold.cyan(`\nStream event #${eventNumber}`),
    `  Type:          transaction`,
    `  Record ID:     ${transaction.hash}`,
    `  Cursor:        ${transaction.paging_token}`,
    `  Transaction:   ${transaction.hash}`,
  ].join('\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function run(
  params: ResilientStreamingParams = {},
): Promise<ResilientStreamingReport> {
  const horizonUrl =
    params.horizonUrl || process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const resource = params.resource || process.env.STREAM_RESOURCE || 'payments';
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
  const json = wantsJson(params);

  const server = new Horizon.Server(horizonUrl);
  const startedAt = Date.now();

  if (!json) {
    console.log(chalk.bold('Resilient Horizon streaming example'));
    console.log(`Horizon URL: ${horizonUrl}`);
    console.log(`Resource: ${resource}`);
    console.log('Tracks cursor, ignores duplicates/malformed events, and reconnects with backoff.');
    console.log('Press Ctrl+C to shut down cleanly.\n');
  }

  await server.root();

  let cursor = params.cursor || process.env.STREAM_CURSOR || 'now';
  let closeStream: (() => void) | undefined;
  let reconnectAttempt = 0;
  let shutdown = false;
  let durationTimer: NodeJS.Timeout | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  const seenCursors = new Set<string>();

  const stats: StreamStats = {
    processed: 0,
    duplicatesIgnored: 0,
    malformedIgnored: 0,
    reconnectAttempts: 0,
    uptimeMs: 0,
    lastCursor: cursor,
    status: 'running',
  };

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

  const buildReport = (): ResilientStreamingReport => ({
    horizonUrl,
    resource,
    cursor: stats.lastCursor,
    stats: {
      ...stats,
      uptimeMs: Date.now() - startedAt,
    },
  });

  const stop = async (reason: string): Promise<void> => {
    if (shutdown) {
      return;
    }

    shutdown = true;
    stats.status = 'stopped';
    stats.uptimeMs = Date.now() - startedAt;
    cleanup();

    const report = buildReport();

    if (json) {
      console.log(JSON.stringify({ ...report, stopReason: reason }, null, 2));
      return;
    }

    console.log(chalk.green(`\n${formatConnectionStatus('closed', { cursor: stats.lastCursor })}`));
    console.log(chalk.green(`Stream stopped: ${reason}`));
    console.log('\n--- Stream Statistics ---');
    console.log(`Processed events:     ${stats.processed}`);
    console.log(`Duplicates ignored:   ${stats.duplicatesIgnored}`);
    console.log(`Malformed ignored:    ${stats.malformedIgnored}`);
    console.log(`Reconnect attempts:   ${stats.reconnectAttempts}`);
    console.log(`Uptime (ms):          ${stats.uptimeMs}`);
    console.log(`Last cursor:          ${stats.lastCursor}`);
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

    if (!json) {
      console.log(chalk.blue(formatConnectionStatus('connected', { cursor })));
    }

    const builder =
      resource === 'transactions'
        ? server.transactions()
        : resource === 'operations'
          ? server.operations()
          : server.payments();

    closeStream = builder.cursor(cursor).stream({
      reconnectTimeout: 24 * 60 * 60 * 1000,
      onmessage: (record: ServerApi.OperationRecord | ServerApi.TransactionRecord) => {
        const streamRecord = record as StreamRecord;
        if (isMalformedStreamRecord(streamRecord)) {
          stats.malformedIgnored += 1;
          if (!json) {
            console.warn(chalk.yellow('Ignored malformed stream record'));
          }
          return;
        }

        if (seenCursors.has(streamRecord.paging_token)) {
          stats.duplicatesIgnored += 1;
          return;
        }

        reconnectAttempt = 0;
        seenCursors.add(streamRecord.paging_token);
        cursor = streamRecord.paging_token;
        stats.lastCursor = cursor;
        stats.processed += 1;

        if (!json) {
          console.log(formatRecordSummary(streamRecord, stats.processed));
        }

        if (maxEvents !== undefined && stats.processed >= maxEvents) {
          void stop(`received ${stats.processed} event(s)`);
        }
      },
      onerror: (error: unknown) => {
        if (!json) {
          console.error(chalk.red(`Stream error: ${describeStreamError(error)}`));
        }

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
    stats.reconnectAttempts += 1;
    const delayMs = computeReconnectDelay(reconnectAttempt, baseRetryDelayMs, maxRetryDelayMs);

    if (!json) {
      console.log(
        chalk.yellow(
          formatConnectionStatus('reconnecting', {
            cursor,
            attempt: reconnectAttempt,
            delayMs,
          }),
        ),
      );
    }

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
  } else if (maxEvents === undefined) {
    durationTimer = setTimeout(() => {
      void stop('default sample duration reached (8s)');
    }, 8_000);
  }

  while (!shutdown) {
    await sleep(250);
  }

  return buildReport();
}
