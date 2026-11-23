/**
 * 263 — Soroban contract event replay and checkpoint recovery (issue #599).
 *
 * Replays a contract's events from Stellar RPC `getEvents`, processes them in a
 * deterministic order, and keeps a checkpoint so processing resumes after a
 * restart, RPC failure or handler crash.
 *
 * Delivery model: retrieval is at-least-once. A crash after a handler ran but
 * before the checkpoint was saved replays that event, so handlers must be
 * idempotent (e.g. upsert keyed by event id). The checkpoint plus an id set
 * removes duplicates the RPC returns on overlapping queries, but this example
 * never claims exactly-once processing.
 *
 * Checkpoint = last ledger reached + ids already processed in that ledger.
 * Resuming re-queries from that ledger (inclusive) and skips those ids, so a
 * crash in the middle of a ledger neither loses nor repeats events.
 *
 * RPC keeps a limited event history. Ranges older than the server's oldest
 * ledger are reported as unrecoverable instead of being skipped silently.
 *
 * Retrieval, deduplication, processing and checkpoint storage are separate:
 * `EventSource` and `CheckpointStore` are interfaces, so tests use mocks and
 * production code can use a database.
 */
import { promises as fs } from 'fs';
import dotenv from 'dotenv';
import { rpc, StrKey, xdr, scValToNative } from '@stellar/stellar-sdk';
import { resolveNetworkConfiguration } from './60-network-configuration';

// ── Types ────────────────────────────────────────────────────────────────────

export class ReplayError extends Error {}

export interface EventQuery {
  filters: rpc.Api.EventFilter[];
  startLedger?: number;
  endLedger?: number;
  cursor?: string;
  limit: number;
}

export interface EventPage {
  events: rpc.Api.EventResponse[];
  cursor?: string;
  latestLedger: number;
}

/** Event retrieval. `rpcEventSource` adapts `rpc.Server`; tests supply a mock. */
export interface EventSource {
  getEvents(query: EventQuery): Promise<EventPage>;
  /** Oldest/latest ledger the server can answer for, when it reports them. */
  getRetention(): Promise<{ oldestLedger?: number; latestLedger?: number }>;
}

export interface Checkpoint {
  version: 1;
  /** Identifies what was being replayed; a checkpoint is only reused for the same scope. */
  scope: string;
  lastLedger: number;
  /** Ids already processed in `lastLedger`. */
  processedIds: string[];
}

/** Checkpoint persistence. Swap `FileCheckpointStore` for a database in production. */
export interface CheckpointStore {
  load(): Promise<Checkpoint | null>;
  save(checkpoint: Checkpoint): Promise<void>;
}

export interface ReplayOptions {
  contractId: string;
  /** Topic filter segments: an ScSymbol or '*' per position, e.g. ['transfer', '*', '*']. */
  topics?: string[];
  startLedger: number;
  endLedger?: number;
  source: EventSource;
  store: CheckpointStore;
  handler: (event: rpc.Api.EventResponse) => Promise<void>;
  /** Endpoint label for the report; credentials are stripped. */
  endpoint?: string;
  pageLimit?: number;
  maxPages?: number;
  maxRetries?: number;
  /** Continue from the oldest available ledger when history is missing (reported either way). */
  skipUnavailableHistory?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

export type ReplayStatus = 'completed' | 'page-budget-reached' | 'unrecoverable-gap' | 'failed';

export interface ReplayReport {
  contractId: string;
  endpoint: string;
  requestedRange: { startLedger: number; endLedger: number | null };
  resumedFrom: number;
  retrieved: number;
  processed: number;
  duplicates: number;
  outOfOrder: number;
  lastProcessedLedger: number | null;
  savedCheckpoint: { lastLedger: number; processedIds: number } | null;
  retries: number;
  unrecoverableRanges: Array<{ fromLedger: number; toLedger: number }>;
  status: ReplayStatus;
  error?: string;
}

// ── Filters and validation ───────────────────────────────────────────────────

export function buildEventFilter(contractId: string, topics?: string[]): rpc.Api.EventFilter {
  if (!StrKey.isValidContract(contractId))
    throw new ReplayError('Expected a valid C... contract id');
  if (!topics?.length) return { type: 'contract', contractIds: [contractId] };
  const segments = topics.map((segment) => {
    if (segment === '*') return '*';
    if (!/^[a-zA-Z0-9_]{1,32}$/.test(segment))
      throw new ReplayError(`Topic "${segment}" is not an ScSymbol or '*'`);
    return xdr.ScVal.scvSymbol(segment).toXDR('base64');
  });
  return { type: 'contract', contractIds: [contractId], topics: [segments] };
}

function assertLedger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new ReplayError(`${name} must be a positive integer`);
}

function validateEvent(event: rpc.Api.EventResponse): void {
  if (
    !event ||
    typeof event.id !== 'string' ||
    !event.id ||
    !Number.isSafeInteger(event.ledger) ||
    event.ledger <= 0
  ) {
    throw new ReplayError('Malformed event in RPC response (missing id or ledger)');
  }
}

/** Ledger first, then the RPC's sortable event id (ledger/tx/op/event order). */
function compareEvents(a: rpc.Api.EventResponse, b: rpc.Api.EventResponse): number {
  return a.ledger - b.ledger || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function isTransient(error: unknown): boolean {
  const e = error as { response?: { status?: number }; code?: string; message?: string };
  const status = e?.response?.status;
  return (
    status === 429 ||
    (status !== undefined && status >= 500) ||
    /timeout|timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(
      `${e?.code} ${e?.message}`,
    )
  );
}

/** RPC rejects an out-of-retention start with "... between the oldest ledger: X and ...". */
function oldestLedgerFromError(error: unknown): number | undefined {
  const match = /oldest ledger:?\s*(\d+)/i.exec(String((error as Error)?.message ?? error));
  return match ? Number(match[1]) : undefined;
}

export function endpointLabel(url: string | undefined): string {
  if (!url) return 'custom event source';
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return 'unparseable endpoint';
  }
}

// ── Replay ───────────────────────────────────────────────────────────────────

export async function replayEvents(options: ReplayOptions): Promise<ReplayReport> {
  const filter = buildEventFilter(options.contractId, options.topics);
  assertLedger(options.startLedger, 'startLedger');
  if (options.endLedger !== undefined) {
    assertLedger(options.endLedger, 'endLedger');
    if (options.endLedger < options.startLedger)
      throw new ReplayError('endLedger is before startLedger');
  }
  const pageLimit = options.pageLimit ?? 100;
  const maxPages = options.maxPages ?? 100;
  const maxRetries = options.maxRetries ?? 3;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const scope = JSON.stringify([
    'soroban-events',
    options.contractId,
    options.topics ?? [],
    options.startLedger,
    options.endLedger ?? null,
  ]);

  const report: ReplayReport = {
    contractId: options.contractId,
    endpoint: endpointLabel(options.endpoint),
    requestedRange: { startLedger: options.startLedger, endLedger: options.endLedger ?? null },
    resumedFrom: options.startLedger,
    retrieved: 0,
    processed: 0,
    duplicates: 0,
    outOfOrder: 0,
    lastProcessedLedger: null,
    savedCheckpoint: null,
    retries: 0,
    unrecoverableRanges: [],
    status: 'completed',
  };

  // Restore and validate the checkpoint.
  const saved = await options.store.load();
  if (saved) {
    if (
      saved.version !== 1 ||
      saved.scope !== scope ||
      !Number.isSafeInteger(saved.lastLedger) ||
      !Array.isArray(saved.processedIds)
    ) {
      throw new ReplayError(
        'Checkpoint does not match this replay (version, scope or shape); inspect it or remove it to restart',
      );
    }
    if (saved.lastLedger < options.startLedger)
      throw new ReplayError('Checkpoint is before the requested startLedger');
    report.savedCheckpoint = {
      lastLedger: saved.lastLedger,
      processedIds: saved.processedIds.length,
    };
  }
  let progress: Checkpoint = saved ?? {
    version: 1,
    scope,
    lastLedger: options.startLedger,
    processedIds: [],
  };
  report.resumedFrom = progress.lastLedger;
  if (saved) report.lastProcessedLedger = saved.lastLedger;

  const withRetry = async <T>(read: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await read();
      } catch (error) {
        if (!isTransient(error) || attempt >= maxRetries) throw error;
        report.retries++;
        await sleep(250 * 2 ** attempt);
      }
    }
  };

  let dirty = false; // true once an event was processed since the last save
  const persist = async (): Promise<void> => {
    if (!dirty) return;
    await options.store.save(progress);
    dirty = false;
    report.savedCheckpoint = {
      lastLedger: progress.lastLedger,
      processedIds: progress.processedIds.length,
    };
  };

  // Detect history the server no longer has.
  let startLedger = progress.lastLedger;
  try {
    const { oldestLedger } = await withRetry(() => options.source.getRetention());
    if (oldestLedger !== undefined && startLedger < oldestLedger) {
      report.unrecoverableRanges.push({ fromLedger: startLedger, toLedger: oldestLedger - 1 });
      if (!options.skipUnavailableHistory) {
        report.status = 'unrecoverable-gap';
        report.error = `Ledgers ${startLedger}-${oldestLedger - 1} are outside RPC event retention`;
        return report;
      }
      startLedger = oldestLedger;
      progress = { ...progress, lastLedger: oldestLedger, processedIds: [] };
    }
  } catch {
    // Retention is best effort; an out-of-range query below is still detected.
  }

  const seen = new Set(progress.processedIds);
  let cursor: string | undefined;
  try {
    for (let page = 0; page < maxPages; page++) {
      const query: EventQuery = cursor
        ? { filters: [filter], cursor, limit: pageLimit }
        : {
            filters: [filter],
            startLedger,
            ...(options.endLedger ? { endLedger: options.endLedger } : {}),
            limit: pageLimit,
          };
      let response: EventPage;
      try {
        response = await withRetry(() => options.source.getEvents(query));
      } catch (error) {
        const oldest = cursor ? undefined : oldestLedgerFromError(error);
        if (oldest !== undefined && oldest > startLedger) {
          report.unrecoverableRanges.push({ fromLedger: startLedger, toLedger: oldest - 1 });
          if (!options.skipUnavailableHistory) {
            report.status = 'unrecoverable-gap';
            report.error = `Ledgers ${startLedger}-${oldest - 1} are outside RPC event retention`;
            return report;
          }
          startLedger = oldest;
          progress = { ...progress, lastLedger: oldest, processedIds: [] };
          page--;
          continue;
        }
        throw error;
      }
      if (!response || !Array.isArray(response.events))
        throw new ReplayError('Malformed getEvents response');
      response.events.forEach(validateEvent);
      report.retrieved += response.events.length;

      for (const event of [...response.events].sort(compareEvents)) {
        if (options.endLedger !== undefined && event.ledger > options.endLedger) continue;
        if (event.ledger < progress.lastLedger) {
          // Older than the checkpoint: already handled in an earlier ledger.
          report.outOfOrder++;
          report.duplicates++;
          continue;
        }
        if (event.ledger === progress.lastLedger && seen.has(event.id)) {
          report.duplicates++;
          continue;
        }
        await options.handler(event); // throws → stop; checkpoint keeps prior events only
        if (event.ledger > progress.lastLedger) {
          progress = { ...progress, lastLedger: event.ledger, processedIds: [] };
          seen.clear();
        }
        progress.processedIds.push(event.id);
        seen.add(event.id);
        dirty = true;
        report.processed++;
        report.lastProcessedLedger = event.ledger;
      }
      // Commit only after every event in the page succeeded.
      await persist();

      const ended =
        response.events.length === 0 ||
        !response.cursor ||
        response.cursor === cursor ||
        (options.endLedger !== undefined &&
          response.events.some((e) => e.ledger > options.endLedger!));
      if (ended) return report;
      cursor = response.cursor;
    }
    report.status = 'page-budget-reached';
    return report;
  } catch (error) {
    report.status = 'failed';
    report.error = (error as Error).message;
    // Keep work from the events that did succeed; if this save fails too, the
    // previous checkpoint stands and those events will be replayed.
    try {
      await persist();
    } catch (saveError) {
      report.error += `; checkpoint not saved: ${(saveError as Error).message}`;
    }
    return report;
  }
}

// ── Adapters ─────────────────────────────────────────────────────────────────

export function rpcEventSource(server: rpc.Server): EventSource {
  return {
    async getEvents(query) {
      const response = await server.getEvents(query);
      return {
        events: response.events,
        cursor: response.cursor,
        latestLedger: response.latestLedger,
      };
    },
    async getRetention() {
      // RPC returns oldestLedger/latestLedger from getHealth; SDK 13's types omit them.
      const health = (await server.getHealth()) as unknown as {
        oldestLedger?: number;
        latestLedger?: number;
      };
      return { oldestLedger: health.oldestLedger, latestLedger: health.latestLedger };
    },
  };
}

export class MemoryCheckpointStore implements CheckpointStore {
  constructor(public checkpoint: Checkpoint | null = null) {}
  async load(): Promise<Checkpoint | null> {
    return this.checkpoint
      ? { ...this.checkpoint, processedIds: [...this.checkpoint.processedIds] }
      : null;
  }
  async save(checkpoint: Checkpoint): Promise<void> {
    this.checkpoint = { ...checkpoint, processedIds: [...checkpoint.processedIds] };
  }
}

/** JSON file checkpoint, written atomically (temp file + rename). */
export class FileCheckpointStore implements CheckpointStore {
  constructor(private readonly file: string) {}
  async load(): Promise<Checkpoint | null> {
    try {
      return JSON.parse(await fs.readFile(this.file, 'utf8')) as Checkpoint;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new ReplayError(
        `Unreadable checkpoint ${this.file}; inspect it or remove it to restart`,
      );
    }
  }
  async save(checkpoint: Checkpoint): Promise<void> {
    const temporary = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(checkpoint, null, 2), { mode: 0o600 });
    await fs.rename(temporary, this.file);
  }
}

// ── Reporting ────────────────────────────────────────────────────────────────

export function formatReport(report: ReplayReport): string {
  const range = `${report.requestedRange.startLedger}-${report.requestedRange.endLedger ?? 'latest'}`;
  const lines = [
    `Event replay: ${report.status.toUpperCase()}`,
    `  Contract:            ${report.contractId}`,
    `  RPC endpoint:        ${report.endpoint}`,
    `  Requested range:     ${range} (resumed from ledger ${report.resumedFrom})`,
    `  Retrieved events:    ${report.retrieved}`,
    `  Processed events:    ${report.processed}`,
    `  Duplicates skipped:  ${report.duplicates}${report.outOfOrder ? ` (${report.outOfOrder} out of order)` : ''}`,
    `  Last processed:      ${report.lastProcessedLedger ?? 'none'}`,
    `  Saved checkpoint:    ${report.savedCheckpoint ? `ledger ${report.savedCheckpoint.lastLedger}, ${report.savedCheckpoint.processedIds} id(s)` : 'none'}`,
    `  Retries:             ${report.retries}`,
    `  Unrecoverable:       ${report.unrecoverableRanges.map((r) => `${r.fromLedger}-${r.toLedger}`).join(', ') || 'none'}`,
  ];
  if (report.error) lines.push(`  Error:               ${report.error}`);
  return lines.join('\n');
}

// ── Runner entry point ───────────────────────────────────────────────────────

function decode(value: xdr.ScVal): unknown {
  try {
    return scValToNative(value);
  } catch {
    return { undecodable: true };
  }
}

export async function run(
  params: { contractId?: string; startLedger?: string; topics?: string } = {},
): Promise<void> {
  const config = resolveNetworkConfiguration();
  const contractId = params.contractId || process.env.CONTRACT_ID || '';
  const startLedger = Number(params.startLedger || process.env.START_LEDGER);
  const endLedger = process.env.END_LEDGER ? Number(process.env.END_LEDGER) : undefined;
  const topicsInput = params.topics ?? process.env.EVENT_TOPICS;
  const server = new rpc.Server(config.sorobanRpcUrl, {
    allowHttp: config.sorobanRpcUrl.startsWith('http://'),
  });

  const report = await replayEvents({
    contractId,
    topics: topicsInput ? topicsInput.split(',').map((t) => t.trim()) : undefined,
    startLedger,
    endLedger,
    source: rpcEventSource(server),
    store: new FileCheckpointStore(process.env.CHECKPOINT_FILE || '.event-replay-checkpoint.json'),
    endpoint: config.sorobanRpcUrl,
    skipUnavailableHistory: process.env.SKIP_UNAVAILABLE_HISTORY === '1',
    // Idempotent handler: printing an event twice is harmless. A real handler
    // should upsert keyed by event.id.
    handler: async (event) => {
      console.log(
        JSON.stringify(
          {
            id: event.id,
            ledger: event.ledger,
            tx: event.txHash,
            topics: event.topic.map(decode),
            value: decode(event.value),
          },
          (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
        ),
      );
    },
  });
  console.log(formatReport(report));
  if (report.status === 'failed' || report.status === 'unrecoverable-gap') process.exitCode = 1;
}

if (require.main === module) {
  dotenv.config();
  run().catch((error: unknown) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  });
}
