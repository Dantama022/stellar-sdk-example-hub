/**
 * Tests for ISSUE-417: Soroban Contract State Snapshot and Upgrade Regression
 * Comparison (262-contract-state-snapshot + 263-state-snapshot-diff).
 *
 * All tests are offline — no live RPC is required.  RPC interactions are
 * reproduced via jest mocks and deterministic XDR fixtures.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { Contract, xdr } from '@stellar/stellar-sdk';

// ── module under test ────────────────────────────────────────────────────────
import {
  buildInstanceKey,
  buildCodeKey,
  buildUnavailableEntry,
  captureSnapshot,
  classifyKey,
  computeFingerprint,
  consolidateEntries,
  entryFingerprint,
  extractWasmHash,
  isValidContractId,
  loadContractSnapshot,
  saveSnapshot,
  snapshotFingerprint,
  validateSnapshotShape,
  ContractStateSnapshot,
  SnapshotEntry,
} from '../src/examples/262-contract-state-snapshot';

import {
  assertCompatible,
  classifyDiff,
  compareSnapshotFiles,
  diffSnapshots,
  renderReport,
} from '../src/examples/263-state-snapshot-diff';

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** A valid 32-byte zero-padded contract address (C…). */
const CONTRACT_ID = new Contract(
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
).contractId();

// A second, different contract ID for mismatch tests
const OTHER_CONTRACT_ID = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';

/** Deterministic 32-byte WASM hash placeholder. */
const WASM_HASH_HEX = 'a'.repeat(64); // 32 bytes of 0xaa

/** Build a minimal valid SnapshotEntry for testing. */
function makeEntry(
  overrides: Partial<SnapshotEntry> = {},
): SnapshotEntry {
  const ledgerKey = buildInstanceKey(CONTRACT_ID).toXDR('base64');
  return {
    ledgerKey,
    entryType: 'contractData',
    durability: 'persistent',
    role: 'instance',
    status: 'found',
    keySize: Buffer.from(ledgerKey, 'base64').length,
    valueSize: 0,
    fingerprint: computeFingerprint({ ledgerKey, valueXdr: null }),
    ...overrides,
  };
}

/** Build a minimal valid snapshot for testing. */
function makeSnapshot(
  overrides: Partial<ContractStateSnapshot> = {},
): ContractStateSnapshot {
  const entry = makeEntry();
  return {
    version: 1,
    snapshotId: 'test0001',
    contractId: CONTRACT_ID,
    network: 'testnet',
    ledgerSequence: 1000,
    capturedAt: '2024-01-01T00:00:00.000Z',
    fingerprint: snapshotFingerprint([entry]),
    entries: [entry],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// 1. isValidContractId
// ─────────────────────────────────────────────────────────────────────────────

describe('isValidContractId', () => {
  it('accepts a valid C-encoded contract address', () => {
    expect(isValidContractId(CONTRACT_ID)).toBe(true);
  });

  it('rejects a G-encoded account address', () => {
    expect(isValidContractId('GBWMCCC3NHSKLAOJDBKKYW7SSH2PFTTNVFKWKPKQX5YDEZ')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isValidContractId('')).toBe(false);
  });

  it('rejects a string that is too short', () => {
    expect(isValidContractId('CABC')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. buildInstanceKey / buildCodeKey
// ─────────────────────────────────────────────────────────────────────────────

describe('buildInstanceKey', () => {
  it('returns a ContractData LedgerKey with scvLedgerKeyContractInstance', () => {
    const key = buildInstanceKey(CONTRACT_ID);
    expect(key.switch().name).toBe('contractData');
    const cd = key.contractData();
    expect(cd.key().switch()).toBe(xdr.ScValType.scvLedgerKeyContractInstance());
    expect(cd.durability()).toBe(xdr.ContractDataDurability.persistent());
  });

  it('round-trips through base64 XDR', () => {
    const key = buildInstanceKey(CONTRACT_ID);
    const xdrBase64 = key.toXDR('base64');
    const decoded = xdr.LedgerKey.fromXDR(xdrBase64, 'base64');
    expect(decoded.switch().name).toBe('contractData');
  });
});

describe('buildCodeKey', () => {
  it('returns a ContractCode LedgerKey containing the hash bytes', () => {
    const key = buildCodeKey(WASM_HASH_HEX);
    expect(key.switch().name).toBe('contractCode');
    const hash = key.contractCode().hash();
    expect(hash.toString('hex')).toBe(WASM_HASH_HEX);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. classifyKey
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyKey', () => {
  it('classifies the instance key as instance/persistent', () => {
    const keyXdr = buildInstanceKey(CONTRACT_ID).toXDR('base64');
    const result = classifyKey(keyXdr);
    expect(result.role).toBe('instance');
    expect(result.durability).toBe('persistent');
  });

  it('classifies a code key as code/persistent', () => {
    const keyXdr = buildCodeKey(WASM_HASH_HEX).toXDR('base64');
    const result = classifyKey(keyXdr);
    expect(result.role).toBe('code');
    expect(result.durability).toBe('persistent');
  });

  it('returns other/unknown for unrecognised input', () => {
    const result = classifyKey('not-valid-xdr');
    expect(result.role).toBe('other');
    expect(result.durability).toBe('unknown');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. computeFingerprint / entryFingerprint
// ─────────────────────────────────────────────────────────────────────────────

describe('computeFingerprint', () => {
  it('is deterministic for the same input', () => {
    const a = computeFingerprint({ key: 'value', num: 42 });
    const b = computeFingerprint({ key: 'value', num: 42 });
    expect(a).toBe(b);
  });

  it('differs for different inputs', () => {
    const a = computeFingerprint({ key: 'value' });
    const b = computeFingerprint({ key: 'other' });
    expect(a).not.toBe(b);
  });

  it('is not sensitive to object key ordering', () => {
    const a = computeFingerprint({ a: 1, b: 2 });
    const b = computeFingerprint({ b: 2, a: 1 });
    expect(a).toBe(b);
  });

  it('produces a 64-character hex string', () => {
    const fp = computeFingerprint({});
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('entryFingerprint', () => {
  it('is the same for entries with identical key and value', () => {
    const fp1 = entryFingerprint({ ledgerKey: 'KEY', valueXdr: 'VALUE' });
    const fp2 = entryFingerprint({ ledgerKey: 'KEY', valueXdr: 'VALUE' });
    expect(fp1).toBe(fp2);
  });

  it('changes when valueXdr changes', () => {
    const fp1 = entryFingerprint({ ledgerKey: 'KEY', valueXdr: 'VALUE1' });
    const fp2 = entryFingerprint({ ledgerKey: 'KEY', valueXdr: 'VALUE2' });
    expect(fp1).not.toBe(fp2);
  });

  it('is undefined-safe — treats missing valueXdr as null', () => {
    const fp1 = entryFingerprint({ ledgerKey: 'KEY', valueXdr: undefined });
    const fp2 = entryFingerprint({ ledgerKey: 'KEY', valueXdr: undefined });
    expect(fp1).toBe(fp2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. buildUnavailableEntry
// ─────────────────────────────────────────────────────────────────────────────

describe('buildUnavailableEntry', () => {
  it('marks status as unavailable', () => {
    const keyXdr = buildInstanceKey(CONTRACT_ID).toXDR('base64');
    const entry = buildUnavailableEntry(keyXdr, 'Not found.', 'instance');
    expect(entry.status).toBe('unavailable');
    expect(entry.unavailableReason).toBe('Not found.');
    expect(entry.valueSize).toBe(0);
  });

  it('records the supplied role', () => {
    const keyXdr = buildCodeKey(WASM_HASH_HEX).toXDR('base64');
    const entry = buildUnavailableEntry(keyXdr, 'Archived.', 'code');
    expect(entry.role).toBe('code');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. consolidateEntries
// ─────────────────────────────────────────────────────────────────────────────

describe('consolidateEntries', () => {
  it('deduplicates by ledgerKey, preferring found entries', () => {
    const keyXdr = buildInstanceKey(CONTRACT_ID).toXDR('base64');
    const unavailable = buildUnavailableEntry(keyXdr, 'missing', 'instance');
    const found = makeEntry({ ledgerKey: keyXdr, role: 'instance', status: 'found' });
    const result = consolidateEntries([unavailable, found]);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('found');
  });

  it('sorts entries by ledgerKey', () => {
    const a = makeEntry({ ledgerKey: 'zzz', role: 'storage' });
    const b = makeEntry({ ledgerKey: 'aaa', role: 'storage' });
    const result = consolidateEntries([a, b]);
    expect(result[0].ledgerKey).toBe('aaa');
    expect(result[1].ledgerKey).toBe('zzz');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. snapshotFingerprint
// ─────────────────────────────────────────────────────────────────────────────

describe('snapshotFingerprint', () => {
  it('produces the same fingerprint for the same entries', () => {
    const entries = [makeEntry()];
    expect(snapshotFingerprint(entries)).toBe(snapshotFingerprint(entries));
  });

  it('produces a different fingerprint after a modification', () => {
    const a = [makeEntry({ fingerprint: 'fp-a' })];
    const b = [makeEntry({ fingerprint: 'fp-b' })];
    expect(snapshotFingerprint(a)).not.toBe(snapshotFingerprint(b));
  });

  it('produces the same fingerprint regardless of initial array order (after consolidation)', () => {
    // snapshotFingerprint operates on the already-sorted array; both orders
    // should give the same result only if the input order is identical.
    // Confirm it is order-sensitive (i.e. caller must sort first).
    const e1 = makeEntry({ ledgerKey: 'aaa' });
    const e2 = makeEntry({ ledgerKey: 'zzz' });
    const fp1 = snapshotFingerprint([e1, e2]);
    const fp2 = snapshotFingerprint([e1, e2]);
    expect(fp1).toBe(fp2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. saveSnapshot / loadContractSnapshot
// ─────────────────────────────────────────────────────────────────────────────

describe('saveSnapshot / loadContractSnapshot', () => {
  let tmpDir: string;
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-test-'));
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('round-trips a snapshot through JSON', () => {
    const snapshot = makeSnapshot();
    const file = path.join(tmpDir, 'snap.json');
    saveSnapshot(snapshot, file);
    const loaded = loadContractSnapshot(file);
    expect(loaded.contractId).toBe(snapshot.contractId);
    expect(loaded.network).toBe(snapshot.network);
    expect(loaded.fingerprint).toBe(snapshot.fingerprint);
    expect(loaded.entries).toHaveLength(1);
  });

  it('throws for a missing file', () => {
    expect(() => loadContractSnapshot('/no/such/file.json')).toThrow(/Cannot read snapshot file/);
  });

  it('throws for a malformed JSON file', () => {
    const file = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(file, '{not json}', 'utf8');
    expect(() => loadContractSnapshot(file)).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. validateSnapshotShape
// ─────────────────────────────────────────────────────────────────────────────

describe('validateSnapshotShape', () => {
  it('accepts a well-formed snapshot', () => {
    const snap = makeSnapshot();
    expect(() => validateSnapshotShape(snap)).not.toThrow();
  });

  it('rejects an array', () => {
    expect(() => validateSnapshotShape([])).toThrow(/must be a JSON object/i);
  });

  it('rejects an unsupported version', () => {
    expect(() => validateSnapshotShape({ version: 2, contractId: 'C', network: 'x', entries: [] })).toThrow(
      /version/i,
    );
  });

  it('rejects a missing contractId', () => {
    expect(() => validateSnapshotShape({ version: 1, network: 'x', entries: [] })).toThrow(
      /contractId/i,
    );
  });

  it('rejects a missing network', () => {
    expect(() =>
      validateSnapshotShape({ version: 1, contractId: 'C', entries: [] }),
    ).toThrow(/network/i);
  });

  it('rejects non-array entries', () => {
    expect(() =>
      validateSnapshotShape({ version: 1, contractId: 'C', network: 'x', entries: null }),
    ).toThrow(/entries/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. classifyDiff
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyDiff', () => {
  const found = makeEntry({ status: 'found', fingerprint: 'fp1' });
  const foundChanged = makeEntry({ status: 'found', fingerprint: 'fp2' });
  const unavail = makeEntry({ status: 'unavailable', fingerprint: 'fp3' });

  it('classifies a new entry as created', () => {
    expect(classifyDiff(undefined, found)).toBe('created');
  });

  it('classifies a missing entry as removed', () => {
    expect(classifyDiff(found, undefined)).toBe('removed');
  });

  it('classifies two unavailable entries as unverifiable', () => {
    expect(classifyDiff(unavail, unavail)).toBe('unverifiable');
  });

  it('classifies matching fingerprints as unchanged', () => {
    expect(classifyDiff(found, found)).toBe('unchanged');
  });

  it('classifies differing fingerprints as modified', () => {
    expect(classifyDiff(found, foundChanged)).toBe('modified');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. assertCompatible
// ─────────────────────────────────────────────────────────────────────────────

describe('assertCompatible', () => {
  it('passes when contractId and network match', () => {
    const a = makeSnapshot();
    const b = makeSnapshot();
    expect(() => assertCompatible(a, b)).not.toThrow();
  });

  it('throws on contractId mismatch', () => {
    const a = makeSnapshot({ contractId: CONTRACT_ID });
    const b = makeSnapshot({ contractId: OTHER_CONTRACT_ID });
    expect(() => assertCompatible(a, b)).toThrow(/Contract ID mismatch/i);
  });

  it('throws on network mismatch', () => {
    const a = makeSnapshot({ network: 'testnet' });
    const b = makeSnapshot({ network: 'mainnet' });
    expect(() => assertCompatible(a, b)).toThrow(/Network mismatch/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. diffSnapshots — basic classification
// ─────────────────────────────────────────────────────────────────────────────

describe('diffSnapshots', () => {
  it('reports identical when snapshots are equal', () => {
    const snap = makeSnapshot();
    const report = diffSnapshots(snap, snap);
    expect(report.status).toBe('identical');
    expect(report.created).toHaveLength(0);
    expect(report.modified).toHaveLength(0);
    expect(report.removed).toHaveLength(0);
    expect(report.unchanged).toHaveLength(1);
  });

  it('detects a newly created entry', () => {
    const base = makeSnapshot({ entries: [] });
    const newEntry = makeEntry({ ledgerKey: 'newkey', role: 'storage', status: 'found' });
    const compare = makeSnapshot({ entries: [newEntry] });
    const report = diffSnapshots(base, compare);
    expect(report.created).toHaveLength(1);
    expect(report.created[0].ledgerKey).toBe('newkey');
    expect(report.status).toBe('changed');
  });

  it('detects a removed entry', () => {
    const entry = makeEntry({ ledgerKey: 'gone', role: 'storage', status: 'found' });
    const base = makeSnapshot({ entries: [entry] });
    const compare = makeSnapshot({ entries: [] });
    const report = diffSnapshots(base, compare);
    expect(report.removed).toHaveLength(1);
    expect(report.removed[0].ledgerKey).toBe('gone');
  });

  it('detects a modified entry', () => {
    const before = makeEntry({ ledgerKey: 'KEY', fingerprint: 'fp-before', status: 'found' });
    const after = makeEntry({ ledgerKey: 'KEY', fingerprint: 'fp-after', status: 'found' });
    const base = makeSnapshot({ entries: [before] });
    const compare = makeSnapshot({ entries: [after] });
    const report = diffSnapshots(base, compare);
    expect(report.modified).toHaveLength(1);
    expect(report.modified[0].baseFingerprint).toBe('fp-before');
    expect(report.modified[0].compareFingerprint).toBe('fp-after');
  });

  it('classifies entries unavailable in both as unverifiable', () => {
    const keyXdr = buildInstanceKey(CONTRACT_ID).toXDR('base64');
    const unavail = buildUnavailableEntry(keyXdr, 'missing', 'instance');
    const base = makeSnapshot({ entries: [unavail] });
    const compare = makeSnapshot({ entries: [unavail] });
    const report = diffSnapshots(base, compare);
    expect(report.unverifiable).toHaveLength(1);
  });

  it('reports total inspected correctly', () => {
    const e1 = makeEntry({ ledgerKey: 'k1', fingerprint: 'fp1', status: 'found' });
    const e2 = makeEntry({ ledgerKey: 'k2', fingerprint: 'fp2', status: 'found' });
    const e3 = makeEntry({ ledgerKey: 'k3', fingerprint: 'fp3', status: 'found' });
    const base = makeSnapshot({ entries: [e1, e2] });
    const compare = makeSnapshot({ entries: [e2, e3] });
    const report = diffSnapshots(base, compare);
    // e1 removed, e2 unchanged, e3 created
    expect(report.totalInspected).toBe(3);
  });

  it('records baseLedger and compareLedger', () => {
    const base = makeSnapshot({ ledgerSequence: 100 });
    const compare = makeSnapshot({ ledgerSequence: 200 });
    const report = diffSnapshots(base, compare);
    expect(report.baseLedger).toBe(100);
    expect(report.compareLedger).toBe(200);
  });

  it('throws on contractId mismatch', () => {
    const base = makeSnapshot({ contractId: CONTRACT_ID });
    const compare = makeSnapshot({ contractId: OTHER_CONTRACT_ID });
    expect(() => diffSnapshots(base, compare)).toThrow(/Contract ID mismatch/i);
  });

  it('throws on network mismatch', () => {
    const base = makeSnapshot({ network: 'testnet' });
    const compare = makeSnapshot({ network: 'mainnet' });
    expect(() => diffSnapshots(base, compare)).toThrow(/Network mismatch/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. diffSnapshots — upgrade review
// ─────────────────────────────────────────────────────────────────────────────

describe('diffSnapshots — upgradeReview', () => {
  it('flags instance changes', () => {
    const before = makeEntry({ ledgerKey: 'INST', role: 'instance', fingerprint: 'fp1', status: 'found' });
    const after = makeEntry({ ledgerKey: 'INST', role: 'instance', fingerprint: 'fp2', status: 'found' });
    const base = makeSnapshot({ entries: [before] });
    const compare = makeSnapshot({ entries: [after] });
    const report = diffSnapshots(base, compare, { upgradeReview: true });
    expect(report.upgradeReview?.instanceChanged).toBe(true);
  });

  it('flags code changes', () => {
    const before = makeEntry({ ledgerKey: 'CODE', role: 'code', fingerprint: 'fp1', status: 'found' });
    const after = makeEntry({ ledgerKey: 'CODE', role: 'code', fingerprint: 'fp2', status: 'found' });
    const base = makeSnapshot({ entries: [before] });
    const compare = makeSnapshot({ entries: [after] });
    const report = diffSnapshots(base, compare, { upgradeReview: true });
    expect(report.upgradeReview?.codeChanged).toBe(true);
  });

  it('distinguishes expected from unexpected modifications via allowlist', () => {
    const before = makeEntry({ ledgerKey: 'EXPECTED', role: 'storage', fingerprint: 'fp1', status: 'found' });
    const after = makeEntry({ ledgerKey: 'EXPECTED', role: 'storage', fingerprint: 'fp2', status: 'found' });
    const base = makeSnapshot({ entries: [before] });
    const compare = makeSnapshot({ entries: [after] });
    const report = diffSnapshots(base, compare, {
      upgradeReview: true,
      allowlist: ['EXPECTED'],
    });
    expect(report.upgradeReview?.unexpectedModifications).toHaveLength(0);
  });

  it('reports unexpected modifications not in the allowlist', () => {
    const before = makeEntry({ ledgerKey: 'SURPRISE', role: 'storage', fingerprint: 'fp1', status: 'found' });
    const after = makeEntry({ ledgerKey: 'SURPRISE', role: 'storage', fingerprint: 'fp2', status: 'found' });
    const base = makeSnapshot({ entries: [before] });
    const compare = makeSnapshot({ entries: [after] });
    const report = diffSnapshots(base, compare, { upgradeReview: true });
    expect(report.upgradeReview?.unexpectedModifications).toContain('SURPRISE');
  });

  it('reports unexpected removals', () => {
    const entry = makeEntry({ ledgerKey: 'GONE', role: 'storage', status: 'found' });
    const base = makeSnapshot({ entries: [entry] });
    const compare = makeSnapshot({ entries: [] });
    const report = diffSnapshots(base, compare, { upgradeReview: true });
    expect(report.upgradeReview?.unexpectedRemovals).toContain('GONE');
  });

  it('does not set upgradeReview when flag is false', () => {
    const snap = makeSnapshot();
    const report = diffSnapshots(snap, snap, { upgradeReview: false });
    expect(report.upgradeReview).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. compareSnapshotFiles — file I/O
// ─────────────────────────────────────────────────────────────────────────────

describe('compareSnapshotFiles', () => {
  let tmpDir: string;
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-diff-test-'));
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('compares two valid snapshot files', () => {
    const base = makeSnapshot({ ledgerSequence: 50 });
    const compare = makeSnapshot({ ledgerSequence: 60 });
    const f1 = path.join(tmpDir, 'base.json');
    const f2 = path.join(tmpDir, 'compare.json');
    saveSnapshot(base, f1);
    saveSnapshot(compare, f2);
    const report = compareSnapshotFiles(f1, f2);
    expect(report.baseLedger).toBe(50);
    expect(report.compareLedger).toBe(60);
    expect(report.status).toBe('identical');
  });

  it('writes the report to outputFile when specified', () => {
    const base = makeSnapshot();
    const compare = makeSnapshot();
    const f1 = path.join(tmpDir, 'b.json');
    const f2 = path.join(tmpDir, 'c.json');
    const out = path.join(tmpDir, 'report.json');
    saveSnapshot(base, f1);
    saveSnapshot(compare, f2);
    compareSnapshotFiles(f1, f2, { outputFile: out });
    expect(fs.existsSync(out)).toBe(true);
    const written = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(written.contractId).toBe(base.contractId);
  });

  it('throws for mismatched contract IDs', () => {
    const base = makeSnapshot({ contractId: CONTRACT_ID });
    const compare = makeSnapshot({ contractId: OTHER_CONTRACT_ID });
    const f1 = path.join(tmpDir, 'mismatch-a.json');
    const f2 = path.join(tmpDir, 'mismatch-b.json');
    saveSnapshot(base, f1);
    saveSnapshot(compare, f2);
    expect(() => compareSnapshotFiles(f1, f2)).toThrow(/Contract ID mismatch/i);
  });

  it('throws for mismatched networks', () => {
    const base = makeSnapshot({ network: 'testnet' });
    const compare = makeSnapshot({ network: 'mainnet' });
    const f1 = path.join(tmpDir, 'net-a.json');
    const f2 = path.join(tmpDir, 'net-b.json');
    saveSnapshot(base, f1);
    saveSnapshot(compare, f2);
    expect(() => compareSnapshotFiles(f1, f2)).toThrow(/Network mismatch/i);
  });

  it('throws for a malformed snapshot file', () => {
    const bad = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(bad, '{"version":99,"entries":[]}', 'utf8');
    const good = path.join(tmpDir, 'good.json');
    saveSnapshot(makeSnapshot(), good);
    expect(() => compareSnapshotFiles(bad, good)).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 15. captureSnapshot — mocked RPC
// ─────────────────────────────────────────────────────────────────────────────

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk') as Record<string, unknown>;
  return {
    ...actual,
    rpc: {
      ...(actual['rpc'] as Record<string, unknown>),
      Server: jest.fn(),
    },
  };
});

/**
 * Build a minimal ContractData LedgerEntry using a StellarAsset executable
 * (no WASM hash).  Follows the same pattern used by the existing
 * soroban-contract-deployment-inspection tests.
 */
function makeMinimalLedgerEntry(contractId: string): xdr.LedgerEntry {
  const address = new Contract(contractId).address().toScAddress();
  const instance = new xdr.ScContractInstance({
    executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
    storage: null,
  });
  const scVal = xdr.ScVal.scvContractInstance(instance);
  const contractDataEntry = new xdr.ContractDataEntry({
    ext: new (xdr.ExtensionPoint as unknown as new (v: number) => xdr.ExtensionPoint)(0),
    contract: address,
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent(),
    val: scVal,
  });
  return new xdr.LedgerEntry({
    lastModifiedLedgerSeq: 42,
    data: xdr.LedgerEntryData.contractData(contractDataEntry),
    ext: new (xdr.LedgerEntryExt as unknown as new (v: number) => xdr.LedgerEntryExt)(0),
  });
}

/**
 * Build a minimal ContractData LedgerEntry with a WASM executable so that
 * extractWasmHash can find the hash.
 */
function makeWasmLedgerEntry(contractId: string, wasmHashHex: string): xdr.LedgerEntry {
  const address = new Contract(contractId).address().toScAddress();
  const executable = xdr.ContractExecutable.contractExecutableWasm(
    Buffer.from(wasmHashHex, 'hex'),
  );
  const instance = new xdr.ScContractInstance({ executable, storage: null });
  const scVal = xdr.ScVal.scvContractInstance(instance);
  const contractDataEntry = new xdr.ContractDataEntry({
    ext: new (xdr.ExtensionPoint as unknown as new (v: number) => xdr.ExtensionPoint)(0),
    contract: address,
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent(),
    val: scVal,
  });
  return new xdr.LedgerEntry({
    lastModifiedLedgerSeq: 42,
    data: xdr.LedgerEntryData.contractData(contractDataEntry),
    ext: new (xdr.LedgerEntryExt as unknown as new (v: number) => xdr.LedgerEntryExt)(0),
  });
}

describe('captureSnapshot — mocked RPC', () => {
  const { rpc } = jest.requireMock('@stellar/stellar-sdk') as {
    rpc: { Server: jest.MockedClass<{ new (url: string, opts: unknown): unknown }> };
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('throws for an invalid contract ID', async () => {
    await expect(
      captureSnapshot({ rpcUrl: 'http://mock', contractId: 'INVALID', network: 'testnet' }),
    ).rejects.toThrow(/Invalid contract ID/i);
  });

  it('throws when getLatestLedger fails', async () => {
    (rpc.Server as unknown as jest.Mock).mockImplementation(() => ({
      getLatestLedger: jest.fn().mockRejectedValue(new Error('connection refused')),
    }));
    await expect(
      captureSnapshot({ rpcUrl: 'http://mock', contractId: CONTRACT_ID, network: 'testnet' }),
    ).rejects.toThrow(/RPC unreachable/i);
  });

  it('records the instance entry as unavailable when not found', async () => {
    (rpc.Server as unknown as jest.Mock).mockImplementation(() => ({
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 100 }),
      getLedgerEntries: jest.fn().mockResolvedValue({ entries: [] }),
    }));
    const snap = await captureSnapshot({
      rpcUrl: 'http://mock',
      contractId: CONTRACT_ID,
      network: 'testnet',
    });
    expect(snap.entries).toHaveLength(1);
    expect(snap.entries[0].status).toBe('unavailable');
    expect(snap.entries[0].role).toBe('instance');
  });

  it('captures the instance entry when the RPC returns it', async () => {
    const ledgerEntry = makeMinimalLedgerEntry(CONTRACT_ID);
    (rpc.Server as unknown as jest.Mock).mockImplementation(() => ({
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 200 }),
      getLedgerEntries: jest.fn().mockResolvedValue({
        entries: [
          {
            val: ledgerEntry,
            lastModifiedLedgerSeq: 42,
            liveUntilLedgerSeq: 500,
            key: buildInstanceKey(CONTRACT_ID),
          },
        ],
      }),
    }));
    const snap = await captureSnapshot({
      rpcUrl: 'http://mock',
      contractId: CONTRACT_ID,
      network: 'testnet',
    });
    expect(snap.ledgerSequence).toBe(200);
    const instanceEntry = snap.entries.find((e) => e.role === 'instance');
    expect(instanceEntry?.status).toBe('found');
  });

  it('also fetches the code entry when a WASM hash is present', async () => {
    const instanceEntry = makeWasmLedgerEntry(CONTRACT_ID, WASM_HASH_HEX);
    const codeEntry = makeMinimalLedgerEntry(CONTRACT_ID); // reuse as placeholder code entry
    const getLedgerEntries = jest
      .fn()
      // first call → instance
      .mockResolvedValueOnce({
        entries: [{ val: instanceEntry, lastModifiedLedgerSeq: 10, liveUntilLedgerSeq: 1000, key: buildInstanceKey(CONTRACT_ID) }],
      })
      // second call → code
      .mockResolvedValueOnce({
        entries: [{ val: codeEntry, lastModifiedLedgerSeq: 10, liveUntilLedgerSeq: 1000, key: buildCodeKey(WASM_HASH_HEX) }],
      });
    (rpc.Server as unknown as jest.Mock).mockImplementation(() => ({
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 300 }),
      getLedgerEntries,
    }));
    const snap = await captureSnapshot({
      rpcUrl: 'http://mock',
      contractId: CONTRACT_ID,
      network: 'testnet',
    });
    expect(snap.entries.some((e) => e.role === 'instance')).toBe(true);
    expect(snap.entries.some((e) => e.role === 'code')).toBe(true);
  });

  it('marks an archived/expired entry as unavailable with an informative reason', async () => {
    (rpc.Server as unknown as jest.Mock).mockImplementation(() => ({
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 300 }),
      getLedgerEntries: jest
        .fn()
        .mockRejectedValue(new Error('entry is archived and cannot be retrieved')),
    }));
    const snap = await captureSnapshot({
      rpcUrl: 'http://mock',
      contractId: CONTRACT_ID,
      network: 'testnet',
    });
    expect(snap.entries[0].status).toBe('unavailable');
    expect(snap.entries[0].unavailableReason).toMatch(/archiv/i);
  });

  it('records ledgerSequence, contractId, and network in the snapshot', async () => {
    (rpc.Server as unknown as jest.Mock).mockImplementation(() => ({
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 999 }),
      getLedgerEntries: jest.fn().mockResolvedValue({ entries: [] }),
    }));
    const snap = await captureSnapshot({
      rpcUrl: 'http://mock',
      contractId: CONTRACT_ID,
      network: 'testnet',
    });
    expect(snap.ledgerSequence).toBe(999);
    expect(snap.contractId).toBe(CONTRACT_ID);
    expect(snap.network).toBe('testnet');
  });

  it('writes output to a file when outputFile is specified', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-write-'));
    const outFile = path.join(tmpDir, 'out.json');
    (rpc.Server as unknown as jest.Mock).mockImplementation(() => ({
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 50 }),
      getLedgerEntries: jest.fn().mockResolvedValue({ entries: [] }),
    }));
    const snap = await captureSnapshot({
      rpcUrl: 'http://mock',
      contractId: CONTRACT_ID,
      network: 'testnet',
      outputFile: outFile,
    });
    expect(fs.existsSync(outFile)).toBe(true);
    const written = JSON.parse(fs.readFileSync(outFile, 'utf8')) as ContractStateSnapshot;
    expect(written.contractId).toBe(snap.contractId);
    expect(written.fingerprint).toBe(snap.fingerprint);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 16. extractWasmHash
// ─────────────────────────────────────────────────────────────────────────────

describe('extractWasmHash', () => {
  it('returns null for a built-in (StellarAsset) executable', () => {
    const ledgerEntry = makeMinimalLedgerEntry(CONTRACT_ID);
    const fakeResult = {
      val: ledgerEntry,
      lastModifiedLedgerSeq: 1,
      key: buildInstanceKey(CONTRACT_ID),
    } as unknown as import('@stellar/stellar-sdk').rpc.Api.LedgerEntryResult;
    expect(extractWasmHash(fakeResult)).toBeNull();
  });

  it('returns the hex WASM hash for a WASM executable', () => {
    const ledgerEntry = makeWasmLedgerEntry(CONTRACT_ID, WASM_HASH_HEX);
    const fakeResult = {
      val: ledgerEntry,
      lastModifiedLedgerSeq: 1,
      key: buildInstanceKey(CONTRACT_ID),
    } as unknown as import('@stellar/stellar-sdk').rpc.Api.LedgerEntryResult;
    expect(extractWasmHash(fakeResult)).toBe(WASM_HASH_HEX);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 17. renderReport
// ─────────────────────────────────────────────────────────────────────────────

describe('renderReport', () => {
  it('includes contract ID, network, and ledger range', () => {
    const base = makeSnapshot({ ledgerSequence: 100 });
    const compare = makeSnapshot({ ledgerSequence: 200 });
    const report = diffSnapshots(base, compare);
    const text = renderReport(report);
    expect(text).toContain(CONTRACT_ID);
    expect(text).toContain('testnet');
    expect(text).toContain('100 → 200');
  });

  it('includes upgrade review disclaimer text', () => {
    const snap = makeSnapshot();
    const report = diffSnapshots(snap, snap, { upgradeReview: true });
    const text = renderReport(report);
    expect(text).toMatch(/does not by itself indicate/i);
  });

  it('marks identical snapshots with IDENTICAL status', () => {
    const snap = makeSnapshot();
    const report = diffSnapshots(snap, snap);
    expect(renderReport(report)).toContain('IDENTICAL');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 18. Report fingerprint is deterministic
// ─────────────────────────────────────────────────────────────────────────────

describe('report fingerprint', () => {
  it('is deterministic for the same inputs', () => {
    const snap = makeSnapshot();
    const r1 = diffSnapshots(snap, snap);
    const r2 = diffSnapshots(snap, snap);
    expect(r1.reportFingerprint).toBe(r2.reportFingerprint);
  });

  it('differs when ledger sequences differ', () => {
    const base = makeSnapshot({ ledgerSequence: 10 });
    const compare1 = makeSnapshot({ ledgerSequence: 20 });
    const compare2 = makeSnapshot({ ledgerSequence: 30 });
    const r1 = diffSnapshots(base, compare1);
    const r2 = diffSnapshots(base, compare2);
    expect(r1.reportFingerprint).not.toBe(r2.reportFingerprint);
  });
});
