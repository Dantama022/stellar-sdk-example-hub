import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  Account,
  Address,
  Keypair,
  Networks,
  rpc,
  SorobanDataBuilder,
  StrKey,
  Transaction,
  xdr,
} from '@stellar/stellar-sdk';

import {
  findUpgradeEntryPoint,
  formatReport,
  PreflightOptions,
  PreflightRpc,
  runUpgradePreflight,
} from '../src/examples/264-contract-upgrade-preflight';

// ── Deterministic fixtures ───────────────────────────────────────────────────

const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 7));
const source = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x11)).publicKey();
const admin = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x22)).publicKey();
const stranger = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x33)).publicKey();

const bytes32 = xdr.ScSpecTypeDef.scSpecTypeBytesN(new xdr.ScSpecTypeBytesN({ n: 32 }));
function specFn(name: string, args: Array<[string, xdr.ScSpecTypeDef]>): xdr.ScSpecEntry {
  return xdr.ScSpecEntry.scSpecEntryFunctionV0(
    new xdr.ScSpecFunctionV0({
      doc: '',
      name,
      inputs: args.map(([n, type]) => new xdr.ScSpecFunctionInputV0({ doc: '', name: n, type })),
      outputs: [],
    }),
  );
}

function leb128(n: number): Buffer {
  const out: number[] = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return Buffer.from(out);
}

/** Smallest valid Wasm module carrying a contractspecv0 custom section. */
function wasmWithSpec(entries: xdr.ScSpecEntry[], version = ''): Buffer {
  const name = Buffer.from('contractspecv0');
  // A per-version function keeps fixture hashes distinct while the spec stays parseable.
  const all = version ? [...entries, specFn(`version_${version}`, [])] : entries;
  const payload = Buffer.concat(all.map((e) => e.toXDR()));
  const body = Buffer.concat([leb128(name.length), name, payload]);
  return Buffer.concat([
    Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]),
    Buffer.from([0]),
    leb128(body.length),
    body,
  ]);
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const CURRENT = wasmWithSpec(
  [specFn('upgrade', [['new_wasm_hash', bytes32]]), specFn('balance', [])],
  'v1',
);
const NEXT = wasmWithSpec(
  [specFn('upgrade', [['new_wasm_hash', bytes32]]), specFn('balance', [])],
  'v2',
);

function authEntry(address: string | 'source'): xdr.SorobanAuthorizationEntry {
  const credentials =
    address === 'source'
      ? xdr.SorobanCredentials.sorobanCredentialsSourceAccount()
      : xdr.SorobanCredentials.sorobanCredentialsAddress(
          new xdr.SorobanAddressCredentials({
            address: Address.fromString(address).toScAddress(),
            nonce: xdr.Int64.fromString('1'),
            signatureExpirationLedger: 0,
            signature: xdr.ScVal.scvVoid(),
          }),
        );
  return new xdr.SorobanAuthorizationEntry({
    credentials,
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(CONTRACT).toScAddress(),
          functionName: 'upgrade',
          args: [],
        }),
      ),
      subInvocations: [],
    }),
  });
}

function simSuccess(
  auth: xdr.SorobanAuthorizationEntry[],
  extra: object = {},
): rpc.Api.SimulateTransactionResponse {
  return {
    id: '1',
    latestLedger: 1000,
    events: [],
    _parsed: true,
    minResourceFee: '45678',
    transactionData: new SorobanDataBuilder().setResources(1_500_000, 2048, 512),
    result: { auth, retval: xdr.ScVal.scvVoid() },
    ...extra,
  } as unknown as rpc.Api.SimulateTransactionResponse;
}

/** Mock Soroban RPC: contract instance, installed code and simulation are configurable. */
class MockRpc implements PreflightRpc {
  passphrase = Networks.TESTNET;
  instance: 'wasm' | 'missing' | 'sac' = 'wasm';
  currentWasm: Buffer | null = CURRENT;
  installed = new Set<string>([sha(CURRENT), sha(NEXT)]);
  simulation: rpc.Api.SimulateTransactionResponse = simSuccess([authEntry(admin)]);
  down = false;
  simulated: Transaction[] = [];
  submitted = 0;

  async getNetwork() {
    if (this.down) throw new Error('connect ECONNREFUSED 127.0.0.1:8000');
    return { passphrase: this.passphrase };
  }
  async getLedgerEntries(...keys: xdr.LedgerKey[]) {
    const key = keys[0];
    if (key.switch().name === 'contractCode') {
      return {
        entries: this.installed.has(key.contractCode().hash().toString('hex'))
          ? [{ val: {} as xdr.LedgerEntryData }]
          : [],
      };
    }
    if (this.instance === 'missing') return { entries: [] };
    const executable =
      this.instance === 'sac'
        ? xdr.ContractExecutable.contractExecutableStellarAsset()
        : xdr.ContractExecutable.contractExecutableWasm(Buffer.from(sha(CURRENT), 'hex'));
    const val = xdr.LedgerEntryData.contractData(
      new xdr.ContractDataEntry({
        ext: xdr.ExtensionPoint.fromXDR(Buffer.alloc(4)),
        contract: Address.fromString(CONTRACT).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
        val: xdr.ScVal.scvContractInstance(
          new xdr.ScContractInstance({ executable, storage: null }),
        ),
      }),
    );
    return { entries: [{ val }] };
  }
  async getContractWasmByHash(): Promise<Buffer> {
    if (!this.currentWasm) throw new Error('not found');
    return this.currentWasm;
  }
  async getAccount(id: string) {
    return new Account(id, '100');
  }
  async simulateTransaction(tx: Transaction) {
    this.simulated.push(tx);
    return this.simulation;
  }
  // Present only to prove it is never called.
  async sendTransaction() {
    this.submitted++;
  }
}

let dir: string;
let nextPath: string;
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'upgrade-preflight-'));
  nextPath = path.join(dir, 'next.wasm');
  await fs.writeFile(nextPath, NEXT);
});

function options(overrides: Partial<PreflightOptions> = {}): PreflightOptions {
  return {
    contractId: CONTRACT,
    replacementWasmPath: nextPath,
    networkPassphrase: Networks.TESTNET,
    sourceAccount: source,
    upgradeFunction: 'upgrade',
    expectedAdmin: admin,
    ...overrides,
  };
}
const codes = (r: { findings: Array<{ code: string }> }) => r.findings.map((f) => f.code);

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Soroban contract upgrade preflight (#600)', () => {
  it('1. inspects the deployed contract and reports readiness', async () => {
    const server = new MockRpc();
    const report = await runUpgradePreflight(server, options());
    expect(report.readiness).toBe('ready');
    expect(report.currentWasmHash).toBe(sha(CURRENT));
    expect(report.currentSpecAvailable).toBe(true);
    expect(report.entryPoint).toEqual({ name: 'upgrade', source: 'verified-in-spec' });
    expect(report.authorization).toMatchObject({ observedAuthorizers: [admin], verified: true });
    expect(report.simulation).toMatchObject({
      succeeded: true,
      minResourceFee: '45678',
      instructions: 1_500_000,
      readBytes: 2048,
      writeBytes: 512,
    });
    // the invocation carries the replacement hash as its BytesN<32> argument
    const op = server.simulated[0].operations[0] as unknown as { func: xdr.HostFunction };
    expect(op.func.invokeContract().args()[0].bytes().toString('hex')).toBe(sha(NEXT));
    expect(server.submitted).toBe(0);
  });

  it('2. blocks on an unavailable contract or a Stellar Asset Contract', async () => {
    const missing = new MockRpc();
    missing.instance = 'missing';
    expect(codes(await runUpgradePreflight(missing, options()))).toContain('contract-unavailable');
    const sac = new MockRpc();
    sac.instance = 'sac';
    expect(codes(await runUpgradePreflight(sac, options()))).toContain('not-wasm-contract');
  });

  it('3. blocks on a missing or unreadable WASM file', async () => {
    const report = await runUpgradePreflight(
      new MockRpc(),
      options({ replacementWasmPath: path.join(dir, 'absent.wasm') }),
    );
    expect(report.readiness).toBe('blocked');
    expect(report.findings[0]).toMatchObject({
      code: 'wasm-unreadable',
      message: expect.stringContaining('ENOENT'),
    });
  });

  it('4. blocks on an invalid WASM artifact', async () => {
    const bad = path.join(dir, 'bad.wasm');
    await fs.writeFile(bad, Buffer.from('definitely not wasm'));
    const report = await runUpgradePreflight(new MockRpc(), options({ replacementWasmPath: bad }));
    expect(report.replacement.validWasm).toBe(false);
    expect(codes(report)).toContain('invalid-wasm');
  });

  it('5. calculates the replacement SHA-256', async () => {
    const report = await runUpgradePreflight(new MockRpc(), options());
    expect(report.replacement).toMatchObject({
      sha256: sha(NEXT),
      validWasm: true,
      specAvailable: true,
      installedOnLedger: true,
    });
  });

  it('6. blocks when the artifact hash differs from the expected release hash', async () => {
    const report = await runUpgradePreflight(
      new MockRpc(),
      options({ expectedReplacementHash: 'ab'.repeat(32) }),
    );
    expect(codes(report)).toContain('hash-mismatch');
    expect(report.readiness).toBe('blocked');
  });

  it('7. blocks when the contract has no upgrade entry point', async () => {
    const server = new MockRpc();
    server.currentWasm = wasmWithSpec([specFn('balance', [])]);
    expect(codes(await runUpgradePreflight(server, options()))).toContain('missing-entry-point');
    expect(
      codes(await runUpgradePreflight(server, options({ upgradeFunction: undefined }))),
    ).toContain('missing-entry-point');
  });

  it('8. blocks when simulation needs no authorization or the wrong admin', async () => {
    const open = new MockRpc();
    open.simulation = simSuccess([]);
    expect(codes(await runUpgradePreflight(open, options()))).toContain('no-authorization');

    const wrong = new MockRpc();
    wrong.simulation = simSuccess([authEntry(stranger)]);
    const report = await runUpgradePreflight(wrong, options());
    expect(codes(report)).toContain('unexpected-authorizer');
    expect(report.authorization.verified).toBe(false);
  });

  it('9. accepts a valid authorization configuration', async () => {
    const server = new MockRpc();
    server.simulation = simSuccess([authEntry('source')]);
    const report = await runUpgradePreflight(server, options({ sourceAccount: admin }));
    expect(report.authorization).toMatchObject({ observedAuthorizers: [admin], verified: true });
    expect(codes(report)).not.toContain('separate-signer');
    expect(report.readiness).toBe('ready');
  });

  it('10. reports a failed simulation (including authorization failures)', async () => {
    const server = new MockRpc();
    server.simulation = {
      id: '1',
      latestLedger: 1,
      events: [{} as xdr.DiagnosticEvent],
      _parsed: true,
      error: 'HostError: Error(WasmVm, InvalidAction)\nmore',
    } as rpc.Api.SimulateTransactionResponse;
    const report = await runUpgradePreflight(server, options());
    expect(report.simulation).toMatchObject({ attempted: true, succeeded: false });
    expect(codes(report)).toContain('authorization-failed');

    server.simulation = {
      id: '1',
      latestLedger: 1,
      events: [],
      _parsed: true,
      error: 'HostError: Error(Storage, MissingValue)',
    } as rpc.Api.SimulateTransactionResponse;
    expect(codes(await runUpgradePreflight(server, options()))).toContain('simulation-failed');
  });

  it('11. reports success with warnings (restore needed, separate signer)', async () => {
    const server = new MockRpc();
    server.simulation = simSuccess([authEntry(admin)], {
      restorePreamble: { minResourceFee: '100', transactionData: new SorobanDataBuilder() },
    });
    const report = await runUpgradePreflight(server, options());
    expect(report.readiness).toBe('ready-with-warnings');
    expect(codes(report)).toEqual(
      expect.arrayContaining(['restore-required', 'separate-signer', 'simulation-not-guarantee']),
    );
  });

  it('12. blocks when RPC is unreachable', async () => {
    const server = new MockRpc();
    server.down = true;
    const report = await runUpgradePreflight(server, options());
    expect(codes(report)).toEqual(['rpc-unavailable']);
    expect(report.simulation.attempted).toBe(false);
  });

  it('13. blocks on a network passphrase mismatch', async () => {
    const report = await runUpgradePreflight(
      new MockRpc(),
      options({ networkPassphrase: Networks.PUBLIC }),
    );
    expect(report.network).toMatchObject({ matches: false, rpcPassphrase: Networks.TESTNET });
    expect(codes(report)).toEqual(['network-mismatch']);
  });

  it('14. flags incomplete metadata and an inferred entry point', async () => {
    const noSpec = new MockRpc();
    noSpec.currentWasm = null;
    const report = await runUpgradePreflight(noSpec, options());
    expect(codes(report)).toEqual(
      expect.arrayContaining(['incomplete-metadata', 'entry-point-unverified']),
    );
    expect(report.entryPoint.source).toBe('unverified');

    const inferred = await runUpgradePreflight(
      new MockRpc(),
      options({ upgradeFunction: undefined }),
    );
    expect(inferred.entryPoint).toEqual({ name: 'upgrade', source: 'inferred-from-spec' });
    expect(inferred.readiness).toBe('ready-with-warnings');
  });

  it('warns when the replacement WASM is not installed or removes the upgrade function', async () => {
    const server = new MockRpc();
    server.installed.delete(sha(NEXT));
    expect(codes(await runUpgradePreflight(server, options()))).toContain('wasm-not-installed');

    const frozen = path.join(dir, 'frozen.wasm');
    const frozenWasm = wasmWithSpec([specFn('balance', [])], 'v3');
    await fs.writeFile(frozen, frozenWasm);
    const s2 = new MockRpc();
    s2.installed.add(sha(frozenWasm));
    expect(
      codes(await runUpgradePreflight(s2, options({ replacementWasmPath: frozen }))),
    ).toContain('upgrade-removed');
  });

  it('refuses to guess between several hash-taking functions', () => {
    const spec = {
      funcs: () =>
        [specFn('upgrade', [['h', bytes32]]), specFn('migrate', [['h', bytes32]])].map((e) =>
          e.functionV0(),
        ),
    };
    expect(findUpgradeEntryPoint(spec).finding?.code).toBe('ambiguous-entry-point');
  });

  it('never logs authorization payloads', async () => {
    const report = await runUpgradePreflight(new MockRpc(), options());
    const text = formatReport(report) + JSON.stringify(report);
    expect(text).not.toMatch(/AAAA[A-Za-z0-9+/]{40,}/); // no XDR blobs
    expect(text).toContain('No transaction was submitted');
  });
});
