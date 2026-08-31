import { xdr, rpc, scValToNative, Contract } from '@stellar/stellar-sdk';
import chalk from 'chalk';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';
const DEFAULT_POLL_INTERVAL_MS = 1_500;
const DEFAULT_MAX_INTERVAL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MonitorParams {
  rpcUrl?: string;
  txHash?: string;
  pollIntervalMs?: number;
  maxIntervalMs?: number;
  timeoutMs?: number;
  json?: boolean;
}

export interface DecodedValue {
  xdrType: string;
  value: unknown;
  decoded: boolean;
}

export interface DecodedEvent {
  id: string;
  type: string;
  contractId: string;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  pagingToken: string;
  inSuccessfulContractCall: boolean;
  /** Decoded topics */
  topics: DecodedValue[];
  /** First symbol topic, if any */
  eventName: string | null;
  /** Decoded payload */
  value: DecodedValue;
  /** Raw base64 XDR for each topic */
  rawTopics: string[];
  /** Raw base64 XDR payload */
  rawValue: string;
}

export interface EventGroup {
  contractId: string;
  events: DecodedEvent[];
}

export interface MonitorReport {
  txHash: string;
  status: 'SUCCESS' | 'FAILED' | 'NOT_FOUND' | 'TIMEOUT' | 'ERROR';
  ledger: number | null;
  ledgerClosedAt: string | null;
  envelopeXdr: string | null;
  resultXdr: string | null;
  returnValue: DecodedValue | null;
  events: DecodedEvent[];
  diagnosticEvents: DecodedEvent[];
  byContract: Record<string, DecodedEvent[]>;
  byEventName: Record<string, DecodedEvent[]>;
  totalEvents: number;
  error: string | null;
  pollAttempts: number;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/** Returns true when the string looks like a 64-hex-character transaction hash. */
export function isValidTxHash(hash: string): boolean {
  if (typeof hash !== 'string') return false;
  return /^[0-9a-fA-F]{64}$/.test(hash.trim());
}

// ---------------------------------------------------------------------------
// ScVal decoding
// ---------------------------------------------------------------------------

/**
 * Decode a single ScVal, returning a structured result that preserves type
 * information. Never throws — returns decoded=false on failure.
 */
export function decodeScVal(val: xdr.ScVal | undefined): DecodedValue {
  if (!val) return { xdrType: 'void', value: null, decoded: true };

  const xdrType = val.switch()?.name ?? 'unknown';
  try {
    const native = scValToNative(val);
    return { xdrType, value: formatNativeValue(native), decoded: true };
  } catch {
    return { xdrType, value: null, decoded: false };
  }
}

/**
 * Recursively make a native ScVal value JSON-serializable.
 * Converts BigInt → string, Buffer → 0x-hex, Map → plain object.
 */
export function formatNativeValue(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return '0x' + Buffer.from(v).toString('hex');
  if (v instanceof Map) {
    const obj: Record<string, unknown> = {};
    v.forEach((val, key) => {
      obj[String(key)] = formatNativeValue(val);
    });
    return obj;
  }
  if (Array.isArray(v)) return v.map(formatNativeValue);
  if (typeof v === 'object') {
    const obj: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      obj[k] = formatNativeValue(val);
    }
    return obj;
  }
  return v;
}

/** Extract the event name from the first symbol topic, if present. */
export function extractEventName(topics: DecodedValue[]): string | null {
  if (!topics.length) return null;
  const first = topics[0];
  if (first.xdrType === 'scvSymbol' && typeof first.value === 'string') return first.value;
  return null;
}

/** Extract a contract strkey from either a Contract instance or raw string. */
export function extractContractId(raw: unknown): string {
  if (!raw) return '';
  if (typeof raw === 'string') return raw;
  if (raw instanceof Contract) return raw.address().toString();
  return '';
}

// ---------------------------------------------------------------------------
// Event parsing
// ---------------------------------------------------------------------------

/** Shape returned by server.getEvents */
export type RawEventRecord = rpc.Api.EventRecord;

/** Parse a single RPC event record into a fully decoded structure. */
export function parseEventRecord(ev: RawEventRecord): DecodedEvent {
  const rawTopics = (ev.topic ?? []).map((t: xdr.ScVal) => t.toXDR('base64'));
  const rawValue = ev.value ? (ev.value as xdr.ScVal).toXDR('base64') : '';

  const topics = (ev.topic ?? []).map((t: xdr.ScVal) => decodeScVal(t));
  const value = decodeScVal(ev.value as xdr.ScVal | undefined);

  return {
    id: ev.id ?? '',
    type: ev.type ?? 'contract',
    contractId: extractContractId(ev.contractId),
    ledger: ev.ledger ?? 0,
    ledgerClosedAt: ev.ledgerClosedAt ?? '',
    txHash: ev.txHash ?? '',
    pagingToken: ev.pagingToken ?? '',
    inSuccessfulContractCall: ev.inSuccessfulContractCall ?? true,
    topics,
    eventName: extractEventName(topics),
    value,
    rawTopics,
    rawValue,
  };
}

/**
 * Group an array of decoded events by contractId and by eventName.
 */
export function groupEvents(events: DecodedEvent[]): {
  byContract: Record<string, DecodedEvent[]>;
  byEventName: Record<string, DecodedEvent[]>;
} {
  const byContract: Record<string, DecodedEvent[]> = {};
  const byEventName: Record<string, DecodedEvent[]> = {};

  for (const ev of events) {
    const cid = ev.contractId || 'unknown';
    (byContract[cid] ??= []).push(ev);

    const name = ev.eventName ?? ev.type ?? 'unknown';
    (byEventName[name] ??= []).push(ev);
  }
  return { byContract, byEventName };
}

// ---------------------------------------------------------------------------
// Polling helpers
// ---------------------------------------------------------------------------

export interface PollConfig {
  intervalMs: number;
  maxIntervalMs: number;
  timeoutMs: number;
}

export type PollResult =
  | { kind: 'SUCCESS'; response: rpc.Api.GetSuccessfulTransactionResponse; attempts: number }
  | { kind: 'FAILED'; response: rpc.Api.GetFailedTransactionResponse; attempts: number }
  | { kind: 'NOT_FOUND'; attempts: number }
  | { kind: 'TIMEOUT'; attempts: number }
  | { kind: 'ERROR'; error: string; attempts: number };

/**
 * Poll a transaction until it reaches a terminal state or the deadline passes.
 *
 * Temporary RPC failures (network blips) are retried without terminating.
 * Interval grows up to maxIntervalMs to reduce load on the RPC node.
 */
export async function pollTransaction(
  server: rpc.Server,
  txHash: string,
  config: PollConfig,
): Promise<PollResult> {
  const deadline = Date.now() + config.timeoutMs;
  let interval = config.intervalMs;
  let attempts = 0;

  while (Date.now() < deadline) {
    await sleep(interval);
    attempts++;

    let response: rpc.Api.GetTransactionResponse;
    try {
      response = await server.getTransaction(txHash);
    } catch (err: any) {
      // Transient RPC failure — back off and retry
      interval = Math.min(interval * 2, config.maxIntervalMs);
      continue;
    }

    switch (response.status) {
      case rpc.Api.GetTransactionStatus.SUCCESS:
        return {
          kind: 'SUCCESS',
          response: response as rpc.Api.GetSuccessfulTransactionResponse,
          attempts,
        };
      case rpc.Api.GetTransactionStatus.FAILED:
        return {
          kind: 'FAILED',
          response: response as rpc.Api.GetFailedTransactionResponse,
          attempts,
        };
      case rpc.Api.GetTransactionStatus.NOT_FOUND:
        // Still pending or not yet ingested — continue polling
        interval = Math.min(interval * 1.5, config.maxIntervalMs);
        break;
    }
  }

  return { kind: 'TIMEOUT', attempts };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Event retrieval
// ---------------------------------------------------------------------------

/**
 * Fetch contract events associated with a specific transaction hash from a
 * surrounding ledger window.
 *
 * getEvents does not support direct hash filtering, so we query around the
 * transaction's ledger and filter client-side.
 */
export async function fetchTransactionEvents(
  server: rpc.Server,
  txHash: string,
  txLedger: number,
): Promise<{ events: DecodedEvent[]; diagnosticEvents: DecodedEvent[] }> {
  const startLedger = Math.max(1, txLedger - 2);

  let rawEvents: RawEventRecord[] = [];
  try {
    const response = await server.getEvents({
      startLedger,
      filters: [{ type: 'contract' }],
      limit: 200,
    });
    rawEvents = response.events ?? [];
  } catch {
    // Non-fatal; return empty
  }

  const txEvents = rawEvents.filter((ev) => ev.txHash === txHash);

  let diagnosticRaw: RawEventRecord[] = [];
  try {
    const diagResponse = await server.getEvents({
      startLedger,
      filters: [{ type: 'diagnostic' }],
      limit: 200,
    });
    diagnosticRaw = (diagResponse.events ?? []).filter((ev) => ev.txHash === txHash);
  } catch {
    // Diagnostic events are optional
  }

  return {
    events: txEvents.map(parseEventRecord),
    diagnosticEvents: diagnosticRaw.map(parseEventRecord),
  };
}

// ---------------------------------------------------------------------------
// Core monitor
// ---------------------------------------------------------------------------

/**
 * Monitor a submitted Soroban transaction: poll until terminal, then collect
 * and decode all associated contract events.
 */
export async function monitorTransaction(
  server: rpc.Server,
  txHash: string,
  config: PollConfig,
): Promise<MonitorReport> {
  const report: MonitorReport = {
    txHash,
    status: 'ERROR',
    ledger: null,
    ledgerClosedAt: null,
    envelopeXdr: null,
    resultXdr: null,
    returnValue: null,
    events: [],
    diagnosticEvents: [],
    byContract: {},
    byEventName: {},
    totalEvents: 0,
    error: null,
    pollAttempts: 0,
  };

  const pollResult = await pollTransaction(server, txHash, config);
  report.pollAttempts = pollResult.attempts;

  if (pollResult.kind === 'TIMEOUT') {
    report.status = 'TIMEOUT';
    report.error = `Timed out after ${config.timeoutMs}ms (${pollResult.attempts} attempts)`;
    return report;
  }

  if (pollResult.kind === 'ERROR') {
    report.status = 'ERROR';
    report.error = pollResult.error;
    return report;
  }

  if (pollResult.kind === 'NOT_FOUND') {
    report.status = 'NOT_FOUND';
    report.error = 'Transaction not found on the network after polling';
    return report;
  }

  if (pollResult.kind === 'FAILED') {
    const failedResp = pollResult.response;
    report.status = 'FAILED';
    report.ledger = failedResp.ledger ?? null;
    report.ledgerClosedAt = failedResp.createdAt
      ? new Date(Number(failedResp.createdAt) * 1000).toISOString()
      : null;
    report.envelopeXdr = failedResp.envelopeXdr?.toXDR('base64') ?? null;
    report.resultXdr = failedResp.resultXdr?.toXDR('base64') ?? null;
    report.error = 'Transaction failed on-chain';
    return report;
  }

  // SUCCESS path
  const successResp = pollResult.response;
  report.status = 'SUCCESS';
  report.ledger = successResp.ledger ?? null;
  report.ledgerClosedAt = successResp.createdAt
    ? new Date(Number(successResp.createdAt) * 1000).toISOString()
    : null;
  report.envelopeXdr = successResp.envelopeXdr?.toXDR('base64') ?? null;
  report.resultXdr = successResp.resultXdr?.toXDR('base64') ?? null;

  if (successResp.returnValue) {
    report.returnValue = decodeScVal(successResp.returnValue);
  }

  // Collect events
  if (report.ledger !== null) {
    const { events, diagnosticEvents } = await fetchTransactionEvents(
      server,
      txHash,
      report.ledger,
    );
    report.events = events;
    report.diagnosticEvents = diagnosticEvents;
  }

  const { byContract, byEventName } = groupEvents(report.events);
  report.byContract = byContract;
  report.byEventName = byEventName;
  report.totalEvents = report.events.length;

  return report;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function renderValue(dv: DecodedValue): string {
  if (!dv.decoded) return chalk.yellow(`<undecodable ${dv.xdrType}>`);
  if (dv.value === null) return chalk.gray('void');
  return chalk.cyan(JSON.stringify(dv.value));
}

function printEvent(ev: DecodedEvent, index: number): void {
  console.log(chalk.bold(`\n  Event #${index + 1}`));
  console.log(`    ID:         ${ev.id}`);
  console.log(`    Type:       ${ev.type}`);
  console.log(`    Contract:   ${ev.contractId || chalk.gray('n/a')}`);
  console.log(`    Ledger:     ${ev.ledger}`);
  console.log(`    Tx Hash:    ${ev.txHash}`);
  if (ev.eventName) {
    console.log(`    Event Name: ${chalk.green(ev.eventName)}`);
  }
  if (!ev.inSuccessfulContractCall) {
    console.log(chalk.yellow('    ⚠ emitted by a sub-call that failed'));
  }
  console.log(`    Topics (${ev.topics.length}):`);
  ev.topics.forEach((t, i) => {
    console.log(`      [${i}] ${chalk.gray(t.xdrType)} = ${renderValue(t)}`);
    console.log(`          raw: ${chalk.gray(ev.rawTopics[i] ?? '')}`);
  });
  console.log(`    Value:      ${chalk.gray(ev.value.xdrType)} = ${renderValue(ev.value)}`);
  console.log(`    Raw Value:  ${chalk.gray(ev.rawValue || '(empty)')}`);
}

function printReport(report: MonitorReport, jsonOutput: boolean): void {
  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(chalk.bold('\n=== Soroban Transaction Event Monitor ==='));
  console.log(`${chalk.bold('Tx Hash:')}     ${report.txHash}`);
  console.log(
    `${chalk.bold('Status:')}      ${
      report.status === 'SUCCESS'
        ? chalk.green(report.status)
        : report.status === 'FAILED'
          ? chalk.red(report.status)
          : chalk.yellow(report.status)
    }`,
  );

  if (report.ledger) {
    console.log(`${chalk.bold('Ledger:')}      ${report.ledger}`);
  }
  if (report.ledgerClosedAt) {
    console.log(`${chalk.bold('Closed At:')}   ${report.ledgerClosedAt}`);
  }
  if (report.pollAttempts) {
    console.log(`${chalk.bold('Poll Attempts:')} ${report.pollAttempts}`);
  }

  if (report.returnValue) {
    console.log(`${chalk.bold('Return Value:')} ${renderValue(report.returnValue)}`);
  }

  if (report.error) {
    console.log(chalk.red(`\nError: ${report.error}`));
  }

  // Events
  console.log(chalk.bold(`\n--- Contract Events (${report.totalEvents}) ---`));
  if (report.events.length === 0) {
    console.log(chalk.gray('  No contract events emitted by this transaction.'));
  } else {
    report.events.forEach((ev, i) => printEvent(ev, i));

    // Group summary
    const contractIds = Object.keys(report.byContract);
    if (contractIds.length > 1) {
      console.log(chalk.bold('\n--- By Contract ---'));
      for (const cid of contractIds) {
        console.log(`  ${cid}: ${report.byContract[cid].length} event(s)`);
      }
    }

    const eventNames = Object.keys(report.byEventName);
    if (eventNames.length > 0) {
      console.log(chalk.bold('\n--- By Event Type ---'));
      for (const name of eventNames) {
        console.log(`  ${name}: ${report.byEventName[name].length} event(s)`);
      }
    }
  }

  // Diagnostic events
  if (report.diagnosticEvents.length > 0) {
    console.log(chalk.bold(`\n--- Diagnostic Events (${report.diagnosticEvents.length}) ---`));
    report.diagnosticEvents.forEach((ev: DecodedEvent, i: number) => printEvent(ev, i));
  }

  console.log('');
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export async function run(params?: MonitorParams): Promise<void> {
  const rpcUrl = params?.rpcUrl ?? process.env.SOROBAN_RPC_URL ?? DEFAULT_RPC_URL;
  const jsonOutput = params?.json === true || process.env.JSON_OUTPUT === 'true';

  const txHash =
    (params?.txHash ?? process.env.TX_HASH ?? '').trim();

  const pollConfig: PollConfig = {
    intervalMs: (params?.pollIntervalMs ?? Number(process.env.POLL_INTERVAL_MS)) || DEFAULT_POLL_INTERVAL_MS,
    maxIntervalMs: (params?.maxIntervalMs ?? Number(process.env.MAX_INTERVAL_MS)) || DEFAULT_MAX_INTERVAL_MS,
    timeoutMs: (params?.timeoutMs ?? Number(process.env.POLL_TIMEOUT_MS)) || DEFAULT_TIMEOUT_MS,
  };

  if (!jsonOutput) {
    console.log(chalk.blue('Soroban Transaction Event Monitor'));
    console.log(chalk.gray(`RPC: ${rpcUrl}`));
  }

  if (!isValidTxHash(txHash)) {
    const msg = `Invalid transaction hash: "${txHash}". Expected 64 hex characters.`;
    if (jsonOutput) {
      console.log(JSON.stringify({ error: msg }));
    } else {
      console.error(chalk.red(msg));
    }
    return;
  }

  const server = new rpc.Server(rpcUrl);
  const report = await monitorTransaction(server, txHash, pollConfig);

  printReport(report, jsonOutput);
}
