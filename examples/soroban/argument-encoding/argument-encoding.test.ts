import { Address, StrKey, scValToNative, xdr } from '@stellar/stellar-sdk';
import {
  EncodingError,
  encodeValue,
  formatReport,
  getFunctionDefinition,
  parseSpecification,
  prepareArguments,
  validateArguments,
  validateFunctionDefinition,
  type FunctionDefinition,
} from './index';

const ACCOUNT = 'GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX';
const CONTRACT = 'CARZQMYKDGA4TTIE2XBDJ42EX27VYLLJGGG4WGUIXXWIVHPDTX3UCLJA';

const def = (args: FunctionDefinition['args']): FunctionDefinition => ({ name: 'f', args });
const one = (type: FunctionDefinition['args'][number]['type'], value: unknown) =>
  prepareArguments({ functionName: 'f', definition: def([{ name: 'x', type }]), args: { x: value } });

describe('function definition validation', () => {
  it('accepts a valid definition', () => {
    expect(validateFunctionDefinition(def([{ name: 'a', type: { kind: 'u32' } }]))).toEqual([]);
  });

  it('rejects malformed definitions with clear messages', () => {
    expect(validateFunctionDefinition(null)).toEqual(['function definition must be an object']);
    expect(validateFunctionDefinition({ name: '1bad', args: [] })[0]).toMatch(/function name/);
    const problems = validateFunctionDefinition(
      def([
        { name: 'a', type: { kind: 'u32' } },
        { name: 'a', type: { kind: 'nope' } as never },
        { name: 'v', type: { kind: 'vec' } as never },
        { name: 'b', type: { kind: 'bytesN', length: 0 } },
        { name: 's', type: { kind: 'struct', fields: [] } },
      ]),
    );
    expect(problems.join('\n')).toMatch(/duplicate argument name "a"/);
    expect(problems.join('\n')).toMatch(/unsupported type kind "nope"/);
    expect(problems.join('\n')).toMatch(/vec.*element|element/);
    expect(problems.join('\n')).toMatch(/bytesN needs a positive/);
    expect(problems.join('\n')).toMatch(/struct needs at least one field/);
  });

  it('reports an invalid definition instead of encoding', () => {
    const { report, encoded } = prepareArguments({
      functionName: 'f',
      definition: def([{ name: 'a', type: { kind: 'wat' } as never }]),
      args: { a: 1 },
    });
    expect(report.valid).toBe(false);
    expect(report.errors[0]).toMatch(/invalid function definition/);
    expect(encoded).toEqual([]);
  });
});

describe('required and unexpected arguments', () => {
  const d = def([
    { name: 'a', type: { kind: 'u32' } },
    { name: 'maybe', type: { kind: 'option', value: { kind: 'string' } } },
  ]);

  it('detects a missing required argument and names it', () => {
    const issues = validateArguments(d, {});
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'MISSING_ARGUMENT', path: 'a', expected: 'u32' });
  });

  it('detects an unexpected argument', () => {
    const issues = validateArguments(d, { a: 1, extra: true });
    expect(issues.map((i) => i.code)).toEqual(['UNEXPECTED_ARGUMENT']);
    const { report } = prepareArguments({ functionName: 'f', definition: d, args: { a: 1, extra: true } });
    expect(report.valid).toBe(false);
    expect(report.errors.join()).toMatch(/extra/);
  });

  it('treats option arguments as optional', () => {
    expect(validateArguments(d, { a: 1 })).toEqual([]);
  });
});

describe('primitive encoding', () => {
  it('encodes booleans', () => {
    const { encoded, report } = one({ kind: 'bool' }, true);
    expect(report.valid).toBe(true);
    expect(encoded[0].scValType).toBe('scvBool');
    expect(scValToNative(encoded[0].scVal)).toBe(true);
  });

  it('rejects a non-boolean for bool with a type mismatch', () => {
    const { report } = one({ kind: 'bool' }, 'true');
    expect(report.arguments[0].issues[0]).toMatchObject({ code: 'TYPE_MISMATCH', expected: 'bool' });
  });

  it.each([
    ['u32', 4_000_000_000, 'scvU32'],
    ['i32', -5, 'scvI32'],
    ['u64', 18446744073709551615n, 'scvU64'],
    ['i64', -9223372036854775808n, 'scvI64'],
    ['u128', '340282366920938463463374607431768211455', 'scvU128'],
    ['i128', '-170141183460469231731687303715884105728', 'scvI128'],
    ['u256', 2n ** 255n, 'scvU256'],
    ['i256', -(2n ** 255n), 'scvI256'],
  ] as const)('encodes %s boundary value without precision loss', (kind, value, wire) => {
    const { encoded, report } = one({ kind }, value);
    expect(report.valid).toBe(true);
    expect(encoded[0].scValType).toBe(wire);
    const native = scValToNative(encoded[0].scVal);
    // 32-bit values come back as JS numbers, 64-bit and wider as bigint.
    expect(native).toBe((kind === 'u32' || kind === 'i32' ? value : BigInt(value)) as never);
  });

  it('keeps a 2^100 value exact', () => {
    const { encoded } = one({ kind: 'u128' }, (2n ** 100n).toString());
    expect(scValToNative(encoded[0].scVal)).toBe(2n ** 100n);
  });

  it('rejects out-of-range integers', () => {
    expect(one({ kind: 'u32' }, 4_294_967_296).report.arguments[0].issues[0].code).toBe('OUT_OF_RANGE');
    expect(one({ kind: 'u32' }, -1).report.arguments[0].issues[0].code).toBe('OUT_OF_RANGE');
    expect(one({ kind: 'i64' }, '9223372036854775808').report.arguments[0].issues[0].code).toBe('OUT_OF_RANGE');
    expect(one({ kind: 'u128' }, 2n ** 128n).report.valid).toBe(false);
  });

  it('refuses unsafe JavaScript numbers instead of silently losing precision', () => {
    const { report } = one({ kind: 'i128' }, 2 ** 70);
    expect(report.arguments[0].issues[0]).toMatchObject({ code: 'PRECISION_LOSS' });
  });

  it('rejects non-integer input for integer types', () => {
    expect(one({ kind: 'u32' }, 1.5).report.arguments[0].issues[0].code).toBe('TYPE_MISMATCH');
    expect(one({ kind: 'u32' }, 'abc').report.arguments[0].issues[0].code).toBe('TYPE_MISMATCH');
  });

  it('encodes strings and symbols as distinct wire types', () => {
    expect(one({ kind: 'string' }, 'hello world').encoded[0].scValType).toBe('scvString');
    expect(one({ kind: 'symbol' }, 'transfer').encoded[0].scValType).toBe('scvSymbol');
    expect(one({ kind: 'symbol' }, 'has space').report.valid).toBe(false);
    expect(one({ kind: 'symbol' }, 'x'.repeat(33)).report.valid).toBe(false);
  });

  it('encodes byte arrays from Uint8Array and hex, and enforces bytesN length', () => {
    const fromBytes = one({ kind: 'bytes' }, new Uint8Array([1, 2, 3]));
    const fromHex = one({ kind: 'bytes' }, '010203');
    expect(fromBytes.encoded[0].xdrBase64).toBe(fromHex.encoded[0].xdrBase64);
    expect(one({ kind: 'bytesN', length: 4 }, '01020304').report.valid).toBe(true);
    expect(one({ kind: 'bytesN', length: 4 }, '010203').report.arguments[0].issues[0].code).toBe('INVALID_LENGTH');
    expect(one({ kind: 'bytes' }, 'zz').report.valid).toBe(false);
  });

  it('validates and encodes addresses', () => {
    const acct = one({ kind: 'address' }, ACCOUNT);
    expect(acct.report.valid).toBe(true);
    expect(Address.fromScVal(acct.encoded[0].scVal).toString()).toBe(ACCOUNT);
    expect(Address.fromScVal(one({ kind: 'address' }, CONTRACT).encoded[0].scVal).toString()).toBe(CONTRACT);
    expect(StrKey.isValidContract(CONTRACT)).toBe(true);
    expect(one({ kind: 'address' }, 'GNOTANADDRESS').report.arguments[0].issues[0].code).toBe('INVALID_ADDRESS');
    expect(one({ kind: 'address' }, 42).report.arguments[0].issues[0].code).toBe('TYPE_MISMATCH');
  });
});

describe('composite encoding', () => {
  it('encodes vectors, tuples and options', () => {
    const vec = one({ kind: 'vec', element: { kind: 'u32' } }, [1, 2, 3]);
    expect(scValToNative(vec.encoded[0].scVal)).toEqual([1, 2, 3]);
    const bad = one({ kind: 'vec', element: { kind: 'u32' } }, [1, 'x']);
    expect(bad.report.arguments[0].issues[0].path).toBe('x[1]');

    const tuple = one({ kind: 'tuple', elements: [{ kind: 'u32' }, { kind: 'bool' }] }, [7, false]);
    expect(scValToNative(tuple.encoded[0].scVal)).toEqual([7, false]);
    expect(one({ kind: 'tuple', elements: [{ kind: 'u32' }] }, [1, 2]).report.valid).toBe(false);

    const opt = { kind: 'option', value: { kind: 'u32' } } as const;
    expect(one(opt, null).encoded[0].scValType).toBe('scvVoid');
    expect(scValToNative(one(opt, 9).encoded[0].scVal)).toBe(9);
  });

  it('encodes maps in sorted key order from objects, Maps and pair arrays', () => {
    const type = { kind: 'map', key: { kind: 'symbol' }, value: { kind: 'u32' } } as const;
    const a = one(type, { b: 2, a: 1 });
    const b = one(type, new Map([['b', 2], ['a', 1]]));
    const c = one(type, [['a', 1], ['b', 2]]);
    expect(a.encoded[0].xdrBase64).toBe(b.encoded[0].xdrBase64);
    expect(a.encoded[0].xdrBase64).toBe(c.encoded[0].xdrBase64);
    expect(a.encoded[0].scVal.map()!.map((e) => e.key().sym().toString())).toEqual(['a', 'b']);
    expect(one(type, [['a', 1], ['a', 2]]).report.arguments[0].issues[0].code).toBe('DUPLICATE_KEY');
  });

  it('sorts integer map keys numerically', () => {
    const type = { kind: 'map', key: { kind: 'i64' }, value: { kind: 'bool' } } as const;
    const { encoded } = one(type, [[10, true], [-3, false], [2, true]]);
    expect(encoded[0].scVal.map()!.map((e) => scValToNative(e.key()))).toEqual([-3n, 2n, 10n]);
  });

  it('encodes nested composites with precise error paths', () => {
    const type = {
      kind: 'vec',
      element: { kind: 'struct', fields: [{ name: 'to', type: { kind: 'address' } }, { name: 'amount', type: { kind: 'i128' } }] },
    } as const;
    const ok = one(type, [{ to: ACCOUNT, amount: '10000000000000000000000' }]);
    expect(ok.report.valid).toBe(true);
    const bad = one(type, [{ to: ACCOUNT, amount: 1 }, { to: 'nope', amount: 2 }]);
    expect(bad.report.arguments[0].issues[0].path).toBe('x[1].to');
  });
});

describe('custom types', () => {
  const point = {
    kind: 'struct',
    name: 'Point',
    fields: [{ name: 'y', type: { kind: 'i32' } }, { name: 'x', type: { kind: 'i32' } }],
  } as const;

  it('encodes structs as symbol-keyed maps sorted by field name', () => {
    const { encoded, report } = one(point, { x: 1, y: -2 });
    expect(report.valid).toBe(true);
    expect(encoded[0].scVal.map()!.map((e) => e.key().sym().toString())).toEqual(['x', 'y']);
    expect(scValToNative(encoded[0].scVal)).toEqual({ x: 1, y: -2 });
  });

  it('reports missing and unexpected struct fields', () => {
    const codes = one(point, { x: 1, z: 3 }).report.arguments[0].issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['MISSING_FIELD', 'UNEXPECTED_FIELD']));
  });

  it('encodes integer enums as u32 and union enums as vec[symbol, ...]', () => {
    const en = { kind: 'enum', name: 'Level', cases: [{ name: 'Low', value: 1 }, { name: 'High', value: 5 }] } as const;
    expect(scValToNative(one(en, 'High').encoded[0].scVal)).toBe(5);
    expect(scValToNative(one(en, 1).encoded[0].scVal)).toBe(1);
    expect(one(en, 'Mid').report.arguments[0].issues[0].code).toBe('UNKNOWN_VARIANT');

    const un = { kind: 'union', name: 'Action', cases: [{ name: 'Stop', values: [] }, { name: 'Move', values: [{ kind: 'u32' }] }] } as const;
    expect(scValToNative(one(un, 'Stop').encoded[0].scVal)).toEqual(['Stop']);
    expect(scValToNative(one(un, { tag: 'Move', values: [3] }).encoded[0].scVal)).toEqual(['Move', 3]);
    expect(one(un, { tag: 'Move', values: [] }).report.arguments[0].issues[0].code).toBe('INVALID_LENGTH');
  });
});

describe('encoder safety', () => {
  it('throws EncodingError (not a wrong value) if given unvalidated input', () => {
    expect(() => encodeValue({ kind: 'u32' }, 'abc', 'x')).toThrow(EncodingError);
    expect(() => encodeValue({ kind: 'address' }, 'nope', 'x')).toThrow(/invalid address/);
  });

  it('reports an encoding failure when validation passes but encoding cannot complete', () => {
    // The getter succeeds during validation, then fails during encoding.
    const type = { kind: 'struct', fields: [{ name: 'a', type: { kind: 'u32' } }] } as const;
    let reads = 0;
    const value = {
      get a(): number {
        reads += 1;
        if (reads > 1) throw new Error('boom');
        return 1;
      },
    };
    const { report, encoded } = one(type, value);
    expect(report.valid).toBe(false);
    expect(report.errors[0]).toMatch(/encoding failed: boom/);
    expect(encoded).toEqual([]);
  });
});

describe('contract specification', () => {
  const T = xdr.ScSpecTypeDef;
  const input = (name: string, type: xdr.ScSpecTypeDef) => new xdr.ScSpecFunctionInputV0({ doc: '', name, type });
  const fnEntry = (name: string, inputs: xdr.ScSpecFunctionInputV0[]) =>
    xdr.ScSpecEntry.scSpecEntryFunctionV0(new xdr.ScSpecFunctionV0({ doc: '', name, inputs, outputs: [] })).toXDR('base64');
  const struct = xdr.ScSpecEntry.scSpecEntryUdtStructV0(
    new xdr.ScSpecUdtStructV0({
      doc: '', lib: '', name: 'Order',
      fields: [
        new xdr.ScSpecUdtStructFieldV0({ doc: '', name: 'amount', type: T.scSpecTypeI128() }),
        new xdr.ScSpecUdtStructFieldV0({ doc: '', name: 'tags', type: T.scSpecTypeVec(new xdr.ScSpecTypeVec({ elementType: T.scSpecTypeSymbol() })) }),
      ],
    }),
  ).toXDR('base64');
  const enumEntry = xdr.ScSpecEntry.scSpecEntryUdtEnumV0(
    new xdr.ScSpecUdtEnumV0({ doc: '', lib: '', name: 'Kind', cases: [new xdr.ScSpecUdtEnumCaseV0({ doc: '', name: 'Buy', value: 1 })] }),
  ).toXDR('base64');
  const unionEntry = xdr.ScSpecEntry.scSpecEntryUdtUnionV0(
    new xdr.ScSpecUdtUnionV0({
      doc: '', lib: '', name: 'Cmd',
      cases: [
        xdr.ScSpecUdtUnionCaseV0.scSpecUdtUnionCaseVoidV0(new xdr.ScSpecUdtUnionCaseVoidV0({ doc: '', name: 'Stop' })),
        xdr.ScSpecUdtUnionCaseV0.scSpecUdtUnionCaseTupleV0(new xdr.ScSpecUdtUnionCaseTupleV0({ doc: '', name: 'Go', type: [T.scSpecTypeU32()] })),
      ],
    }),
  ).toXDR('base64');
  const place = fnEntry('place', [
    input('who', T.scSpecTypeAddress()),
    input('order', T.scSpecTypeUdt(new xdr.ScSpecTypeUdt({ name: 'Order' }))),
    input('kind', T.scSpecTypeUdt(new xdr.ScSpecTypeUdt({ name: 'Kind' }))),
    input('cmd', T.scSpecTypeUdt(new xdr.ScSpecTypeUdt({ name: 'Cmd' }))),
    input('memo', T.scSpecTypeOption(new xdr.ScSpecTypeOption({ valueType: T.scSpecTypeString() }))),
    input('hash', T.scSpecTypeBytesN(new xdr.ScSpecTypeBytesN({ n: 32 }))),
  ]);
  const entries = [place, struct, enumEntry, unionEntry];

  it('extracts argument names and resolves custom types', () => {
    const d = getFunctionDefinition(parseSpecification(entries), 'place');
    expect(d.args.map((a) => a.name)).toEqual(['who', 'order', 'kind', 'cmd', 'memo', 'hash']);
    expect(d.args[1].type).toMatchObject({ kind: 'struct', name: 'Order' });
    expect(d.args[2].type).toMatchObject({ kind: 'enum', name: 'Kind' });
    expect(d.args[3].type).toMatchObject({ kind: 'union', name: 'Cmd' });
    expect(d.args[5].type).toEqual({ kind: 'bytesN', length: 32 });
  });

  it('validates and encodes using the specification', () => {
    const { report, encoded } = prepareArguments({
      functionName: 'place',
      contractAddress: CONTRACT,
      specEntries: entries,
      args: {
        who: ACCOUNT,
        order: { amount: '123456789012345678901234567890', tags: ['a', 'b'] },
        kind: 'Buy',
        cmd: { tag: 'Go', values: [4] },
        hash: 'aa'.repeat(32),
      },
    });
    expect(report.schemaSource).toBe('specification');
    expect(report.contractAddress).toBe(CONTRACT);
    expect(report.valid).toBe(true);
    expect(encoded).toHaveLength(6);
    expect(report.arguments.every((a) => a.encoded?.xdrBase64)).toBe(true);
    expect(formatReport(report)).toContain('VALID');
  });

  it('reports spec-driven validation errors', () => {
    const { report } = prepareArguments({
      functionName: 'place',
      specEntries: entries,
      args: { who: ACCOUNT, order: { amount: 1 }, kind: 'Sell', cmd: 'Stop', hash: 'aa' },
    });
    const codes = report.arguments.flatMap((a) => a.issues.map((i) => i.code));
    expect(codes).toEqual(expect.arrayContaining(['MISSING_FIELD', 'UNKNOWN_VARIANT', 'INVALID_LENGTH']));
    expect(report.valid).toBe(false);
  });

  it('fails clearly for a malformed specification', () => {
    const { report } = prepareArguments({ functionName: 'place', specEntries: ['!!!not xdr!!!'], args: {} });
    expect(report.valid).toBe(false);
    expect(report.errors[0]).toMatch(/specification: spec entry 0 is not valid/);
  });

  it('fails clearly for an unknown function, undefined type, recursive type and unsupported type', () => {
    expect(() => getFunctionDefinition(parseSpecification(entries), 'nope')).toThrow(/not in the specification/);

    const missing = fnEntry('f', [input('x', T.scSpecTypeUdt(new xdr.ScSpecTypeUdt({ name: 'Ghost' })))]);
    expect(() => getFunctionDefinition(parseSpecification([missing]), 'f')).toThrow(/not defined in the specification/);

    const loop = xdr.ScSpecEntry.scSpecEntryUdtStructV0(
      new xdr.ScSpecUdtStructV0({
        doc: '', lib: '', name: 'Loop',
        fields: [new xdr.ScSpecUdtStructFieldV0({ doc: '', name: 'next', type: T.scSpecTypeUdt(new xdr.ScSpecTypeUdt({ name: 'Loop' })) })],
      }),
    ).toXDR('base64');
    const useLoop = fnEntry('f', [input('x', T.scSpecTypeUdt(new xdr.ScSpecTypeUdt({ name: 'Loop' })))]);
    expect(() => getFunctionDefinition(parseSpecification([loop, useLoop]), 'f')).toThrow(/refers to itself/);

    const unsupported = fnEntry('f', [input('x', T.scSpecTypeVal())]);
    const { report } = prepareArguments({ functionName: 'f', specEntries: [unsupported], args: { x: 1 } });
    expect(report.errors[0]).toMatch(/not supported/);
  });

  it('reports when neither a schema nor a specification is available', () => {
    const { report } = prepareArguments({ functionName: 'f', args: {} });
    expect(report.schemaSource).toBe('none');
    expect(report.errors[0]).toMatch(/no argument schema available/);
  });
});

describe('report', () => {
  it('is read-only and states that valid encoding does not guarantee success', () => {
    const { report } = one({ kind: 'u32' }, 1);
    expect(report.readOnly).toBe(true);
    expect(report.note).toMatch(/does not prove the contract call will succeed/);
    expect(report.arguments[0].encoded).toMatchObject({ scValType: 'scvU32' });
    expect(() => xdr.ScVal.fromXDR(report.arguments[0].encoded!.xdrBase64, 'base64')).not.toThrow();
  });
});
