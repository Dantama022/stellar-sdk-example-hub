import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { rpc, StrKey, xdr } from '@stellar/stellar-sdk';

import {
  buildEventFilter,
  endpointLabel,
  EventPage,
  EventQuery,
  EventSource,
  FileCheckpointStore,
  formatReport,
  MemoryCheckpointStore,
  replayEvents,
  ReplayError,
  ReplayOptions,
} from '../src/examples/263-soroban-event-replay-checkpoint';

const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 1));
const OTHER = StrKey.encodeContract(Buffer.alloc(32, 2));

/** Deterministic event shaped like RPC output; ids sort like real paging tokens. */
function ev(ledger: number, n = 1, topic = 'transfer', contract = CONTRACT): rpc.Api.EventResponse {
  return {
    id: `${String(ledger * 4096).padStart(19, '0')}-${String(n).padStart(10, '0')}`,
    type: 'contract',
    ledger,
    ledgerClosedAt: '2026-01-01T00:00:00Z',
    pagingToken: '',
    inSuccessfulContractCall: true,
    txHash: 'ab'.repeat(32),
    contractId: undefined,
    topic: [xdr.ScVal.scvSymbol(topic)],
    value: xdr.ScVal.scvU32(n),
    // carry the source contract for the mock's filter
    ...({ _contract: contract } as object),
  } as rpc.Api.EventResponse;
}

/**
 * Mock RPC: serves `events` in pages of `limit` with cursors, applies the
 * contract/topic filter and the ledger range, and can inject failures.
 */
class MockSource implements EventSource {
  calls: EventQuery[] = [];
  failures: unknown[] = [];
  oldestLedger?: number;
  pageOverride?: (query: EventQuery) => EventPage | undefined;
  constructor(public events: rpc.Api.EventResponse[]) {}

  async getRetention(): Promise<{ oldestLedger?: number; latestLedger?: number }> {
    return { oldestLedger: this.oldestLedger, latestLedger: 10_000 };
  }

  async getEvents(query: EventQuery): Promise<EventPage> {
    this.calls.push(query);
    if (this.failures.length) throw this.failures.shift();
    const override = this.pageOverride?.(query);
    if (override) return override;
    if (this.oldestLedger && query.startLedger && query.startLedger < this.oldestLedger) {
      throw new Error(
        `startLedger must be between the oldest ledger: ${this.oldestLedger} and the latest ledger: 10000`,
      );
    }
    const filter = query.filters[0];
    const topic = filter.topics?.[0]?.[0];
    const matching = this.events.filter(
      (e) =>
        filter.contractIds?.includes((e as unknown as { _contract: string })._contract) &&
        (!topic || topic === '*' || e.topic[0].toXDR('base64') === topic) &&
        (query.cursor ? e.id > query.cursor : e.ledger >= (query.startLedger ?? 0)) &&
        (query.endLedger === undefined || e.ledger <= query.endLedger),
    );
    const page = matching.slice(0, query.limit);
    return {
      events: page,
      cursor: page.length ? page[page.length - 1].id : (query.cursor ?? 'end'),
      latestLedger: 10_000,
    };
  }
}

function setup(events: rpc.Api.EventResponse[], overrides: Partial<ReplayOptions> = {}) {
  const source = new MockSource(events);
  const store = new MemoryCheckpointStore();
  const handled: string[] = [];
  const options: ReplayOptions = {
    contractId: CONTRACT,
    startLedger: 100,
    source,
    store,
    pageLimit: 2,
    sleep: async () => undefined,
    handler: async (event) => {
      handled.push(event.id);
    },
    ...overrides,
  };
  return { source, store, handled, options };
}

describe('Soroban event replay and checkpoint recovery (#599)', () => {
  it('1. retrieves and processes events across pages, then checkpoints', async () => {
    const { options, handled, store, source } = setup([ev(100), ev(101), ev(101, 2), ev(105)]);
    const report = await replayEvents(options);
    expect(report).toMatchObject({
      status: 'completed',
      retrieved: 4,
      processed: 4,
      duplicates: 0,
      lastProcessedLedger: 105,
    });
    expect(handled).toHaveLength(4);
    expect(store.checkpoint).toMatchObject({ lastLedger: 105, processedIds: [ev(105).id] });
    expect(source.calls[0]).toMatchObject({ startLedger: 100, limit: 2 });
    expect(source.calls[1].cursor).toBeDefined();
    expect(source.calls[1].startLedger).toBeUndefined(); // cursor and startLedger are exclusive
  });

  it('2. handles an empty result', async () => {
    const { options, handled } = setup([]);
    expect(await replayEvents(options)).toMatchObject({
      status: 'completed',
      retrieved: 0,
      processed: 0,
    });
    expect(handled).toEqual([]);
  });

  it('3. filters by contract id', async () => {
    const { options, handled } = setup([ev(100), ev(100, 2, 'transfer', OTHER)]);
    await replayEvents(options);
    expect(handled).toEqual([ev(100).id]);
    expect(() => buildEventFilter('not-a-contract')).toThrow(ReplayError);
  });

  it('4. filters by event topic', async () => {
    const { options, handled } = setup([ev(100, 1, 'transfer'), ev(100, 2, 'mint')], {
      topics: ['mint'],
    });
    await replayEvents(options);
    expect(handled).toEqual([ev(100, 2).id]);
    expect(() => buildEventFilter(CONTRACT, ['not a symbol!'])).toThrow(/ScSymbol/);
  });

  it('5. processes multiple ledger ranges independently', async () => {
    const events = [ev(100), ev(150), ev(200), ev(250)];
    const first = setup(events, { startLedger: 100, endLedger: 150 });
    expect(await replayEvents(first.options)).toMatchObject({
      processed: 2,
      lastProcessedLedger: 150,
    });
    const second = setup(events, { startLedger: 200, endLedger: 250 });
    await replayEvents(second.options);
    expect(second.handled).toEqual([ev(200).id, ev(250).id]);
  });

  it('6. saves and restores a checkpoint (file store)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-'));
    const store = new FileCheckpointStore(path.join(dir, 'cp.json'));
    const events = [ev(100), ev(101)];
    await replayEvents({ ...setup(events).options, store });
    const restored = await store.load();
    expect(restored).toMatchObject({ version: 1, lastLedger: 101, processedIds: [ev(101).id] });

    events.push(ev(102));
    const again = setup(events, { store });
    const report = await replayEvents(again.options);
    expect(again.handled).toEqual([ev(102).id]); // ledger 101 re-queried, its id skipped
    expect(report).toMatchObject({ resumedFrom: 101, duplicates: 1, processed: 1 });
  });

  it('7. resumes after an interruption without losing or repeating events', async () => {
    const events = [ev(100), ev(101), ev(101, 2), ev(102)];
    let crash = true;
    const first = setup(events, {
      handler: async (event) => {
        if (event.id === ev(101, 2).id && crash) throw new Error('process killed');
        first.handled.push(event.id);
      },
    });
    const interrupted = await replayEvents(first.options);
    expect(interrupted.status).toBe('failed');
    expect(first.store.checkpoint).toMatchObject({ lastLedger: 101, processedIds: [ev(101).id] });

    crash = false;
    const resumed = setup(events, { store: first.store });
    await replayEvents(resumed.options);
    expect(resumed.handled).toEqual([ev(101, 2).id, ev(102).id]);
    expect([...first.handled, ...resumed.handled]).toEqual(events.map((e) => e.id));
  });

  it('8. skips duplicates returned by overlapping queries', async () => {
    const { options, handled, source } = setup([ev(100), ev(101)]);
    source.pageOverride = (q) =>
      q.startLedger
        ? { events: [ev(100), ev(100), ev(101)], cursor: 'c1', latestLedger: 1 }
        : undefined;
    const report = await replayEvents(options);
    expect(handled).toEqual([ev(100).id, ev(101).id]);
    expect(report.duplicates).toBe(1);
  });

  it('9. reports a checkpoint persistence failure and keeps the prior checkpoint', async () => {
    const { options, store } = setup([ev(100), ev(101), ev(102)]);
    let saves = 0;
    store.save = async (cp) => {
      if (++saves > 1) throw new Error('disk full');
      MemoryCheckpointStore.prototype.save.call(store, cp);
    };
    const report = await replayEvents(options);
    expect(report.status).toBe('failed');
    expect(report.error).toMatch(/disk full/);
    expect(store.checkpoint?.lastLedger).toBe(101); // first page only
  });

  it('10. fails cleanly when RPC keeps timing out', async () => {
    const { options, source, handled } = setup([ev(100)], { maxRetries: 2 });
    source.failures = Array(5).fill(
      Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED' }),
    );
    const report = await replayEvents(options);
    expect(report).toMatchObject({ status: 'failed', retries: 2, processed: 0 });
    expect(handled).toEqual([]);
  });

  it('11. retries a transient failure, then succeeds', async () => {
    const { options, source } = setup([ev(100)]);
    source.failures = [
      Object.assign(new Error('Service Unavailable'), { response: { status: 503 } }),
    ];
    expect(await replayEvents(options)).toMatchObject({
      status: 'completed',
      retries: 1,
      processed: 1,
    });
  });

  it('12. reports history outside RPC retention instead of skipping it', async () => {
    const stopped = setup([ev(300)], { startLedger: 100 });
    stopped.source.oldestLedger = 250;
    expect(await replayEvents(stopped.options)).toMatchObject({
      status: 'unrecoverable-gap',
      unrecoverableRanges: [{ fromLedger: 100, toLedger: 249 }],
      processed: 0,
    });

    const skipping = setup([ev(300)], { startLedger: 100, skipUnavailableHistory: true });
    skipping.source.getRetention = async () => ({}); // no retention info: detected from the RPC error
    skipping.source.oldestLedger = 250;
    const report = await replayEvents(skipping.options);
    expect(report).toMatchObject({
      status: 'completed',
      processed: 1,
      unrecoverableRanges: [{ fromLedger: 100, toLedger: 249 }],
    });
  });

  it('13. rejects malformed responses without advancing the checkpoint', async () => {
    const bad = setup([ev(100)]);
    bad.source.pageOverride = () => ({
      events: undefined as unknown as [],
      cursor: 'x',
      latestLedger: 1,
    });
    expect(await replayEvents(bad.options)).toMatchObject({ status: 'failed', processed: 0 });
    expect(bad.store.checkpoint).toBeNull();

    const missingId = setup([ev(100)]);
    missingId.source.pageOverride = () => ({
      events: [{ ...ev(100), id: '' }],
      cursor: 'x',
      latestLedger: 1,
    });
    expect((await replayEvents(missingId.options)).error).toMatch(/Malformed event/);
  });

  it('14. processes events in deterministic order when RPC returns them out of order', async () => {
    const { options, handled, source } = setup([]);
    source.pageOverride = (q) =>
      q.startLedger
        ? { events: [ev(102), ev(100), ev(101, 2), ev(101)], cursor: 'c1', latestLedger: 1 }
        : q.cursor === 'c1'
          ? { events: [ev(100, 9)], cursor: 'c2', latestLedger: 1 }
          : { events: [], cursor: 'c2', latestLedger: 1 };
    const report = await replayEvents(options);
    expect(handled).toEqual([ev(100).id, ev(101).id, ev(101, 2).id, ev(102).id]);
    expect(report.outOfOrder).toBe(1); // ledger 100 arriving after the checkpoint reached 102
  });

  it('rejects a checkpoint from a different replay scope', async () => {
    const { options, store } = setup([ev(100)]);
    store.checkpoint = { version: 1, scope: 'something else', lastLedger: 100, processedIds: [] };
    await expect(replayEvents(options)).rejects.toThrow(/does not match/);
  });

  it('reports the endpoint without credentials', async () => {
    expect(endpointLabel('https://user:secret@rpc.example.com/soroban?key=abc')).toBe(
      'https://rpc.example.com/soroban',
    );
    const { options } = setup([ev(100)], { endpoint: 'https://user:secret@rpc.example.com/' });
    const text = formatReport(await replayEvents(options));
    expect(text).toContain('https://rpc.example.com');
    expect(text).not.toContain('secret');
  });
});
