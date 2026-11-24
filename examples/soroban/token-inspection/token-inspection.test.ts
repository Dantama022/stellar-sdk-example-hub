import { Keypair, StrKey, Transaction, nativeToScVal, rpc, xdr } from '@stellar/stellar-sdk';
import {
  MAX_DECIMALS,
  extractSpecSection,
  formatTokenAmount,
  inspectToken,
  reportFromFunctions,
  specFunctions,
  validateAccountAddress,
  validateContractAddress,
  validateDecimals,
  validateSpenderAddress,
} from './index';
import { ContractExecutable, TokenRpcClient } from './invoke';

const TESTNET = 'Test SDF Network ; September 2015';
const MAINNET = 'Public Global Stellar Network ; September 2015';
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 1));
const ACCOUNT = Keypair.random().publicKey();
const SPENDER = Keypair.random().publicKey();

const i128 = (n: bigint): xdr.ScVal => nativeToScVal(n, { type: 'i128' });
const u32 = (n: number): xdr.ScVal => xdr.ScVal.scvU32(n);

// ---- Mock RPC -----------------------------------------------------------------------

type MethodResult = xdr.ScVal | Error | { simError: string };

function ok(retval: xdr.ScVal): rpc.Api.SimulateTransactionResponse {
  return {
    id: '1',
    latestLedger: 1,
    events: [],
    _parsed: true,
    transactionData: {},
    minResourceFee: '0',
    result: { auth: [], retval },
  } as unknown as rpc.Api.SimulateTransactionResponse;
}

interface MockOptions {
  methods: Record<string, MethodResult>;
  executable?: ContractExecutable | null;
  wasm?: Buffer | Error;
  passphrase?: string;
  rpcDown?: boolean;
}

function mockClient(o: MockOptions): TokenRpcClient & { calls: string[] } {
  const calls: string[] = [];
  const down = (): never => {
    throw new Error('connect ECONNREFUSED');
  };
  return {
    calls,
    getNetwork: jest.fn(async () => (o.rpcDown ? down() : { passphrase: o.passphrase ?? TESTNET })),
    getContractExecutable: jest.fn(async () =>
      o.executable === undefined ? { type: 'stellar_asset' as const } : o.executable
    ),
    getWasm: jest.fn(async () => {
      if (o.wasm instanceof Error) throw o.wasm;
      return o.wasm ?? Buffer.alloc(0);
    }),
    simulateTransaction: jest.fn(async (tx: Transaction) => {
      if (o.rpcDown) down();
      const op = tx.operations[0] as unknown as { func: xdr.HostFunction };
      const method = op.func.invokeContract().functionName().toString();
      calls.push(method);
      const r = o.methods[method];
      if (r === undefined) {
        return {
          id: '1',
          latestLedger: 1,
          error: `HostError: Error(WasmVm, MissingValue)\n"trying to invoke non-existent contract function", ${method}`,
        } as rpc.Api.SimulateTransactionResponse;
      }
      if (r instanceof Error) throw r;
      if ('simError' in r) {
        return { id: '1', latestLedger: 1, error: r.simError } as rpc.Api.SimulateTransactionResponse;
      }
      return ok(r);
    }),
  };
}

// ---- Wasm fixtures ------------------------------------------------------------------

function funcEntry(name: string, inputs: number): xdr.ScSpecEntry {
  return xdr.ScSpecEntry.scSpecEntryFunctionV0(
    new xdr.ScSpecFunctionV0({
      doc: '',
      name,
      inputs: Array.from(
        { length: inputs },
        (_, i) =>
          new xdr.ScSpecFunctionInputV0({
            doc: '',
            name: `arg${i}`,
            type: xdr.ScSpecTypeDef.scSpecTypeAddress(),
          })
      ),
      outputs: [xdr.ScSpecTypeDef.scSpecTypeI128()],
    })
  );
}

const leb = (n: number): number[] => {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
};

/** Minimal valid Wasm module with a type section (to be skipped) and a spec custom section. */
function wasmWithSpec(entries: xdr.ScSpecEntry[]): Buffer {
  const payload = Buffer.concat(entries.map((e) => e.toXDR()));
  const name = Buffer.from('contractspecv0');
  const body = Buffer.concat([Buffer.from(leb(name.length)), name, payload]);
  return Buffer.concat([
    Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    Buffer.from([0x01, 0x01, 0x00]), // empty-ish type section, id 1
    Buffer.from([0x00]),
    Buffer.from(leb(body.length)),
    body,
  ]);
}

const TOKEN_SPEC = [funcEntry('balance', 1), funcEntry('allowance', 2), funcEntry('decimals', 0)];
const standardMethods = { balance: i128(15_000_000n), decimals: u32(7), allowance: i128(2_500_000n) };

// ---- Tests --------------------------------------------------------------------------

describe('address validation', () => {
  it('accepts valid contract and account addresses', () => {
    expect(validateContractAddress(TOKEN)).toBe(TOKEN);
    expect(validateAccountAddress(ACCOUNT)).toBe(ACCOUNT);
    expect(validateAccountAddress(TOKEN)).toBe(TOKEN); // contracts can hold tokens
    expect(validateSpenderAddress(SPENDER)).toBe(SPENDER);
  });

  it('rejects invalid contract addresses', () => {
    for (const bad of ['', 'not-an-address', ACCOUNT, TOKEN.slice(0, -1) + 'A']) {
      expect(() => validateContractAddress(bad)).toThrow(
        expect.objectContaining({ code: 'INVALID_CONTRACT_ADDRESS' })
      );
    }
  });

  it('rejects invalid account and spender addresses', () => {
    expect(() => validateAccountAddress('GBAD')).toThrow(
      expect.objectContaining({ code: 'INVALID_ACCOUNT_ADDRESS' })
    );
    expect(() => validateSpenderAddress('nope')).toThrow(
      expect.objectContaining({ code: 'INVALID_SPENDER_ADDRESS' })
    );
  });

  it('reports invalid input as an error result without touching the RPC', async () => {
    const client = mockClient({ methods: standardMethods });
    const r1 = await inspectToken('bad', ACCOUNT, { client });
    expect(r1.status).toBe('error');
    expect(r1.error?.code).toBe('INVALID_CONTRACT_ADDRESS');
    const r2 = await inspectToken(TOKEN, 'bad', { client });
    expect(r2.error?.code).toBe('INVALID_ACCOUNT_ADDRESS');
    const r3 = await inspectToken(TOKEN, ACCOUNT, { client, spender: 'bad' });
    expect(r3.error?.code).toBe('INVALID_SPENDER_ADDRESS');
    expect(client.getNetwork).not.toHaveBeenCalled();
  });
});

describe('formatting', () => {
  it('formats with the token decimals', () => {
    expect(formatTokenAmount(15_000_000n, 7)).toBe('1.5');
    expect(formatTokenAmount(1n, 7)).toBe('0.0000001');
    expect(formatTokenAmount(10_000_000n, 7)).toBe('1');
    expect(formatTokenAmount(12345n, 0)).toBe('12345');
    expect(formatTokenAmount(15_000_000n, 7, true)).toBe('1.5000000');
    expect(formatTokenAmount(-1_500_000n, 6)).toBe('-1.5');
  });

  it('does not lose precision above Number.MAX_SAFE_INTEGER', () => {
    const big = 170141183460469231731687303715884105727n; // i128 max
    expect(formatTokenAmount(big, 7)).toBe('17014118346046923173168730371588.4105727');
    expect(formatTokenAmount(9007199254740993n, 0)).toBe('9007199254740993'); // 2^53 + 1
  });

  it('validates decimals', () => {
    expect(validateDecimals(0)).toBe(0);
    expect(validateDecimals(MAX_DECIMALS)).toBe(MAX_DECIMALS);
    for (const bad of [-1, 39, 1.5, NaN, '7', undefined]) {
      expect(() => validateDecimals(bad)).toThrow(expect.objectContaining({ code: 'INVALID_DECIMALS' }));
    }
  });

  it('rejects non-bigint raw amounts', () => {
    expect(() => formatTokenAmount(5 as unknown as bigint, 7)).toThrow(
      expect.objectContaining({ code: 'FORMAT_ERROR' })
    );
  });
});

describe('balance', () => {
  it('retrieves and formats a balance', async () => {
    const client = mockClient({ methods: standardMethods });
    const r = await inspectToken(TOKEN, ACCOUNT, { client });
    expect(r.status).toBe('ok');
    expect(r.network).toBe('testnet');
    expect(r.tokenContract).toBe(TOKEN);
    expect(r.account).toBe(ACCOUNT);
    expect(r.balance).toEqual({ raw: 15_000_000n, formatted: '1.5' });
    expect(r.decimals).toBe(7);
    expect(r.decimalsSource).toBe('contract');
    expect(r.allowance).toBeUndefined();
    expect(r.interface?.source).toBe('stellar_asset');
  });

  it('reports a zero balance as zero, not as a failure', async () => {
    const client = mockClient({ methods: { ...standardMethods, balance: i128(0n) } });
    const r = await inspectToken(TOKEN, ACCOUNT, { client });
    expect(r.status).toBe('ok');
    expect(r.balance).toEqual({ raw: 0n, formatted: '0' });
  });

  it('keeps large balances exact', async () => {
    const huge = 123456789012345678901234567890n;
    const client = mockClient({ methods: { ...standardMethods, balance: i128(huge) } });
    const r = await inspectToken(TOKEN, ACCOUNT, { client });
    expect(r.balance?.raw).toBe(huge);
    expect(r.balance?.formatted).toBe('12345678901234567890123.456789');
  });

  it('prefers explicit decimals and skips the decimals() call', async () => {
    const client = mockClient({ methods: { balance: i128(250n) } });
    const r = await inspectToken(TOKEN, ACCOUNT, { client, decimals: 2 });
    expect(r.decimalsSource).toBe('explicit');
    expect(r.balance?.formatted).toBe('2.5');
    expect(client.calls).toEqual(['balance']);
  });

  it('is partial, with raw balance preserved, when decimals are unavailable', async () => {
    const client = mockClient({ methods: { balance: i128(15_000_000n) } }); // no decimals()
    const r = await inspectToken(TOKEN, ACCOUNT, { client });
    expect(r.status).toBe('partial');
    expect(r.balance).toEqual({ raw: 15_000_000n, formatted: undefined });
    expect(r.warnings.join(' ')).toMatch(/decimals unavailable/);
  });

  it('flags invalid contract-reported decimals', async () => {
    const client = mockClient({ methods: { ...standardMethods, decimals: u32(99) } });
    const r = await inspectToken(TOKEN, ACCOUNT, { client });
    expect(r.status).toBe('partial');
    expect(r.decimals).toBeUndefined();
    expect(r.warnings.join(' ')).toMatch(/between 0 and 38/);
  });

  it('rejects invalid explicit decimals', async () => {
    const client = mockClient({ methods: standardMethods });
    const r = await inspectToken(TOKEN, ACCOUNT, { client, decimals: 50 });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('INVALID_DECIMALS');
  });

  it('rejects an unexpected balance return type', async () => {
    const client = mockClient({ methods: { balance: xdr.ScVal.scvString('hello') } });
    const r = await inspectToken(TOKEN, ACCOUNT, { client });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('UNEXPECTED_RETURN_TYPE');
    expect(r.error?.message).toMatch(/scvString/);
  });

  it('rejects a negative balance', async () => {
    const client = mockClient({ methods: { balance: i128(-1n) } });
    const r = await inspectToken(TOKEN, ACCOUNT, { client });
    expect(r.error?.code).toBe('UNEXPECTED_RETURN_TYPE');
  });

  it('rejects a non-u32 decimals return as a warning', async () => {
    const client = mockClient({ methods: { balance: i128(1n), decimals: xdr.ScVal.scvBool(true) } });
    const r = await inspectToken(TOKEN, ACCOUNT, { client });
    expect(r.status).toBe('partial');
    expect(r.warnings.join(' ')).toMatch(/scvBool/);
  });

  it('reports a contract without balance() as an unsupported interface', async () => {
    const client = mockClient({ methods: {} });
    const r = await inspectToken(TOKEN, ACCOUNT, { client });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('UNSUPPORTED_INTERFACE');
  });

  it('surfaces contract-side failures distinctly', async () => {
    const client = mockClient({ methods: { balance: { simError: 'HostError: Error(Contract, #3)' } } });
    const r = await inspectToken(TOKEN, ACCOUNT, { client });
    expect(r.error?.code).toBe('INVOCATION_FAILED');
    expect(r.error?.message).toMatch(/Contract, #3/);
  });
});

describe('allowance', () => {
  it('retrieves and formats an allowance', async () => {
    const client = mockClient({ methods: standardMethods });
    const r = await inspectToken(TOKEN, ACCOUNT, { client, spender: SPENDER });
    expect(r.status).toBe('ok');
    expect(r.allowance).toEqual({
      owner: ACCOUNT,
      spender: SPENDER,
      status: 'ok',
      amount: { raw: 2_500_000n, formatted: '0.25' },
    });
  });

  it('treats a zero allowance as ok, not unsupported', async () => {
    const client = mockClient({ methods: { ...standardMethods, allowance: i128(0n) } });
    const r = await inspectToken(TOKEN, ACCOUNT, { client, spender: SPENDER });
    expect(r.status).toBe('ok');
    expect(r.allowance?.status).toBe('ok');
    expect(r.allowance?.amount).toEqual({ raw: 0n, formatted: '0' });
    expect(r.allowance?.error).toBeUndefined();
  });

  it('marks a missing allowance method as unsupported without losing the balance', async () => {
    const client = mockClient({ methods: { balance: i128(15_000_000n), decimals: u32(7) } });
    const r = await inspectToken(TOKEN, ACCOUNT, { client, spender: SPENDER });
    expect(r.status).toBe('partial');
    expect(r.balance?.formatted).toBe('1.5');
    expect(r.allowance?.status).toBe('unsupported');
    expect(r.allowance?.amount).toBeUndefined();
    expect(r.allowance?.error?.code).toBe('METHOD_NOT_FOUND');
  });

  it('marks an allowance invocation error as failed, not unsupported', async () => {
    const client = mockClient({
      methods: { ...standardMethods, allowance: { simError: 'HostError: Error(Contract, #9)' } },
    });
    const r = await inspectToken(TOKEN, ACCOUNT, { client, spender: SPENDER });
    expect(r.allowance?.status).toBe('failed');
    expect(r.allowance?.error?.code).toBe('INVOCATION_FAILED');
  });

  it('marks an unexpected allowance return type as failed', async () => {
    const client = mockClient({ methods: { ...standardMethods, allowance: xdr.ScVal.scvBool(true) } });
    const r = await inspectToken(TOKEN, ACCOUNT, { client, spender: SPENDER });
    expect(r.allowance?.status).toBe('failed');
    expect(r.allowance?.error?.code).toBe('UNEXPECTED_RETURN_TYPE');
  });

  it('keeps large allowances exact (e.g. an "unlimited" approval)', async () => {
    const max = 170141183460469231731687303715884105727n;
    const client = mockClient({ methods: { ...standardMethods, allowance: i128(max) } });
    const r = await inspectToken(TOKEN, ACCOUNT, { client, spender: SPENDER });
    expect(r.allowance?.amount?.raw).toBe(max);
  });
});

describe('RPC and contract lookup', () => {
  it('reports an unreachable RPC endpoint', async () => {
    const client = mockClient({ methods: standardMethods, rpcDown: true });
    const r = await inspectToken(TOKEN, ACCOUNT, { client });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('RPC_UNAVAILABLE');
    expect(r.error?.message).toMatch(/ECONNREFUSED/);
  });

  it('reports an RPC failure while invoking', async () => {
    const client = mockClient({ methods: { balance: new Error('503 Service Unavailable') } });
    const r = await inspectToken(TOKEN, ACCOUNT, { client });
    expect(r.error?.code).toBe('RPC_UNAVAILABLE');
  });

  it('reports a network mismatch', async () => {
    const client = mockClient({ methods: standardMethods, passphrase: MAINNET });
    const r = await inspectToken(TOKEN, ACCOUNT, { client, network: 'testnet' });
    expect(r.error?.code).toBe('NETWORK_MISMATCH');
  });

  it('supports explicit mainnet configuration', async () => {
    const client = mockClient({ methods: standardMethods, passphrase: MAINNET });
    const r = await inspectToken(TOKEN, ACCOUNT, { client, network: 'mainnet' });
    expect(r.status).toBe('ok');
    expect(r.network).toBe('mainnet');
    expect(r.networkPassphrase).toBe(MAINNET);
  });

  it('reports a missing contract instance', async () => {
    const client = mockClient({ methods: standardMethods, executable: null });
    const r = await inspectToken(TOKEN, ACCOUNT, { client });
    expect(r.error?.code).toBe('CONTRACT_NOT_FOUND');
    expect(client.calls).toEqual([]);
  });
});

describe('contract spec inspection', () => {
  const wasmExec: ContractExecutable = { type: 'wasm', wasmHash: Buffer.alloc(32, 7) };

  it('extracts and decodes functions from a Wasm custom section', () => {
    const wasm = wasmWithSpec(TOKEN_SPEC);
    expect(extractSpecSection(wasm)).not.toBeNull();
    expect(specFunctions(wasm).map((f) => f.name().toString())).toEqual([
      'balance',
      'allowance',
      'decimals',
    ]);
    expect(reportFromFunctions(specFunctions(wasm)).methods).toEqual({
      balance: true,
      allowance: true,
      decimals: true,
    });
  });

  it('uses the spec when available', async () => {
    const client = mockClient({
      methods: standardMethods,
      executable: wasmExec,
      wasm: wasmWithSpec(TOKEN_SPEC),
    });
    const r = await inspectToken(TOKEN, ACCOUNT, { client, spender: SPENDER });
    expect(r.status).toBe('ok');
    expect(r.interface?.source).toBe('contract_spec');
  });

  it('fails fast when the spec has no balance function', async () => {
    const client = mockClient({
      methods: standardMethods,
      executable: wasmExec,
      wasm: wasmWithSpec([funcEntry('mint', 2)]),
    });
    const r = await inspectToken(TOKEN, ACCOUNT, { client });
    expect(r.error?.code).toBe('UNSUPPORTED_INTERFACE');
    expect(client.calls).toEqual([]);
  });

  it('marks allowance unsupported from the spec without invoking it', async () => {
    const client = mockClient({
      methods: standardMethods,
      executable: wasmExec,
      wasm: wasmWithSpec([funcEntry('balance', 1), funcEntry('decimals', 0)]),
    });
    const r = await inspectToken(TOKEN, ACCOUNT, { client, spender: SPENDER });
    expect(r.allowance?.status).toBe('unsupported');
    expect(client.calls).not.toContain('allowance');
  });

  it('treats a wrong-arity balance as missing', () => {
    expect(reportFromFunctions(specFunctions(wasmWithSpec([funcEntry('balance', 2)]))).methods.balance).toBe(false);
  });

  it('falls back to invoking, with a warning, when the spec cannot be read', async () => {
    for (const wasm of [new Error('fetch failed'), Buffer.from('not wasm at all')]) {
      const client = mockClient({ methods: standardMethods, executable: wasmExec, wasm });
      const r = await inspectToken(TOKEN, ACCOUNT, { client });
      expect(r.status).toBe('ok');
      expect(r.interface?.source).toBe('unavailable');
      expect(r.warnings.join(' ')).toMatch(/Could not read the contract spec/);
    }
  });
});

describe('read-only guarantee', () => {
  it('only ever invokes balance, decimals and allowance', async () => {
    const client = mockClient({ methods: standardMethods });
    await inspectToken(TOKEN, ACCOUNT, { client, spender: SPENDER });
    expect(new Set(client.calls)).toEqual(new Set(['balance', 'decimals', 'allowance']));
    expect(client).not.toHaveProperty('sendTransaction');
  });
});
