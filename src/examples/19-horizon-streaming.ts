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

interface StreamingParams {
  horizonUrl?: string;
  maxEvents?: string | number;
  reconnectTimeoutMs?: string | number;
  streamDurationSeconds?: string | number;
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

function shortenKey(value: string | undefined): string {
  if (!value) {
    return 'unknown';
  }

  if (value.length <= 16) {
    return value;
  }

  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}

function formatAsset(
  assetType: string | undefined,
  assetCode?: string,
  assetIssuer?: string,
): string {
  if (!assetType) {
    return 'unknown asset';
  }

  if (assetType === 'native') {
    return 'XLM';
  }

  const code = assetCode ?? assetType;
  return `${code} issued by ${shortenKey(assetIssuer)}`;
}

function formatStreamRecord(record: PaymentStreamRecord, eventNumber: number): string {
  const recordType = String(record.type);
  const lines = [
    chalk.bold.cyan(`\nPayment stream event #${eventNumber} (${recordType})`),
    `  Created:       ${record.created_at}`,
    `  Operation ID:  ${record.id}`,
    `  Transaction:   ${record.transaction_hash}`,
    `  Horizon cursor: ${record.paging_token}`,
  ];

  switch (recordType) {
    case 'payment': {
      const payment = record as ServerApi.PaymentOperationRecord;
      lines.push(
        `  From:          ${shortenKey(payment.from)}`,
        `  To:            ${shortenKey(payment.to)}`,
        `  Amount:        ${payment.amount} ${formatAsset(
          payment.asset_type,
          payment.asset_code,
          payment.asset_issuer,
        )}`,
      );
      break;
    }
    case 'create_account': {
      const createAccount = record as ServerApi.CreateAccountOperationRecord;
      lines.push(
        `  Funder:        ${shortenKey(createAccount.funder)}`,
        `  New account:   ${shortenKey(createAccount.account)}`,
        `  Start balance: ${createAccount.starting_balance} XLM`,
      );
      break;
    }
    case 'path_payment':
    case 'path_payment_strict_receive': {
      const pathPayment = record as ServerApi.PathPaymentOperationRecord;
      lines.push(
        `  From:          ${shortenKey(pathPayment.from)}`,
        `  To:            ${shortenKey(pathPayment.to)}`,
        `  Sent:          ${pathPayment.source_amount} ${formatAsset(
          pathPayment.source_asset_type,
          pathPayment.source_asset_code,
          pathPayment.source_asset_issuer,
        )}`,
        `  Received:      ${pathPayment.amount} ${formatAsset(
          pathPayment.asset_type,
          pathPayment.asset_code,
          pathPayment.asset_issuer,
        )}`,
        `  Path hops:     ${pathPayment.path.length}`,
      );
      break;
    }
    case 'path_payment_strict_send': {
      const strictSend = record as ServerApi.PathPaymentStrictSendOperationRecord;
      lines.push(
        `  From:          ${shortenKey(strictSend.from)}`,
        `  To:            ${shortenKey(strictSend.to)}`,
        `  Sent:          ${strictSend.source_amount} ${formatAsset(
          strictSend.source_asset_type,
          strictSend.source_asset_code,
          strictSend.source_asset_issuer,
        )}`,
        `  Received:      ${strictSend.amount} ${formatAsset(
          strictSend.asset_type,
          strictSend.asset_code,
          strictSend.asset_issuer,
        )}`,
        `  Path hops:     ${strictSend.path.length}`,
      );
      break;
    }
    case 'account_merge': {
      const merge = record as ServerApi.AccountMergeOperationRecord;
      lines.push(
        `  Account:       ${shortenKey(merge.source_account)}`,
        `  Merged into:   ${shortenKey(merge.into)}`,
      );
      break;
    }
    default:
      lines.push(
        `  Source:        ${shortenKey(record.source_account)}`,
        '  Details:       Non-payment operation returned by the payments endpoint.',
      );
  }

  return lines.join('\n');
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

export async function run(params: StreamingParams = {}): Promise<void> {
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
  const reconnectTimeoutMs =
    readPositiveNumber(
      params.reconnectTimeoutMs ?? process.env.STREAM_RECONNECT_TIMEOUT_MS,
      'STREAM_RECONNECT_TIMEOUT_MS',
    ) ?? 15_000;

  const server = new Horizon.Server(horizonUrl);

  console.log(chalk.bold('Starting Horizon payment stream example'));
  console.log(`Horizon URL: ${horizonUrl}`);
  console.log('Cursor: now');
  console.log(
    'SSE note: Horizon keeps this HTTP connection open and pushes each new payment-like operation as it lands.',
  );
  console.log('Press Ctrl+C to close the stream gracefully.\n');

  await server.root();
  console.log(chalk.green('Connected to Horizon root endpoint.'));
  console.log(chalk.gray('Waiting for live Testnet payment events...'));

  let closeStream: (() => void) | undefined;
  let durationTimer: NodeJS.Timeout | undefined;
  let eventCount = 0;
  let settled = false;

  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      process.off('SIGINT', handleSigint);
      process.off('SIGTERM', handleSigterm);

      if (durationTimer) {
        clearTimeout(durationTimer);
      }

      if (closeStream) {
        closeStream();
        closeStream = undefined;
      }
    };

    const stop = (reason: string): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      console.log(chalk.green(`\nStream closed cleanly: ${reason}`));
      resolve();
    };

    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
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
      // Horizon streams use Server-Sent Events: one long-lived HTTP response
      // delivers each new record, and the SDK advances the cursor from the
      // returned paging token so reconnects can resume from the latest event.
      closeStream = server
        .payments()
        .cursor('now')
        .stream({
          reconnectTimeout: reconnectTimeoutMs,
          onmessage: (record: PaymentStreamRecord) => {
            eventCount += 1;
            console.log(formatStreamRecord(record, eventCount));

            if (maxEvents !== undefined && eventCount >= maxEvents) {
              stop(`received ${eventCount} event(s)`);
            }
          },
          onerror: (error: unknown) => {
            console.error(chalk.red(`Stream error: ${describeStreamError(error)}`));
            console.log(
              chalk.yellow(
                `The SDK will reconnect automatically after ${reconnectTimeoutMs}ms unless the stream is closed.`,
              ),
            );
          },
        });
    } catch (error) {
      fail(error);
      return;
    }

    if (streamDurationSeconds !== undefined) {
      // Optional sample mode keeps demos and CI smoke checks from hanging while
      // preserving the default behavior of streaming until Ctrl+C.
      durationTimer = setTimeout(() => {
        stop(`sample duration reached (${streamDurationSeconds}s)`);
      }, streamDurationSeconds * 1000);
    }
  });
}
