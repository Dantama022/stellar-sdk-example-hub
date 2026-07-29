import { rpc, scValToNative, StrKey, xdr } from '@stellar/stellar-sdk';

/**
 * Example 67: Soroban Contract Events
 *
 * Soroban contracts publish events to describe what they did, so applications
 * can follow on-chain activity without reading contract storage or replaying
 * transaction meta by hand. Indexers, notification services, analytics
 * pipelines, and debugging tools are all built on this query.
 *
 * Anatomy of a Soroban event
 * --------------------------
 * A contract emits an event with a call shaped like:
 *
 *   env.events().publish((symbol_short!("transfer"), from, to), amount);
 *
 * which produces two distinct parts:
 *
 *   Topics — an ordered tuple of up to four `ScVal`s. Topics are *indexed*: the
 *     RPC server can filter on them server-side, so they are where identifying
 *     information belongs. By near-universal convention the first topic is a
 *     symbol naming the event (`transfer`, `mint`, `approve`), and the
 *     remaining topics are the parameters callers would want to filter by, such
 *     as the `from` and `to` addresses of a token transfer.
 *
 *   Value (data) — a single `ScVal` payload carrying the rest of the event. It
 *     is *not* indexed and cannot be filtered on, but it has no shape
 *     restrictions: a scalar, a vector, or a map of named fields.
 *
 * Both parts are XDR-encoded `ScVal` unions. `scValToNative` converts them into
 * JavaScript values — symbols and strings become strings, addresses become
 * strkeys, `i128`/`u128` become `bigint`, `bytes` becomes a `Buffer`, vectors
 * become arrays, and maps become plain objects.
 *
 * Event types
 * -----------
 *   `contract`   — published by contract code via `events().publish(...)`.
 *   `system`     — emitted by the host itself for lifecycle moments such as a
 *                  contract being deployed or its Wasm being updated.
 *   `diagnostic` — verbose host tracing (call/return trails, errors). These are
 *                  off by default on public RPC instances and are meant for
 *                  debugging, not for application logic.
 *
 * Every event also carries `inSuccessfulContractCall`. A sub-call can emit
 * events and then have its frame fail while the surrounding transaction still
 * succeeds; those events are returned with the flag set to `false` and must be
 * ignored by any indexer that cares about final state.
 *
 * Contract events vs. Horizon events
 * ----------------------------------
 * This is the distinction most people trip over, and it is not a difference in
 * API style — the two carry different data with different lifetimes:
 *
 *   Horizon operations and effects (examples `45-horizon-effects`,
 *   `19-horizon-streaming`)
 *     - Derived by Horizon from *classic* ledger state changes: payments,
 *       trustlines, offers, account entries.
 *     - The schema is fixed and defined by the protocol. Every account credit
 *       looks the same regardless of who caused it.
 *     - Retained for the full history the Horizon instance has ingested, and
 *       paginated with cursors that stay valid indefinitely.
 *     - A Soroban invocation shows up only as an `invoke_host_function`
 *       operation. Horizon does not decode the events the contract emitted.
 *
 *   Soroban contract events (this example)
 *     - Application-defined. The contract author chooses the topics and the
 *       payload, so the schema is per-contract and only meaningful if you know
 *       the contract's interface.
 *     - Not part of ledger *state*. They live in transaction meta, and RPC
 *       servers keep only a rolling retention window (commonly ~24 hours of
 *       ledgers). Events older than that window are gone from RPC, even though
 *       the transactions that produced them are permanent.
 *     - Queried exclusively through Soroban RPC's `getEvents`, filtered by
 *       ledger range, contract ID, event type, and topic patterns.
 *
 * The practical consequence: you cannot backfill contract events on demand the
 * way you can page back through Horizon. Anything that needs long-term event
 * history has to ingest continuously and store the results itself, which is
 * exactly why the retention window is surfaced prominently below.
 *
 * Relationship to example `10-soroban-events`
 * -------------------------------------------
 * `10-soroban-events` is a minimal first look at `getEvents` against a fixed
 * contract ID. This example is the fuller treatment: contract ID input,
 * explicit ledger-range filtering with retention handling, per-topic decoding
 * with XDR type names, ledger and transaction references, aggregate summaries,
 * and graceful empty results.
 *
 * This example is strictly read-only. It submits no transactions and needs no
 * funded account.
 */

const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';

/**
 * Default ledger lookback (~24 hours at 5-second ledgers).
 *
 * This matches the event retention window most RPC instances are configured
 * with, so it is the widest range that is usually accepted.
 */
const DEFAULT_LEDGER_LOOKBACK = 17280;

/**
 * Progressively narrower lookbacks, tried in order when the server rejects the
 * requested range. An RPC instance configured with a shorter retention window
 * than the default rejects the first attempt but accepts a later one.
 */
const FALLBACK_LOOKBACKS = [17280, 8640, 2880, 720, 120];

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 200;

/** Number of events scanned when discovering an active contract to inspect. */
const DISCOVERY_LIMIT = 100;

export interface ContractEventsParams {
  /** Contract ID to query, as a `C...` strkey. */
  contractId?: string;
  /** First ledger of the query range (inclusive). */
  startLedger?: number | string;
  /** Last ledger of the query range (inclusive), where the RPC supports it. */
  endLedger?: number | string;
  /** Maximum number of events to retrieve (1-200). */
  limit?: number | string;
  /** Event type filter: `contract`, `system`, or `diagnostic`. */
  eventType?: string;
  rpcUrl?: string;
}

/** A single decoded `ScVal`, kept alongside the XDR type it was encoded as. */
export interface DecodedScVal {
  /** XDR discriminant name, e.g. `scvSymbol`, `scvAddress`, `scvI128`. */
  xdrType: string;
  /** JSON-safe native value, or `null` when decoding failed. */
  value: unknown;
  /** False when the `ScVal` could not be converted to a native value. */
  decoded: boolean;
  /** Reason decoding failed, when `decoded` is false. */
  error?: string;
}

/** A Soroban event reduced to the fields this example reports on. */
export interface ParsedContractEvent {
  /** RPC event ID, unique and ordered within the ledger range. */
  id: string;
  /** `contract`, `system`, or `diagnostic`. */
  type: string;
  /** Ledger sequence that contained the emitting transaction. */
  ledger: number;
  /** ISO-8601 close time of that ledger. */
  ledgerClosedAt: string;
  /** Hash of the transaction whose invocation emitted the event. */
  txHash: string;
  /** Contract that emitted the event, as a `C...` strkey. */
  contractId: string;
  /** Decoded topic tuple, in emission order. */
  topics: DecodedScVal[];
  /**
   * Event name taken from the first topic when it is a symbol.
   *
   * This is a strong convention rather than a protocol rule, so it is reported
   * as unknown rather than guessed when the first topic is not a symbol.
   */
  eventName: string | null;
  /** Decoded data payload. */
  value: DecodedScVal;
  /**
   * False when the emitting sub-call ultimately failed. Such events are still
   * returned by RPC and must be filtered out by state-tracking consumers.
   */
  inSuccessfulContractCall: boolean;
  /** Cursor for resuming pagination after this event. */
  pagingToken: string;
}

export interface ContractEventsSummary {
  eventCount: number;
  /** Event counts keyed by the name in the first topic. */
  countsByName: Record<string, number>;
  /** Event counts keyed by `contract` / `system` / `diagnostic`. */
  countsByType: Record<string, number>;
  /** Distinct contracts represented in the result set. */
  contractIds: string[];
  /** Lowest ledger sequence in the result set. */
  firstLedger: number | null;
  /** Highest ledger sequence in the result set. */
  lastLedger: number | null;
  /** Distinct transactions that produced the events. */
  transactionCount: number;
  /** Events emitted by a sub-call that later failed. */
  failedCallEventCount: number;
}

/** The ledger window actually queried, after clamping and fallbacks. */
export interface LedgerRange {
  startLedger: number;
  /** Undefined when the query was left open-ended up to the latest ledger. */
  endLedger?: number;
}

/**
 * Validates a contract ID and normalizes its formatting.
 *
 * Contract IDs are strkeys with a `C` prefix. Validating here turns a typo into
 * a clear message instead of an opaque RPC `-32602 invalid filter` response.
 */
export function normalizeContractId(value: string, label = 'contract ID'): string {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error(`Missing ${label}. Provide a contract ID starting with "C".`);
  }

  if (!StrKey.isValidContract(trimmed)) {
    throw new Error(
      `Invalid ${label} "${trimmed}". Expected a 56-character strkey starting with "C".`,
    );
  }

  return trimmed;
}

/**
 * Converts a decoded native value into something safe to print.
 *
 * `scValToNative` returns values `JSON.stringify` cannot handle: `bigint`
 * throws outright, and `Buffer` renders as a byte-array object. Numeric types
 * become strings to preserve full `i128`/`u256` precision, and byte strings
 * become hex.
 */
export function formatNativeValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  // Must precede the generic object branch: buffers are objects.
  if (value instanceof Uint8Array) {
    return `0x${Buffer.from(value).toString('hex')}`;
  }

  if (Array.isArray(value)) {
    return value.map(formatNativeValue);
  }

  // ScVal maps with non-string keys decode to a Map rather than a plain object.
  if (value instanceof Map) {
    const entries: Record<string, unknown> = {};
    for (const [key, entry] of value.entries()) {
      entries[String(formatNativeValue(key))] = formatNativeValue(entry);
    }
    return entries;
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = formatNativeValue(entry);
    }
    return out;
  }

  return value;
}

/**
 * Decodes one `ScVal`, retaining its XDR type name.
 *
 * The type name is worth keeping: `scValToNative` maps several distinct XDR
 * types onto the same JavaScript type, so a decoded `"transfer"` could have
 * been a symbol or a string, and a decoded `"100"` could have been any of six
 * integer widths. Event consumers that match on shape need the distinction.
 *
 * Decoding never throws. An event carrying one value this SDK version cannot
 * represent should still have its other fields reported.
 */
export function decodeScVal(scVal: xdr.ScVal | undefined): DecodedScVal {
  if (!scVal) {
    return { xdrType: 'void', value: null, decoded: true };
  }

  let xdrType = 'unknown';
  try {
    const discriminant = (scVal as unknown as { switch?: () => { name?: string } }).switch?.();
    xdrType = discriminant?.name ?? String(discriminant ?? 'unknown');
  } catch {
    xdrType = 'unknown';
  }

  try {
    return { xdrType, value: formatNativeValue(scValToNative(scVal)), decoded: true };
  } catch (error: any) {
    return {
      xdrType,
      value: null,
      decoded: false,
      error: error?.message || String(error),
    };
  }
}

/** Renders a decoded value on one line, quoting strings for readability. */
export function renderDecodedValue(decoded: DecodedScVal): string {
  if (!decoded.decoded) {
    return `<undecodable: ${decoded.error ?? 'unknown error'}>`;
  }
  if (typeof decoded.value === 'string') {
    return `"${decoded.value}"`;
  }
  if (decoded.value === null || decoded.value === undefined) {
    return 'void';
  }
  return JSON.stringify(decoded.value);
}

/**
 * Extracts the event name from the topic tuple.
 *
 * Returns null unless the first topic is a symbol, since only that case is the
 * documented convention. Guessing from a non-symbol first topic would silently
 * mislabel events emitted by contracts that use a different scheme.
 */
export function extractEventName(topics: DecodedScVal[]): string | null {
  const first = topics[0];
  if (!first || !first.decoded || first.xdrType !== 'scvSymbol') {
    return null;
  }
  return typeof first.value === 'string' ? first.value : null;
}

/**
 * Reads the contract ID off an event record.
 *
 * The SDK hydrates `contractId` into a `Contract` instance, but the raw RPC
 * response carries a plain strkey string. Both shapes are accepted, and
 * anything that does not validate as a contract strkey is reported as empty
 * rather than as `[object Object]`.
 */
export function extractContractId(contractId: unknown): string {
  if (!contractId) {
    return '';
  }

  const candidate =
    typeof contractId === 'string'
      ? contractId
      : String((contractId as { toString?: () => string }).toString?.() ?? '');

  return StrKey.isValidContract(candidate) ? candidate : '';
}

/** Shape of the raw RPC event payload consumed by `parseEventRecord`. */
export interface RawEventRecord {
  id?: string;
  type?: string;
  ledger?: number;
  ledgerClosedAt?: string;
  txHash?: string;
  contractId?: unknown;
  topic?: xdr.ScVal[];
  value?: xdr.ScVal;
  inSuccessfulContractCall?: boolean;
  pagingToken?: string;
}

/** Converts an RPC event record into a fully decoded `ParsedContractEvent`. */
export function parseEventRecord(event: RawEventRecord): ParsedContractEvent {
  const topics = (event.topic ?? []).map(decodeScVal);

  return {
    id: event.id ?? '',
    type: event.type ?? 'contract',
    ledger: event.ledger ?? 0,
    ledgerClosedAt: event.ledgerClosedAt ?? '',
    txHash: event.txHash ?? '',
    contractId: extractContractId(event.contractId),
    topics,
    eventName: extractEventName(topics),
    value: decodeScVal(event.value),
    // Absent on older RPC responses; assume success rather than flagging every
    // event as coming from a failed call.
    inSuccessfulContractCall: event.inSuccessfulContractCall !== false,
    pagingToken: event.pagingToken ?? '',
  };
}

/** Aggregates parsed events into per-name, per-type, and ledger-span totals. */
export function summarizeEvents(events: ParsedContractEvent[]): ContractEventsSummary {
  if (events.length === 0) {
    return {
      eventCount: 0,
      countsByName: {},
      countsByType: {},
      contractIds: [],
      firstLedger: null,
      lastLedger: null,
      transactionCount: 0,
      failedCallEventCount: 0,
    };
  }

  const countsByName: Record<string, number> = {};
  const countsByType: Record<string, number> = {};
  const contractIds = new Set<string>();
  const transactions = new Set<string>();
  let firstLedger = Number.POSITIVE_INFINITY;
  let lastLedger = Number.NEGATIVE_INFINITY;
  let failedCallEventCount = 0;

  for (const event of events) {
    const name = event.eventName ?? '(unnamed)';
    countsByName[name] = (countsByName[name] ?? 0) + 1;
    countsByType[event.type] = (countsByType[event.type] ?? 0) + 1;

    if (event.contractId) {
      contractIds.add(event.contractId);
    }
    if (event.txHash) {
      transactions.add(event.txHash);
    }
    if (event.ledger > 0) {
      firstLedger = Math.min(firstLedger, event.ledger);
      lastLedger = Math.max(lastLedger, event.ledger);
    }
    if (!event.inSuccessfulContractCall) {
      failedCallEventCount += 1;
    }
  }

  return {
    eventCount: events.length,
    countsByName,
    countsByType,
    contractIds: Array.from(contractIds),
    firstLedger: Number.isFinite(firstLedger) ? firstLedger : null,
    lastLedger: Number.isFinite(lastLedger) ? lastLedger : null,
    transactionCount: transactions.size,
    failedCallEventCount,
  };
}

/**
 * Clamps a requested result limit into a readable range.
 *
 * RPC accepts far larger limits, but this example prints every event in full,
 * so the cap keeps the output usable.
 */
export function normalizeLimit(value?: number | string): number {
  const parsed = typeof value === 'string' ? parseInt(value.trim(), 10) : value;

  if (parsed === undefined || parsed === null || Number.isNaN(parsed)) {
    return DEFAULT_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_LIMIT);
}

/** Parses an optional ledger sequence, returning undefined for absent input. */
export function parseLedgerInput(value?: number | string): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const parsed = typeof value === 'string' ? parseInt(value.trim(), 10) : value;
  if (Number.isNaN(parsed) || parsed < 1) {
    return undefined;
  }

  return Math.trunc(parsed);
}

/**
 * Resolves the ledger window to query.
 *
 * `getEvents` requires either a `startLedger` or a pagination cursor, so a
 * start is always produced: an explicit one when supplied, otherwise
 * `latestLedger - lookback`. Both bounds are clamped into `[1, latestLedger]`,
 * and a start above the end is pulled back rather than sent as an empty range
 * the server would reject.
 */
export function resolveLedgerRange(
  latestLedger: number,
  options: { startLedger?: number; endLedger?: number; lookback?: number } = {},
): LedgerRange {
  const lookback = options.lookback ?? DEFAULT_LEDGER_LOOKBACK;
  const safeLatest = Math.max(1, Math.trunc(latestLedger));

  const endLedger =
    options.endLedger === undefined
      ? undefined
      : Math.min(Math.max(1, Math.trunc(options.endLedger)), safeLatest);

  const upperBound = endLedger ?? safeLatest;

  const requestedStart = options.startLedger ?? Math.max(1, safeLatest - lookback);
  const startLedger = Math.min(Math.max(1, Math.trunc(requestedStart)), upperBound);

  return endLedger === undefined ? { startLedger } : { startLedger, endLedger };
}

/**
 * Detects a rejection caused by querying outside the retention window.
 *
 * RPC instances keep only a rolling window of event history and answer a start
 * ledger below it with an error rather than an empty page. That is a retryable
 * condition — the same query over a narrower window usually succeeds — so it
 * has to be told apart from genuine failures.
 */
export function isLedgerRangeError(error: any): boolean {
  const message = String(error?.message ?? error ?? '').toLowerCase();
  return (
    message.includes('ledger range') ||
    message.includes('oldest ledger') ||
    message.includes('startledger must') ||
    message.includes('start is before') ||
    message.includes('not within the ledger range')
  );
}

/**
 * Pulls the supported ledger window out of an RPC range error.
 *
 * The server states its retained range in the error text, which lets the
 * example retry with a window that is known to be valid instead of guessing.
 * Message wording varies between RPC versions, so a failed parse is normal and
 * falls back to the fixed lookback ladder.
 */
export function extractValidLedgerRange(message: string): LedgerRange | null {
  const rangeMatch = message.match(/ledger range:?\s*(\d+)\s*(?:-|–|to)\s*(\d+)/i);
  if (rangeMatch) {
    return { startLedger: parseInt(rangeMatch[1], 10), endLedger: parseInt(rangeMatch[2], 10) };
  }

  const oldestMatch = message.match(/oldest ledger[^0-9]*(\d+)/i);
  if (oldestMatch) {
    return { startLedger: parseInt(oldestMatch[1], 10) };
  }

  return null;
}

/**
 * Detects an RPC that does not understand the `endLedger` bound.
 *
 * `endLedger` was added after `getEvents` shipped, so instances running older
 * builds reject it. The caller retries without the upper bound and trims the
 * range client-side instead.
 */
export function isEndLedgerUnsupportedError(error: any): boolean {
  const message = String(error?.message ?? error ?? '').toLowerCase();
  return message.includes('endledger') || message.includes('end ledger');
}

/** Keeps only the events that fall inside an explicitly requested range. */
export function filterEventsByLedgerRange(
  events: ParsedContractEvent[],
  range: LedgerRange,
): ParsedContractEvent[] {
  return events.filter(
    (event) =>
      event.ledger >= range.startLedger &&
      (range.endLedger === undefined || event.ledger <= range.endLedger),
  );
}

/** Formats one decoded topic as `[i] scvSymbol "transfer"`. */
function formatTopicLine(topic: DecodedScVal, index: number): string {
  return `        [${index}] ${topic.xdrType.padEnd(12)} ${renderDecodedValue(topic)}`;
}

/** Renders the event listing and summary as a console-ready string. */
export function formatContractEventsReport(
  contractId: string,
  range: LedgerRange,
  events: ParsedContractEvent[],
  summary: ContractEventsSummary,
  context: { latestLedger: number; eventType: string; limit: number; cursor?: string } = {
    latestLedger: 0,
    eventType: 'contract',
    limit: DEFAULT_LIMIT,
  },
): string {
  const lines: string[] = [];

  lines.push('=== Soroban Contract Events ===');
  lines.push(`Contract:     ${contractId || '(all contracts)'}`);
  lines.push(`Event Type:   ${context.eventType}`);
  lines.push(
    `Ledger Range: ${range.startLedger} -> ${range.endLedger ?? 'latest'}` +
      (context.latestLedger ? ` (network latest: ${context.latestLedger})` : ''),
  );
  lines.push(`Result Limit: ${context.limit}`);

  if (events.length === 0) {
    lines.push('');
    lines.push('No events found for this contract in the queried ledger range.');
    lines.push('');
    lines.push('This is a valid, empty result rather than an error. It usually means:');
    lines.push('  - the contract has not been invoked within the queried ledgers, or');
    lines.push('  - the contract was invoked but its code emits no events, or');
    lines.push('  - the activity is older than the ledger range requested, or');
    lines.push('  - the activity is older than the RPC event retention window, in which');
    lines.push('    case no ledger range can recover it from this server.');
    lines.push('');
    lines.push('Unlike Horizon, Soroban RPC cannot be paged backwards through full history.');
    lines.push('Events outside the retention window must have been ingested as they happened.');
    return lines.join('\n');
  }

  lines.push('');
  lines.push(`Events Retrieved: ${events.length}`);
  lines.push('');
  lines.push('Event Records (oldest first):');

  events.forEach((event, index) => {
    lines.push('');
    lines.push(`  [${index + 1}] ${event.eventName ?? '(unnamed event)'}  —  ${event.type} event`);
    lines.push(`      Ledger:       ${event.ledger} (closed ${event.ledgerClosedAt})`);
    lines.push(`      Tx Hash:      ${event.txHash}`);
    lines.push(`      Contract:     ${event.contractId || '(unavailable)'}`);
    lines.push(`      Event ID:     ${event.id}`);

    if (event.topics.length === 0) {
      lines.push('      Topics:       (none)');
    } else {
      lines.push(`      Topics:       ${event.topics.length} indexed value(s)`);
      event.topics.forEach((topic, topicIndex) => {
        lines.push(formatTopicLine(topic, topicIndex));
      });
    }

    lines.push(`      Data:         ${event.value.xdrType}`);
    // The payload is often a map or vector, so print it expanded rather than
    // truncating a structure the reader would need to inspect field by field.
    const rendered = renderDecodedValue(event.value);
    const pretty =
      event.value.decoded && event.value.value !== null && typeof event.value.value === 'object'
        ? JSON.stringify(event.value.value, null, 2)
            .split('\n')
            .map((line) => `        ${line}`)
            .join('\n')
        : `        ${rendered}`;
    lines.push(pretty);

    if (!event.inSuccessfulContractCall) {
      lines.push('      NOTE:         emitted by a sub-call that failed; ignore for state.');
    }
  });

  lines.push('');
  lines.push('Event Summary:');
  lines.push(`  Events:        ${summary.eventCount}`);
  lines.push(`  Transactions:  ${summary.transactionCount}`);
  lines.push(`  Ledger Span:   ${summary.firstLedger} -> ${summary.lastLedger}`);
  lines.push(`  Contracts:     ${summary.contractIds.length}`);

  const nameEntries = Object.entries(summary.countsByName).sort((a, b) => b[1] - a[1]);
  if (nameEntries.length > 0) {
    lines.push('  By Event Name:');
    for (const [name, count] of nameEntries) {
      lines.push(`    ${name.padEnd(24)} ${count}`);
    }
  }

  const typeEntries = Object.entries(summary.countsByType).sort((a, b) => b[1] - a[1]);
  if (typeEntries.length > 0) {
    lines.push('  By Event Type:');
    for (const [type, count] of typeEntries) {
      lines.push(`    ${type.padEnd(24)} ${count}`);
    }
  }

  if (summary.failedCallEventCount > 0) {
    lines.push(
      `  Failed-call events: ${summary.failedCallEventCount} (emitted, then the sub-call reverted)`,
    );
  }

  if (context.cursor) {
    lines.push('');
    lines.push(`Next page cursor: ${context.cursor}`);
    lines.push('Pass it as `cursor` (instead of `startLedger`) to continue from here.');
  }

  return lines.join('\n');
}

/**
 * Queries events, narrowing the ledger range until the server accepts it.
 *
 * Two failures are handled rather than surfaced. A range error means the window
 * predates the server's retention; the request is retried against the range the
 * error advertises, then against progressively shorter lookbacks. An
 * `endLedger` rejection means the server predates that parameter; the bound is
 * dropped and applied client-side by the caller instead.
 *
 * Every candidate window is clamped to `[1, endLedger]`, so a requested
 * `endLedger` that itself predates the retention window makes the ladder
 * collapse onto a single unusable range. Already-attempted ranges are therefore
 * tracked and skipped: without that guard the retry loop would reissue the same
 * failing request forever.
 */
export async function queryContractEvents(
  server: rpc.Server,
  options: {
    latestLedger: number;
    range: LedgerRange;
    filters: rpc.Api.EventFilter[];
    limit: number;
  },
): Promise<{ response: rpc.Api.GetEventsResponse; range: LedgerRange; endLedgerApplied: boolean }> {
  let range = options.range;
  let endLedgerApplied = range.endLedger !== undefined;
  let lastError: any;

  const attempts: LedgerRange[] = [range];
  const tried = new Set<string>();
  const rangeKey = (candidate: LedgerRange): string =>
    `${candidate.startLedger}-${candidate.endLedger ?? 'latest'}`;

  /** Queues a candidate window unless an identical one was already tried. */
  const queue = (candidate: LedgerRange): boolean => {
    if (tried.has(rangeKey(candidate))) {
      return false;
    }
    attempts.push(candidate);
    return true;
  };

  for (let attempt = 0; attempt < attempts.length; attempt += 1) {
    range = attempts[attempt];
    tried.add(rangeKey(range));

    try {
      const response = await server.getEvents({
        startLedger: range.startLedger,
        ...(endLedgerApplied && range.endLedger !== undefined
          ? { endLedger: range.endLedger }
          : {}),
        filters: options.filters,
        limit: options.limit,
      });

      return { response, range, endLedgerApplied };
    } catch (error: any) {
      lastError = error;

      if (isEndLedgerUnsupportedError(error) && endLedgerApplied) {
        // Retry the same window without the upper bound; the caller trims it.
        // This fires at most once, since `endLedgerApplied` never goes back to
        // true, so re-queuing an already-tried range is safe here.
        endLedgerApplied = false;
        attempts.push(range);
        continue;
      }

      if (!isLedgerRangeError(error)) {
        throw error;
      }

      // Prefer the window the server named in its error over a blind retry.
      const advertised = extractValidLedgerRange(String(error?.message ?? ''));
      if (
        advertised &&
        attempt === 0 &&
        queue(
          resolveLedgerRange(options.latestLedger, {
            startLedger: advertised.startLedger,
            endLedger: range.endLedger,
          }),
        )
      ) {
        continue;
      }

      // Walk the ladder until a lookback yields a window not yet attempted. A
      // clamped `endLedger` can make several lookbacks collapse onto the same
      // range, so a single candidate is not enough to guarantee progress.
      const progressed = FALLBACK_LOOKBACKS.filter(
        (lookback) => options.latestLedger - lookback > range.startLedger,
      ).some((lookback) =>
        queue(
          resolveLedgerRange(options.latestLedger, {
            lookback,
            endLedger: range.endLedger,
          }),
        ),
      );

      if (!progressed) {
        break;
      }
    }
  }

  throw lastError ?? new Error('Unable to query contract events.');
}

/**
 * Finds a contract that has emitted events recently.
 *
 * Contract IDs are network- and deployment-specific, so hardcoding one would
 * leave the example printing "no events" for most users. Scanning unfiltered
 * contract events and picking the busiest emitter keeps the example runnable
 * with no setup, in the same spirit as the asset-pair discovery in
 * `55-trade-history`.
 */
export function pickMostActiveContract(events: ParsedContractEvent[]): string | null {
  const counts = new Map<string, number>();

  for (const event of events) {
    if (!event.contractId) {
      continue;
    }
    counts.set(event.contractId, (counts.get(event.contractId) ?? 0) + 1);
  }

  let best: string | null = null;
  let bestCount = 0;
  for (const [contractId, count] of counts.entries()) {
    if (count > bestCount) {
      best = contractId;
      bestCount = count;
    }
  }

  return best;
}

async function discoverActiveContract(
  server: rpc.Server,
  latestLedger: number,
  range: LedgerRange,
): Promise<string | null> {
  try {
    const { response } = await queryContractEvents(server, {
      latestLedger,
      range,
      filters: [{ type: 'contract' }],
      limit: DISCOVERY_LIMIT,
    });

    return pickMostActiveContract((response.events ?? []).map(parseEventRecord));
  } catch {
    return null;
  }
}

/** Validates the event type filter, defaulting to contract-published events. */
export function normalizeEventType(value?: string): rpc.Api.EventType {
  const normalized = (value ?? '').trim().toLowerCase();

  if (normalized === 'system' || normalized === 'diagnostic') {
    return normalized;
  }

  return 'contract';
}

/**
 * Runs the Soroban contract events example.
 *
 * Inputs can come from the runner prompts, the `CONTRACT_ID`,
 * `START_LEDGER`, `END_LEDGER`, `EVENT_LIMIT`, `EVENT_TYPE`, and
 * `SOROBAN_RPC_URL` environment variables, or CLI arguments:
 *
 *   npm run run-example -- 67-soroban-contract-events <contractId> <start> <end> <limit>
 *
 * With no contract ID, the example discovers a recently active contract so it
 * stays runnable without any setup.
 */
export async function run(params: ContractEventsParams = {}): Promise<void> {
  const rpcUrl = params.rpcUrl || process.env.SOROBAN_RPC_URL || DEFAULT_RPC_URL;
  const server = new rpc.Server(rpcUrl);

  const contractInput =
    params.contractId?.trim() || process.env.CONTRACT_ID?.trim() || process.argv[3]?.trim();
  const startInput = parseLedgerInput(
    params.startLedger ?? process.env.START_LEDGER ?? process.argv[4],
  );
  const endInput = parseLedgerInput(params.endLedger ?? process.env.END_LEDGER ?? process.argv[5]);
  const limit = normalizeLimit(params.limit ?? process.env.EVENT_LIMIT ?? process.argv[6]);
  const eventType = normalizeEventType(params.eventType ?? process.env.EVENT_TYPE);

  console.log('Starting Soroban Contract Events Example...');
  console.log(`Using Soroban RPC: ${rpcUrl}`);
  console.log('Contract events are application-defined and read from transaction meta,');
  console.log('not from ledger state as Horizon operations and effects are.');

  let latestLedger: number;
  try {
    const latest = await server.getLatestLedger();
    latestLedger = latest.sequence;
    console.log(`\nLatest ledger: ${latestLedger}`);
  } catch (error: any) {
    console.log(`\nCould not reach the Soroban RPC server: ${error?.message || error}`);
    console.log('Check SOROBAN_RPC_URL, or try https://soroban-testnet.stellar.org.');
    return;
  }

  const requestedRange = resolveLedgerRange(latestLedger, {
    startLedger: startInput,
    endLedger: endInput,
  });

  if (startInput !== undefined || endInput !== undefined) {
    console.log(
      `Ledger range filter: ${requestedRange.startLedger} -> ${requestedRange.endLedger ?? 'latest'}`,
    );
  } else {
    console.log(
      `No ledger range supplied; scanning the last ${DEFAULT_LEDGER_LOOKBACK} ledgers (~24h).`,
    );
  }

  let contractId = '';
  if (contractInput) {
    try {
      contractId = normalizeContractId(contractInput);
    } catch (error: any) {
      console.log(`\n${error?.message || error}`);
      console.log('\nExpected format (a 56-character contract strkey):');
      console.log('  CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC');
      return;
    }
    console.log(`\nContract: ${contractId}`);
  } else {
    console.log('\nNo contract ID supplied. Looking for a recently active contract...');

    const discovered = await discoverActiveContract(server, latestLedger, requestedRange);
    if (!discovered) {
      console.log('Could not find any contract events in the queried range on this network.');
      console.log('Supply a contract ID explicitly, for example:');
      console.log('  npm run run-example -- 67-soroban-contract-events C...');
      console.log('\nDeploy one first with example 13-soroban-deploy, then invoke it with');
      console.log('example 05-soroban-invoke to generate events this example can read.');
      return;
    }

    contractId = discovered;
    console.log(`Discovered active contract: ${contractId}`);
  }

  let events: ParsedContractEvent[] = [];
  let effectiveRange = requestedRange;
  let cursor: string | undefined;

  try {
    const result = await queryContractEvents(server, {
      latestLedger,
      range: requestedRange,
      filters: [{ type: eventType, contractIds: [contractId] }],
      limit,
    });

    effectiveRange = result.range;
    cursor = result.response.cursor;
    events = (result.response.events ?? []).map(parseEventRecord);

    if (!result.endLedgerApplied && requestedRange.endLedger !== undefined) {
      // The server ignored or rejected the upper bound, so enforce it here to
      // keep the reported range honest.
      console.log('\nThis RPC server does not support `endLedger`; filtering the range locally.');
      events = filterEventsByLedgerRange(events, requestedRange);
      effectiveRange = requestedRange;
    }

    if (result.range.startLedger !== requestedRange.startLedger) {
      console.log(
        `\nRequested range predates this server's retention window; narrowed to start at ledger ${result.range.startLedger}.`,
      );
    }
  } catch (error: any) {
    if (isLedgerRangeError(error)) {
      console.log("\nThe requested ledger range is outside this server's retention window.");
      console.log('Soroban RPC keeps only a rolling window of event history (commonly ~24h).');
      console.log('Retry with a more recent startLedger, or use an RPC with longer retention.');
      return;
    }

    console.log(`\nCould not retrieve contract events: ${error?.message || error}`);
    return;
  }

  const summary = summarizeEvents(events);

  console.log(
    '\n' +
      formatContractEventsReport(contractId, effectiveRange, events, summary, {
        latestLedger,
        eventType,
        limit,
        cursor: events.length > 0 ? cursor : undefined,
      }),
  );

  console.log('\nHow this differs from Horizon:');
  console.log('  - Horizon effects describe protocol-defined changes to classic ledger state;');
  console.log('    contract events describe whatever the contract author chose to publish.');
  console.log('  - Horizon retains full history and pages backwards with durable cursors;');
  console.log('    RPC retains a rolling window, so contract events must be ingested live.');
  console.log('  - Topics are indexed and filterable server-side; the data payload is not.');
  console.log('\nSoroban contract events example completed successfully.');
}
