import { Address, Keypair, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import {
  decodeScVal,
  describeExecutable,
  ledgerEntryDataFromBase64,
  scValFromBase64,
} from './decoder';
import {
  buildInstanceLedgerKey,
  inspectContractInstance,
  InstanceRpcClient,
  validateContractAddress,
} from './inspector';
import { InspectionError } from './types';

const CONTRACT = 'CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDA';
const TESTNET = 'Test SDF Network ; September 2015';
const MAINNET = 'Public Global Stellar Network ; September 2015';
const WASM_HASH = Buffer.alloc(32, 0xab);

function sym(s: string): xdr.ScVal {
  return xdr.ScVal.scvSymbol(s);
}

function entry(
  storage: xdr.ScMapEntry[] | null,
  executable: xdr.ContractExecutable = xdr.ContractExecutable.contractExecutableWasm(WASM_HASH)
): string {
  const data = xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: xdr.ExtensionPoint.fromXDR(Buffer.alloc(4)),
      contract: new Address(CONTRACT).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({ executable, storage })),
    })
  );
  return data.toXDR('base64');
}

function mockClient(overrides: Partial<InstanceRpcClient> = {}, xdrEntry?: string): InstanceRpcClient {
  return {
    getNetwork: jest.fn().mockResolvedValue({ passphrase: TESTNET }),
    getRawLedgerEntries: jest.fn().mockResolvedValue({
      latestLedger: 500,
      entries: xdrEntry
        ? [{ key: 'k', xdr: xdrEntry, lastModifiedLedgerSeq: 400, liveUntilLedgerSeq: 900 }]
        : [],
    }),
    ...overrides,
  };
}

describe('address validation', () => {
  it('accepts a valid contract address', () => {
    expect(validateContractAddress(CONTRACT)).toBe(CONTRACT);
  });

  it('rejects account addresses, garbage and bad checksums', () => {
    const account = Keypair.random().publicKey();
    for (const bad of [account, 'not-an-address', '', CONTRACT.slice(0, 10) + (CONTRACT[10] === 'A' ? 'B' : 'A') + CONTRACT.slice(11)]) {
      expect(() => validateContractAddress(bad)).toThrow(InspectionError);
    }
  });

  it('reports INVALID_ADDRESS without touching the RPC', async () => {
    const client = mockClient();
    const result = await inspectContractInstance('nope', { client });
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('INVALID_ADDRESS');
    expect(client.getNetwork).not.toHaveBeenCalled();
  });
});

describe('instance ledger key', () => {
  it('is a persistent contractData key using the instance ScVal', () => {
    const key = buildInstanceLedgerKey(CONTRACT).contractData();
    expect(key.key().switch().name).toBe('scvLedgerKeyContractInstance');
    expect(key.durability().name).toBe('persistent');
    expect(Address.fromScAddress(key.contract()).toString()).toBe(CONTRACT);
  });
});

describe('decodeScVal', () => {
  it('decodes booleans, void and small integers', () => {
    expect(decodeScVal(xdr.ScVal.scvBool(true))).toMatchObject({ type: 'scvBool', value: true });
    expect(decodeScVal(xdr.ScVal.scvVoid())).toMatchObject({ value: null, supported: true });
    expect(decodeScVal(xdr.ScVal.scvU32(7)).value).toBe(7);
    expect(decodeScVal(xdr.ScVal.scvI32(-7)).value).toBe(-7);
  });

  it('decodes 64/128/256-bit integers as exact decimal strings', () => {
    expect(decodeScVal(nativeToScVal(2n ** 64n - 1n, { type: 'u64' })).value).toBe('18446744073709551615');
    expect(decodeScVal(nativeToScVal(-5n, { type: 'i64' })).value).toBe('-5');
    expect(decodeScVal(nativeToScVal(2n ** 100n, { type: 'u128' })).value).toBe(String(2n ** 100n));
    expect(decodeScVal(nativeToScVal(-(2n ** 100n), { type: 'i128' })).value).toBe(String(-(2n ** 100n)));
    expect(decodeScVal(nativeToScVal(2n ** 200n, { type: 'u256' })).value).toBe(String(2n ** 200n));
  });

  it('decodes strings, symbols and bytes', () => {
    expect(decodeScVal(xdr.ScVal.scvString('héllo')).value).toBe('héllo');
    expect(decodeScVal(sym('Admin'))).toMatchObject({ type: 'scvSymbol', value: 'Admin' });
    expect(decodeScVal(xdr.ScVal.scvBytes(Buffer.from([0xde, 0xad, 0xbe, 0xef]))).value).toBe('deadbeef');
  });

  it('flags non-UTF-8 strings and keeps their XDR', () => {
    const bad = xdr.ScVal.scvString(Buffer.from([0xff, 0xfe]));
    const out = decodeScVal(bad);
    expect(out.supported).toBe(false);
    expect(out.value).toBe('fffe');
    expect(out.xdr).toBe(bad.toXDR('base64'));
  });

  it('decodes addresses (contract and account)', () => {
    const account = Keypair.random().publicKey();
    expect(decodeScVal(new Address(CONTRACT).toScVal()).value).toBe(CONTRACT);
    expect(decodeScVal(new Address(account).toScVal()).value).toBe(account);
  });

  it('decodes vectors and maps recursively', () => {
    const vec = xdr.ScVal.scvVec([xdr.ScVal.scvU32(1), sym('x')]);
    const out = decodeScVal(vec);
    expect(out.type).toBe('scvVec');
    expect((out.value as { value: unknown }[]).map((v) => v.value)).toEqual([1, 'x']);

    const map = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: sym('count'), val: xdr.ScVal.scvU32(3) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvU32(9), val: vec }),
    ]);
    const m = decodeScVal(map).value as { key: { value: unknown }; value: { type: string } }[];
    expect(m[0].key.value).toBe('count');
    expect(m[1].value.type).toBe('scvVec');
  });

  it('keeps XDR for unsupported types and nested unsupported members', () => {
    const err = xdr.ScVal.scvError(xdr.ScError.sceContract(5));
    const out = decodeScVal(err);
    expect(out.supported).toBe(false);
    expect(out.xdr).toBe(err.toXDR('base64'));

    const nested = decodeScVal(xdr.ScVal.scvVec([err, xdr.ScVal.scvBool(false)]));
    const items = nested.value as { supported: boolean }[];
    expect(items.map((i) => i.supported)).toEqual([false, true]);
  });

  it('stops at the depth limit instead of recursing forever', () => {
    let v: xdr.ScVal = xdr.ScVal.scvU32(1);
    for (let i = 0; i < 5; i++) v = xdr.ScVal.scvVec([v]);
    const out = decodeScVal(v, { maxDepth: 2 });
    expect(JSON.stringify(out)).toContain('Maximum depth');
  });

  it('retains XDR for every value when asked', () => {
    expect(decodeScVal(xdr.ScVal.scvU32(1), { retainXdr: true }).xdr).toBeDefined();
    expect(decodeScVal(xdr.ScVal.scvU32(1)).xdr).toBeUndefined();
  });
});

describe('malformed XDR', () => {
  it('throws XDR_DECODE_FAILED for bad ScVal and ledger entry data', () => {
    expect(() => scValFromBase64('AAAA')).toThrow(/XDR/);
    expect(() => ledgerEntryDataFromBase64('!!!not-xdr')).toThrow(InspectionError);
  });

  it('is surfaced in the inspection result', async () => {
    const client = mockClient({}, 'AAAAAAAA');
    const result = await inspectContractInstance(CONTRACT, { client });
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('XDR_DECODE_FAILED');
  });
});

describe('inspectContractInstance', () => {
  it('retrieves and decodes an instance entry', async () => {
    const xdrEntry = entry([
      new xdr.ScMapEntry({ key: sym('Admin'), val: new Address(CONTRACT).toScVal() }),
      new xdr.ScMapEntry({ key: sym('Paused'), val: xdr.ScVal.scvBool(false) }),
    ]);
    const client = mockClient({}, xdrEntry);
    const result = await inspectContractInstance(CONTRACT, { client });

    expect(result.status).toBe('ok');
    expect(result.network).toBe('testnet');
    expect(result.contractAddress).toBe(CONTRACT);
    expect(result.instance).toMatchObject({
      storageEntryCount: 2,
      lastModifiedLedgerSeq: 400,
      liveUntilLedgerSeq: 900,
      latestLedger: 500,
    });
    expect(result.storage.map((s) => s.key.value)).toEqual(['Admin', 'Paused']);
    expect(result.storage[1].value.value).toBe(false);

    // The request used the instance key and nothing else.
    expect(client.getRawLedgerEntries).toHaveBeenCalledWith(
      buildInstanceLedgerKey(CONTRACT).toXDR('base64')
    );
  });

  it('inspects the executable reference without fetching Wasm', async () => {
    const result = await inspectContractInstance(CONTRACT, { client: mockClient({}, entry([])) });
    expect(result.instance?.executable).toEqual({ type: 'wasm', wasmHash: WASM_HASH.toString('hex') });
    expect(result.warnings.join(' ')).toMatch(/not fetched/);
    expect(result.storage).toEqual([]);
  });

  it('describes Stellar Asset Contracts and null storage', async () => {
    const sac = xdr.ContractExecutable.contractExecutableStellarAsset();
    expect(describeExecutable(sac)).toEqual({ type: 'stellar_asset' });
    const result = await inspectContractInstance(CONTRACT, {
      client: mockClient({}, entry(null, sac)),
    });
    expect(result.instance?.executable.type).toBe('stellar_asset');
    expect(result.instance?.storageEntryCount).toBeNull();
  });

  it('warns about unsupported values but still succeeds', async () => {
    const xdrEntry = entry([
      new xdr.ScMapEntry({
        key: sym('Err'),
        val: xdr.ScVal.scvError(xdr.ScError.sceContract(1)),
      }),
    ]);
    const result = await inspectContractInstance(CONTRACT, { client: mockClient({}, xdrEntry) });
    expect(result.status).toBe('ok');
    expect(result.storage[0].value.supported).toBe(false);
    expect(result.storage[0].value.xdr).toBeDefined();
    expect(result.warnings.join(' ')).toMatch(/could not be fully decoded/);
  });

  it('reports a missing instance as not_found', async () => {
    const result = await inspectContractInstance(CONTRACT, { client: mockClient() });
    expect(result.status).toBe('not_found');
    expect(result.error?.code).toBe('INSTANCE_NOT_FOUND');
  });

  it('reports RPC failures on either call', async () => {
    const down = new Error('connect ECONNREFUSED');
    let r = await inspectContractInstance(CONTRACT, {
      client: mockClient({ getNetwork: jest.fn().mockRejectedValue(down) }),
    });
    expect(r.error?.code).toBe('RPC_UNAVAILABLE');
    expect(r.error?.message).toMatch(/ECONNREFUSED/);

    r = await inspectContractInstance(CONTRACT, {
      client: mockClient({ getRawLedgerEntries: jest.fn().mockRejectedValue(down) }),
    });
    expect(r.error?.code).toBe('RPC_UNAVAILABLE');
  });

  it('detects a network mismatch', async () => {
    const r = await inspectContractInstance(CONTRACT, {
      network: 'testnet',
      client: mockClient({ getNetwork: jest.fn().mockResolvedValue({ passphrase: MAINNET }) }),
    });
    expect(r.error?.code).toBe('NETWORK_MISMATCH');
  });

  it('rejects entries that are not contract instances', async () => {
    const account = xdr.LedgerEntryData.ttl(
      new xdr.TtlEntry({ keyHash: Buffer.alloc(32), liveUntilLedgerSeq: 1 })
    ).toXDR('base64');
    let r = await inspectContractInstance(CONTRACT, { client: mockClient({}, account) });
    expect(r.error?.code).toBe('INVALID_LEDGER_ENTRY');

    const notInstance = xdr.LedgerEntryData.contractData(
      new xdr.ContractDataEntry({
        ext: xdr.ExtensionPoint.fromXDR(Buffer.alloc(4)),
        contract: new Address(CONTRACT).toScAddress(),
        key: sym('Balance'),
        durability: xdr.ContractDataDurability.persistent(),
        val: xdr.ScVal.scvU32(1),
      })
    ).toXDR('base64');
    r = await inspectContractInstance(CONTRACT, { client: mockClient({}, notInstance) });
    expect(r.error?.code).toBe('INVALID_LEDGER_ENTRY');
  });
});
