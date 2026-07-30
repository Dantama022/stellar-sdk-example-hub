/**
 * 92-account-payment-stream
 *
 * Demonstrates subscribing to a Stellar account's real-time payment stream
 * using Horizon Server-Sent Events (SSE):
 *   1. Connecting to a Horizon payment stream for a specific account
 *   2. Displaying incoming and outgoing payments as they arrive
 *   3. Handling stream errors with automatic reconnection
 *   4. Graceful shutdown on Ctrl+C
 *
 * Background — Streaming vs Polling
 * ----------------------------------
 * Polling periodically queries Horizon for new records and processes them in
 * batches.  It is simple but introduces latency proportional to the poll
 * interval and wastes network resources during quiet periods.
 *
 * Streaming uses Horizon's Server-Sent Events endpoint to maintain a single
 * long-lived HTTP connection.  The server pushes each new payment record to
 * the client immediately after the ledger closes, typically within 5 seconds
 * of the transaction landing.
 *
 * When to prefer streaming:
 *   • Wallets displaying live balance changes
 *   • Exchanges needing immediate deposit detection
 *   • Payment processors confirming transfers in near-real-time
 *   • Monitoring dashboards tracking high-frequency activity
 *
 * When to prefer polling:
 *   • Batch reconciliation jobs that run on a schedule
 *   • Historical data backfill across thousands of accounts
 *   • Environments where persistent connections are not permitted
 *
 * Running
 * -------
 * npm run run-example 92-account-payment-stream
 *
 * Environment variables
 * ---------------------
 * HORIZON_URL              Horizon endpoint (default: Testnet)
 * ACCOUNT_ID               Account to monitor (default: discovers a recent account)
 * STREAM_MAX_EVENTS        Stop after N events (useful in CI)
 * STREAM_DURATION_SECONDS  Stop after N seconds (useful in CI)
 * PAYMENT_FILTER           Filter by type: "incoming" | "outgoing" | "all" (default: all)
 */

import { Horizon } from '@stellar/stellar-sdk';
import type { ServerApi } from '@stellar/stellar-sdk/lib/horizon/server_api';
import chalk from 'chalk';

// ─── types ──────────────────────────────────────────────────────────────────

type PaymentStreamRecord =
  | ServerApi.PaymentOperationRecord
  | ServerApi.CreateAccountOperationRecord
  | ServerApi.AccountMergeOperationRecord
  | ServerApi.PathPaymentOperationRecord
  | ServerApi.PathPaymentStrictSendOperationRecord
  | ServerApi.InvokeHostFunctionOperationRecord;

type PaymentFilter = 'all' | 'incoming' | 'outgoing';

interface AccountPaymentStreamParams {
  accountId?: string;
  horizonUrl?: string;
  maxEvents?: string | number;
  streamDurationSeconds?: string | number;
  paymentFilter?: PaymentFilter;
}

// ─── helpers ────────────────────────────────────────────────────────────────

function readPositiveNumber(value: string | number | undefined, label: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(chalk.yellow(`Ignoring invalid ${label}: ${value}`));
    return undefined;
  }
  return parsed;
}

function shortenKey(value: string | undefined): string {
  if (!value) return '(unknown)';
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}…${value.slice(-8)}`;
}

function formatAsset(
  assetType: string | undefined,
  assetCode?: string,
  assetIssuer?: string,
): string {
  if (!assetType) return 'unknown asset';
  if (assetType === 'native') return 'XLM (native)';
  return `${assetCode ?? assetType} issued by ${shortenKey(assetIssuer)}`;
}

function formatTimestamp(isoString: string): string {
  try {
    const date = new Date(isoString);
    return date.toUTCString();
  } catch {
    return isoString;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null) {
    const ev = error as { message?: string; type?: string };
    return ev.message ?? ev.type ?? JSON.stringify(error);
  }
  return String(error);
}

/**
 * Determine whether a payment record is incoming, outgoing, or a self-payment
 * relative to the monitored account.
 */
function classifyPayment(
  record: PaymentStreamRecord,
  monitoredAccount: string,
): 'incoming' | 'outgoing' | 'self' | 'related' {
  const type = String(record.type);

  if (type === 'payment') {
    const p = record as ServerApi.PaymentOperationRecord;
    if (p.to === monitoredAccount && p.from === monitoredAccount) return 'self';
    if (p.to === monitoredAccount) return 'incoming';
    if (p.from === monitoredAccount) return 'outgoing';
    return 'related';
  }

  if (type === 'create_account') {
    const ca = record as ServerApi.CreateAccountOperationRecord;
    if (ca.account === monitoredAccount) return 'incoming';
    if (ca.funder === monitoredAccount) return 'outgoing';
    return 'related';
  }

  if (type === 'path_payment' || type === 'path_payment_strict_receive') {
    const pp = record as ServerApi.PathPaymentOperationRecord;
    if (pp.to === monitoredAccount && pp.from === monitoredAccount) return 'self';
    if (pp.to === monitoredAccount) return 'incoming';
    if (pp.from === monitoredAccount) return 'outgoing';
    return 'related';
  }

  if (type === 'path_payment_strict_send') {
    const ps = record as ServerApi.PathPaymentStrictSendOperationRecord;
    if (ps.to === monitoredAccount && ps.from === monitoredAccount) return 'self';
    if (ps.to === monitoredAccount) return 'incoming';
    if (ps.from === monitoredAccount) return 'outgoing';
    return 'related';
  }

  if (type === 'account_merge') {
    const am = record as ServerApi.AccountMergeOperationRecord;
    if (am.into === monitoredAccount) return 'incoming';
    if (am.source_account === monitoredAccount) return 'outgoing';
    return 'related';
  }

  return 'related';
}

function directionChalk(direction: 'incoming' | 'outgoing' | 'self' | 'related'): string {
  switch (direction) {
    case 'incoming': return chalk.green('↙ INCOMING');
    case 'outgoing': return chalk.red('↗ OUTGOING');
    case 'self':     return chalk.blue('⇌ SELF');
    default:         return chalk.gray('~ RELATED');
  }
}

/**
 * Build a human-readable block for a single payment stream record.
 */
function formatPaymentRecord(
  record: PaymentStreamRecord,
  eventNumber: number,
  monitoredAccount: string,
): string {
  const direction = classifyPayment(record, monitoredAccount);
  const type = String(record.type);
  const lines: string[] = [
    '',
    chalk.bold(`Payment event #${eventNumber}  ${directionChalk(direction)}  [${type}]`),
    `  Timestamp:        ${formatTimestamp(record.created_at)}`,
    `  Operation ID:     ${record.id}`,
    `  Transaction hash: ${record.transaction_hash}`,
    `  Paging token:     ${record.paging_token}`,
  ];

  switch (type) {
    case 'payment': {
      const p = record as ServerApi.PaymentOperationRecord;
      lines.push(
        `  Source:           ${shortenKey(p.from)}`,
        `  Destination:      ${shortenKey(p.to)}`,
        `  Amount:           ${p.amount} ${formatAsset(p.asset_type, p.asset_code, p.asset_issuer)}`,
      );
      break;
    }

    case 'create_account': {
      const ca = record as ServerApi.CreateAccountOperationRecord;
      lines.push(
        `  Funder:           ${shortenKey(ca.funder)}`,
        `  New account:      ${shortenKey(ca.account)}`,
        `  Starting balance: ${ca.starting_balance} XLM (native)`,
      );
      break;
    }

    case 'path_payment':
    case 'path_payment_strict_receive': {
      const pp = record as ServerApi.PathPaymentOperationRecord;
      lines.push(
        `  Source:           ${shortenKey(pp.from)}`,
        `  Destination:      ${shortenKey(pp.to)}`,
        `  Sent:             ${pp.source_amount} ${formatAsset(pp.source_asset_type, pp.source_asset_code, pp.source_asset_issuer)}`,
        `  Received:         ${pp.amount} ${formatAsset(pp.asset_type, pp.asset_code, pp.asset_issuer)}`,
        `  Path hops:        ${pp.path.length}`,
      );
      break;
    }

    case 'path_payment_strict_send': {
      const ps = record as ServerApi.PathPaymentStrictSendOperationRecord;
      lines.push(
        `  Source:           ${shortenKey(ps.from)}`,
        `  Destination:      ${shortenKey(ps.to)}`,
        `  Sent (exact):     ${ps.source_amount} ${formatAsset(ps.source_asset_type, ps.source_asset_code, ps.source_asset_issuer)}`,
        `  Received:         ${ps.amount} ${formatAsset(ps.asset_type, ps.asset_code, ps.asset_issuer)}`,
        `  Path hops:        ${ps.path.length}`,
      );
      break;
    }

    case 'account_merge': {
      const am = record as ServerApi.AccountMergeOperationRecord;
      lines.push(
        `  Merged account:   ${shortenKey(am.source_account)}`,
        `  Merged into:      ${shortenKey(am.into)}`,
        `  Note: remaining XLM balance transferred to destination`,
      );
      break;
    }

    default:
      lines.push(
        `  Source:           ${shortenKey(record.source_account)}`,
        `  Note:             non-payment operation type returned by payments endpoint`,
      );
  }

  return lines.join('\n');
}

/**
 * Try to discover a recently active account to use as default when no
 * accountId is supplied.  Uses the most recent payment record on Horizon.
 */
async function discoverAccount(server: Horizon.Server): Promise<string | null> {
  try {
    const recentPayments = await server.payments().limit(1).order('desc').call();
    if (recentPayments.records.length > 0) {
      const record = recentPayments.records[0] as PaymentStreamRecord;
      if (record.type === 'payment') {
        return (record as ServerApi.PaymentOperationRecord).to;
      }
      if (record.type === 'create_account') {
        return (record as ServerApi.CreateAccountOperationRecord).account;
      }
      if (record.source_account) {
        return record.source_account;
      }
    }
  } catch {
    // ignore discovery failure
  }
  return null;
}

// ─── main ────────────────────────────────────────────────────────────────────

export async function run(params: AccountPaymentStreamParams = {}): Promise<void> {
  const horizonUrl =
    params.horizonUrl ?? process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org';
  const maxEvents = readPositiveNumber(
    params.maxEvents ?? process.env.STREAM_MAX_EVENTS,
    'STREAM_MAX_EVENTS',
  );
  const streamDurationSeconds = readPositiveNumber(
    params.streamDurationSeconds ?? process.env.STREAM_DURATION_SECONDS,
    'STREAM_DURATION_SECONDS',
  );

  // Validate payment filter
  const rawFilter = (params.paymentFilter ?? process.env.PAYMENT_FILTER ?? 'all').toLowerCase();
  const paymentFilter: PaymentFilter =
    rawFilter === 'incoming' || rawFilter === 'outgoing' ? rawFilter : 'all';

  const server = new Horizon.Server(horizonUrl);

  // ── Introduction ───────────────────────────────────────────────────────────
  console.log(chalk.bold('\n═══════════════════════════════════════════════'));
  console.log(chalk.bold(' Stellar Account Payment Stream Example'));
  console.log(chalk.bold('═══════════════════════════════════════════════'));
  console.log(`
Horizon exposes a Server-Sent Events (SSE) endpoint that delivers new
payment records for an account in near-real-time — typically within 5 seconds
of the transaction landing on the ledger.

Streaming vs polling:
  ┌──────────────┬────────────────────────────┬──────────────────────────┐
  │ Dimension    │ Streaming                  │ Polling                  │
  ├──────────────┼────────────────────────────┼──────────────────────────┤
  │ Latency      │ ~5s (ledger close time)    │ Up to poll interval      │
  │ Network use  │ Single persistent conn.    │ Repeated requests        │
  │ Complexity   │ Requires SSE / WebSocket   │ Simple HTTP GET loop     │
  │ Best for     │ Wallets, live dashboards   │ Batch jobs, backfill     │
  └──────────────┴────────────────────────────┴──────────────────────────┘

The payments() endpoint includes: payment, create_account,
path_payment_strict_receive, path_payment_strict_send, and account_merge
operations — any operation that credits or debits an account.
`);

  // ── Connect to Horizon ─────────────────────────────────────────────────────
  console.log(chalk.cyan('Connecting to Horizon…'));
  try {
    await server.root();
    console.log(chalk.green(`Connected: ${horizonUrl}`));
  } catch (err) {
    throw new Error(
      `Failed to connect to Horizon at ${horizonUrl}: ${describeError(err)}\n` +
        'Check the HORIZON_URL environment variable and your network connectivity.',
    );
  }

  // ── Resolve account ────────────────────────────────────────────────────────
  let accountId = params.accountId ?? process.env.ACCOUNT_ID;
  if (!accountId) {
    console.log(chalk.gray('No account specified — discovering a recently active account…'));
    const discovered = await discoverAccount(server);
    if (!discovered) {
      throw new Error(
        'Could not discover a recently active account automatically.\n' +
          'Provide an account ID via ACCOUNT_ID or pass accountId as a parameter.',
      );
    }
    accountId = discovered;
    console.log(chalk.gray(`Using account: ${accountId}`));
  }

  // Validate the account exists
  try {
    await server.loadAccount(accountId);
    console.log(chalk.green(`Account verified: ${accountId}`));
  } catch (err) {
    throw new Error(
      `Account "${accountId}" not found on Horizon: ${describeError(err)}\n` +
        'Provide a valid funded account ID via ACCOUNT_ID or pass accountId as a parameter.',
    );
  }

  // ── Stream configuration ───────────────────────────────────────────────────
  console.log(chalk.bold('\n─── Stream configuration ──────────────────'));
  console.log(`  Account:   ${accountId}`);
  console.log(`  Cursor:    now  (events from this moment forward)`);
  console.log(`  Filter:    ${paymentFilter}`);
  if (maxEvents) console.log(`  Max events: ${maxEvents}`);
  if (streamDurationSeconds) console.log(`  Duration:   ${streamDurationSeconds}s`);
  console.log('');
  console.log(chalk.gray('Waiting for payment events…  Press Ctrl+C to stop.'));

  // ── Open stream ────────────────────────────────────────────────────────────
  let eventCount = 0;
  let filteredCount = 0;
  let closeStream: (() => void) | undefined;
  let durationTimer: NodeJS.Timeout | undefined;
  let settled = false;

  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      process.off('SIGINT', handleSigint);
      process.off('SIGTERM', handleSigterm);
      if (durationTimer) clearTimeout(durationTimer);
      if (closeStream) {
        closeStream();
        closeStream = undefined;
      }
    };

    const stop = (reason: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      console.log(chalk.green(`\nStream closed: ${reason}`));
      console.log(
        `\nTotal events received: ${eventCount}  (${filteredCount} displayed after filter="${paymentFilter}")`,
      );
      resolve();
    };

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    function handleSigint(): void {
      stop('received SIGINT (Ctrl+C)');
    }

    function handleSigterm(): void {
      stop('received SIGTERM');
    }

    process.once('SIGINT', handleSigint);
    process.once('SIGTERM', handleSigterm);

    try {
      // The SDK streams payment-like operations for the given account.
      // cursor("now") skips all historical records and delivers only new ones.
      closeStream = server
        .payments()
        .forAccount(accountId!)
        .cursor('now')
        .stream({
          // The SDK will automatically reconnect after this timeout if the
          // connection drops without an explicit error.
          reconnectTimeout: 15_000,

          onmessage: (record: PaymentStreamRecord) => {
            eventCount += 1;

            const direction = classifyPayment(record, accountId!);

            // Apply the optional filter
            if (
              paymentFilter !== 'all' &&
              direction !== paymentFilter &&
              direction !== 'self'
            ) {
              return; // skip filtered-out direction
            }

            filteredCount += 1;
            console.log(formatPaymentRecord(record, filteredCount, accountId!));

            if (maxEvents !== undefined && eventCount >= maxEvents) {
              stop(`received ${eventCount} event(s) — max reached`);
            }
          },

          onerror: (error: unknown) => {
            // Stream errors are non-fatal by default: the SDK reconnects after
            // the reconnectTimeout.  Log the error but do not reject the
            // promise, so the stream stays open.
            const msg = describeError(error);
            console.error(chalk.red(`\nStream error: ${msg}`));
            console.log(
              chalk.yellow(
                'The SDK will reconnect automatically.  If the error persists, ' +
                  'check Horizon availability and your network connection.',
              ),
            );

            // If the error looks fatal (account deleted, auth revoked), stop.
            if (
              typeof msg === 'string' &&
              (msg.includes('Not Found') || msg.includes('404'))
            ) {
              fail(
                new Error(
                  `Account "${accountId}" was not found on Horizon.  The account may have been merged or the ID is incorrect.`,
                ),
              );
            }
          },
        });
    } catch (err) {
      fail(err);
      return;
    }

    // Optional time-based termination for CI / demos
    if (streamDurationSeconds !== undefined) {
      durationTimer = setTimeout(() => {
        stop(`sample duration reached (${streamDurationSeconds}s)`);
      }, streamDurationSeconds * 1_000);
    }
  });
}
