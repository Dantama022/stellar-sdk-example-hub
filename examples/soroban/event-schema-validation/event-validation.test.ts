/**
 * event-validation.test.ts
 *
 * Unit tests for the Soroban contract event schema validation example.
 * All RPC interactions are mocked; no network calls are made.
 *
 * Coverage areas:
 *  - Event query configuration (contract ID, limit, event type, ledger range)
 *  - Event retrieval (happy path, empty response, pagination, RPC failure)
 *  - Topic and payload decoding (symbol, address, integer, map, vector,
 *    unsupported type, malformed XDR)
 *  - Schema definition and resolution
 *  - Event validation (valid, missing field, wrong type, failed sub-call)
 *  - De-duplication of duplicate event records
 */

import { Address, Contract, nativeToScVal, xdr } from '@stellar/stellar-sdk';

import {
  deduplicateEvents,
  EventQueryParams,
  extractValidLedgerRange,
  filterEventsByLedgerRange,
  isEndLedgerUnsupportedError,
  isLedgerRangeError,
  normalizeContractId,
  normalizeEventType,
  normalizeLimit,
  parseLedgerInput,
  queryContractEvents,
  RawEventRecord,
  resolveLedgerRange,
  SorobanRpcServer,
} from './event-query';

import {
  decodeScVal,
  extractContractId,
  extractEventName,
  formatNativeValue,
  parseEventRecord,
  renderDecodedValue,
} from './decoder';

import {
  BURN_SCHEMA,
  DEFAULT_SCHEMA_REGISTRY,
  MINT_SCHEMA,
  resolveSchema,
  SchemaRegistry,
  TRANSFER_SCHEMA,
  UNKNOWN_EVENT_SCHEMA,
} from './schema';

import { validateEvent, validateEvents } from './validator';

// ─── shared test fixtures ─────────────────────────────────────────────────────

const CONTRACT_ID = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const OTHER_CONTRACT_ID = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const ACCOUNT_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const TX_HASH = 'a'.repeat(64);

/** Builds a minimal raw event record, with sensible defaults. */
function buildRawEvent(overrides: Partial<RawEventRecord> = {}): RawEventRecord {
  return {
    id: '0001234567890-0000000001',
    type: 'contract',
    ledger: 1000,
    ledgerClosedAt: '2026-07-28T10:00:00Z',
    txHash: TX_HASH,
    contractId: CONTRACT_ID,
    topic: [
      xdr.ScVal.scvSymbol('transfer'),
      nativeToScVal(new Address(ACCOUNT_ID)),
      nativeToScVal(new Address(CONTRACT_ID)),
    ],
    value: nativeToScVal(1_000_000n, { type: 'i128' }),
    inSuccessfulContractCall: true,
    pagingToken: '0001234567890-0000000001',
    ...overrides,
  };
}

/** Returns a mock RPC server whose getEvents resolves with the supplied value. */
function mockServer(response: Partial<{ events: RawEventRecord[] | null; latestLedger: number; cursor: string }>): SorobanRpcServer {
  return {
    getEvents: async () => ({
      events: response.events ?? [],
      latestLedger: response.latestLedger ?? 2000,
      cursor: response.cursor ?? '',
    }),
  } as unknown as SorobanRpcServer;
}

function defaultQueryParams(overrides: Partial<EventQueryParams> = {}): EventQueryParams {
  return {
    latestLedger: 2000,
    range: { startLedger: 1000 },
    filters: [{ type: 'contract', contractIds: [CONTRACT_ID] }],
    limit: 10,
    ...overrides,
  };
}

// ─── 1. Event query configuration ─────────────────────────────────────────────

describe('Event query configuration', () => {
  describe('normalizeContractId', () => {
    it('accepts and trims a valid contract strkey', () => {
      expect(normalizeContractId(`  ${CONTRACT_ID}  `)).toBe(CONTRACT_ID);
    });

    it('rejects empty input', () => {
      expect(() => normalizeContractId('')).toThrow(/Missing contract ID/);
      expect(() => normalizeContractId('   ')).toThrow(/Missing contract ID/);
    });

    it('rejects an account strkey', () => {
      expect(() => normalizeContractId(ACCOUNT_ID)).toThrow(/Invalid contract ID/);
    });

    it('rejects a malformed string', () => {
      expect(() => normalizeContractId('CNOTAREALCONTRACT')).toThrow(/Invalid contract ID/);
    });
  });

  describe('normalizeLimit', () => {
    it('defaults to 10 for undefined input', () => {
      expect(normalizeLimit(undefined)).toBe(10);
    });

    it('parses a numeric string', () => {
      expect(normalizeLimit('25')).toBe(25);
    });

    it('clamps below minimum to 1', () => {
      expect(normalizeLimit(0)).toBe(1);
    });

    it('clamps above maximum to 200', () => {
      expect(normalizeLimit(5000)).toBe(200);
    });

    it('defaults to 10 for non-numeric strings', () => {
      expect(normalizeLimit('not-a-number')).toBe(10);
    });
  });

  describe('normalizeEventType', () => {
    it('accepts "system"', () => expect(normalizeEventType('system')).toBe('system'));
    it('accepts "diagnostic" case-insensitively', () => expect(normalizeEventType('DIAGNOSTIC')).toBe('diagnostic'));
    it('defaults to "contract" for unknown values', () => expect(normalizeEventType('nonsense')).toBe('contract'));
    it('defaults to "contract" when undefined', () => expect(normalizeEventType(undefined)).toBe('contract'));
  });

  describe('parseLedgerInput', () => {
    it('parses a numeric string', () => expect(parseLedgerInput('1234')).toBe(1234));
    it('passes through a number', () => expect(parseLedgerInput(1234)).toBe(1234));
    it('returns undefined for empty string', () => expect(parseLedgerInput('')).toBeUndefined());
    it('returns undefined for non-numeric string', () => expect(parseLedgerInput('not-a-number')).toBeUndefined());
    it('returns undefined for 0', () => expect(parseLedgerInput(0)).toBeUndefined());
    it('returns undefined for undefined', () => expect(parseLedgerInput(undefined)).toBeUndefined());
  });

  describe('resolveLedgerRange', () => {
    it('defaults to a 17 280-ledger lookback', () => {
      const r = resolveLedgerRange(100000);
      expect(r.startLedger).toBe(100000 - 17280);
      expect(r.endLedger).toBeUndefined();
    });

    it('honours explicit start and end', () => {
      expect(resolveLedgerRange(100000, { startLedger: 500, endLedger: 900 })).toEqual({
        startLedger: 500,
        endLedger: 900,
      });
    });

    it('clamps an end beyond the latest ledger', () => {
      expect(resolveLedgerRange(1000, { startLedger: 10, endLedger: 99999 })).toEqual({
        startLedger: 10,
        endLedger: 1000,
      });
    });

    it('raises an end below the start to the start', () => {
      expect(resolveLedgerRange(1000, { startLedger: 900, endLedger: 500 })).toEqual({
        startLedger: 900,
        endLedger: 900,
      });
    });

    it('clamps the start to 1 when the lookback exceeds history', () => {
      expect(resolveLedgerRange(50).startLedger).toBe(1);
    });
  });
});

// ─── 2. Event retrieval ────────────────────────────────────────────────────────

describe('Event retrieval', () => {
  it('returns events from a successful query', async () => {
    const server = mockServer({ events: [buildRawEvent()], latestLedger: 2000 });
    const result = await queryContractEvents(server, defaultQueryParams());
    expect(result.response.events).toHaveLength(1);
    expect(result.response.latestLedger).toBe(2000);
  });

  it('handles an empty event result', async () => {
    const server = mockServer({ events: [], latestLedger: 2000 });
    const result = await queryContractEvents(server, defaultQueryParams());
    expect(result.response.events).toEqual([]);
  });

  it('handles a null events array in the RPC response', async () => {
    const server = mockServer({ events: null, latestLedger: 2000 });
    const result = await queryContractEvents(server, defaultQueryParams());
    // The SDK normalises null to an empty array; callers can safely iterate.
    const events = (result.response.events ?? []).map(parseEventRecord);
    expect(events).toHaveLength(0);
  });

  it('propagates an RPC failure that is not ledger-range related', async () => {
    const server: SorobanRpcServer = {
      getEvents: async () => { throw new Error('502 Bad Gateway'); },
    } as unknown as SorobanRpcServer;

    await expect(queryContractEvents(server, defaultQueryParams())).rejects.toThrow('502 Bad Gateway');
  });

  it('retries when the server advertises a narrower range', async () => {
    const calls: unknown[] = [];
    const server: SorobanRpcServer = {
      getEvents: async (req: unknown) => {
        calls.push(req);
        const r = req as { startLedger: number };
        if (r.startLedger < 500) {
          throw new Error('startLedger must be within the ledger range: 500 - 2000');
        }
        return { events: [buildRawEvent({ ledger: 600 })], latestLedger: 2000, cursor: '' };
      },
    } as unknown as SorobanRpcServer;

    const result = await queryContractEvents(server, defaultQueryParams({ range: { startLedger: 1 } }));
    expect(calls).toHaveLength(2);
    expect(result.range.startLedger).toBe(500);
  });

  it('drops endLedger when the server does not support it', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const server: SorobanRpcServer = {
      getEvents: async (req: Record<string, unknown>) => {
        calls.push({ ...req });
        if (req['endLedger'] !== undefined) {
          throw new Error('unknown parameter endLedger');
        }
        return { events: [], latestLedger: 2000, cursor: '' };
      },
    } as unknown as SorobanRpcServer;

    const result = await queryContractEvents(
      server,
      defaultQueryParams({ range: { startLedger: 500, endLedger: 800 } }),
    );
    expect(calls[0]['endLedger']).toBe(800);
    expect(calls[1]['endLedger']).toBeUndefined();
    expect(result.endLedgerApplied).toBe(false);
  });

  it('never retries the same range twice (loop-termination guard)', async () => {
    const seen: string[] = [];
    const server: SorobanRpcServer = {
      getEvents: async (req: { startLedger: number; endLedger?: number }) => {
        seen.push(`${req.startLedger}-${req.endLedger}`);
        if (seen.length > 20) throw new Error('retry loop did not terminate');
        throw new Error('startLedger must be within the ledger range: 3831828 - 3849108');
      },
    } as unknown as SorobanRpcServer;

    await expect(
      queryContractEvents(server, {
        latestLedger: 3849108,
        range: { startLedger: 1, endLedger: 3 },
        filters: [{ type: 'contract' }],
        limit: 10,
      }),
    ).rejects.toThrow(/ledger range/);

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeLessThanOrEqual(3);
  });

  it('recognises a retention-window error', () => {
    expect(isLedgerRangeError(new Error('startLedger must be within the ledger range: 10 - 90'))).toBe(true);
    expect(isLedgerRangeError(new Error('start is before oldest ledger'))).toBe(true);
    expect(isLedgerRangeError(new Error('connection refused'))).toBe(false);
  });

  it('recognises an endLedger-unsupported error', () => {
    expect(isEndLedgerUnsupportedError(new Error('no such field: endLedger'))).toBe(true);
    expect(isEndLedgerUnsupportedError(new Error('timeout'))).toBe(false);
  });

  it('extracts a valid ledger range from a server error message', () => {
    expect(extractValidLedgerRange('ledger range: 10 - 90')).toEqual({ startLedger: 10, endLedger: 90 });
    expect(extractValidLedgerRange('oldest ledger is 4242')).toEqual({ startLedger: 4242 });
    expect(extractValidLedgerRange('something else entirely')).toBeNull();
  });

  it('filters events client-side by ledger range', () => {
    const events = [100, 200, 300].map((ledger) => parseEventRecord(buildRawEvent({ ledger })));
    expect(
      filterEventsByLedgerRange(events, { startLedger: 150, endLedger: 250 }).map((e) => e.ledger),
    ).toEqual([200]);
    expect(
      filterEventsByLedgerRange(events, { startLedger: 150 }).map((e) => e.ledger),
    ).toEqual([200, 300]);
  });
});

// ─── 3. Topic decoding ─────────────────────────────────────────────────────────

describe('Topic decoding', () => {
  it('decodes a symbol topic', () => {
    const decoded = decodeScVal(xdr.ScVal.scvSymbol('transfer'));
    expect(decoded.xdrType).toBe('scvSymbol');
    expect(decoded.decoded).toBe(true);
    expect(decoded.value).toBe('transfer');
  });

  it('decodes an address topic', () => {
    const decoded = decodeScVal(nativeToScVal(new Address(ACCOUNT_ID)));
    expect(decoded.xdrType).toBe('scvAddress');
    expect(decoded.decoded).toBe(true);
    expect(decoded.value).toBe(ACCOUNT_ID);
  });

  it('decodes an i128 integer', () => {
    const decoded = decodeScVal(nativeToScVal(1234567890n, { type: 'i128' }));
    expect(decoded.xdrType).toBe('scvI128');
    expect(decoded.decoded).toBe(true);
    expect(decoded.value).toBe('1234567890');
  });

  it('decodes a u64 integer', () => {
    const decoded = decodeScVal(nativeToScVal(999n, { type: 'u64' }));
    expect(decoded.xdrType).toBe('scvU64');
    expect(decoded.decoded).toBe(true);
    expect(decoded.value).toBe('999');
  });

  it('decodes a vector', () => {
    // Use string values to build a vec; bigints inside a vec require an explicit
    // per-element type hint which the SDK does not support via the array shorthand.
    const vec = nativeToScVal(['alpha', 'beta', 'gamma']);
    const decoded = decodeScVal(vec);
    expect(decoded.xdrType).toBe('scvVec');
    expect(decoded.decoded).toBe(true);
    expect(Array.isArray(decoded.value)).toBe(true);
  });

  it('decodes a map payload', () => {
    const map = nativeToScVal({ amount: 500n, memo: 'invoice-1' });
    const decoded = decodeScVal(map);
    expect(decoded.xdrType).toBe('scvMap');
    expect(decoded.decoded).toBe(true);
    expect(decoded.value).toMatchObject({ amount: '500', memo: 'invoice-1' });
  });

  it('reports an unsupported ScVal type without throwing', () => {
    const bogus = { switch: () => ({ name: 'scvContractInstanceWasm' }), toXDR: () => Buffer.alloc(0) } as unknown as xdr.ScVal;
    const decoded = decodeScVal(bogus);
    expect(decoded.decoded).toBe(false);
    expect(decoded.xdrType).toBe('scvContractInstanceWasm');
    expect(decoded.error).toMatch(/not supported/);
  });

  it('reports malformed XDR without throwing', () => {
    // Simulate a value whose toXDR and scValToNative both fail.
    const broken = {
      switch: () => ({ name: 'scvI128' }),
      toXDR: () => { throw new Error('corrupt XDR'); },
    } as unknown as xdr.ScVal;
    const decoded = decodeScVal(broken);
    // rawXdr serialisation failed; decoded should still report gracefully.
    expect(decoded.rawXdr).toContain('could not serialize');
  });

  it('treats undefined as void', () => {
    const decoded = decodeScVal(undefined);
    expect(decoded).toEqual({ xdrType: 'void', rawXdr: '', value: null, decoded: true });
  });
});

// ─── 4. Event data decoding ────────────────────────────────────────────────────

describe('Event data decoding', () => {
  it('decodes all topics and the payload in a parsed event record', () => {
    const parsed = parseEventRecord(buildRawEvent());
    expect(parsed.topics).toHaveLength(3);
    expect(parsed.topics[0]).toMatchObject({ xdrType: 'scvSymbol', value: 'transfer', decoded: true });
    expect(parsed.topics[1]).toMatchObject({ xdrType: 'scvAddress', value: ACCOUNT_ID });
    expect(parsed.topics[2]).toMatchObject({ xdrType: 'scvAddress', value: CONTRACT_ID });
    expect(parsed.value.xdrType).toBe('scvI128');
    expect(parsed.value.value).toBe('1000000');
  });

  it('extracts event name from the first symbol topic', () => {
    expect(parseEventRecord(buildRawEvent()).eventName).toBe('transfer');
  });

  it('returns null event name when first topic is not a symbol', () => {
    const parsed = parseEventRecord(buildRawEvent({ topic: [nativeToScVal(new Address(ACCOUNT_ID))] }));
    expect(parsed.eventName).toBeNull();
  });

  it('returns null event name for empty topic array', () => {
    expect(extractEventName([])).toBeNull();
    expect(parseEventRecord(buildRawEvent({ topic: [] })).eventName).toBeNull();
  });

  it('defaults inSuccessfulContractCall to true when absent', () => {
    const parsed = parseEventRecord(buildRawEvent({ inSuccessfulContractCall: undefined }));
    expect(parsed.inSuccessfulContractCall).toBe(true);
  });

  it('preserves ledger, txHash, contractId, and pagingToken', () => {
    const parsed = parseEventRecord(buildRawEvent({ ledger: 9999 }));
    expect(parsed.ledger).toBe(9999);
    expect(parsed.txHash).toBe(TX_HASH);
    expect(parsed.contractId).toBe(CONTRACT_ID);
    expect(parsed.pagingToken).toBe('0001234567890-0000000001');
  });
});

// ─── 5. formatNativeValue ──────────────────────────────────────────────────────

describe('formatNativeValue', () => {
  it('converts bigint to string', () => {
    expect(formatNativeValue(42n)).toBe('42');
  });

  it('converts a Buffer to hex', () => {
    expect(formatNativeValue(Buffer.from([0xde, 0xad]))).toBe('0xdead');
  });

  it('recursively converts arrays', () => {
    expect(formatNativeValue([1n, Buffer.from([0x01])])).toEqual(['1', '0x01']);
  });

  it('converts a Map to a plain object', () => {
    expect(formatNativeValue(new Map<unknown, unknown>([['amount', 5n]]))).toEqual({ amount: '5' });
  });

  it('recursively converts plain objects', () => {
    expect(formatNativeValue({ total: 2n ** 100n })).toEqual({ total: (2n ** 100n).toString() });
  });

  it('passes through primitives unchanged', () => {
    expect(formatNativeValue('plain')).toBe('plain');
    expect(formatNativeValue(null)).toBeNull();
    expect(formatNativeValue(42)).toBe(42);
  });

  it('produces JSON-serializable output even for large bigints', () => {
    expect(() => JSON.stringify(formatNativeValue({ total: 2n ** 200n }))).not.toThrow();
  });
});

// ─── 6. renderDecodedValue ─────────────────────────────────────────────────────

describe('renderDecodedValue', () => {
  it('renders void as "void"', () => {
    expect(renderDecodedValue({ xdrType: 'void', rawXdr: '', value: null, decoded: true })).toBe('void');
  });

  it('renders an undecodable value', () => {
    expect(renderDecodedValue({ xdrType: 'scvBogus', rawXdr: '', value: null, decoded: false })).toContain('undecodable');
  });

  it('quotes string values', () => {
    expect(renderDecodedValue({ xdrType: 'scvSymbol', rawXdr: '', value: 'mint', decoded: true })).toBe('"mint"');
  });

  it('JSON-serializes object values', () => {
    expect(renderDecodedValue({ xdrType: 'scvVec', rawXdr: '', value: [1, 2], decoded: true })).toBe('[1,2]');
  });
});

// ─── 7. extractContractId ─────────────────────────────────────────────────────

describe('extractContractId', () => {
  it('passes through a strkey string', () => {
    expect(extractContractId(CONTRACT_ID)).toBe(CONTRACT_ID);
  });

  it('extracts from a Contract instance', () => {
    expect(extractContractId(new Contract(CONTRACT_ID))).toBe(CONTRACT_ID);
  });

  it('returns empty string for unrecognised input', () => {
    expect(extractContractId({ unexpected: true })).toBe('');
    expect(extractContractId(undefined)).toBe('');
  });
});

// ─── 8. Schema definition and resolution ──────────────────────────────────────

describe('Schema definition', () => {
  it('resolves the transfer schema by name', () => {
    expect(resolveSchema(DEFAULT_SCHEMA_REGISTRY, 'transfer')).toBe(TRANSFER_SCHEMA);
  });

  it('resolves the mint schema by name', () => {
    expect(resolveSchema(DEFAULT_SCHEMA_REGISTRY, 'mint')).toBe(MINT_SCHEMA);
  });

  it('resolves the burn schema by name', () => {
    expect(resolveSchema(DEFAULT_SCHEMA_REGISTRY, 'burn')).toBe(BURN_SCHEMA);
  });

  it('falls back to the wildcard schema for unknown event names', () => {
    expect(resolveSchema(DEFAULT_SCHEMA_REGISTRY, 'unknown_event')).toBe(UNKNOWN_EVENT_SCHEMA);
  });

  it('falls back to the wildcard schema when eventName is null', () => {
    expect(resolveSchema(DEFAULT_SCHEMA_REGISTRY, null)).toBe(UNKNOWN_EVENT_SCHEMA);
  });

  it('returns null when no schema and no wildcard are present', () => {
    const registry: SchemaRegistry = { schemas: [TRANSFER_SCHEMA] };
    expect(resolveSchema(registry, 'unknownEvent')).toBeNull();
  });
});

// ─── 9. Event validation ──────────────────────────────────────────────────────

describe('Event validation', () => {
  it('validates a correct transfer event as valid', () => {
    const event = parseEventRecord(buildRawEvent());
    const result = validateEvent(event);
    expect(result.valid).toBe(true);
    expect(result.schemaId).toBe('transfer');
    expect(result.findings.filter((f) => f.severity === 'error')).toHaveLength(0);
  });

  it('fails validation when topic count is wrong', () => {
    // Transfer expects 3 topics; provide only 1.
    const event = parseEventRecord(
      buildRawEvent({ topic: [xdr.ScVal.scvSymbol('transfer')] }),
    );
    const result = validateEvent(event);
    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.severity === 'error' && f.field === 'topics')).toBe(true);
  });

  it('fails validation when a topic has the wrong XDR type', () => {
    // Replace the "from" address topic (index 1) with a string.
    const event = parseEventRecord(
      buildRawEvent({
        topic: [
          xdr.ScVal.scvSymbol('transfer'),
          xdr.ScVal.scvString('not-an-address'),
          nativeToScVal(new Address(CONTRACT_ID)),
        ],
      }),
    );
    const result = validateEvent(event);
    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.field === 'topics[1]')).toBe(true);
  });

  it('fails validation when the payload XDR type is wrong', () => {
    // Transfer expects i128; provide a string instead.
    const event = parseEventRecord(
      buildRawEvent({ value: xdr.ScVal.scvString('wrong-type') }),
    );
    const result = validateEvent(event);
    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.field === 'value')).toBe(true);
  });

  it('issues a warning for a failed sub-call event', () => {
    const event = parseEventRecord(buildRawEvent({ inSuccessfulContractCall: false }));
    const result = validateEvent(event);
    expect(result.findings.some((f) => f.severity === 'warning' && f.field === 'inSuccessfulContractCall')).toBe(true);
  });

  it('reports a missing required map field', () => {
    // Build a schema that expects a "recipient" field in a map payload.
    const registry: SchemaRegistry = {
      schemas: [
        {
          id: 'custom_event',
          description: 'Custom event with a required map field',
          eventName: 'custom_event',
          payloadType: 'scvMap',
          payloadFields: [{ name: 'recipient', type: 'string' }],
        },
      ],
    };

    const mapWithoutRecipient = nativeToScVal({ amount: 100n });
    const event = parseEventRecord(
      buildRawEvent({
        topic: [xdr.ScVal.scvSymbol('custom_event')],
        value: mapWithoutRecipient,
      }),
    );

    const result = validateEvent(event, registry);
    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.field.includes('recipient') && f.severity === 'error')).toBe(true);
  });

  it('reports an unexpected field type in the payload', () => {
    const registry: SchemaRegistry = {
      schemas: [
        {
          id: 'typed_event',
          description: 'Event with typed fields',
          eventName: 'typed_event',
          payloadType: 'scvMap',
          payloadFields: [{ name: 'amount', type: 'bigint' }],
        },
      ],
    };

    // Provide a string where a bigint-string is expected… wait, bigint fields
    // are stored as strings post-formatting. Test an object field expecting
    // 'string' but receiving a number-formatted value.
    const registryNum: SchemaRegistry = {
      schemas: [
        {
          id: 'num_event',
          description: 'Event with a number field',
          eventName: 'num_event',
          // Declare 'count' as a plain JS 'number' type (non-bigint integer).
          payloadType: 'scvMap',
          payloadFields: [{ name: 'count', type: 'number' }],
        },
      ],
    };

    // nativeToScVal uses i128 for bigint → formatNativeValue → string.
    // A string is not 'number', so this should fail.
    const event = parseEventRecord(
      buildRawEvent({
        topic: [xdr.ScVal.scvSymbol('num_event')],
        value: nativeToScVal({ count: 42n }),
      }),
    );

    const result = validateEvent(event, registryNum);
    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.field.includes('count'))).toBe(true);
    void registry; // suppress unused variable warning
  });

  it('issues no error when a schema has no matching entry and no wildcard', () => {
    const registry: SchemaRegistry = { schemas: [TRANSFER_SCHEMA] };
    const event = parseEventRecord(
      buildRawEvent({ topic: [xdr.ScVal.scvSymbol('unknown_event')] }),
    );
    const result = validateEvent(event, registry);
    expect(result.valid).toBe(true);
    expect(result.schemaId).toBeNull();
  });

  it('validates a batch of events', () => {
    const events = [
      parseEventRecord(buildRawEvent()),                                // valid transfer
      parseEventRecord(buildRawEvent({ topic: [xdr.ScVal.scvSymbol('transfer')] })), // too few topics
    ];
    const results = validateEvents(events);
    expect(results[0].validation.valid).toBe(true);
    expect(results[1].validation.valid).toBe(false);
  });
});

// ─── 10. De-duplication ───────────────────────────────────────────────────────

describe('De-duplication', () => {
  it('removes duplicate events by ID', () => {
    const event = buildRawEvent();
    const duplicated = [event, { ...event }, { ...event, id: 'other-id' }];
    const deduplicated = deduplicateEvents(duplicated);
    expect(deduplicated).toHaveLength(2);
    expect(deduplicated.map((e) => e.id)).toEqual([event.id, 'other-id']);
  });

  it('leaves a list without duplicates unchanged', () => {
    const events = [
      buildRawEvent({ id: 'id-1' }),
      buildRawEvent({ id: 'id-2' }),
    ];
    expect(deduplicateEvents(events)).toHaveLength(2);
  });

  it('handles an empty list', () => {
    expect(deduplicateEvents([])).toEqual([]);
  });
});

// ─── 11. Event pagination ─────────────────────────────────────────────────────

describe('Event pagination', () => {
  it('passes a cursor through to the RPC request', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const server: SorobanRpcServer = {
      getEvents: async (req: Record<string, unknown>) => {
        captured.push({ ...req });
        return { events: [], latestLedger: 2000, cursor: 'next-page-cursor' };
      },
    } as unknown as SorobanRpcServer;

    await queryContractEvents(server, defaultQueryParams({ cursor: 'page-cursor-1' }));
    expect(captured[0]['cursor']).toBe('page-cursor-1');
  });

  it('returns the next cursor from the RPC response', async () => {
    const server = mockServer({ events: [], latestLedger: 2000, cursor: 'next-cursor' });
    const result = await queryContractEvents(server, defaultQueryParams());
    expect(result.response.cursor).toBe('next-cursor');
  });
});

// ─── 12. Edge: events from multiple contracts ─────────────────────────────────

describe('Events from multiple contracts', () => {
  it("preserves each event's own contractId rather than assuming a single contract", () => {
    const events = [
      parseEventRecord(buildRawEvent({ contractId: CONTRACT_ID })),
      parseEventRecord(buildRawEvent({ contractId: OTHER_CONTRACT_ID })),
    ];
    expect(events[0].contractId).toBe(CONTRACT_ID);
    expect(events[1].contractId).toBe(OTHER_CONTRACT_ID);
  });
});
