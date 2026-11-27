/**
 * ISSUE-404: Stellar ledger close metadata and protocol version inspector.
 *
 * Retrieves a ledger by sequence (or the latest ledger), extracts the metadata
 * exposed by Horizon, compares consecutive ledgers for protocol changes, checks
 * an application's declared protocol compatibility, and analyzes close
 * intervals. Fields not exposed by the endpoint are reported as null rather
 * than invented.
 *
 * Usage:
 *   npx ts-node examples/ledger/ledger-metadata-inspector.ts --sequence 12345 \
 *     --min-protocol 20 --max-protocol 22 --json
 *   npx ts-node examples/ledger/ledger-metadata-inspector.ts --latest
 */

import { Horizon } from '@stellar/stellar-sdk';

export interface LedgerMetadata {
  sequence: number | null;
  hash: string | null;
  previousHash: string | null;
  closedAt: string | null;
  transactionCount: number | null;
  operationCount: number | null;
  successfulTransactionCount: number | null;
  protocolVersion: number | null;
  baseFeeInStroops: number | null;
  networkPassphrase: string | null;
  missingFields: string[];
}

export interface ProtocolComparison {
  changed: boolean;
  direction: 'upgrade' | 'downgrade' | 'unchanged' | 'unknown';
  from: number | null;
  to: number | null;
  message: string;
}

export interface CompatibilityAssessment {
  compatible: boolean;
  status: 'ok' | 'below-minimum' | 'above-maximum' | 'unknown';
  message: string;
}

export interface CloseInterval {
  elapsedMs: number | null;
  status: 'normal' | 'short' | 'long' | 'unavailable';
  message: string;
}

export interface LedgerInspectionReport {
  network: string;
  inspected: LedgerMetadata;
  previous: LedgerMetadata | null;
  protocolComparison: ProtocolComparison | null;
  compatibility: CompatibilityAssessment;
  closeInterval: CloseInterval;
  errors: string[];
}

export interface IntervalThresholds {
  minMs?: number;
  maxMs?: number;
}

export interface InspectOptions extends IntervalThresholds {
  minSupportedProtocol?: number;
  maxSupportedProtocol?: number;
}

export interface LedgerLoader {
  loadLedger(sequence?: number): Promise<unknown>;
}

type HorizonLedger = Record<string, unknown>;

function asRecord(value: unknown): HorizonLedger | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as HorizonLedger)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Accepts only a positive integer ledger sequence. */
export function parseLedgerSequence(input: unknown): number {
  const text = String(input ?? '').trim();
  if (!/^\d+$/.test(text)) throw new Error(`Invalid ledger sequence: ${input}`);
  const sequence = Number(text);
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new Error(`Ledger sequence must be a positive safe integer: ${input}`);
  }
  return sequence;
}

/** Extracts Horizon ledger fields, marking unavailable values as null. */
export function extractLedgerMetadata(record: unknown): LedgerMetadata {
  const source = asRecord(record);
  if (!source) throw new Error('Ledger record must be an object');

  const metadata: LedgerMetadata = {
    sequence: asNumber(source.sequence) ?? asNumber(source.id),
    hash: asString(source.hash),
    previousHash: asString(source.prev_hash) ?? asString(source.previous_ledger_hash),
    closedAt: asString(source.closed_at),
    transactionCount: asNumber(source.tx_count) ?? asNumber(source.transaction_count),
    operationCount: asNumber(source.operation_count),
    successfulTransactionCount: asNumber(source.successful_tx_count),
    protocolVersion: asNumber(source.protocol_version),
    baseFeeInStroops: asNumber(source.base_fee_in_stroops),
    networkPassphrase: asString(source.network_passphrase),
    missingFields: [],
  };

  const fields: Array<keyof LedgerMetadata> = [
    'sequence',
    'hash',
    'closedAt',
    'transactionCount',
    'operationCount',
    'protocolVersion',
  ];
  metadata.missingFields = fields.filter((field) => metadata[field] === null).map(String);
  return metadata;
}

/** Compares protocol versions without assuming a difference proves an upgrade. */
export function compareProtocolVersions(
  previous: number | null,
  current: number | null,
): ProtocolComparison {
  if (previous === null || current === null) {
    return {
      changed: false,
      direction: 'unknown',
      from: previous,
      to: current,
      message:
        'Protocol version comparison unavailable: at least one ledger has no protocol version',
    };
  }
  if (previous === current) {
    return {
      changed: false,
      direction: 'unchanged',
      from: previous,
      to: current,
      message: `Protocol version unchanged at ${current}`,
    };
  }
  const direction = current > previous ? 'upgrade' : 'downgrade';
  return {
    changed: true,
    direction,
    from: previous,
    to: current,
    message: `Protocol version changed from ${previous} to ${current} (${direction}); confirm a network-wide upgrade before treating this as a compatibility break`,
  };
}

/** Compares a ledger's protocol version with the application's requirements. */
export function checkProtocolCompatibility(
  version: number | null,
  options: Pick<InspectOptions, 'minSupportedProtocol' | 'maxSupportedProtocol'> = {},
): CompatibilityAssessment {
  const { minSupportedProtocol: min, maxSupportedProtocol: max } = options;
  if (version === null) {
    return {
      compatible: false,
      status: 'unknown',
      message: 'Ledger has no protocol version; compatibility cannot be assessed',
    };
  }
  if (min !== undefined && version < min) {
    return {
      compatible: false,
      status: 'below-minimum',
      message: `Ledger protocol ${version} is below the minimum supported version ${min}`,
    };
  }
  if (max !== undefined && version > max) {
    return {
      compatible: false,
      status: 'above-maximum',
      message: `Ledger protocol ${version} exceeds the maximum tested version ${max}; this is a warning, not proof of incompatibility`,
    };
  }
  return {
    compatible: true,
    status: 'ok',
    message: `Ledger protocol ${version} satisfies the declared compatibility range`,
  };
}

/** Calculates the close interval with configurable thresholds. */
export function analyzeCloseInterval(
  previousClosedAt: string | null,
  currentClosedAt: string | null,
  thresholds: IntervalThresholds = {},
): CloseInterval {
  const minMs = thresholds.minMs ?? 1000;
  const maxMs = thresholds.maxMs ?? 20_000;
  const previous = previousClosedAt === null ? NaN : Date.parse(previousClosedAt);
  const current = currentClosedAt === null ? NaN : Date.parse(currentClosedAt);
  if (!Number.isFinite(previous) || !Number.isFinite(current)) {
    return {
      elapsedMs: null,
      status: 'unavailable',
      message: 'Close interval unavailable because a timestamp is missing or invalid',
    };
  }
  const elapsedMs = Math.max(0, current - previous);
  if (elapsedMs < minMs) {
    return {
      elapsedMs,
      status: 'short',
      message: `Close interval ${elapsedMs} ms is shorter than the configured minimum ${minMs} ms`,
    };
  }
  if (elapsedMs > maxMs) {
    return {
      elapsedMs,
      status: 'long',
      message: `Close interval ${elapsedMs} ms exceeds the configured maximum ${maxMs} ms`,
    };
  }
  return {
    elapsedMs,
    status: 'normal',
    message: `Close interval ${elapsedMs} ms is within the configured thresholds`,
  };
}

export async function loadLedgerFromHorizon(
  server: Horizon.Server,
  sequence?: number,
): Promise<unknown> {
  try {
    if (sequence === undefined) {
      const page = await server.ledgers().limit(1).call();
      const record = page.records[0];
      if (!record) throw new Error('No ledgers are available');
      return record;
    }
    return await server.ledgers().ledger(sequence).call();
  } catch (error) {
    throw new Error(`Unable to load ledger ${sequence ?? 'latest'}: ${errorMessage(error)}`);
  }
}

/** Inspects one ledger and its predecessor, collecting retrieval errors. */
export async function inspectLedger(
  loader: LedgerLoader,
  options: InspectOptions & { sequence?: number; network?: string } = {},
): Promise<LedgerInspectionReport> {
  const errors: string[] = [];
  let inspected: LedgerMetadata | null = null;
  let previous: LedgerMetadata | null = null;

  try {
    inspected = extractLedgerMetadata(await loader.loadLedger(options.sequence));
  } catch (error) {
    errors.push(errorMessage(error));
  }

  const sequence = inspected?.sequence;
  if (sequence !== null && sequence !== undefined && sequence > 1) {
    try {
      previous = extractLedgerMetadata(await loader.loadLedger(sequence - 1));
    } catch (error) {
      errors.push(errorMessage(error));
    }
  } else if (sequence === null) {
    errors.push('Previous ledger cannot be resolved because the inspected ledger has no sequence');
  }

  if (!inspected) {
    inspected = {
      sequence: null,
      hash: null,
      previousHash: null,
      closedAt: null,
      transactionCount: null,
      operationCount: null,
      successfulTransactionCount: null,
      protocolVersion: null,
      baseFeeInStroops: null,
      networkPassphrase: null,
      missingFields: [],
    };
  }

  return {
    network: options.network ?? inspected.networkPassphrase ?? '<unspecified>',
    inspected,
    previous,
    protocolComparison: previous
      ? compareProtocolVersions(previous.protocolVersion, inspected.protocolVersion)
      : null,
    compatibility: checkProtocolCompatibility(inspected.protocolVersion, options),
    closeInterval: previous
      ? analyzeCloseInterval(previous.closedAt, inspected.closedAt, options)
      : {
          elapsedMs: null,
          status: 'unavailable',
          message: 'Close interval unavailable because the previous ledger could not be inspected',
        },
    errors,
  };
}

export function formatReport(report: LedgerInspectionReport): string {
  const ledger = report.inspected;
  const lines = [
    'Ledger metadata inspection report',
    `Network:            ${report.network}`,
    `Sequence:           ${ledger.sequence ?? '<unavailable>'}`,
    `Hash:               ${ledger.hash ?? '<unavailable>'}`,
    `Previous hash:      ${ledger.previousHash ?? '<unavailable>'}`,
    `Closed at:          ${ledger.closedAt ?? '<unavailable>'}`,
    `Transactions:       ${ledger.transactionCount ?? '<unavailable>'}`,
    `Operations:         ${ledger.operationCount ?? '<unavailable>'}`,
    `Successful tx:      ${ledger.successfulTransactionCount ?? '<unavailable>'}`,
    `Protocol version:   ${ledger.protocolVersion ?? '<unavailable>'}`,
    `Base fee (stroops): ${ledger.baseFeeInStroops ?? '<unavailable>'}`,
    `Missing fields:     ${ledger.missingFields.length ? ledger.missingFields.join(', ') : 'none'}`,
    `Compatibility:      ${report.compatibility.status}: ${report.compatibility.message}`,
    `Close interval:     ${report.closeInterval.status}: ${report.closeInterval.message}`,
  ];
  if (report.protocolComparison) {
    lines.push(
      `Protocol change:    ${report.protocolComparison.direction}: ${report.protocolComparison.message}`,
    );
  }
  for (const error of report.errors) lines.push(`ERROR               ${error}`);
  lines.push('Observed close intervals are samples, not a network performance guarantee.');
  return lines.join('\n');
}

function argumentValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function run(params?: any): Promise<void> {
  const args = (params?.args as string[] | undefined) ?? process.argv.slice(2);
  const rawSequence = params?.sequence ?? argumentValue(args, '--sequence');
  const isLatest = params?.latest ?? args.includes('--latest');
  if (!isLatest && rawSequence === undefined) {
    console.log(
      'Usage: ledger-metadata-inspector --sequence <n> | --latest [--min-protocol <n>] [--max-protocol <n>] [--json]',
    );
    return;
  }

  let sequence: number | undefined;
  try {
    sequence = isLatest ? undefined : parseLedgerSequence(rawSequence);
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
    return;
  }

  const horizonUrl =
    params?.horizonUrl ?? argumentValue(args, '--horizon') ?? 'https://horizon-testnet.stellar.org';
  const server = new Horizon.Server(horizonUrl);
  const loader: LedgerLoader = {
    loadLedger: async (seq) => await loadLedgerFromHorizon(server, seq),
  };
  const report = await inspectLedger(loader, {
    sequence,
    minSupportedProtocol:
      params?.minProtocol !== undefined
        ? Number(params.minProtocol)
        : numberOrUndefined(argumentValue(args, '--min-protocol')),
    maxSupportedProtocol:
      params?.maxProtocol !== undefined
        ? Number(params.maxProtocol)
        : numberOrUndefined(argumentValue(args, '--max-protocol')),
    minMs: numberOrUndefined(argumentValue(args, '--min-interval-ms')),
    maxMs: numberOrUndefined(argumentValue(args, '--max-interval-ms')),
    network: params?.network ?? argumentValue(args, '--network'),
  });

  if (params?.json ?? args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }
  if (report.errors.length > 0 && (params?.failOnError ?? args.includes('--fail-on-error'))) {
    process.exitCode = 1;
  }
}

function numberOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
