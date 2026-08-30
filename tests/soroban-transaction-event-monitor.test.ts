import { Address, Contract, nativeToScVal, xdr } from '@stellar/stellar-sdk';

import {
  isValidTxHash,
  decodeScVal,
  formatNativeValue,
  extractEventName,
  extractContractId,
  parseEventRecord,
  groupEvents,
  pollTransaction,
  monitorTransaction,
  RawEventRecord,
  DecodedEvent,
  PollConfig,
} from '../src/examples/190-soroban-transaction-event-monitor';
import { examples } from '../src/runner/catalog';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_HASH = 'a'.repeat(64);
const CONTRACT_ID = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const ACCOUNT_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

function buildEvent(overrides: Partial<RawEventRecord> = {}): RawEventRecord {
  return {
    id: '0001234567890-0000000001',
    type: 'contract',
    ledger: 1000,
    ledgerClosedAt: '2026-07-28T10:00:00Z',
    txHash: VALID_HASH,
    contractId: CONTRACT_ID,
    topic: [
      xdr.ScVal.scvSymbol('transfer'),
      nativeToScVal(new Address(ACCOUNT_ID)),
    ],
    value: nativeToScVal(999n, { type: 'i128' }),
    inSuccessfulContractCall: true,
    pagingToken: '0001234567890-0000000001',
    ...overrides,
  } as unknown as RawEventRecord;
}

// ---------------------------------------------------------------------------
// isValidTxHash
// ---------------------------------------------------------------------------

describe('isValidTxHash', () => {
  it('accepts a 64-char lowercase hex string', () => {
    expect(isValidTxHash(VALID_HASH)).toBe(true);
  });

  it('accepts uppercase hex', () => {
    expect(isValidTxHash('B'.repeat(64))).toBe(true);
  });

  it('rejects strings shorter than 64 chars', () => {
    expect(isValidTxHash('a'.repeat(63))).toBe(false);
  });

  it('rejects strings longer than 64 chars', () => {
    expect(isValidTxHash('a'.repeat(65))).toBe(false);
  });

  it('rejects non-hex characters', () => {
    expect(isValidTxHash('g'.repeat(64))).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidTxHash('')).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isValidTxHash(null as any)).toBe(false);
    expect(isValidTxHash(undefined as any)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// decodeScVal
// ---------------------------------------------------------------------------

describe('decodeScVal', () => {
  it('decodes a symbol', () => {
    const val = xdr.ScVal.scvSymbol('mint');
    const result = decodeScVal(val);
    expect(result.xdrType).toBe('scvSymbol');
    expect(result.value).toBe('mint');
    expect(result.decoded).toBe(true);
  });

  it('decodes an i128 as a string', () => {
    const val = nativeToScVal(12345n, { type: 'i128' });
    const result = decodeScVal(val);
    expect(result.xdrType).toBe('scvI128');
    expect(result.value).toBe('12345');
    expect(result.decoded).toBe(true);
  });

  it('returns void for undefined input', () => {
    const result = decodeScVal(undefined);
    expect(result).toEqual({ xdrType: 'void', value: null, decoded: true });
  });

  it('handles unsupported types without throwing', () => {
    const broken = { switch: () => ({ name: 'scvUnknown' }) } as any;
    const result = decodeScVal(broken);
    expect(result.decoded).toBe(false);
    expect(result.xdrType).toBe('scvUnknown');
  });
});

// ---------------------------------------------------------------------------
// formatNativeValue
// ---------------------------------------------------------------------------

describe('formatNativeValue', () => {
  it('converts BigInt to string', () => {
    expect(formatNativeValue(42n)).toBe('42');
  });

  it('converts Buffer to 0x-prefixed hex', () => {
    expect(formatNativeValue(Buffer.from([0xca, 0xfe]))).toBe('0xcafe');
  });

  it('recursively handles arrays', () => {
    expect(formatNativeValue([1n, 2n])).toEqual(['1', '2']);
  });

  it('handles plain objects with BigInt values', () => {
    expect(formatNativeValue({ amount: 7n })).toEqual({ amount: '7' });
  });

  it('handles Map instances', () => {
    const m = new Map<unknown, unknown>([['k', 5n]]);
    expect(formatNativeValue(m)).toEqual({ k: '5' });
  });

  it('passes through primitives unchanged', () => {
    expect(formatNativeValue('hello')).toBe('hello');
    expect(formatNativeValue(42)).toBe(42);
    expect(formatNativeValue(null)).toBeNull();
  });

  it('produces JSON-serializable output for complex values', () => {
    const result = formatNativeValue({ total: 2n ** 100n, nested: { x: [1n] } });
    expect(() => JSON.stringify(result)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// extractEventName
// ---------------------------------------------------------------------------

describe('extractEventName', () => {
  it('returns the symbol string from the first topic', () => {
    const topics = [{ xdrType: 'scvSymbol', value: 'burn', decoded: true }];
    expect(extractEventName(topics)).toBe('burn');
  });

  it('returns null when first topic is not a symbol', () => {
    const topics = [{ xdrType: 'scvAddress', value: ACCOUNT_ID, decoded: true }];
    expect(extractEventName(topics)).toBeNull();
  });

  it('returns null for empty topics', () => {
    expect(extractEventName([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractContractId
// ---------------------------------------------------------------------------

describe('extractContractId', () => {
  it('returns the string as-is', () => {
    expect(extractContractId(CONTRACT_ID)).toBe(CONTRACT_ID);
  });

  it('extracts the ID from a Contract instance', () => {
    const contract = new Contract(CONTRACT_ID);
    expect(extractContractId(contract)).toBe(contract.address().toString());
  });

  it('returns empty string for null/undefined', () => {
    expect(extractContractId(null)).toBe('');
    expect(extractContractId(undefined)).toBe('');
  });

  it('returns empty string for unexpected types', () => {
    expect(extractContractId({ unexpected: true })).toBe('');
  });
});

// ---------------------------------------------------------------------------
// parseEventRecord
// ---------------------------------------------------------------------------

describe('parseEventRecord', () => {
  it('decodes topics and value, captures event name from first symbol', () => {
    const parsed = parseEventRecord(buildEvent());
    expect(parsed.eventName).toBe('transfer');
    expect(parsed.topics).toHaveLength(2);
    expect(parsed.topics[0]).toMatchObject({ xdrType: 'scvSymbol', value: 'transfer' });
    expect(parsed.value.xdrType).toBe('scvI128');
    expect(parsed.value.value).toBe('999');
  });

  it('preserves ledger, txHash, contractId, and pagingToken', () => {
    const parsed = parseEventRecord(buildEvent());
    expect(parsed.ledger).toBe(1000);
    expect(parsed.txHash).toBe(VALID_HASH);
    expect(parsed.contractId).toBe(CONTRACT_ID);
    expect(parsed.pagingToken).toBe('0001234567890-0000000001');
  });

  it('preserves raw XDR alongside decoded values', () => {
    const parsed = parseEventRecord(buildEvent());
    expect(parsed.rawTopics).toHaveLength(2);
    expect(parsed.rawTopics[0]).toBeTruthy();
    expect(parsed.rawValue).toBeTruthy();
  });

  it('handles an event with no topics', () => {
    const parsed = parseEventRecord(buildEvent({ topic: [] }));
    expect(parsed.topics).toHaveLength(0);
    expect(parsed.eventName).toBeNull();
  });

  it('defaults inSuccessfulContractCall to true when absent', () => {
    const parsed = parseEventRecord(buildEvent({ inSuccessfulContractCall: undefined }));
    expect(parsed.inSuccessfulContractCall).toBe(true);
  });

  it('flags failed sub-call events', () => {
    const parsed = parseEventRecord(buildEvent({ inSuccessfulContractCall: false }));
    expect(parsed.inSuccessfulContractCall).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// groupEvents
// ---------------------------------------------------------------------------

describe('groupEvents', () => {
  const OTHER_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';

  function makeDecoded(overrides: Partial<DecodedEvent> = {}): DecodedEvent {
    return {
      id: '1',
      type: 'contract',
      contractId: CONTRACT_ID,
      ledger: 1000,
      ledgerClosedAt: '',
      txHash: VALID_HASH,
      pagingToken: '',
      inSuccessfulContractCall: true,
      topics: [],
      eventName: 'transfer',
      value: { xdrType: 'void', value: null, decoded: true },
      rawTopics: [],
      rawValue: '',
      ...overrides,
    };
  }

  it('groups by contractId', () => {
    const events = [
      makeDecoded({ contractId: CONTRACT_ID }),
      makeDecoded({ contractId: OTHER_CONTRACT }),
      makeDecoded({ contractId: CONTRACT_ID }),
    ];
    const { byContract } = groupEvents(events);
    expect(byContract[CONTRACT_ID]).toHaveLength(2);
    expect(byContract[OTHER_CONTRACT]).toHaveLength(1);
  });

  it('groups by eventName', () => {
    const events = [
      makeDecoded({ eventName: 'mint' }),
      makeDecoded({ eventName: 'burn' }),
      makeDecoded({ eventName: 'mint' }),
    ];
    const { byEventName } = groupEvents(events);
    expect(byEventName['mint']).toHaveLength(2);
    expect(byEventName['burn']).toHaveLength(1);
  });

  it('returns empty groups for an empty event array', () => {
    const { byContract, byEventName } = groupEvents([]);
    expect(Object.keys(byContract)).toHaveLength(0);
    expect(Object.keys(byEventName)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// pollTransaction
// ---------------------------------------------------------------------------

describe('pollTransaction', () => {
  const config: PollConfig = { intervalMs: 0, maxIntervalMs: 10, timeoutMs: 5_000 };

  function makeServer(responses: Array<() => rpc.Api.GetTransactionResponse | never>): any {
    let call = 0;
    return {
      getTransaction: jest.fn(async () => {
        const fn = responses[Math.min(call++, responses.length - 1)];
        return fn();
      }),
    };
  }

  it('returns SUCCESS on first successful response', async () => {
    const server = makeServer([
      () => ({ status: rpc.Api.GetTransactionStatus.SUCCESS }) as any,
    ]);
    const result = await pollTransaction(server, VALID_HASH, config);
    expect(result.kind).toBe('SUCCESS');
    expect(result.attempts).toBe(1);
  });

  it('returns FAILED on a failed transaction', async () => {
    const server = makeServer([
      () => ({ status: rpc.Api.GetTransactionStatus.FAILED }) as any,
    ]);
    const result = await pollTransaction(server, VALID_HASH, config);
    expect(result.kind).toBe('FAILED');
  });

  it('polls past NOT_FOUND before reaching SUCCESS', async () => {
    let calls = 0;
    const server = {
      getTransaction: jest.fn(async () => {
        calls++;
        if (calls < 3) return { status: rpc.Api.GetTransactionStatus.NOT_FOUND } as any;
        return { status: rpc.Api.GetTransactionStatus.SUCCESS } as any;
      }),
    };
    const result = await pollTransaction(server, VALID_HASH, config);
    expect(result.kind).toBe('SUCCESS');
    expect(result.attempts).toBeGreaterThanOrEqual(3);
  });

  it('returns TIMEOUT when the deadline expires', async () => {
    const tightConfig: PollConfig = { intervalMs: 10, maxIntervalMs: 10, timeoutMs: 1 };
    const server = makeServer([
      () => ({ status: rpc.Api.GetTransactionStatus.NOT_FOUND }) as any,
    ]);
    const result = await pollTransaction(server, VALID_HASH, tightConfig);
    expect(result.kind).toBe('TIMEOUT');
  });

  it('retries after a transient RPC error without immediately failing', async () => {
    let calls = 0;
    const server = {
      getTransaction: jest.fn(async () => {
        calls++;
        if (calls === 1) throw new Error('network error');
        return { status: rpc.Api.GetTransactionStatus.SUCCESS } as any;
      }),
    };
    const result = await pollTransaction(server, VALID_HASH, config);
    expect(result.kind).toBe('SUCCESS');
  });
});

// ---------------------------------------------------------------------------
// monitorTransaction
// ---------------------------------------------------------------------------

describe('monitorTransaction', () => {
  const config: PollConfig = { intervalMs: 0, maxIntervalMs: 10, timeoutMs: 5_000 };

  function makeServer(txStatus: string, ledger = 1000): any {
    return {
      getTransaction: jest.fn(async () => ({
        status: txStatus,
        ledger,
        createdAt: '1700000000',
        envelopeXdr: null,
        resultXdr: null,
        returnValue: undefined,
      })),
      getEvents: jest.fn(async () => ({ events: [] })),
    };
  }

  it('builds a SUCCESS report with correct ledger and status', async () => {
    const server = makeServer(rpc.Api.GetTransactionStatus.SUCCESS);
    const report = await monitorTransaction(server, VALID_HASH, config);
    expect(report.status).toBe('SUCCESS');
    expect(report.ledger).toBe(1000);
    expect(report.error).toBeNull();
  });

  it('builds a FAILED report with an error message', async () => {
    const server = makeServer(rpc.Api.GetTransactionStatus.FAILED);
    const report = await monitorTransaction(server, VALID_HASH, config);
    expect(report.status).toBe('FAILED');
    expect(report.error).toBeTruthy();
  });

  it('handles empty event list gracefully', async () => {
    const server = makeServer(rpc.Api.GetTransactionStatus.SUCCESS);
    const report = await monitorTransaction(server, VALID_HASH, config);
    expect(report.events).toHaveLength(0);
    expect(report.totalEvents).toBe(0);
  });

  it('returns TIMEOUT report when deadline is exceeded', async () => {
    const tightConfig: PollConfig = { intervalMs: 10, maxIntervalMs: 10, timeoutMs: 1 };
    const server = {
      getTransaction: jest.fn(async () => ({
        status: rpc.Api.GetTransactionStatus.NOT_FOUND,
      })),
      getEvents: jest.fn(async () => ({ events: [] })),
    };
    const report = await monitorTransaction(server, VALID_HASH, tightConfig);
    expect(report.status).toBe('TIMEOUT');
    expect(report.error).toContain('Timed out');
  });
});

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------

describe('JSON output', () => {
  it('isValidTxHash rejects short hash before any RPC call', () => {
    expect(isValidTxHash('abc')).toBe(false);
  });

  it('a full report serializes without throwing', () => {
    const report = {
      txHash: VALID_HASH,
      status: 'SUCCESS',
      ledger: 1000,
      events: [parseEventRecord(buildEvent())],
    };
    expect(() => JSON.stringify(report)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Runner registration
// ---------------------------------------------------------------------------

describe('runner registration', () => {
  it('is registered in the catalog', () => {
    expect(examples['190-soroban-transaction-event-monitor']).toBeDefined();
  });

  it('has a run function', () => {
    expect(typeof examples['190-soroban-transaction-event-monitor'].run).toBe('function');
  });

  it('has a description', () => {
    expect(examples['190-soroban-transaction-event-monitor'].description.length).toBeGreaterThan(
      10,
    );
  });

  it('prompts for rpcUrl and txHash', () => {
    const params = examples['190-soroban-transaction-event-monitor'].params ?? [];
    const names = params.map((p) => p.name);
    expect(names).toContain('rpcUrl');
    expect(names).toContain('txHash');
  });
});

// ---------------------------------------------------------------------------
// README documentation
// ---------------------------------------------------------------------------

describe('README documentation', () => {
  it('lists the example in the README catalog', () => {
    const readme = require('fs').readFileSync('README.md', 'utf8');
    expect(readme).toContain('190-soroban-transaction-event-monitor');
  });
});
