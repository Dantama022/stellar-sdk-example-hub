import { Horizon } from '@stellar/stellar-sdk';
import type { ServerApi } from '@stellar/stellar-sdk/lib/horizon/server_api';
import chalk from 'chalk';

type StreamRecord = ServerApi.OperationRecord;

export type FilterMode = 'and' | 'or';

export interface StreamFilterCriteria {
  account?: string;
  assetCode?: string;
  assetIssuer?: string;
  operationType?: string;
  successOnly?: boolean;
  minAmount?: number;
  maxAmount?: number;
}

export interface StreamFilterMetrics {
  received: number;
  accepted: number;
  rejected: number;
  lastCursor: string;
}

export interface StreamFilteringParams {
  horizonUrl?: string;
  cursor?: string;
  maxEvents?: string | number;
  streamDurationSeconds?: string | number;
  filterMode?: FilterMode;
  account?: string;
  assetCode?: string;
  assetIssuer?: string;
  operationType?: string;
  successOnly?: boolean | string;
  minAmount?: string | number;
  maxAmount?: string | number;
  json?: boolean | string;
}

export interface StreamFilteringReport {
  horizonUrl: string;
  filterMode: FilterMode;
  criteria: StreamFilterCriteria;
  metrics: StreamFilterMetrics;
  acceptedSamples: Array<Record<string, unknown>>;
}

function wantsJson(params: StreamFilteringParams = {}): boolean {
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
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(chalk.yellow(`Ignoring invalid ${label}: ${value}`));
    return undefined;
  }

  return parsed;
}

function readBoolean(value: boolean | string | undefined, fallback = false): boolean {
  if (value === undefined || value === '') {
    return fallback;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  return value === 'true';
}

function getRecordFields(record: StreamRecord): Record<string, unknown> {
  return record as unknown as Record<string, unknown>;
}

function getRecordAmount(record: StreamRecord): number | undefined {
  const amount = getRecordFields(record).amount;
  if (typeof amount === 'string') {
    const parsed = Number(amount);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function getAssetFields(record: StreamRecord): { code?: string; issuer?: string } {
  const candidate = getRecordFields(record);
  const assetType = candidate.asset_type;

  if (assetType === 'native') {
    return { code: 'native' };
  }

  return {
    code: typeof candidate.asset_code === 'string' ? candidate.asset_code : undefined,
    issuer: typeof candidate.asset_issuer === 'string' ? candidate.asset_issuer : undefined,
  };
}

export function matchesAccountFilter(record: StreamRecord, account?: string): boolean {
  if (!account) {
    return true;
  }

  const candidate = getRecordFields(record);
  const relatedAccounts = [
    candidate.from,
    candidate.to,
    candidate.source_account,
    candidate.account,
    candidate.trustor,
    candidate.destination,
  ];

  return relatedAccounts.some((value) => value === account);
}

export function matchesAssetCodeFilter(record: StreamRecord, assetCode?: string): boolean {
  if (!assetCode) {
    return true;
  }

  const asset = getAssetFields(record);
  return asset.code?.toLowerCase() === assetCode.toLowerCase();
}

export function matchesAssetIssuerFilter(record: StreamRecord, assetIssuer?: string): boolean {
  if (!assetIssuer) {
    return true;
  }

  const asset = getAssetFields(record);
  return asset.issuer === assetIssuer;
}

export function matchesOperationTypeFilter(record: StreamRecord, operationType?: string): boolean {
  if (!operationType) {
    return true;
  }

  return record.type.toLowerCase() === operationType.toLowerCase();
}

export function matchesSuccessFilter(record: StreamRecord, successOnly?: boolean): boolean {
  if (!successOnly) {
    return true;
  }

  const candidate = getRecordFields(record);
  return candidate.transaction_successful !== false;
}

export function matchesAmountRangeFilter(
  record: StreamRecord,
  minAmount?: number,
  maxAmount?: number,
): boolean {
  const amount = getRecordAmount(record);
  if (amount === undefined) {
    return minAmount === undefined && maxAmount === undefined;
  }

  if (minAmount !== undefined && amount < minAmount) {
    return false;
  }

  if (maxAmount !== undefined && amount > maxAmount) {
    return false;
  }

  return true;
}

export function evaluateFilterPipeline(
  record: StreamRecord,
  criteria: StreamFilterCriteria,
  mode: FilterMode = 'and',
): boolean {
  const checks = [
    matchesAccountFilter(record, criteria.account),
    matchesAssetCodeFilter(record, criteria.assetCode),
    matchesAssetIssuerFilter(record, criteria.assetIssuer),
    matchesOperationTypeFilter(record, criteria.operationType),
    matchesSuccessFilter(record, criteria.successOnly),
    matchesAmountRangeFilter(record, criteria.minAmount, criteria.maxAmount),
  ];

  return mode === 'and' ? checks.every(Boolean) : checks.some(Boolean);
}

function summarizeRecord(record: StreamRecord): Record<string, unknown> {
  const asset = getAssetFields(record);
  return {
    id: record.id,
    type: record.type,
    paging_token: record.paging_token,
    transaction_hash: record.transaction_hash,
    asset_code: asset.code,
    asset_issuer: asset.issuer,
    amount: getRecordAmount(record),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function run(params: StreamFilteringParams = {}): Promise<StreamFilteringReport> {
  const horizonUrl =
    params.horizonUrl || process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const filterMode = (params.filterMode || process.env.FILTER_MODE || 'and') as FilterMode;
  const maxEvents = readPositiveNumber(
    params.maxEvents ?? process.env.STREAM_MAX_EVENTS,
    'STREAM_MAX_EVENTS',
  );
  const streamDurationSeconds = readPositiveNumber(
    params.streamDurationSeconds ?? process.env.STREAM_DURATION_SECONDS,
    'STREAM_DURATION_SECONDS',
  );
  const json = wantsJson(params);

  const criteria: StreamFilterCriteria = {
    account: params.account || process.env.FILTER_ACCOUNT,
    assetCode: params.assetCode || process.env.FILTER_ASSET_CODE,
    assetIssuer: params.assetIssuer || process.env.FILTER_ASSET_ISSUER,
    operationType: params.operationType || process.env.FILTER_OPERATION_TYPE || 'payment',
    successOnly: readBoolean(params.successOnly ?? process.env.FILTER_SUCCESS_ONLY, true),
    minAmount: readPositiveNumber(params.minAmount ?? process.env.FILTER_MIN_AMOUNT, 'minAmount'),
    maxAmount: readPositiveNumber(params.maxAmount ?? process.env.FILTER_MAX_AMOUNT, 'maxAmount'),
  };

  const metrics: StreamFilterMetrics = {
    received: 0,
    accepted: 0,
    rejected: 0,
    lastCursor: params.cursor || process.env.STREAM_CURSOR || 'now',
  };

  const acceptedSamples: Array<Record<string, unknown>> = [];
  const server = new Horizon.Server(horizonUrl);

  if (!json) {
    console.log(chalk.bold('Horizon streaming event filtering example'));
    console.log(`Horizon URL: ${horizonUrl}`);
    console.log(`Filter mode: ${filterMode.toUpperCase()}`);
    console.log('Client-side filters preserve the underlying Horizon cursor.');
    console.log('Criteria:', criteria);
    console.log('');
  }

  let cursor = metrics.lastCursor;
  let closeStream: (() => void) | undefined;
  let shutdown = false;

  const stop = async (reason: string): Promise<void> => {
    if (shutdown) {
      return;
    }

    shutdown = true;
    if (closeStream) {
      closeStream();
      closeStream = undefined;
    }

    const report: StreamFilteringReport = {
      horizonUrl,
      filterMode,
      criteria,
      metrics,
      acceptedSamples,
    };

    if (json) {
      console.log(JSON.stringify({ ...report, stopReason: reason }, null, 2));
      return;
    }

    console.log(chalk.green(`\nStream stopped: ${reason}`));
    console.log('\n--- Filter Metrics ---');
    console.log(`Received:  ${metrics.received}`);
    console.log(`Accepted:  ${metrics.accepted}`);
    console.log(`Rejected:  ${metrics.rejected}`);
    console.log(`Cursor:    ${metrics.lastCursor}`);
  };

  closeStream = server
    .operations()
    .cursor(cursor)
    .stream({
      reconnectTimeout: 60_000,
      onmessage: (record: StreamRecord) => {
        metrics.received += 1;
        metrics.lastCursor = record.paging_token;
        cursor = record.paging_token;

        if (evaluateFilterPipeline(record, criteria, filterMode)) {
          metrics.accepted += 1;
          if (acceptedSamples.length < 5) {
            acceptedSamples.push(summarizeRecord(record));
          }

          if (!json) {
            console.log(chalk.green(`Accepted #${metrics.accepted}: ${record.type} ${record.id}`));
          }

          if (maxEvents !== undefined && metrics.accepted >= maxEvents) {
            void stop(`accepted ${metrics.accepted} filtered event(s)`);
          }
        } else {
          metrics.rejected += 1;
          if (!json && metrics.rejected <= 3) {
            console.log(chalk.gray(`Rejected: ${record.type} ${record.id}`));
          }
        }
      },
      onerror: (error: unknown) => {
        if (!json) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(chalk.red(`Stream error: ${message}`));
        }
        void stop('stream error');
      },
    });

  const durationMs = (streamDurationSeconds ?? 8) * 1000;
  setTimeout(() => {
    void stop(`sample duration reached (${durationMs / 1000}s)`);
  }, durationMs);

  while (!shutdown) {
    await sleep(250);
  }

  return {
    horizonUrl,
    filterMode,
    criteria,
    metrics,
    acceptedSamples,
  };
}
