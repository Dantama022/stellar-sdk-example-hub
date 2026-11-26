/**
 * event-query.ts
 *
 * Responsible for querying Soroban contract events from an RPC server.
 * Handles ledger range validation, pagination, retry on range errors,
 * and de-duplication of returned event records.
 */

import { rpc, StrKey } from '@stellar/stellar-sdk';

/** Minimum number of events allowed per page. */
const MIN_LIMIT = 1;
/** Maximum number of events the RPC server accepts per page. */
const MAX_LIMIT = 200;
/** Default lookback in ledgers (~24 h on Testnet at 5-second close time). */
const DEFAULT_LOOKBACK = 17280;

// ─── types ───────────────────────────────────────────────────────────────────

/** Ledger sequence bounds for an event query. */
export interface LedgerRange {
  startLedger: number;
  endLedger?: number;
}

/** One entry in the filters array accepted by the RPC server. */
export interface EventFilter {
  type: 'contract' | 'system' | 'diagnostic';
  contractIds?: string[];
  topics?: string[][];
}

/** Parameters passed to `queryContractEvents`. */
export interface EventQueryParams {
  /** Latest ledger sequence number, used to clamp ranges. */
  latestLedger: number;
  range: LedgerRange;
  filters: EventFilter[];
  limit: number;
  /** Pagination cursor from a previous response. */
  cursor?: string;
}

/** Wrapper around the raw RPC response from getEvents. */
export interface RawEventsResponse {
  events: RawEventRecord[] | null;
  latestLedger: number;
  cursor: string;
}

/** Subset of an RPC event record that this example relies on. */
export interface RawEventRecord {
  id: string;
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  contractId?: string;
  topic: import('@stellar/stellar-sdk').xdr.ScVal[];
  value: import('@stellar/stellar-sdk').xdr.ScVal;
  inSuccessfulContractCall?: boolean;
  pagingToken: string;
}

/** Full result returned by `queryContractEvents`. */
export interface EventQueryResult {
  response: RawEventsResponse;
  range: LedgerRange;
  /** True when the server accepted and applied the endLedger filter. */
  endLedgerApplied: boolean;
}

// ─── parameter validation ────────────────────────────────────────────────────

/**
 * Accepts a contract address string (or trimmed whitespace), validates that it
 * is a well-formed contract strkey, and returns the normalised form.
 *
 * @throws if the input is blank or not a valid contract address.
 */
export function normalizeContractId(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Missing contract ID. Provide a Stellar contract strkey starting with "C".');
  }
  if (!StrKey.isValidContract(trimmed)) {
    throw new Error(
      `Invalid contract ID "${trimmed}". Expected a Stellar contract strkey starting with "C".`,
    );
  }
  return trimmed;
}

/**
 * Parses a ledger sequence value from either a number or a string.
 * Returns `undefined` for blank strings, NaN, or non-positive values.
 */
export function parseLedgerInput(value?: number | string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'string' ? parseInt(value.trim(), 10) : value;
  if (Number.isNaN(parsed) || parsed < 1) return undefined;
  return Math.trunc(parsed);
}

/**
 * Clamps an event-page limit into the range [MIN_LIMIT, MAX_LIMIT].
 * Non-numeric inputs fall back to 10.
 */
export function normalizeLimit(value?: number | string): number {
  const parsed = typeof value === 'string' ? parseInt(value.trim(), 10) : value;
  if (parsed === undefined || Number.isNaN(parsed)) return 10;
  return Math.min(Math.max(Math.trunc(parsed), MIN_LIMIT), MAX_LIMIT);
}

/**
 * Accepts one of the three RPC event types (case-insensitive).
 * Unknown values fall back to 'contract'.
 */
export function normalizeEventType(
  value?: string,
): 'contract' | 'system' | 'diagnostic' {
  const lower = (value ?? '').toLowerCase();
  if (lower === 'system' || lower === 'diagnostic') {
    return lower;
  }
  return 'contract';
}

// ─── ledger range helpers ─────────────────────────────────────────────────────

/**
 * Resolves a ledger range, clamping values into the valid ledger space.
 *
 * Rules applied:
 * - startLedger defaults to `latestLedger - DEFAULT_LOOKBACK` (min 1).
 * - endLedger beyond the latest ledger is clamped to latestLedger.
 * - endLedger below startLedger is raised to startLedger.
 */
export function resolveLedgerRange(
  latestLedger: number,
  hint?: Partial<LedgerRange>,
): LedgerRange {
  const defaultStart = Math.max(1, latestLedger - DEFAULT_LOOKBACK);
  let start = hint?.startLedger ?? defaultStart;
  start = Math.max(1, start);

  if (hint?.endLedger !== undefined) {
    let end = hint.endLedger;
    if (end > latestLedger) end = latestLedger;
    if (end < start) end = start;
    return { startLedger: start, endLedger: end };
  }
  return { startLedger: start };
}

/**
 * Filters a parsed-event array client-side to those whose ledger falls within
 * the given range. Useful when the server ignores `endLedger`.
 */
export function filterEventsByLedgerRange<T extends { ledger: number }>(
  events: T[],
  range: LedgerRange,
): T[] {
  return events.filter((e) => {
    if (e.ledger < range.startLedger) return false;
    if (range.endLedger !== undefined && e.ledger > range.endLedger) return false;
    return true;
  });
}

/** Returns true when the error message indicates a ledger-range rejection. */
export function isLedgerRangeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes('startledger') ||
    msg.includes('ledger range') ||
    msg.includes('oldest ledger') ||
    msg.includes('start is before')
  );
}

/** Returns true when the error message indicates the server rejects endLedger. */
export function isEndLedgerUnsupportedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return msg.includes('endledger') || msg.includes('no such field');
}

/**
 * Extracts a valid ledger range from a server error message.
 * Returns null when no range can be parsed.
 *
 * Example messages:
 *   "startLedger must be within the ledger range: 500 - 1000"
 *   "oldest ledger is 4242"
 */
export function extractValidLedgerRange(message: string): LedgerRange | null {
  // "ledger range: NNN - NNN"
  const rangeMatch = message.match(/ledger range[:\s]+(\d+)\s*[-–]\s*(\d+)/i);
  if (rangeMatch) {
    return {
      startLedger: parseInt(rangeMatch[1], 10),
      endLedger: parseInt(rangeMatch[2], 10),
    };
  }
  // "oldest ledger is NNN", "oldest ledger: NNN"
  const oldestMatch = message.match(/oldest ledger(?:\s+is)?[:\s]+(\d+)/i);
  if (oldestMatch) {
    return { startLedger: parseInt(oldestMatch[1], 10) };
  }
  return null;
}

// ─── de-duplication ──────────────────────────────────────────────────────────

/**
 * Removes duplicate event records by their `id` field.
 * The first occurrence wins; subsequent duplicates are discarded.
 */
export function deduplicateEvents(events: RawEventRecord[]): RawEventRecord[] {
  const seen = new Set<string>();
  const result: RawEventRecord[] = [];
  for (const event of events) {
    if (!seen.has(event.id)) {
      seen.add(event.id);
      result.push(event);
    }
  }
  return result;
}

// ─── RPC interface (minimal surface) ─────────────────────────────────────────

/**
 * Minimal interface covering only the `getEvents` method used here.
 * The real `rpc.Server` satisfies this interface.
 */
export interface SorobanRpcServer {
  getEvents(request: rpc.Server.GetEventsRequest): Promise<rpc.Api.GetEventsResponse>;
}

// ─── core query ───────────────────────────────────────────────────────────────

/**
 * Queries Soroban contract events from an RPC server.
 *
 * Retry behaviour:
 * - If the server rejects `endLedger`, the request is retried without it and
 *   `endLedgerApplied` is set to false.
 * - If the server rejects the start ledger as too old, the range is narrowed
 *   to the server's advertised minimum and retried once. A second consecutive
 *   range error is re-thrown.
 *
 * De-duplication:
 * - Duplicate event IDs within a single page are silently removed.
 */
export async function queryContractEvents(
  server: SorobanRpcServer,
  params: EventQueryParams,
): Promise<EventQueryResult> {
  let range: LedgerRange = { ...params.range };
  let endLedgerApplied = true;
  const triedRanges = new Set<string>();

  const rangeKey = (r: LedgerRange, end: boolean): string =>
    `${r.startLedger}-${r.endLedger ?? ''}${end ? '+end' : ''}`;

  const buildRequest = (r: LedgerRange, includeEnd: boolean): rpc.Server.GetEventsRequest => {
    const req: rpc.Server.GetEventsRequest = {
      startLedger: r.startLedger,
      filters: params.filters as rpc.Api.EventFilter[],
      limit: params.limit,
    };
    if (includeEnd && r.endLedger !== undefined) {
      // The SDK type does not expose endLedger yet; cast to reach it.
      (req as unknown as Record<string, unknown>)['endLedger'] = r.endLedger;
    }
    if (params.cursor) {
      req.cursor = params.cursor;
    }
    return req;
  };

  // Track whether we still want to send endLedger.
  let sendEnd = true;

  for (let attempt = 0; attempt < 10; attempt++) {
    const key = rangeKey(range, sendEnd);
    if (triedRanges.has(key)) {
      throw new Error(
        `RPC rejected ledger range (start: ${range.startLedger}${range.endLedger !== undefined ? `, end: ${range.endLedger}` : ''}). ` +
          'The requested range may be outside the network retention window.',
      );
    }
    triedRanges.add(key);

    try {
      const request = buildRequest(range, sendEnd);
      const response = await server.getEvents(request);

      // Map the SDK response onto our simpler RawEventsResponse shape.
      const rawEvents = (response.events ?? null) as unknown as RawEventRecord[] | null;
      const raw: RawEventsResponse = {
        events: rawEvents,
        latestLedger: response.latestLedger,
        cursor: response.cursor ?? '',
      };

      return {
        response: {
          ...raw,
          events: raw.events ? deduplicateEvents(raw.events) : null,
        },
        range,
        endLedgerApplied,
      };
    } catch (err) {
      if (isEndLedgerUnsupportedError(err) && sendEnd) {
        // Retry without endLedger.
        sendEnd = false;
        endLedgerApplied = false;
        continue;
      }

      if (isLedgerRangeError(err)) {
        const serverRange = extractValidLedgerRange((err as Error).message);
        if (!serverRange) throw err;

        const newStart = serverRange.startLedger;
        const newEnd =
          range.endLedger !== undefined && serverRange.endLedger !== undefined
            ? Math.min(range.endLedger, serverRange.endLedger)
            : serverRange.endLedger ?? range.endLedger;

        // Guard against an end that is now below the new start.
        const clampedEnd =
          newEnd !== undefined && newEnd < newStart ? newStart : newEnd;

        range = { startLedger: newStart, endLedger: clampedEnd };
        continue;
      }

      throw err;
    }
  }

  throw new Error('queryContractEvents: exhausted retry budget without a successful response.');
}
