import { readFileSync } from 'fs';
import path from 'path';

import { Address, Contract, nativeToScVal, xdr } from '@stellar/stellar-sdk';

import * as ex67 from '../src/examples/67-soroban-contract-events';
import { examples } from '../src/runner/catalog';

describe('ISSUE-067: Soroban Contract Events', () => {
  const contractId = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
  const otherContractId = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
  const accountId = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
  const txHash = 'a'.repeat(64);

  /**
   * Builds an RPC-shaped event record using real `ScVal` values, so decoding is
   * exercised against actual XDR rather than pre-decoded stand-ins.
   */
  const buildEvent = (overrides: Partial<ex67.RawEventRecord> = {}): ex67.RawEventRecord => ({
    id: '0001234567890-0000000001',
    type: 'contract',
    ledger: 1000,
    ledgerClosedAt: '2026-07-28T10:00:00Z',
    txHash,
    contractId,
    topic: [
      xdr.ScVal.scvSymbol('transfer'),
      nativeToScVal(new Address(accountId)),
      nativeToScVal(new Address(contractId)),
    ],
    value: nativeToScVal(1234567890n, { type: 'i128' }),
    inSuccessfulContractCall: true,
    pagingToken: '0001234567890-0000000001',
    ...overrides,
  });

  describe('contract ID input', () => {
    it('accepts and trims a valid contract strkey', () => {
      expect(ex67.normalizeContractId(`  ${contractId}  `)).toBe(contractId);
    });

    it('rejects blank, account, and malformed contract IDs', () => {
      expect(() => ex67.normalizeContractId('')).toThrow(/Missing contract ID/);
      expect(() => ex67.normalizeContractId('   ')).toThrow(/Missing contract ID/);
      expect(() => ex67.normalizeContractId(accountId)).toThrow(/Invalid contract ID/);
      expect(() => ex67.normalizeContractId('CNOTAREALCONTRACT')).toThrow(/Invalid contract ID/);
    });
  });

  describe('event topic and payload decoding', () => {
    it('decodes symbols, addresses, and 128-bit integers with their XDR types', () => {
      const parsed = ex67.parseEventRecord(buildEvent());

      expect(parsed.topics).toHaveLength(3);
      expect(parsed.topics[0]).toMatchObject({ xdrType: 'scvSymbol', value: 'transfer' });
      expect(parsed.topics[1]).toMatchObject({ xdrType: 'scvAddress', value: accountId });
      expect(parsed.topics[2]).toMatchObject({ xdrType: 'scvAddress', value: contractId });

      // i128 decodes to a bigint, which must survive as a lossless string.
      expect(parsed.value.xdrType).toBe('scvI128');
      expect(parsed.value.value).toBe('1234567890');
    });

    it('formats bigints, byte strings, maps, and nested values JSON-safely', () => {
      expect(ex67.formatNativeValue(42n)).toBe('42');
      expect(ex67.formatNativeValue(Buffer.from([0xde, 0xad]))).toBe('0xdead');
      expect(ex67.formatNativeValue([1n, Buffer.from([0x01])])).toEqual(['1', '0x01']);
      expect(ex67.formatNativeValue({ amount: 7n, memo: 'hi' })).toEqual({
        amount: '7',
        memo: 'hi',
      });
      expect(ex67.formatNativeValue(new Map<unknown, unknown>([['amount', 5n]]))).toEqual({
        amount: '5',
      });
      expect(ex67.formatNativeValue('plain')).toBe('plain');
      expect(ex67.formatNativeValue(null)).toBeNull();

      // Raw bigints would throw here; the formatted output must serialize.
      expect(() => JSON.stringify(ex67.formatNativeValue({ total: 2n ** 100n }))).not.toThrow();
    });

    it('decodes a map payload into named fields', () => {
      const parsed = ex67.parseEventRecord(
        buildEvent({ value: nativeToScVal({ amount: 500n, memo: 'invoice-1' }) }),
      );

      expect(parsed.value.xdrType).toBe('scvMap');
      expect(parsed.value.decoded).toBe(true);
      expect(parsed.value.value).toEqual({ amount: '500', memo: 'invoice-1' });
    });

    it('reports an undecodable value instead of throwing', () => {
      const broken = { switch: () => ({ name: 'scvBogus' }) } as any;
      const decoded = ex67.decodeScVal(broken);

      expect(decoded.decoded).toBe(false);
      expect(decoded.xdrType).toBe('scvBogus');
      expect(ex67.renderDecodedValue(decoded)).toContain('undecodable');
    });

    it('treats a missing value as void', () => {
      const decoded = ex67.decodeScVal(undefined);

      expect(decoded).toEqual({ xdrType: 'void', value: null, decoded: true });
      expect(ex67.renderDecodedValue(decoded)).toBe('void');
    });

    it('quotes decoded strings and serializes structures for display', () => {
      expect(ex67.renderDecodedValue({ xdrType: 'scvSymbol', value: 'mint', decoded: true })).toBe(
        '"mint"',
      );
      expect(ex67.renderDecodedValue({ xdrType: 'scvVec', value: [1, 2], decoded: true })).toBe(
        '[1,2]',
      );
    });
  });

  describe('event name extraction', () => {
    it('takes the event name from a leading symbol topic', () => {
      expect(ex67.parseEventRecord(buildEvent()).eventName).toBe('transfer');
    });

    it('returns null when the first topic is not a symbol', () => {
      const parsed = ex67.parseEventRecord(
        buildEvent({ topic: [nativeToScVal(new Address(accountId))] }),
      );

      expect(parsed.eventName).toBeNull();
    });

    it('returns null for an event with no topics', () => {
      expect(ex67.parseEventRecord(buildEvent({ topic: [] })).eventName).toBeNull();
      expect(ex67.extractEventName([])).toBeNull();
    });
  });

  describe('ledger and transaction references', () => {
    it('preserves ledger sequence, close time, transaction hash, and contract', () => {
      const parsed = ex67.parseEventRecord(buildEvent({ ledger: 987654 }));

      expect(parsed.ledger).toBe(987654);
      expect(parsed.ledgerClosedAt).toBe('2026-07-28T10:00:00Z');
      expect(parsed.txHash).toBe(txHash);
      expect(parsed.contractId).toBe(contractId);
      expect(parsed.pagingToken).toBe('0001234567890-0000000001');
    });

    it('accepts both a Contract instance and a raw strkey as contractId', () => {
      expect(ex67.extractContractId(new Contract(contractId))).toBe(contractId);
      expect(ex67.extractContractId(contractId)).toBe(contractId);
      expect(ex67.extractContractId({ unexpected: true })).toBe('');
      expect(ex67.extractContractId(undefined)).toBe('');
    });

    it('renders ledger and transaction references in the report', () => {
      const events = [ex67.parseEventRecord(buildEvent())];
      const report = ex67.formatContractEventsReport(
        contractId,
        { startLedger: 900, endLedger: 1100 },
        events,
        ex67.summarizeEvents(events),
        { latestLedger: 1200, eventType: 'contract', limit: 10 },
      );

      expect(report).toContain('Ledger:       1000');
      expect(report).toContain(`Tx Hash:      ${txHash}`);
      expect(report).toContain(`Contract:     ${contractId}`);
      expect(report).toContain('Ledger Range: 900 -> 1100');
      expect(report).toContain('network latest: 1200');
      expect(report).toContain('scvSymbol');
      expect(report).toContain('"transfer"');
      expect(report).toContain('Ledger Span:   1000 -> 1000');
    });

    it('flags events emitted by a sub-call that failed', () => {
      const events = [ex67.parseEventRecord(buildEvent({ inSuccessfulContractCall: false }))];
      const summary = ex67.summarizeEvents(events);

      expect(summary.failedCallEventCount).toBe(1);
      expect(
        ex67.formatContractEventsReport(contractId, { startLedger: 1 }, events, summary),
      ).toContain('sub-call that failed');
    });

    it('assumes success when the RPC response omits the success flag', () => {
      const parsed = ex67.parseEventRecord(buildEvent({ inSuccessfulContractCall: undefined }));
      expect(parsed.inSuccessfulContractCall).toBe(true);
    });

    it('surfaces the pagination cursor when there are results', () => {
      const events = [ex67.parseEventRecord(buildEvent())];
      const report = ex67.formatContractEventsReport(
        contractId,
        { startLedger: 1 },
        events,
        ex67.summarizeEvents(events),
        { latestLedger: 1200, eventType: 'contract', limit: 10, cursor: 'cursor-1' },
      );

      expect(report).toContain('Next page cursor: cursor-1');
    });
  });

  describe('summaries', () => {
    it('aggregates counts, ledger span, and distinct transactions', () => {
      const events = [
        ex67.parseEventRecord(buildEvent({ ledger: 100, txHash })),
        ex67.parseEventRecord(buildEvent({ ledger: 300, txHash })),
        ex67.parseEventRecord(
          buildEvent({
            ledger: 200,
            txHash: 'b'.repeat(64),
            type: 'system',
            topic: [xdr.ScVal.scvSymbol('mint')],
          }),
        ),
      ];

      const summary = ex67.summarizeEvents(events);

      expect(summary.eventCount).toBe(3);
      expect(summary.countsByName).toEqual({ transfer: 2, mint: 1 });
      expect(summary.countsByType).toEqual({ contract: 2, system: 1 });
      expect(summary.firstLedger).toBe(100);
      expect(summary.lastLedger).toBe(300);
      expect(summary.transactionCount).toBe(2);
      expect(summary.contractIds).toEqual([contractId]);
      expect(summary.failedCallEventCount).toBe(0);
    });

    it('returns a zeroed summary for no events', () => {
      const summary = ex67.summarizeEvents([]);

      expect(summary.eventCount).toBe(0);
      expect(summary.firstLedger).toBeNull();
      expect(summary.lastLedger).toBeNull();
      expect(summary.contractIds).toEqual([]);
      expect(summary.transactionCount).toBe(0);
    });

    it('groups unnamed events under a single bucket', () => {
      const summary = ex67.summarizeEvents([ex67.parseEventRecord(buildEvent({ topic: [] }))]);
      expect(summary.countsByName).toEqual({ '(unnamed)': 1 });
    });
  });

  describe('empty event responses', () => {
    it('explains an empty result rather than reporting an error', () => {
      const report = ex67.formatContractEventsReport(
        contractId,
        { startLedger: 500 },
        [],
        ex67.summarizeEvents([]),
        { latestLedger: 1000, eventType: 'contract', limit: 10 },
      );

      expect(report).toContain('No events found');
      expect(report).toContain('valid, empty result rather than an error');
      expect(report).toContain('retention window');
      expect(report).not.toContain('Event Records');
    });

    it('handles an RPC response whose events array is null', async () => {
      const server = {
        getEvents: async () => ({ events: null, latestLedger: 1000, cursor: '' }),
      } as any;

      const result = await ex67.queryContractEvents(server, {
        latestLedger: 1000,
        range: { startLedger: 500 },
        filters: [{ type: 'contract', contractIds: [contractId] }],
        limit: 10,
      });

      const events = (result.response.events ?? []).map(ex67.parseEventRecord);
      expect(events).toEqual([]);
      expect(ex67.summarizeEvents(events).eventCount).toBe(0);
    });
  });

  describe('ledger range filtering', () => {
    it('defaults to a lookback window ending at the latest ledger', () => {
      const range = ex67.resolveLedgerRange(100000);

      expect(range.startLedger).toBe(100000 - 17280);
      expect(range.endLedger).toBeUndefined();
    });

    it('honours explicit start and end ledgers', () => {
      expect(ex67.resolveLedgerRange(100000, { startLedger: 500, endLedger: 900 })).toEqual({
        startLedger: 500,
        endLedger: 900,
      });
    });

    it('clamps bounds into the valid ledger space', () => {
      // An end beyond the network tip is pulled back to the latest ledger.
      expect(ex67.resolveLedgerRange(1000, { startLedger: 10, endLedger: 99999 })).toEqual({
        startLedger: 10,
        endLedger: 1000,
      });
      // A start above the end would be an empty range the server rejects.
      expect(ex67.resolveLedgerRange(1000, { startLedger: 900, endLedger: 500 })).toEqual({
        startLedger: 500,
        endLedger: 500,
      });
      // A lookback longer than the chain's history cannot go below ledger 1.
      expect(ex67.resolveLedgerRange(50).startLedger).toBe(1);
    });

    it('parses ledger inputs and ignores unusable ones', () => {
      expect(ex67.parseLedgerInput('1234')).toBe(1234);
      expect(ex67.parseLedgerInput(1234)).toBe(1234);
      expect(ex67.parseLedgerInput('')).toBeUndefined();
      expect(ex67.parseLedgerInput('not-a-number')).toBeUndefined();
      expect(ex67.parseLedgerInput(0)).toBeUndefined();
      expect(ex67.parseLedgerInput(undefined)).toBeUndefined();
    });

    it('filters events client-side when the server ignores endLedger', () => {
      const events = [100, 200, 300].map((ledger) => ex67.parseEventRecord(buildEvent({ ledger })));

      expect(
        ex67
          .filterEventsByLedgerRange(events, { startLedger: 150, endLedger: 250 })
          .map((event) => event.ledger),
      ).toEqual([200]);
      expect(
        ex67.filterEventsByLedgerRange(events, { startLedger: 150 }).map((event) => event.ledger),
      ).toEqual([200, 300]);
    });

    it('recognises retention-window errors and extracts the supported range', () => {
      expect(
        ex67.isLedgerRangeError(new Error('startLedger must be within the ledger range: 10 - 90')),
      ).toBe(true);
      expect(ex67.isLedgerRangeError(new Error('start is before oldest ledger'))).toBe(true);
      expect(ex67.isLedgerRangeError(new Error('connection refused'))).toBe(false);

      expect(ex67.extractValidLedgerRange('ledger range: 10 - 90')).toEqual({
        startLedger: 10,
        endLedger: 90,
      });
      expect(ex67.extractValidLedgerRange('oldest ledger is 4242')).toEqual({ startLedger: 4242 });
      expect(ex67.extractValidLedgerRange('something else entirely')).toBeNull();
    });

    it('retries against the ledger range the server advertises', async () => {
      const calls: any[] = [];
      const server = {
        getEvents: async (request: any) => {
          calls.push(request);
          if (request.startLedger < 500) {
            throw new Error('startLedger must be within the ledger range: 500 - 1000');
          }
          return { events: [buildEvent({ ledger: 600 })], latestLedger: 1000, cursor: 'c1' };
        },
      } as any;

      const result = await ex67.queryContractEvents(server, {
        latestLedger: 1000,
        range: { startLedger: 1 },
        filters: [{ type: 'contract', contractIds: [contractId] }],
        limit: 10,
      });

      expect(calls).toHaveLength(2);
      expect(calls[1].startLedger).toBe(500);
      expect(result.range.startLedger).toBe(500);
      expect(result.response.events).toHaveLength(1);
    });

    it('drops endLedger when the server does not support it', async () => {
      const calls: any[] = [];
      const server = {
        getEvents: async (request: any) => {
          calls.push(request);
          if (request.endLedger !== undefined) {
            throw new Error('unknown parameter endLedger');
          }
          return { events: [], latestLedger: 1000, cursor: '' };
        },
      } as any;

      const result = await ex67.queryContractEvents(server, {
        latestLedger: 1000,
        range: { startLedger: 500, endLedger: 800 },
        filters: [{ type: 'contract' }],
        limit: 10,
      });

      expect(calls[0].endLedger).toBe(800);
      expect(calls[1].endLedger).toBeUndefined();
      expect(result.endLedgerApplied).toBe(false);
      expect(ex67.isEndLedgerUnsupportedError(new Error('no such field: endLedger'))).toBe(true);
      expect(ex67.isEndLedgerUnsupportedError(new Error('timeout'))).toBe(false);
    });

    it('passes the requested range and filters straight through when accepted', async () => {
      const calls: any[] = [];
      const server = {
        getEvents: async (request: any) => {
          calls.push(request);
          return { events: [buildEvent()], latestLedger: 1000, cursor: 'c2' };
        },
      } as any;

      const result = await ex67.queryContractEvents(server, {
        latestLedger: 1000,
        range: { startLedger: 400, endLedger: 800 },
        filters: [{ type: 'contract', contractIds: [contractId] }],
        limit: 25,
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ startLedger: 400, endLedger: 800, limit: 25 });
      expect(calls[0].filters[0].contractIds).toEqual([contractId]);
      expect(result.endLedgerApplied).toBe(true);
    });

    it('propagates errors unrelated to the ledger range', async () => {
      const server = {
        getEvents: async () => {
          throw new Error('502 Bad Gateway');
        },
      } as any;

      await expect(
        ex67.queryContractEvents(server, {
          latestLedger: 1000,
          range: { startLedger: 500 },
          filters: [{ type: 'contract' }],
          limit: 10,
        }),
      ).rejects.toThrow('502 Bad Gateway');
    });

    it('never retries the same ledger window twice', async () => {
      // Every candidate is clamped to endLedger, so the fallback ladder
      // collapses onto a single unusable range. Without a dedupe guard the
      // retry loop reissues that request forever.
      const seen: string[] = [];
      const server = {
        getEvents: async (request: any) => {
          seen.push(`${request.startLedger}-${request.endLedger}`);
          if (seen.length > 20) {
            throw new Error('retry loop did not terminate');
          }
          throw new Error('startLedger must be within the ledger range: 3831828 - 3849108');
        },
      } as any;

      await expect(
        ex67.queryContractEvents(server, {
          latestLedger: 3849108,
          range: { startLedger: 1, endLedger: 3 },
          filters: [{ type: 'contract' }],
          limit: 10,
        }),
      ).rejects.toThrow(/ledger range/);

      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.length).toBeLessThanOrEqual(3);
    });

    it('gives up once no narrower lookback remains', async () => {
      const server = {
        getEvents: async () => {
          throw new Error('start is before oldest ledger');
        },
      } as any;

      await expect(
        ex67.queryContractEvents(server, {
          latestLedger: 100,
          range: { startLedger: 1 },
          filters: [{ type: 'contract' }],
          limit: 10,
        }),
      ).rejects.toThrow(/oldest ledger/);
    });
  });

  describe('input normalization', () => {
    it('clamps the result limit into the supported range', () => {
      expect(ex67.normalizeLimit(undefined)).toBe(10);
      expect(ex67.normalizeLimit('25')).toBe(25);
      expect(ex67.normalizeLimit(0)).toBe(1);
      expect(ex67.normalizeLimit(5000)).toBe(200);
      expect(ex67.normalizeLimit('not-a-number')).toBe(10);
    });

    it('accepts only the three RPC event types', () => {
      expect(ex67.normalizeEventType('system')).toBe('system');
      expect(ex67.normalizeEventType('DIAGNOSTIC')).toBe('diagnostic');
      expect(ex67.normalizeEventType('nonsense')).toBe('contract');
      expect(ex67.normalizeEventType(undefined)).toBe('contract');
    });
  });

  describe('contract discovery', () => {
    it('picks the contract that emitted the most events', () => {
      const events = [
        ex67.parseEventRecord(buildEvent()),
        ex67.parseEventRecord(buildEvent({ contractId: otherContractId })),
        ex67.parseEventRecord(buildEvent({ contractId: otherContractId })),
      ];

      expect(ex67.pickMostActiveContract(events)).toBe(otherContractId);
    });

    it('returns null when no event carries a usable contract ID', () => {
      expect(ex67.pickMostActiveContract([])).toBeNull();
      expect(
        ex67.pickMostActiveContract([ex67.parseEventRecord(buildEvent({ contractId: undefined }))]),
      ).toBeNull();
    });
  });

  describe('runner and documentation registration', () => {
    it('registers the example with contract and ledger range parameters', () => {
      const entry = examples['67-soroban-contract-events'];

      expect(entry).toBeDefined();
      expect(typeof entry.run).toBe('function');
      expect(entry.params?.map((param) => param.name)).toEqual([
        'contractId',
        'startLedger',
        'endLedger',
        'limit',
      ]);
    });

    it('documents the example and the Horizon distinction in the README', () => {
      const readme = readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

      expect(readme).toContain('`67-soroban-contract-events`');
      expect(readme).toContain('npm run run-example 67-soroban-contract-events');
      expect(readme).toContain('Contract events are **not** Horizon events');
    });

    it('explains how contract events differ from Horizon events in the source', () => {
      const source = readFileSync(
        path.join(__dirname, '..', 'src', 'examples', '67-soroban-contract-events.ts'),
        'utf8',
      );

      expect(source).toContain('Contract events vs. Horizon events');
      expect(source).toContain('Anatomy of a Soroban event');
      expect(source).toContain('Event types');
    });
  });
});
