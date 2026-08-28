import {
  describeUnsupportedJsType,
  encodeAddress,
  encodeNested,
  formatJsValue,
  jsToScVal,
  roundTrip,
  scValToJs,
  serializeValue,
  stableStringify,
  trySerialize,
} from '../src/utils/scval-utils';

const TEST_ACCOUNT = 'GAGMSM3BKRHLXLJUE7ZDCXMPKL6YSUUMW5DGWL4EIBU4B32KYY6OB3MZ';

describe('scval-utils', () => {
  it('encodes primitives and options', () => {
    expect(jsToScVal(null, { type: 'option', element: { type: 'u32' } }).switch().name).toBe(
      'scvVoid',
    );
    expect(jsToScVal(42, { type: 'u32' }).switch().name).toBe('scvU32');
    expect(jsToScVal(42, { type: 'i64' }).switch().name).toBe('scvI64');
  });

  it('formats nested JavaScript values', () => {
    const map = new Map<string, unknown>([['a', 1n]]);
    expect(formatJsValue(map)).toEqual({ a: '1' });
    expect(formatJsValue([1, 2])).toEqual([1, 2]);
    expect(formatJsValue(Uint8Array.from([1, 2]))).toBe('0x0102');
    expect(formatJsValue({ nested: { ok: true } })).toEqual({ nested: { ok: true } });
  });

  it('serializes values and round-trips simple types', () => {
    const encoded = serializeValue('hello', { type: 'string' });
    expect(encoded.xdrType).toBe('scvString');
    expect(encoded.rawXdr.length).toBeGreaterThan(0);

    const trip = roundTrip(true, { type: 'bool' });
    expect(trip.matches).toBe(true);
    expect(scValToJs(encoded.scVal)).toBe('hello');
  });

  it('encodes valid Stellar addresses and rejects invalid values', () => {
    expect(encodeAddress(TEST_ACCOUNT).switch().name).toBe('scvAddress');
    expect(() => encodeAddress('not-an-address')).toThrow(/Invalid Stellar address/);
  });

  it('encodes nested maps with supported value types', () => {
    const nested = encodeNested({
      flag: true,
      count: 3,
      label: 'ok',
      big: 9n,
      child: { inner: false },
    });
    expect(nested.switch().name).toBe('scvMap');
  });

  it('rejects unsupported nested values', () => {
    expect(() => encodeNested({ bad: Symbol('x') as unknown as string })).toThrow(
      /Unsupported nested value/,
    );
  });

  it('describes unsupported JavaScript types', () => {
    expect(describeUnsupportedJsType(undefined)).toContain('undefined');
    expect(describeUnsupportedJsType(() => undefined)).toContain('Functions');
    expect(describeUnsupportedJsType(new Date())).toContain('Date');
    expect(describeUnsupportedJsType(Symbol('x'))).toContain('not supported');
  });

  it('stable-stringifies bigint and byte values', () => {
    expect(stableStringify({ value: 5n })).toBe('{"value":"5"}');
    expect(stableStringify(Uint8Array.from([0]))).toBe('"0x00"');
  });

  it('returns structured success and failure from trySerialize', () => {
    const ok = trySerialize(true, { type: 'bool' });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.result.scVal.switch().name).toBe('scvBool');
    }

    const failed = trySerialize(Symbol('x'), { type: 'string' });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.length).toBeGreaterThan(0);
    }
  });
});
