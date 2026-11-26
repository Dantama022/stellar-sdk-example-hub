import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import {
  decodeReturnValue,
  formatReport,
  getReturnType,
  inspectReturnValue,
  parseSpecification,
  toReadable,
  validateReturnType,
  type ExpectedType,
} from './index';

const ACCOUNT = 'GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX';
const CONTRACT = 'CARZQMYKDGA4TTIE2XBDJ42EX27VYLLJGGG4WGUIXXWIVHPDTX3UCLJA';

const decodeOk = (v: xdr.ScVal) => {
  const r = decodeReturnValue(v);
  expect(r.status).toBe('decoded');
  return r.node!;
};
const check = (v: xdr.ScVal, expectedType: ExpectedType) =>
  inspectReturnValue({ functionName: 'f', returnValue: v, expectedType });

describe('primitive decoding', () => {
  it('decodes booleans and void', () => {
    expect(decodeOk(xdr.ScVal.scvBool(true))).toMatchObject({ scType: 'scvBool', value: true });
    expect(decodeOk(xdr.ScVal.scvVoid())).toMatchObject({ scType: 'scvVoid', value: null });
  });

  it('decodes signed and unsigned 32-bit integers as numbers', () => {
    expect(decodeOk(xdr.ScVal.scvU32(4_000_000_000)).value).toBe(4_000_000_000);
    expect(decodeOk(xdr.ScVal.scvI32(-7)).value).toBe(-7);
  });

  it('decodes 64-bit and wider integers as bigint without precision loss', () => {
    const cases: Array<[string, bigint]> = [
      ['u64', 18446744073709551615n],
      ['i64', -9223372036854775808n],
      ['u128', 340282366920938463463374607431768211455n],
      ['i128', -170141183460469231731687303715884105728n],
      ['u256', 2n ** 256n - 1n],
      ['i256', -(2n ** 255n)],
    ];
    for (const [type, value] of cases) {
      const node = decodeOk(nativeToScVal(value, { type: type as never }));
      expect(node.scType).toBe(`scv${type.toUpperCase()}`);
      expect(node.value).toBe(value);
      expect(toReadable(node)).toBe(value.toString());
    }
  });

  it('decodes strings and symbols as distinct types', () => {
    expect(decodeOk(xdr.ScVal.scvString('héllo')).value).toBe('héllo');
    expect(decodeOk(xdr.ScVal.scvSymbol('transfer'))).toMatchObject({ scType: 'scvSymbol', value: 'transfer' });
  });

  it('decodes byte arrays', () => {
    const node = decodeOk(xdr.ScVal.scvBytes(Buffer.from('deadbeef', 'hex')));
    expect(Buffer.from(node.value as Uint8Array).toString('hex')).toBe('deadbeef');
    expect(toReadable(node)).toBe('deadbeef');
  });

  it('decodes account and contract addresses', () => {
    expect(decodeOk(new Address(ACCOUNT).toScVal()).value).toBe(ACCOUNT);
    expect(decodeOk(new Address(CONTRACT).toScVal()).value).toBe(CONTRACT);
  });

  it('decodes timepoint and duration', () => {
    expect(decodeOk(xdr.ScVal.scvTimepoint(new xdr.Uint64(1_700_000_000n))).value).toBe(1_700_000_000n);
    expect(decodeOk(xdr.ScVal.scvDuration(new xdr.Uint64(60n))).value).toBe(60n);
  });
});

describe('composite decoding', () => {
  it('decodes vectors and maps in wire order', () => {
    const vec = decodeOk(nativeToScVal([1, 2, 3], { type: 'u32' } as never));
    expect(vec.items!.map((i) => i.value)).toEqual([1, 2, 3]);
    const map = decodeOk(nativeToScVal({ a: 1, b: 2 }, { type: { a: ['symbol', 'u32'], b: ['symbol', 'u32'] } }));
    expect(map.entries!.map((e) => [e.key.value, e.value.value])).toEqual([['a', 1], ['b', 2]]);
  });

  it('decodes nested composite values', () => {
    const entry = (key: string, val: xdr.ScVal) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });
    const inner = xdr.ScVal.scvMap([
      entry('amounts', xdr.ScVal.scvVec([nativeToScVal(10n, { type: 'i128' }), nativeToScVal(20n, { type: 'i128' })])),
      entry('who', new Address(ACCOUNT).toScVal()),
    ]);
    const outer = xdr.ScVal.scvVec([inner, inner]);
    const node = decodeOk(outer);
    expect(node.items).toHaveLength(2);
    const readable = toReadable(node) as Array<Array<{ key: string; value: unknown }>>;
    expect(readable[0].find((e) => e.key === 'amounts')!.value).toEqual(['10', '20']);
  });

  it('accepts base64 XDR and raw XDR bytes as input', () => {
    const v = xdr.ScVal.scvU32(9);
    expect(decodeReturnValue(v.toXDR('base64')).node!.value).toBe(9);
    expect(decodeReturnValue(v.toXDR()).node!.value).toBe(9);
  });
});

describe('unsupported and malformed input', () => {
  it('preserves raw XDR for an unsupported type (scvError)', () => {
    const err = xdr.ScVal.scvError(xdr.ScError.sceContract(7));
    const r = decodeReturnValue(err);
    expect(r.status).toBe('failed');
    expect(r.errors[0]).toMatchObject({ code: 'UNSUPPORTED_TYPE', path: '$' });
    expect(r.node!.unsupportedRaw).toBe(err.toXDR('base64'));
    expect(r.rawXdr).toBe(err.toXDR('base64'));
  });

  it('keeps decoding the rest of a value that contains an unsupported element', () => {
    const err = xdr.ScVal.scvError(xdr.ScError.sceContract(1));
    const r = decodeReturnValue(xdr.ScVal.scvVec([xdr.ScVal.scvU32(1), err]));
    expect(r.status).toBe('partial');
    expect(r.node!.items![0].value).toBe(1);
    expect(r.node!.items![1].unsupportedRaw).toBe(err.toXDR('base64'));
    expect(r.errors[0].path).toBe('$[1]');
    expect(toReadable(r.node!)).toEqual([1, { unsupported: 'scvError', rawXdr: err.toXDR('base64') }]);
  });

  it('reports malformed XDR as a decoding error, not a type mismatch', () => {
    const r = decodeReturnValue('not-valid-xdr');
    expect(r.status).toBe('failed');
    expect(r.errors[0].code).toBe('MALFORMED_XDR');
    const report = inspectReturnValue({ functionName: 'f', returnValue: 'not-valid-xdr', expectedType: { kind: 'u32' } });
    expect(report.decoding.status).toBe('failed');
    expect(report.validation.status).toBe('inconclusive');
    expect(report.validation.mismatches).toEqual([]);
  });

  it('reports a missing return value', () => {
    for (const input of [undefined, null, '']) {
      const r = decodeReturnValue(input);
      expect(r.status).toBe('missing');
      expect(r.errors[0].code).toBe('MISSING_RETURN_VALUE');
    }
  });

  it('rejects input that is not an ScVal, XDR string or bytes', () => {
    const r = decodeReturnValue({ nope: true } as never);
    expect(r.status).toBe('failed');
    expect(r.errors[0].code).toBe('INVALID_SCVAL');
  });
});

describe('type validation', () => {
  it('accepts matching primitives, vectors, maps and options', () => {
    expect(check(xdr.ScVal.scvBool(false), { kind: 'bool' }).validation.status).toBe('valid');
    expect(check(xdr.ScVal.scvVec([xdr.ScVal.scvU32(1)]), { kind: 'vec', element: { kind: 'u32' } }).validation.status).toBe('valid');
    expect(check(xdr.ScVal.scvVoid(), { kind: 'option', value: { kind: 'u32' } }).validation.status).toBe('valid');
    expect(check(xdr.ScVal.scvU32(1), { kind: 'option', value: { kind: 'u32' } }).validation.status).toBe('valid');
    const map = nativeToScVal({ a: 1 }, { type: { a: ['symbol', 'u32'] } });
    expect(check(map, { kind: 'map', key: { kind: 'symbol' }, value: { kind: 'u32' } }).validation.status).toBe('valid');
  });

  it('reports a return type mismatch with path, expected and actual', () => {
    const report = check(xdr.ScVal.scvString('7'), { kind: 'u32' });
    expect(report.decoding.status).toBe('decoded');
    expect(report.validation.status).toBe('mismatch');
    expect(report.validation.mismatches[0]).toMatchObject({ path: '$', expected: 'u32', actual: 'scvString' });
  });

  it('does not accept a different integer width as the same type', () => {
    expect(check(nativeToScVal(5n, { type: 'u64' }), { kind: 'u128' }).validation.status).toBe('mismatch');
    expect(check(xdr.ScVal.scvI32(1), { kind: 'u32' }).validation.status).toBe('mismatch');
  });

  it('flags element mismatches with the element path', () => {
    const v = xdr.ScVal.scvVec([xdr.ScVal.scvU32(1), xdr.ScVal.scvBool(true)]);
    const m = check(v, { kind: 'vec', element: { kind: 'u32' } }).validation.mismatches;
    expect(m).toHaveLength(1);
    expect(m[0].path).toBe('$[1]');
  });

  it('validates integer range when the wire type fits but the value does not for the expected kind', () => {
    // A node whose wire type matches but value is out of range cannot come from a well-formed ScVal,
    // so exercise the range check directly through a hand-built decoded node.
    const result = validateReturnType({ scType: 'scvU32', value: 4294967296 }, { kind: 'u32' });
    expect(result.status).toBe('mismatch');
    expect(result.mismatches[0].message).toMatch(/outside u32 range/);
  });

  it('checks bytesN length', () => {
    expect(check(xdr.ScVal.scvBytes(Buffer.alloc(32)), { kind: 'bytesN', length: 32 }).validation.status).toBe('valid');
    expect(check(xdr.ScVal.scvBytes(Buffer.alloc(31)), { kind: 'bytesN', length: 32 }).validation.mismatches[0].message).toMatch(/expected 32 bytes/);
  });

  it('is inconclusive when no expected type is available', () => {
    const report = inspectReturnValue({ functionName: 'f', returnValue: xdr.ScVal.scvU32(1) });
    expect(report.decoding.status).toBe('decoded');
    expect(report.validation.status).toBe('inconclusive');
    expect(report.validation.reason).toMatch(/no expected return type/);
    expect(report.expectedType).toBeNull();
  });
});

describe('custom types', () => {
  const account: ExpectedType = {
    kind: 'struct',
    name: 'Account',
    fields: [
      { name: 'balance', type: { kind: 'i128' } },
      { name: 'owner', type: { kind: 'address' } },
      { name: 'memo', type: { kind: 'option', value: { kind: 'string' } } },
    ],
  };
  const make = (obj: Record<string, unknown>, types: Record<string, [string, unknown]>) =>
    nativeToScVal(obj, { type: types as never });

  it('decodes and validates a struct', () => {
    const v = make({ balance: 5n, owner: ACCOUNT }, { balance: ['symbol', 'i128'], owner: ['symbol', 'address'] });
    const report = check(v, account);
    expect(report.validation.status).toBe('valid');
    expect(report.expectedType).toBe('struct Account');
    expect(report.decoded).toEqual(expect.arrayContaining([{ key: 'balance', value: '5' }]));
  });

  it('detects missing and unexpected struct fields', () => {
    const v = make({ balance: 5n, extra: 1 }, { balance: ['symbol', 'i128'], extra: ['symbol', 'u32'] });
    const messages = check(v, account).validation.mismatches.map((m) => m.message).join('\n');
    expect(messages).toMatch(/\$\.owner: missing field/);
    expect(messages).toMatch(/\$\.extra: unexpected field/);
  });

  it('validates integer enums and union enums', () => {
    const en: ExpectedType = { kind: 'enum', name: 'Level', cases: [{ name: 'Low', value: 1 }, { name: 'High', value: 5 }] };
    expect(check(xdr.ScVal.scvU32(5), en).validation.status).toBe('valid');
    expect(check(xdr.ScVal.scvU32(9), en).validation.status).toBe('mismatch');

    const un: ExpectedType = { kind: 'union', name: 'Action', cases: [{ name: 'Stop', values: [] }, { name: 'Move', values: [{ kind: 'u32' }] }] };
    const move = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Move'), xdr.ScVal.scvU32(3)]);
    expect(check(move, un).validation.status).toBe('valid');
    expect(check(xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Jump')]), un).validation.status).toBe('mismatch');
    expect(check(xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Move')]), un).validation.mismatches[0].message).toMatch(/carries 1 value/);
  });
});

describe('contract specification', () => {
  const T = xdr.ScSpecTypeDef;
  const fnEntry = (name: string, outputs: xdr.ScSpecTypeDef[]) =>
    xdr.ScSpecEntry.scSpecEntryFunctionV0(new xdr.ScSpecFunctionV0({ doc: '', name, inputs: [], outputs })).toXDR('base64');
  const structEntry = xdr.ScSpecEntry.scSpecEntryUdtStructV0(
    new xdr.ScSpecUdtStructV0({
      doc: '', lib: '', name: 'Account',
      fields: [
        new xdr.ScSpecUdtStructFieldV0({ doc: '', name: 'balance', type: T.scSpecTypeI128() }),
        new xdr.ScSpecUdtStructFieldV0({ doc: '', name: 'owner', type: T.scSpecTypeAddress() }),
      ],
    }),
  ).toXDR('base64');
  const entries = [
    fnEntry('get_account', [T.scSpecTypeUdt(new xdr.ScSpecTypeUdt({ name: 'Account' }))]),
    fnEntry('ping', []),
    fnEntry('safe_div', [T.scSpecTypeResult(new xdr.ScSpecTypeResult({ okType: T.scSpecTypeU32(), errorType: T.scSpecTypeError() }))]),
    structEntry,
  ];

  it('derives the return type and validates against it', () => {
    const spec = parseSpecification(entries);
    expect(getReturnType(spec, 'get_account')).toMatchObject({ kind: 'struct', name: 'Account' });
    expect(getReturnType(spec, 'ping')).toEqual({ kind: 'void' });
    expect(getReturnType(spec, 'safe_div')).toEqual({ kind: 'u32' });

    const v = nativeToScVal({ balance: 1n, owner: ACCOUNT }, { type: { balance: ['symbol', 'i128'], owner: ['symbol', 'address'] } });
    const report = inspectReturnValue({ functionName: 'get_account', returnValue: v, specEntries: entries, contractAddress: CONTRACT });
    expect(report.expectedTypeSource).toBe('specification');
    expect(report.contractAddress).toBe(CONTRACT);
    expect(report.validation.status).toBe('valid');
    expect(formatReport(report)).toContain('Validation: valid');
  });

  it('detects a mismatch against the specification', () => {
    const report = inspectReturnValue({ functionName: 'safe_div', returnValue: xdr.ScVal.scvBool(true), specEntries: entries });
    expect(report.validation.status).toBe('mismatch');
  });

  it('reports specification parsing failure without losing the decoded value', () => {
    const report = inspectReturnValue({ functionName: 'f', returnValue: xdr.ScVal.scvU32(3), specEntries: ['@@bad@@'] });
    expect(report.specificationErrors[0]).toMatch(/spec entry 0 is not valid/);
    expect(report.decoding.status).toBe('decoded');
    expect(report.decoded).toBe(3);
    expect(report.validation.status).toBe('inconclusive');
  });

  it('reports unknown function, undefined custom type and an invalid explicit type', () => {
    expect(inspectReturnValue({ functionName: 'nope', returnValue: xdr.ScVal.scvVoid(), specEntries: entries }).specificationErrors[0]).toMatch(/not in the specification/);

    const dangling = [fnEntry('g', [T.scSpecTypeUdt(new xdr.ScSpecTypeUdt({ name: 'Ghost' }))])];
    expect(inspectReturnValue({ functionName: 'g', returnValue: xdr.ScVal.scvVoid(), specEntries: dangling }).specificationErrors[0]).toMatch(/not defined/);

    const bad = inspectReturnValue({ functionName: 'f', returnValue: xdr.ScVal.scvU32(1), expectedType: { kind: 'struct', fields: [] } as ExpectedType });
    expect(bad.specificationErrors[0]).toMatch(/invalid expected type/);
    expect(bad.validation.status).toBe('inconclusive');
  });
});

describe('report', () => {
  it('is read-only, shows raw XDR next to the decoded value, and separates errors from mismatches', () => {
    const v = xdr.ScVal.scvU32(1);
    const report = check(v, { kind: 'u32' });
    expect(report.readOnly).toBe(true);
    expect(report.raw).toEqual({ scValType: 'scvU32', xdrBase64: v.toXDR('base64') });
    expect(report.decoding.errors).toEqual([]);
    expect(report.validation.mismatches).toEqual([]);
    expect(report.note).toMatch(/still be wrong for your application/);
  });
});
