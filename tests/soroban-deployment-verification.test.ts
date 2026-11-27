import { readFileSync } from 'fs';
import path from 'path';

import { Networks, contract, rpc, xdr } from '@stellar/stellar-sdk';

import {
  buildContractCodeLedgerKey,
  buildContractInstanceLedgerKey,
  extractExecutableInfo,
  fetchContractCode,
  inspectContractInstance,
} from '../src/examples/281-soroban-deployment-verification/contract-inspector';
import type { SorobanRpcClient } from '../src/examples/281-soroban-deployment-verification/contract-inspector';
import { DeploymentVerificationError } from '../src/examples/281-soroban-deployment-verification/errors';
import { verifyExecutable } from '../src/examples/281-soroban-deployment-verification/executable-verifier';
import {
  readContractSpecFromWasm,
  verifyInterface,
  verifyInterfaceAgainstNetwork,
} from '../src/examples/281-soroban-deployment-verification/interface-verifier';
import {
  SAMPLE_MANIFESTS,
  assertValidManifest,
  isWasmHash,
  loadManifestFile,
  selectManifest,
  validateManifest,
} from '../src/examples/281-soroban-deployment-verification/manifest';
import type { DeploymentManifest } from '../src/examples/281-soroban-deployment-verification/manifest';
import {
  checkNetwork,
  validateRpcEndpoint,
} from '../src/examples/281-soroban-deployment-verification/network-check';
import {
  buildDeploymentVerificationReport,
  determineOverallStatus,
  formatDeploymentVerificationReport,
} from '../src/examples/281-soroban-deployment-verification/report';
import { verifyDeployment } from '../src/examples/281-soroban-deployment-verification/index';

// ---------------------------------------------------------------------------
// Deterministic fixtures
// ---------------------------------------------------------------------------

const CONTRACT_ID = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const ACCOUNT_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const TESTNET_RPC = 'https://soroban-testnet.stellar.org';
const WASM_HASH = 'ab'.repeat(32);
const OTHER_WASM_HASH = 'cd'.repeat(32);
const EMPTY_WASM = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

const EXAMPLE_DIR = path.join(
  __dirname,
  '..',
  'src',
  'examples',
  '281-soroban-deployment-verification',
);

function testnetNetwork(): DeploymentManifest['network'] {
  return { name: 'testnet', passphrase: Networks.TESTNET, rpcUrl: TESTNET_RPC };
}

function wasmManifest(overrides: Partial<DeploymentManifest> = {}): DeploymentManifest {
  return {
    environment: 'testnet',
    contractId: CONTRACT_ID,
    network: testnetNetwork(),
    executable: { type: 'wasm', wasmHash: WASM_HASH },
    ...overrides,
  };
}

function builtinManifest(overrides: Partial<DeploymentManifest> = {}): DeploymentManifest {
  return {
    environment: 'testnet',
    contractId: CONTRACT_ID,
    network: testnetNetwork(),
    executable: { type: 'builtin' },
    ...overrides,
  };
}

function makeInstanceEntry(
  executableType: 'wasm' | 'builtin',
  options: { wasmHash?: string; liveUntilLedgerSeq?: number } = {},
): rpc.Api.LedgerEntryResult {
  const executable =
    executableType === 'wasm'
      ? xdr.ContractExecutable.contractExecutableWasm(
          Buffer.from(options.wasmHash ?? WASM_HASH, 'hex'),
        )
      : xdr.ContractExecutable.contractExecutableStellarAsset();

  const instance = new xdr.ScContractInstance({ executable, storage: null });
  const data = xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: new (xdr.ExtensionPoint as any)(0) as xdr.ExtensionPoint,
      contract: xdr.ScAddress.scAddressTypeContract(Buffer.alloc(32)),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvContractInstance(instance),
    }),
  );

  return {
    key: buildContractInstanceLedgerKey(CONTRACT_ID),
    val: data,
    lastModifiedLedgerSeq: 900,
    liveUntilLedgerSeq: options.liveUntilLedgerSeq ?? 5000,
  };
}

function makeCodeEntry(wasm: Buffer, wasmHash: string = WASM_HASH): rpc.Api.LedgerEntryResult {
  return {
    key: buildContractCodeLedgerKey(wasmHash),
    val: xdr.LedgerEntryData.contractCode(
      new xdr.ContractCodeEntry({
        ext: new (xdr.ContractCodeEntryExt as any)(0) as xdr.ContractCodeEntryExt,
        hash: Buffer.from(wasmHash, 'hex'),
        code: wasm,
      }),
    ),
    lastModifiedLedgerSeq: 800,
    liveUntilLedgerSeq: 4000,
  };
}

interface MockClientOptions {
  passphrase?: string;
  instanceEntry?: rpc.Api.LedgerEntryResult | null;
  codeEntry?: rpc.Api.LedgerEntryResult | null;
  instanceError?: Error;
  codeError?: Error;
  networkError?: Error;
  latestLedger?: number;
}

/** Deterministic in-memory replacement for `rpc.Server`. */
function makeClient(options: MockClientOptions = {}): SorobanRpcClient {
  return {
    async getNetwork() {
      if (options.networkError) throw options.networkError;
      return { passphrase: options.passphrase ?? Networks.TESTNET, protocolVersion: '22' };
    },
    async getLatestLedger() {
      return { sequence: options.latestLedger ?? 1000 };
    },
    async getLedgerEntries(...keys: xdr.LedgerKey[]) {
      const key = keys[0];
      if (key.switch() === xdr.LedgerEntryType.contractData()) {
        if (options.instanceError) throw options.instanceError;
        return { entries: options.instanceEntry ? [options.instanceEntry] : [] };
      }
      if (options.codeError) throw options.codeError;
      return { entries: options.codeEntry ? [options.codeEntry] : [] };
    },
  };
}

function uleb128(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);
  return Buffer.from(bytes);
}

/** Builds a minimal Wasm module that only carries a contractspecv0 section. */
function wasmWithSpec(entries: xdr.ScSpecEntry[]): Buffer {
  const payload = Buffer.concat(entries.map((entry) => entry.toXDR()));
  const sectionName = Buffer.from('contractspecv0', 'utf8');
  const sectionBody = Buffer.concat([uleb128(sectionName.length), sectionName, payload]);
  const magic = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  return Buffer.concat([magic, Buffer.from([0x00]), uleb128(sectionBody.length), sectionBody]);
}

function specFunction(
  name: string,
  inputs: Array<{ name: string; type: xdr.ScSpecTypeDef }> = [],
  outputs: xdr.ScSpecTypeDef[] = [],
): xdr.ScSpecEntry {
  return xdr.ScSpecEntry.scSpecEntryFunctionV0(
    new xdr.ScSpecFunctionV0({
      doc: '',
      name,
      inputs: inputs.map(
        (input) => new xdr.ScSpecFunctionInputV0({ doc: '', name: input.name, type: input.type }),
      ),
      outputs,
    }),
  );
}

const addressType = (): xdr.ScSpecTypeDef => xdr.ScSpecTypeDef.scSpecTypeAddress();
const i128Type = (): xdr.ScSpecTypeDef => xdr.ScSpecTypeDef.scSpecTypeI128();

function counterSpecWasm(): Buffer {
  return wasmWithSpec([
    specFunction('balance', [{ name: 'id', type: addressType() }], [i128Type()]),
    specFunction('ping'),
  ]);
}

// ---------------------------------------------------------------------------
// 1. Manifest validation
// ---------------------------------------------------------------------------

describe('validateRpcEndpoint', () => {
  it('accepts https and http endpoints', () => {
    expect(validateRpcEndpoint('https://soroban-testnet.stellar.org')).toBeNull();
    expect(validateRpcEndpoint('http://localhost:8000')).toBeNull();
  });

  it('rejects an empty value', () => {
    expect(validateRpcEndpoint('')).toMatch(/non-empty/);
  });

  it('rejects an unparsable URL', () => {
    expect(validateRpcEndpoint('not a url')).toMatch(/not a valid URL/);
  });

  it('rejects non-http protocols', () => {
    expect(validateRpcEndpoint('ftp://example.com')).toMatch(/http or https/);
  });
});

describe('validateManifest', () => {
  it('accepts the bundled sample manifest', () => {
    const result = validateManifest(SAMPLE_MANIFESTS.testnet);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.manifest?.executable).toEqual({ type: 'builtin' });
  });

  it('accepts a complete Wasm manifest and normalizes the hash to lowercase', () => {
    const result = validateManifest({
      ...wasmManifest(),
      executable: { type: 'wasm', wasmHash: WASM_HASH.toUpperCase() },
      interface: {
        functions: [
          { name: 'balance', inputs: [{ name: 'id', type: 'address' }], outputs: ['i128'] },
          { name: 'ping', outputs: [] },
        ],
        allowAdditionalFunctions: false,
      },
      metadata: { release: 'v1.2.3' },
    });

    expect(result.valid).toBe(true);
    if (result.manifest?.executable.type !== 'wasm') throw new Error('expected a wasm executable');
    expect(result.manifest.executable.wasmHash).toBe(WASM_HASH);
    expect(result.manifest.interface?.functions).toHaveLength(2);
    expect(result.manifest.metadata).toEqual({ release: 'v1.2.3' });
  });

  it('rejects a non-object manifest', () => {
    expect(validateManifest('nope').valid).toBe(false);
    expect(validateManifest(null).valid).toBe(false);
  });

  it('rejects an account address used as a contract ID', () => {
    const result = validateManifest({ ...wasmManifest(), contractId: ACCOUNT_ID });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/not a valid Stellar contract/);
  });

  it('rejects a Wasm hash used as a contract ID', () => {
    const result = validateManifest({ ...wasmManifest(), contractId: WASM_HASH });
    expect(result.valid).toBe(false);
  });

  it('requires a Wasm hash when the executable is Wasm', () => {
    const result = validateManifest({
      ...wasmManifest(),
      executable: { type: 'wasm' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/wasmHash is required/);
  });

  it('rejects a malformed Wasm hash', () => {
    const result = validateManifest({
      ...wasmManifest(),
      executable: { type: 'wasm', wasmHash: 'abc123' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/64-character hex/);
  });

  it('warns when a built-in executable declares a Wasm hash', () => {
    const result = validateManifest({
      ...builtinManifest(),
      executable: { type: 'builtin', wasmHash: WASM_HASH },
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/ignored/);
  });

  it('rejects an invalid RPC URL without contacting the network', () => {
    const result = validateManifest({
      ...wasmManifest(),
      network: { ...testnetNetwork(), rpcUrl: 'localhost:8000' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/rpcUrl/);
  });

  it('warns for a custom passphrase but still validates', () => {
    const result = validateManifest({
      ...wasmManifest(),
      network: { ...testnetNetwork(), passphrase: 'My Custom Network ; 2026' },
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/not a known Stellar network passphrase/);
  });

  it('rejects duplicate interface function names', () => {
    const result = validateManifest({
      ...wasmManifest(),
      interface: { functions: [{ name: 'ping' }, { name: 'ping' }] },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/duplicate name "ping"/);
  });

  it('rejects an empty interface function list', () => {
    const result = validateManifest({
      ...wasmManifest(),
      interface: { functions: [] },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/non-empty array/);
  });

  it('rejects an unknown executable type', () => {
    const result = validateManifest({
      ...wasmManifest(),
      executable: { type: 'evm' } as unknown as DeploymentManifest['executable'],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/must be 'wasm' or 'builtin'/);
  });

  it('assertValidManifest throws a coded error for invalid input', () => {
    expect(() => assertValidManifest({ contractId: 'nope' })).toThrow(DeploymentVerificationError);
    try {
      assertValidManifest({ contractId: 'nope' });
    } catch (error) {
      expect((error as DeploymentVerificationError).code).toBe('INVALID_MANIFEST');
    }
  });

  it('isWasmHash recognises only 64 hex characters', () => {
    expect(isWasmHash(WASM_HASH)).toBe(true);
    expect(isWasmHash(WASM_HASH.toUpperCase())).toBe(true);
    expect(isWasmHash('ab')).toBe(false);
    expect(isWasmHash(42)).toBe(false);
  });
});

describe('manifest loading helpers', () => {
  it('reports a missing manifest file as an invalid manifest', () => {
    expect(() => loadManifestFile('/definitely/not/here.json')).toThrow(
      DeploymentVerificationError,
    );
  });

  it('selects a manifest by environment', () => {
    expect(selectManifest({ testnet: SAMPLE_MANIFESTS.testnet }, 'testnet')).toBe(
      SAMPLE_MANIFESTS.testnet,
    );
  });

  it('throws when an environment has no manifest', () => {
    expect(() => selectManifest({ testnet: SAMPLE_MANIFESTS.testnet }, 'production')).toThrow(
      /No manifest for environment "production"/,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Ledger keys and instance inspection
// ---------------------------------------------------------------------------

describe('ledger key construction', () => {
  it('builds a persistent contract instance key', () => {
    const key = buildContractInstanceLedgerKey(CONTRACT_ID);
    expect(key.switch()).toBe(xdr.LedgerEntryType.contractData());
    expect(key.contractData().durability()).toBe(xdr.ContractDataDurability.persistent());
    expect(key.contractData().key().switch()).toBe(xdr.ScValType.scvLedgerKeyContractInstance());
  });

  it('rejects an invalid contract address', () => {
    expect(() => buildContractInstanceLedgerKey(ACCOUNT_ID)).toThrow(DeploymentVerificationError);
  });

  it('builds a contract code key from a Wasm hash', () => {
    const key = buildContractCodeLedgerKey(WASM_HASH);
    expect(key.switch()).toBe(xdr.LedgerEntryType.contractCode());
    expect(key.contractCode().hash().toString('hex')).toBe(WASM_HASH);
  });

  it('rejects an invalid Wasm hash', () => {
    expect(() => buildContractCodeLedgerKey('deadbeef')).toThrow(/64-character hex/);
  });
});

describe('extractExecutableInfo', () => {
  it('extracts a Wasm hash (not the contract address)', () => {
    const info = extractExecutableInfo(makeInstanceEntry('wasm'));
    expect(info).toEqual({ kind: 'wasm', wasmHash: WASM_HASH, typeName: 'wasm' });
  });

  it('classifies built-in executables without a hash', () => {
    const info = extractExecutableInfo(makeInstanceEntry('builtin'));
    expect(info).toEqual({ kind: 'builtin', wasmHash: null, typeName: 'stellarAsset' });
  });

  it('returns null for a non-instance ledger entry', () => {
    expect(extractExecutableInfo(makeCodeEntry(counterSpecWasm()))).toBeNull();
  });
});

describe('inspectContractInstance', () => {
  it('records instance metadata for an available Wasm contract', async () => {
    const client = makeClient({ instanceEntry: makeInstanceEntry('wasm') });
    const inspection = await inspectContractInstance(client, CONTRACT_ID);

    expect(inspection.status).toBe('found');
    expect(inspection.latestLedger).toBe(1000);
    expect(inspection.lastModifiedLedgerSeq).toBe(900);
    expect(inspection.liveUntilLedgerSeq).toBe(5000);
    expect(inspection.executable?.wasmHash).toBe(WASM_HASH);
    expect(inspection.error).toBeNull();
  });

  it('reports a contract that is missing from the expected network', async () => {
    const inspection = await inspectContractInstance(makeClient(), CONTRACT_ID);
    expect(inspection.status).toBe('not_found');
    expect(inspection.error).toMatch(/not found/);
  });

  it('reports an RPC failure while fetching the instance', async () => {
    const client = makeClient({ instanceError: new Error('connection refused') });
    const inspection = await inspectContractInstance(client, CONTRACT_ID);
    expect(inspection.status).toBe('error');
    expect(inspection.error).toMatch(/RPC failure fetching contract instance/);
  });

  it('classifies an archived entry error', async () => {
    const client = makeClient({ instanceError: new Error('entry is archived and expired') });
    const inspection = await inspectContractInstance(client, CONTRACT_ID);
    expect(inspection.status).toBe('error');
    expect(inspection.error).toMatch(/archived or expired/);
  });

  it('reports a latest-ledger RPC failure', async () => {
    const client: SorobanRpcClient = {
      ...makeClient({ instanceEntry: makeInstanceEntry('wasm') }),
      getLatestLedger: async () => {
        throw new Error('timeout');
      },
    };
    const inspection = await inspectContractInstance(client, CONTRACT_ID);
    expect(inspection.status).toBe('error');
    expect(inspection.error).toMatch(/latest ledger/);
  });

  it('does not throw for an invalid contract address', async () => {
    const inspection = await inspectContractInstance(makeClient(), ACCOUNT_ID);
    expect(inspection.status).toBe('error');
    expect(inspection.error).toMatch(/not a valid Stellar contract/);
  });
});

describe('fetchContractCode', () => {
  it('returns the Wasm bytes from the code entry', async () => {
    const wasm = counterSpecWasm();
    const lookup = await fetchContractCode(
      makeClient({ codeEntry: makeCodeEntry(wasm) }),
      WASM_HASH,
    );
    expect(lookup.status).toBe('found');
    expect(lookup.code?.equals(wasm)).toBe(true);
  });

  it('reports a missing code entry', async () => {
    const lookup = await fetchContractCode(makeClient(), WASM_HASH);
    expect(lookup.status).toBe('not_found');
  });

  it('reports an RPC failure', async () => {
    const lookup = await fetchContractCode(
      makeClient({ codeError: new Error('socket hang up') }),
      WASM_HASH,
    );
    expect(lookup.status).toBe('error');
    expect(lookup.error).toMatch(/RPC failure fetching contract code entry/);
  });
});

// ---------------------------------------------------------------------------
// 3. Network verification
// ---------------------------------------------------------------------------

describe('checkNetwork', () => {
  it('matches the expected passphrase', async () => {
    const result = await checkNetwork(makeClient(), {
      passphrase: Networks.TESTNET,
      rpcUrl: TESTNET_RPC,
    });
    expect(result.status).toBe('match');
    expect(result.protocolVersion).toBe('22');
  });

  it('detects a passphrase mismatch', async () => {
    const result = await checkNetwork(makeClient({ passphrase: Networks.PUBLIC }), {
      passphrase: Networks.TESTNET,
      rpcUrl: TESTNET_RPC,
    });
    expect(result.status).toBe('mismatch');
    expect(result.reportedPassphrase).toBe(Networks.PUBLIC);
  });

  it('is unavailable when the endpoint cannot report its network', async () => {
    const result = await checkNetwork(makeClient({ networkError: new Error('ECONNREFUSED') }), {
      passphrase: Networks.TESTNET,
      rpcUrl: TESTNET_RPC,
    });
    expect(result.status).toBe('unavailable');
    expect(result.error).toMatch(/RPC network check failed/);
  });
});

// ---------------------------------------------------------------------------
// 4. Executable verification
// ---------------------------------------------------------------------------

describe('verifyExecutable', () => {
  const wasmInspection = {
    contractId: CONTRACT_ID,
    status: 'found' as const,
    latestLedger: 1000,
    lastModifiedLedgerSeq: 900,
    liveUntilLedgerSeq: 5000,
    executable: { kind: 'wasm' as const, wasmHash: WASM_HASH, typeName: 'wasm' },
    error: null,
  };

  it('matches a Wasm hash', () => {
    const result = verifyExecutable(wasmInspection, { type: 'wasm', wasmHash: WASM_HASH });
    expect(result.status).toBe('match');
  });

  it('matches a hash regardless of hex case', () => {
    const result = verifyExecutable(wasmInspection, {
      type: 'wasm',
      wasmHash: WASM_HASH.toUpperCase(),
    });
    expect(result.status).toBe('match');
  });

  it('reports a Wasm hash mismatch', () => {
    const result = verifyExecutable(wasmInspection, { type: 'wasm', wasmHash: OTHER_WASM_HASH });
    expect(result.status).toBe('mismatch');
    expect(result.reason).toMatch(/Wasm hash mismatch/);
    expect(result.reason).toContain(OTHER_WASM_HASH);
  });

  it('reports a type mismatch when the manifest expects Wasm but the contract is built-in', () => {
    const builtin = {
      ...wasmInspection,
      executable: { kind: 'builtin' as const, wasmHash: null, typeName: 'stellarAsset' },
    };
    const result = verifyExecutable(builtin, { type: 'wasm', wasmHash: WASM_HASH });
    expect(result.status).toBe('mismatch');
    expect(result.reason).toMatch(/Expected a Wasm executable/);
  });

  it('handles a built-in executable expectation', () => {
    const builtin = {
      ...wasmInspection,
      executable: { kind: 'builtin' as const, wasmHash: null, typeName: 'stellarAsset' },
    };
    const result = verifyExecutable(builtin, { type: 'builtin' });
    expect(result.status).toBe('match');
    expect(result.notes.join(' ')).toMatch(/no Wasm hash/);
  });

  it('reports a mismatch when a built-in is expected but Wasm is deployed', () => {
    const result = verifyExecutable(wasmInspection, { type: 'builtin' });
    expect(result.status).toBe('mismatch');
    expect(result.reason).toMatch(/Expected a built-in executable/);
  });

  it('is inconclusive for an unrecognised executable type', () => {
    const unknown = {
      ...wasmInspection,
      executable: { kind: 'unknown' as const, wasmHash: null, typeName: 'futureExecutable' },
    };
    const result = verifyExecutable(unknown, { type: 'builtin' });
    expect(result.status).toBe('inconclusive');
    expect(result.notes.join(' ')).toMatch(/unrecognised executable type/);
  });

  it('is inconclusive when the executable is unavailable', () => {
    const unavailable = { ...wasmInspection, executable: null, error: 'instance entry missing' };
    const result = verifyExecutable(unavailable, { type: 'wasm', wasmHash: WASM_HASH });
    expect(result.status).toBe('inconclusive');
    expect(result.notes.join(' ')).toMatch(/unavailable/);
  });

  it('is inconclusive when the contract was not found', () => {
    const missing = { ...wasmInspection, status: 'not_found' as const, executable: null };
    const result = verifyExecutable(missing, { type: 'wasm', wasmHash: WASM_HASH });
    expect(result.status).toBe('inconclusive');
  });
});

// ---------------------------------------------------------------------------
// 5. Interface verification
// ---------------------------------------------------------------------------

describe('readContractSpecFromWasm', () => {
  it('parses exported functions from the contractspecv0 section', () => {
    const result = readContractSpecFromWasm(counterSpecWasm());
    expect(result.status).toBe('ok');
    expect(result.spec?.funcs().map((fn) => fn.name().toString())).toEqual(['balance', 'ping']);
  });

  it('reports a missing spec section', () => {
    expect(readContractSpecFromWasm(EMPTY_WASM).status).toBe('no_spec_section');
  });

  it('reports unreadable Wasm', () => {
    expect(readContractSpecFromWasm(Buffer.from('not wasm')).status).toBe('unreadable_wasm');
  });
});

describe('verifyInterface', () => {
  const spec = new contract.Spec([
    specFunction('balance', [{ name: 'id', type: addressType() }], [i128Type()]),
    specFunction('ping'),
  ]);

  it('matches the expected function set', () => {
    const result = verifyInterface(spec, {
      functions: [
        { name: 'balance', inputs: [{ type: 'address' }], outputs: ['i128'] },
        { name: 'ping', outputs: [] },
      ],
    });
    expect(result.status).toBe('match');
    expect(result.signatureMismatches).toEqual([]);
  });

  it('reports missing functions', () => {
    const result = verifyInterface(spec, {
      functions: [{ name: 'balance', inputs: [{ type: 'address' }] }, { name: 'admin' }],
      allowAdditionalFunctions: true,
    });
    expect(result.status).toBe('mismatch');
    expect(result.missingFunctions).toEqual(['admin']);
  });

  it('reports signature mismatches', () => {
    const result = verifyInterface(spec, {
      functions: [{ name: 'balance', inputs: [{ type: 'symbol' }], outputs: ['i64'] }],
      allowAdditionalFunctions: true,
    });
    expect(result.status).toBe('mismatch');
    expect(result.signatureMismatches).toHaveLength(1);
    expect(result.signatureMismatches[0].actual).toContain('address');
  });

  it('reports unexpected functions unless they are allowed', () => {
    const strict = verifyInterface(spec, {
      functions: [{ name: 'balance', inputs: [{ type: 'address' }] }],
    });
    expect(strict.status).toBe('mismatch');
    expect(strict.unexpectedFunctions).toEqual(['ping']);

    const permissive = verifyInterface(spec, {
      functions: [{ name: 'balance', inputs: [{ type: 'address' }] }],
      allowAdditionalFunctions: true,
    });
    expect(permissive.status).toBe('match');
  });

  it('ignores internal "__" prefixed spec functions', () => {
    const withInternal = new contract.Spec([
      specFunction('balance', [], [i128Type()]),
      specFunction('__constructor'),
    ]);

    const result = verifyInterface(withInternal, {
      functions: [{ name: 'balance', outputs: ['i128'] }],
    });
    expect(result.status).toBe('match');
    expect(result.notes.join(' ')).toMatch(/internal spec function/);
  });
});

describe('verifyInterfaceAgainstNetwork', () => {
  it('is not applicable when the manifest declares no interface', async () => {
    const inspection = await inspectContractInstance(
      makeClient({ instanceEntry: makeInstanceEntry('wasm') }),
      CONTRACT_ID,
    );
    const result = await verifyInterfaceAgainstNetwork(makeClient(), inspection, undefined);
    expect(result.status).toBe('not_applicable');
    expect(result.notes.join(' ')).toMatch(/do not prove/);
  });

  it('verifies the interface from the deployed specification', async () => {
    const client = makeClient({
      instanceEntry: makeInstanceEntry('wasm'),
      codeEntry: makeCodeEntry(counterSpecWasm()),
    });
    const inspection = await inspectContractInstance(client, CONTRACT_ID);
    const result = await verifyInterfaceAgainstNetwork(client, inspection, {
      functions: [
        { name: 'balance', inputs: [{ type: 'address' }], outputs: ['i128'] },
        { name: 'ping' },
      ],
    });
    expect(result.status).toBe('match');
    expect(result.specificationAvailable).toBe(true);
  });

  it('reports an interface mismatch retrieved from the network', async () => {
    const client = makeClient({
      instanceEntry: makeInstanceEntry('wasm'),
      codeEntry: makeCodeEntry(counterSpecWasm()),
    });
    const inspection = await inspectContractInstance(client, CONTRACT_ID);
    const result = await verifyInterfaceAgainstNetwork(client, inspection, {
      functions: [{ name: 'transfer' }],
      allowAdditionalFunctions: true,
    });
    expect(result.status).toBe('mismatch');
    expect(result.missingFunctions).toEqual(['transfer']);
  });

  it('is unavailable for a built-in executable', async () => {
    const client = makeClient({ instanceEntry: makeInstanceEntry('builtin') });
    const inspection = await inspectContractInstance(client, CONTRACT_ID);
    const result = await verifyInterfaceAgainstNetwork(client, inspection, {
      functions: [{ name: 'transfer' }],
    });
    expect(result.status).toBe('unavailable');
    expect(result.notes.join(' ')).toMatch(/no on-chain specification/);
  });

  it('is unavailable when the code entry is missing', async () => {
    const client = makeClient({ instanceEntry: makeInstanceEntry('wasm') });
    const inspection = await inspectContractInstance(client, CONTRACT_ID);
    const result = await verifyInterfaceAgainstNetwork(client, inspection, {
      functions: [{ name: 'balance' }],
    });
    expect(result.status).toBe('unavailable');
    expect(result.notes.join(' ')).toMatch(/code entry .* is missing/);
  });

  it('is unavailable when the code RPC call fails', async () => {
    const client = makeClient({
      instanceEntry: makeInstanceEntry('wasm'),
      codeError: new Error('rpc unavailable'),
    });
    const inspection = await inspectContractInstance(client, CONTRACT_ID);
    const result = await verifyInterfaceAgainstNetwork(client, inspection, {
      functions: [{ name: 'balance' }],
    });
    expect(result.status).toBe('unavailable');
    expect(result.notes.join(' ')).toMatch(/Specification retrieval failed/);
  });

  it('is unavailable when the Wasm publishes no specification', async () => {
    const client = makeClient({
      instanceEntry: makeInstanceEntry('wasm'),
      codeEntry: makeCodeEntry(EMPTY_WASM),
    });
    const inspection = await inspectContractInstance(client, CONTRACT_ID);
    const result = await verifyInterfaceAgainstNetwork(client, inspection, {
      functions: [{ name: 'balance' }],
    });
    expect(result.status).toBe('unavailable');
    expect(result.notes.join(' ')).toMatch(/contractspecv0/);
  });

  it('is unavailable when the instance itself is unavailable', async () => {
    const client = makeClient();
    const inspection = await inspectContractInstance(client, CONTRACT_ID);
    const result = await verifyInterfaceAgainstNetwork(client, inspection, {
      functions: [{ name: 'balance' }],
    });
    expect(result.status).toBe('unavailable');
    expect(result.notes.join(' ')).toMatch(/Contract instance is unavailable/);
  });
});

// ---------------------------------------------------------------------------
// 6. Report and end-to-end audit
// ---------------------------------------------------------------------------

describe('report aggregation', () => {
  it('determines the overall status from mismatches and inconclusive checks', () => {
    expect(determineOverallStatus([], [])).toBe('verified');
    expect(determineOverallStatus(['boom'], [])).toBe('failed');
    expect(determineOverallStatus([], ['unknown'])).toBe('inconclusive');
    expect(determineOverallStatus(['boom'], ['unknown'])).toBe('failed');
  });

  it('builds a verified report when every check matches', async () => {
    const client = makeClient({
      instanceEntry: makeInstanceEntry('wasm'),
      codeEntry: makeCodeEntry(counterSpecWasm()),
    });
    const report = await verifyDeployment(
      client,
      wasmManifest({
        interface: {
          functions: [
            { name: 'balance', inputs: [{ type: 'address' }], outputs: ['i128'] },
            { name: 'ping' },
          ],
        },
      }),
    );

    expect(report.overallStatus).toBe('verified');
    expect(report.availability.status).toBe('available');
    expect(report.executable.status).toBe('match');
    expect(report.interface.status).toBe('match');
    expect(report.mismatches).toEqual([]);
    expect(report.inconclusiveChecks).toEqual([]);
    expect(report.network.passphrase).toBe(Networks.TESTNET);
  });

  it('fails the audit when the Wasm hash does not match', async () => {
    const client = makeClient({
      instanceEntry: makeInstanceEntry('wasm', { wasmHash: OTHER_WASM_HASH }),
      codeEntry: makeCodeEntry(counterSpecWasm(), OTHER_WASM_HASH),
    });
    const report = await verifyDeployment(client, wasmManifest());

    expect(report.overallStatus).toBe('failed');
    expect(report.mismatches.join(' ')).toMatch(/Wasm hash mismatch/);
  });

  it('fails and skips inspection when the network passphrase mismatches', async () => {
    const client = makeClient({
      passphrase: Networks.PUBLIC,
      instanceEntry: makeInstanceEntry('wasm'),
    });
    const report = await verifyDeployment(client, wasmManifest());

    expect(report.networkCheck.status).toBe('mismatch');
    expect(report.overallStatus).toBe('failed');
    expect(report.availability.status).toBe('unavailable');
    expect(report.mismatches.join(' ')).toMatch(/Network passphrase mismatch/);
    expect(report.inconclusiveChecks.join(' ')).toMatch(/skipped/);
  });

  it('fails when the contract is missing from the expected network', async () => {
    const report = await verifyDeployment(makeClient(), wasmManifest());
    expect(report.overallStatus).toBe('failed');
    expect(report.availability.status).toBe('not_found');
    expect(report.mismatches.join(' ')).toMatch(/not found/);
  });

  it('is inconclusive when an expected interface has no retrievable specification', async () => {
    const client = makeClient({
      instanceEntry: makeInstanceEntry('wasm'),
      codeEntry: makeCodeEntry(EMPTY_WASM),
    });
    const report = await verifyDeployment(
      client,
      wasmManifest({ interface: { functions: [{ name: 'balance' }] } }),
    );

    expect(report.executable.status).toBe('match');
    expect(report.interface.status).toBe('unavailable');
    expect(report.inconclusiveChecks.join(' ')).toMatch(/contractspecv0/);
    expect(report.overallStatus).toBe('inconclusive');
  });

  it('is inconclusive when the RPC endpoint is unavailable', async () => {
    const client = makeClient({
      networkError: new Error('ECONNREFUSED'),
      instanceError: new Error('ECONNREFUSED'),
    });
    const report = await verifyDeployment(client, wasmManifest());

    expect(report.networkCheck.status).toBe('unavailable');
    expect(report.overallStatus).toBe('inconclusive');
    expect(report.inconclusiveChecks.length).toBeGreaterThan(0);
  });

  it('warns when the instance TTL has already expired', async () => {
    const client = makeClient({
      instanceEntry: makeInstanceEntry('builtin', { liveUntilLedgerSeq: 500 }),
    });
    const report = await verifyDeployment(client, builtinManifest());
    expect(report.warnings.join(' ')).toMatch(/TTL has expired/);
  });

  it('treats missing interface expectations as a warning, not a pass on equivalence', async () => {
    const client = makeClient({ instanceEntry: makeInstanceEntry('builtin') });
    const report = await verifyDeployment(client, builtinManifest());
    expect(report.interface.status).toBe('not_applicable');
    expect(report.warnings.join(' ')).toMatch(/do not prove/);
    expect(report.overallStatus).toBe('verified');
  });

  it('renders a human-readable report and stays JSON serializable', async () => {
    const client = makeClient({ instanceEntry: makeInstanceEntry('builtin') });
    const report = await verifyDeployment(client, builtinManifest());

    expect(() => JSON.stringify(report)).not.toThrow();

    const text = formatDeploymentVerificationReport(report);
    expect(text).toContain('=== Soroban Deployment Verification Report ===');
    expect(text).toContain(`Contract address:     ${CONTRACT_ID}`);
    expect(text).toContain('--- Executable verification ---');
    expect(text).toContain('--- Interface verification ---');
    expect(text).toContain('--- Configuration audit ---');
    expect(text).toContain('Overall verification: VERIFIED');
  });

  it('passes manifest validation warnings into the report', async () => {
    const client = makeClient({ instanceEntry: makeInstanceEntry('builtin') });
    const report = await verifyDeployment(client, builtinManifest(), {
      manifestWarnings: ['custom warning'],
    });
    expect(report.warnings).toContain('custom warning');
  });

  it('buildDeploymentVerificationReport can be driven with pre-computed checks', () => {
    const report = buildDeploymentVerificationReport({
      manifest: builtinManifest(),
      inspection: {
        contractId: CONTRACT_ID,
        status: 'found',
        latestLedger: 1000,
        lastModifiedLedgerSeq: 900,
        liveUntilLedgerSeq: 5000,
        executable: { kind: 'builtin', wasmHash: null, typeName: 'stellarAsset' },
        error: null,
      },
      networkCheck: {
        status: 'match',
        rpcUrl: TESTNET_RPC,
        expectedPassphrase: Networks.TESTNET,
        reportedPassphrase: Networks.TESTNET,
        protocolVersion: '22',
        error: null,
      },
      executableVerification: {
        status: 'match',
        expectedType: 'builtin',
        actualType: 'builtin',
        expectedWasmHash: null,
        retrievedWasmHash: null,
        reason: null,
        notes: [],
      },
      interfaceVerification: {
        status: 'not_applicable',
        specificationAvailable: false,
        expectedFunctions: [],
        actualFunctions: [],
        missingFunctions: [],
        unexpectedFunctions: [],
        signatureMismatches: [],
        notes: ['no expected interface'],
      },
    });

    expect(report.overallStatus).toBe('verified');
    expect(report.metadata).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 7. Read-only guarantee and repository integration
// ---------------------------------------------------------------------------

describe('read-only guarantee', () => {
  const modules = [
    'index.ts',
    'manifest.ts',
    'network-check.ts',
    'contract-inspector.ts',
    'executable-verifier.ts',
    'interface-verifier.ts',
    'report.ts',
  ];

  it('never builds, signs or submits a transaction', () => {
    for (const moduleName of modules) {
      const source = readFileSync(path.join(EXAMPLE_DIR, moduleName), 'utf8');
      expect(source).not.toMatch(/prepareTransaction|sendTransaction|submitTransaction/);
      expect(source).not.toMatch(/assembleTransaction|signTransaction/);
      expect(source).not.toMatch(/\.sign\(/);
    }
  });

  it('only calls read-only RPC methods', () => {
    const combined = modules
      .map((moduleName) => readFileSync(path.join(EXAMPLE_DIR, moduleName), 'utf8'))
      .join('\n');
    const rpcCalls = combined.match(/\.get[A-Z][A-Za-z]+\(/g) ?? [];
    for (const call of rpcCalls) {
      expect(['.getNetwork(', '.getLatestLedger(', '.getLedgerEntries(']).toContain(call);
    }
  });
});

describe('repository integration', () => {
  it('registers the example in the runner catalog', () => {
    const catalog = readFileSync(path.join(__dirname, '..', 'src', 'runner', 'catalog.ts'), 'utf8');
    expect(catalog).toContain("'281-soroban-deployment-verification'");
    expect(catalog).toContain(
      "loadExample('../examples/281-soroban-deployment-verification/index')",
    );
  });

  it('documents the example in README.md', () => {
    const readme = readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    expect(readme).toContain('281-soroban-deployment-verification');
  });

  it('ships an example README with setup and usage instructions', () => {
    const readme = readFileSync(path.join(EXAMPLE_DIR, 'README.md'), 'utf8');
    expect(readme).toContain('MANIFEST_FILE');
    expect(readme).toContain('npm run run-example 281-soroban-deployment-verification');
    expect(readme).toMatch(/read-only/i);
  });
});
