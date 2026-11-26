import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readFileSync } from 'fs';
import { Address, Networks, nativeToScVal, rpc, StrKey, xdr } from '@stellar/stellar-sdk';
import {
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  SnapshotCompatibilityError,
  SnapshotValidationError,
  UnsupportedHistoricalStateError,
  buildContractDataKey,
  canonicalJson,
  captureContractStateSnapshot,
  fingerprintEntry,
  loadSnapshotFile,
  parseSnapshot,
  parseStorageKeySpecs,
  saveSnapshotFile,
  serializeSnapshot,
  sha256Hex,
  type CaptureContractStateOptions,
  type ContractStateSnapshot,
  type ContractStateSource,
  type StorageKeySpec,
} from '../src/utils/contract-state-snapshot';
import {
  compareSnapshots,
  formatComparisonReport,
  parseExpectedChanges,
} from '../src/utils/contract-state-diff';

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 1));
const OTHER_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 2));
const WASM_HASH = 'ab'.repeat(32);
const ALT_WASM_HASH = 'cd'.repeat(32);
const TESTNET = Networks.TESTNET;

function symbol(name: string): xdr.ScVal {
  return xdr.ScVal.scvSymbol(name);
}

function contractDataEntry(
  contractId: string,
  key: xdr.ScVal,
  durability: xdr.ContractDataDurability,
  value: xdr.ScVal,
  overrides: Partial<rpc.Api.LedgerEntryResult> = {},
): rpc.Api.LedgerEntryResult {
  const address = new Address(contractId).toScAddress();
  return {
    key: xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({ contract: address, key, durability }),
    ),
    val: xdr.LedgerEntryData.contractData(
      new xdr.ContractDataEntry({
        ext: new (xdr.ExtensionPoint as any)(0) as xdr.ExtensionPoint,
        contract: address,
        key,
        durability,
        val: value,
      }),
    ),
    lastModifiedLedgerSeq: 100,
    liveUntilLedgerSeq: 500,
    ...overrides,
  };
}

function instanceValue(
  wasmHash = WASM_HASH,
  storage: Array<[xdr.ScVal, xdr.ScVal]> = [],
): xdr.ScVal {
  const executable = xdr.ContractExecutable.contractExecutableWasm(Buffer.from(wasmHash, 'hex'));
  return xdr.ScVal.scvContractInstance(
    new xdr.ScContractInstance({
      executable,
      storage: storage.map(([key, val]) => new xdr.ScMapEntry({ key, val })),
    }),
  );
}

function instanceEntry(
  contractId = CONTRACT_ID,
  wasmHash = WASM_HASH,
  storage: Array<[xdr.ScVal, xdr.ScVal]> = [],
  overrides: Partial<rpc.Api.LedgerEntryResult> = {},
): rpc.Api.LedgerEntryResult {
  return contractDataEntry(
    contractId,
    xdr.ScVal.scvLedgerKeyContractInstance(),
    xdr.ContractDataDurability.persistent(),
    instanceValue(wasmHash, storage),
    overrides,
  );
}

function codeEntry(
  wasmHash = WASM_HASH,
  overrides: Partial<rpc.Api.LedgerEntryResult> = {},
): rpc.Api.LedgerEntryResult {
  const hash = Buffer.from(wasmHash, 'hex');
  return {
    key: xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash })),
    val: xdr.LedgerEntryData.contractCode(
      new xdr.ContractCodeEntry({
        ext: new (xdr.ContractCodeEntryExt as any)(0) as xdr.ContractCodeEntryExt,
        hash,
        code: Buffer.from(`wasm:${wasmHash.slice(0, 8)}`),
      }),
    ),
    lastModifiedLedgerSeq: 90,
    liveUntilLedgerSeq: 700,
    ...overrides,
  };
}

class FakeStateSource implements ContractStateSource {
  ledger: number;
  private readonly data = new Map<string, rpc.Api.LedgerEntryResult>();
  private readonly code = new Map<string, rpc.Api.LedgerEntryResult>();

  constructor(ledger = 1000) {
    this.ledger = ledger;
  }

  add(entry: rpc.Api.LedgerEntryResult): this {
    this.data.set(entry.key.toXDR('base64'), entry);
    return this;
  }

  addCode(entry: rpc.Api.LedgerEntryResult): this {
    this.code.set(entry.key.toXDR('base64'), entry);
    return this;
  }

  addStorage(
    contractId: string,
    name: string,
    value: unknown,
    durability: 'persistent' | 'temporary' = 'persistent',
    overrides: Partial<rpc.Api.LedgerEntryResult> = {},
  ): this {
    return this.add(
      contractDataEntry(
        contractId,
        symbol(name),
        durability === 'temporary'
          ? xdr.ContractDataDurability.temporary()
          : xdr.ContractDataDurability.persistent(),
        nativeToScVal(value),
        overrides,
      ),
    );
  }

  async getLatestLedger(): Promise<{ sequence: number }> {
    return { sequence: this.ledger };
  }

  async getContractData(
    contractId: string,
    key: xdr.ScVal,
    durability: rpc.Durability,
  ): Promise<rpc.Api.LedgerEntryResult> {
    const ledgerKey = buildContractDataKey(
      contractId,
      key,
      durability === rpc.Durability.Temporary ? 'temporary' : 'persistent',
    );
    const found = this.data.get(ledgerKey.toXDR('base64'));
    if (!found) {
      throw new Error(`Contract data not found for ${contractId}.`);
    }
    return found;
  }

  async getLedgerEntries(
    ...keys: xdr.LedgerKey[]
  ): Promise<{ entries: rpc.Api.LedgerEntryResult[]; latestLedger: number }> {
    const entries = keys
      .map((key) => this.code.get(key.toXDR('base64')) ?? this.data.get(key.toXDR('base64')))
      .filter((entry): entry is rpc.Api.LedgerEntryResult => Boolean(entry));
    return { entries, latestLedger: this.ledger };
  }
}

function capture(
  source: FakeStateSource,
  overrides: Partial<CaptureContractStateOptions> = {},
): Promise<ContractStateSnapshot> {
  return captureContractStateSnapshot({
    contractId: CONTRACT_ID,
    networkPassphrase: TESTNET,
    source,
    capturedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
}

function baseSource(): FakeStateSource {
  return new FakeStateSource(1000).add(instanceEntry()).addCode(codeEntry());
}

function tempFile(name: string): string {
  return path.join(os.tmpdir(), `${name}-${process.pid}-${Date.now()}.json`);
}

describe('contract state retrieval', () => {
  it('retrieves the contract instance and records ledger/network metadata', async () => {
    const source = new FakeStateSource(1234).add(instanceEntry()).addCode(codeEntry());
    const snapshot = await capture(source);

    expect(snapshot.format).toBe(SNAPSHOT_FORMAT);
    expect(snapshot.version).toBe(SNAPSHOT_VERSION);
    expect(snapshot.contractId).toBe(CONTRACT_ID);
    expect(snapshot.network).toEqual({ id: 'testnet', passphrase: TESTNET });
    expect(snapshot.ledger).toBe(1234);
    expect(snapshot.wasmHash).toBe(WASM_HASH);
    expect(snapshot.entries.map((entry) => entry.entryType).sort()).toEqual([
      'contractCode',
      'instance',
    ]);
    expect(snapshot.snapshotFingerprint).toMatch(/^[0-9a-f]{64}$/);

    const instance = snapshot.entries.find((entry) => entry.entryType === 'instance');
    expect(instance?.durability).toBe('instance');
    expect(instance?.comparable).toBe(true);
    expect(instance?.keyId).toBe(sha256Hex(instance?.ledgerKey as string));
  });

  it('captures an empty contract storage without failing', async () => {
    const source = new FakeStateSource()
      .add(instanceEntry(CONTRACT_ID, WASM_HASH, []))
      .addCode(codeEntry());
    const snapshot = await capture(source);

    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.entries.some((entry) => entry.entryType === 'persistent')).toBe(false);
    expect(snapshot.entries.some((entry) => entry.entryType === 'temporary')).toBe(false);
    expect(snapshot.warnings.some((warning) => /No storage keys/.test(warning))).toBe(true);
  });

  it('captures multiple persistent and temporary storage entries', async () => {
    const source = baseSource()
      .addStorage(CONTRACT_ID, 'COUNTER', 7)
      .addStorage(CONTRACT_ID, 'Admin', 'G-address-placeholder')
      .addStorage(CONTRACT_ID, 'LOCK', true, 'temporary');

    const storageKeys: StorageKeySpec[] = [
      { key: symbol('COUNTER'), durability: 'persistent', label: 'COUNTER' },
      { key: symbol('Admin'), durability: 'persistent', label: 'Admin' },
      { key: symbol('LOCK'), durability: 'temporary', label: 'LOCK' },
    ];
    const snapshot = await capture(source, { storageKeys });

    const byLabel = new Map(snapshot.entries.map((entry) => [entry.keyLabel, entry]));
    expect(byLabel.get('COUNTER')?.entryType).toBe('persistent');
    expect(byLabel.get('Admin')?.entryType).toBe('persistent');
    expect(byLabel.get('LOCK')?.entryType).toBe('temporary');
    expect(byLabel.get('LOCK')?.durability).toBe('temporary');
    expect(snapshot.entries).toHaveLength(5); // instance, code, three keys
  });

  it('records unavailable storage keys instead of aborting', async () => {
    const source = baseSource();
    const snapshot = await capture(source, {
      storageKeys: [{ key: symbol('MISSING'), durability: 'persistent', label: 'MISSING' }],
    });

    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.unavailable).toHaveLength(1);
    expect(snapshot.unavailable[0].label).toBe('MISSING');
    expect(snapshot.unavailable[0].reason).toBe('not-found');
  });

  it('records an unavailable contract code entry without failing', async () => {
    const source = new FakeStateSource().add(instanceEntry());
    const snapshot = await capture(source);

    expect(snapshot.entries.some((entry) => entry.entryType === 'instance')).toBe(true);
    expect(snapshot.unavailable.some((entry) => entry.label === 'contract code')).toBe(true);
  });

  it('records an unavailable contract instance without throwing', async () => {
    const source = new FakeStateSource();
    const snapshot = await capture(source);

    expect(snapshot.entries).toHaveLength(0);
    expect(snapshot.unavailable[0].label).toBe('instance');
    expect(snapshot.warnings.join(' ')).toMatch(/instance entry could not be read/i);
  });
});

describe('snapshot serialization and fingerprints', () => {
  it('round-trips a snapshot through JSON without changing fingerprints', async () => {
    const snapshot = await capture(baseSource().addStorage(CONTRACT_ID, 'COUNTER', 1));
    const file = tempFile('contract-state-snapshot');

    try {
      const written = saveSnapshotFile(file, snapshot);
      expect(fs.readFileSync(written, 'utf8')).toBe(serializeSnapshot(snapshot));

      const loaded = loadSnapshotFile(file);
      expect(loaded.snapshotFingerprint).toBe(snapshot.snapshotFingerprint);
      expect(loaded.entries.map((entry) => entry.fingerprint)).toEqual(
        snapshot.entries.map((entry) => entry.fingerprint),
      );
      expect(parseSnapshot(JSON.parse(serializeSnapshot(snapshot)))).toEqual(snapshot);
    } finally {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  });

  it('produces deterministic fingerprints regardless of capture time and ledger', async () => {
    const source = baseSource().addStorage(CONTRACT_ID, 'COUNTER', 1);
    const first = await capture(source);
    source.ledger = 2500;
    const second = await capture(source);

    expect(first.ledger).toBe(1000);
    expect(second.ledger).toBe(2500);
    expect(second.snapshotFingerprint).toBe(first.snapshotFingerprint);
  });

  it('produces the same snapshot fingerprint regardless of RPC entry order', async () => {
    const forward = new FakeStateSource(1000)
      .add(instanceEntry())
      .addCode(codeEntry())
      .addStorage(CONTRACT_ID, 'A', 1)
      .addStorage(CONTRACT_ID, 'B', 2);
    const reverse = new FakeStateSource(1000)
      .addStorage(CONTRACT_ID, 'B', 2)
      .addStorage(CONTRACT_ID, 'A', 1)
      .addCode(codeEntry())
      .add(instanceEntry());

    const storageKeys: StorageKeySpec[] = [
      { key: symbol('A'), durability: 'persistent', label: 'A' },
      { key: symbol('B'), durability: 'persistent', label: 'B' },
    ];

    const first = await capture(forward, { storageKeys });
    const second = await capture(reverse, { storageKeys });
    expect(second.snapshotFingerprint).toBe(first.snapshotFingerprint);
  });

  it('canonicalizes JSON and entry fingerprints deterministically', () => {
    expect(canonicalJson({ b: 1n, a: 2 })).toBe(canonicalJson({ a: 2, b: '1' }));

    const left = fingerprintEntry({
      ledgerKey: 'a2V5',
      entryType: 'persistent',
      durability: 'persistent',
      valueXdr: 'dmFsdWU=',
    });
    const right = fingerprintEntry({
      valueXdr: 'dmFsdWU=',
      durability: 'persistent',
      entryType: 'persistent',
      ledgerKey: 'a2V5',
    });
    expect(left).toBe(right);
    expect(left).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes the value fingerprint when the value changes', async () => {
    const firstSource = baseSource().addStorage(CONTRACT_ID, 'COUNTER', 1);
    const secondSource = baseSource().addStorage(CONTRACT_ID, 'COUNTER', 2);
    const storageKeys: StorageKeySpec[] = [
      { key: symbol('COUNTER'), durability: 'persistent', label: 'COUNTER' },
    ];

    const first = await capture(firstSource, { storageKeys });
    const second = await capture(secondSource, { storageKeys });

    expect(second.snapshotFingerprint).not.toBe(first.snapshotFingerprint);
    const before = first.entries.find((entry) => entry.keyLabel === 'COUNTER');
    const after = second.entries.find((entry) => entry.keyLabel === 'COUNTER');
    expect(before?.fingerprint).not.toBe(after?.fingerprint);
  });
});

describe('snapshot comparison', () => {
  it('identifies created, modified, removed and unchanged entries', async () => {
    const baselineSource = baseSource()
      .addStorage(CONTRACT_ID, 'COUNTER', 1)
      .addStorage(CONTRACT_ID, 'KEEP', 1)
      .addStorage(CONTRACT_ID, 'REMOVE', 1);
    const comparisonSource = baseSource()
      .addStorage(CONTRACT_ID, 'COUNTER', 2)
      .addStorage(CONTRACT_ID, 'KEEP', 1)
      .addStorage(CONTRACT_ID, 'NEW', 1);

    const storageKeys: StorageKeySpec[] = ['COUNTER', 'KEEP', 'REMOVE', 'NEW'].map((name) => ({
      key: symbol(name),
      durability: 'persistent',
      label: name,
    }));

    const baseline = await capture(baselineSource, { storageKeys });
    const comparison = await capture(comparisonSource, { storageKeys });
    const report = compareSnapshots(baseline, comparison);

    expect(report.counts.created).toBe(1);
    expect(report.counts.modified).toBe(1);
    expect(report.counts.removed).toBe(1);
    expect(report.counts.unchanged).toBe(3); // instance, code and KEEP
    expect(report.counts.uniqueKeys).toBe(6);
    expect(report.created[0].keyLabel).toBe('NEW');
    expect(report.modified[0].keyLabel).toBe('COUNTER');
    expect(report.removed[0].keyLabel).toBe('REMOVE');
    expect(report.modified[0].contentChanged).toBe(true);
    expect(report.status).toBe('changed');
  });

  it('reports metadata-only changes without counting them as modified values', async () => {
    const baselineSource = baseSource().addStorage(CONTRACT_ID, 'COUNTER', 1, 'persistent', {
      liveUntilLedgerSeq: 500,
    });
    const comparisonSource = baseSource().addStorage(CONTRACT_ID, 'COUNTER', 1, 'persistent', {
      liveUntilLedgerSeq: 900,
    });
    const storageKeys: StorageKeySpec[] = [
      { key: symbol('COUNTER'), durability: 'persistent', label: 'COUNTER' },
    ];

    const report = compareSnapshots(
      await capture(baselineSource, { storageKeys }),
      await capture(comparisonSource, { storageKeys }),
    );

    expect(report.counts.modified).toBe(0);
    expect(report.counts.metadataOnly).toBe(1);
    expect(report.metadataOnly[0].metadataChanges.join(' ')).toMatch(/liveUntilLedgerSeq/);
    expect(report.status).toBe('changed');
  });

  it('rejects snapshots from different contracts', async () => {
    const baseline = await capture(baseSource());
    const otherSource = new FakeStateSource()
      .add(instanceEntry(OTHER_CONTRACT_ID))
      .addCode(codeEntry());
    const comparison = await capture(otherSource, { contractId: OTHER_CONTRACT_ID });

    expect(() => compareSnapshots(baseline, comparison)).toThrow(SnapshotCompatibilityError);
    expect(() => compareSnapshots(baseline, comparison)).toThrow(/different contracts/);
  });

  it('rejects snapshots from different networks', async () => {
    const baseline = await capture(baseSource());
    const comparison = await capture(baseSource(), {
      networkPassphrase: Networks.FUTURENET,
    });

    expect(() => compareSnapshots(baseline, comparison)).toThrow(SnapshotCompatibilityError);
    expect(() => compareSnapshots(baseline, comparison)).toThrow(/different networks/);
  });

  it('reports unverifiable entries when an entry is archived in the comparison', async () => {
    const baselineSource = baseSource().addStorage(CONTRACT_ID, 'COUNTER', 1);
    const comparisonSource = baseSource();
    const storageKeys: StorageKeySpec[] = [
      { key: symbol('COUNTER'), durability: 'persistent', label: 'COUNTER' },
    ];

    const baseline = await capture(baselineSource, { storageKeys });
    const comparison = await capture(comparisonSource, { storageKeys });
    expect(comparison.unavailable).toHaveLength(1);

    // The provider may report an archived entry as not found. If it reports an
    // archived state explicitly, the entry must not be misreported as removed.
    const archived: ContractStateSnapshot = {
      ...comparison,
      unavailable: comparison.unavailable.map((entry) => ({
        ...entry,
        reason: 'archived',
        message: 'Ledger entry is archived and must be restored before it can be read.',
      })),
    };

    const report = compareSnapshots(baseline, archived);
    expect(report.counts.removed).toBe(0);
    expect(report.counts.unverifiable).toBe(1);
    expect(report.unverifiable[0].baselineStatus).toBe('present');
    expect(report.unverifiable[0].comparisonStatus).toBe('unavailable');
    expect(report.unverifiable[0].reason).toMatch(/archived/);
    expect(report.status).toBe('incomplete');
  });

  it('treats a not-found probe as observed absence with a warning', async () => {
    const baselineSource = baseSource();
    const comparisonSource = baseSource().addStorage(CONTRACT_ID, 'COUNTER', 1);
    const storageKeys: StorageKeySpec[] = [
      { key: symbol('COUNTER'), durability: 'persistent', label: 'COUNTER' },
    ];

    const report = compareSnapshots(
      await capture(baselineSource, { storageKeys }),
      await capture(comparisonSource, { storageKeys }),
    );

    expect(report.counts.created).toBe(1);
    expect(report.warnings.join(' ')).toMatch(/not found in the baseline/);
  });

  it('treats untrustworthy values as unverifiable rather than changed', async () => {
    const baseline = await capture(baseSource());
    const tampered = parseSnapshot({
      ...baseline,
      entries: baseline.entries.map((entry) =>
        entry.entryType === 'instance'
          ? { ...entry, comparable: false, decodeErrors: ['forced decode failure'] }
          : entry,
      ),
    });

    const report = compareSnapshots(baseline, tampered);
    expect(report.counts.unverifiable).toBe(1);
    expect(report.unverifiable[0].reason).toMatch(/not comparable/i);
  });
});

describe('upgrade review and expected changes', () => {
  function upgradeSources(): { baseline: FakeStateSource; comparison: FakeStateSource } {
    return {
      baseline: new FakeStateSource(1000)
        .add(instanceEntry(CONTRACT_ID, WASM_HASH, [[symbol('Admin'), nativeToScVal(1)]]))
        .addCode(codeEntry(WASM_HASH)),
      comparison: new FakeStateSource(1200)
        .add(instanceEntry(CONTRACT_ID, ALT_WASM_HASH, [[symbol('Admin'), nativeToScVal(2)]]))
        .addCode(codeEntry(ALT_WASM_HASH)),
    };
  }

  it('highlights instance and WASM changes during an upgrade review', async () => {
    const { baseline: baselineSource, comparison: comparisonSource } = upgradeSources();
    const baseline = await capture(baselineSource);
    const comparison = await capture(comparisonSource);
    const report = compareSnapshots(baseline, comparison, { upgradeReview: true });

    expect(report.upgradeReview.enabled).toBe(true);
    expect(report.upgradeReview.instanceChanged).toBe(true);
    expect(report.upgradeReview.wasmChanged).toBe(true);
    expect(report.upgradeReview.wasmHashBefore).toBe(WASM_HASH);
    expect(report.upgradeReview.wasmHashAfter).toBe(ALT_WASM_HASH);
    expect(report.upgradeReview.notes[0]).toMatch(/do not by themselves establish/i);
    expect(report.created.some((change) => change.entryType === 'contractCode')).toBe(true);
    expect(report.removed.some((change) => change.entryType === 'contractCode')).toBe(true);

    const text = formatComparisonReport(report);
    expect(text).toContain('Soroban Contract State Comparison');
    expect(text).toContain('Upgrade review');
    expect(text).toContain('WASM reference');
    expect(text).toContain('does not by itself establish');
  });

  it('flags changes outside an allowlist and accepts listed changes', async () => {
    const baselineSource = baseSource()
      .addStorage(CONTRACT_ID, 'COUNTER', 1)
      .addStorage(CONTRACT_ID, 'KEEP', 1);
    const comparisonSource = baseSource()
      .addStorage(CONTRACT_ID, 'COUNTER', 2)
      .addStorage(CONTRACT_ID, 'NEW', 1);
    const storageKeys: StorageKeySpec[] = ['COUNTER', 'KEEP', 'NEW'].map((name) => ({
      key: symbol(name),
      durability: 'persistent',
      label: name,
    }));

    const baseline = await capture(baselineSource, { storageKeys });
    const comparison = await capture(comparisonSource, { storageKeys });

    const partial = compareSnapshots(baseline, comparison, {
      upgradeReview: true,
      expectedChanges: [
        { change: 'modified', key: 'COUNTER', reason: 'planned counter migration' },
      ],
    });
    expect(partial.counts.expected).toBe(1);
    expect(partial.counts.unexpected).toBe(2);
    expect(partial.status).toBe('unexpected-changes');
    expect(partial.expectedChanges[0].expectedReason).toBe('planned counter migration');

    const complete = compareSnapshots(baseline, comparison, {
      upgradeReview: true,
      expectedChanges: [
        { change: 'modified', key: 'COUNTER' },
        { change: 'removed', key: 'KEEP' },
        { change: 'created', key: 'NEW' },
      ],
    });
    expect(complete.counts.expected).toBe(3);
    expect(complete.counts.unexpected).toBe(0);
    expect(complete.status).toBe('expected-changes-only');
  });

  it('parses allowlist files and rejects malformed rules', () => {
    expect(
      parseExpectedChanges([{ change: 'modified', entryType: 'persistent', key: 'COUNTER' }]),
    ).toHaveLength(1);
    expect(
      parseExpectedChanges({ expectedChanges: [{ change: 'any', reason: 'initial deploy' }] }),
    ).toHaveLength(1);

    expect(() => parseExpectedChanges({})).toThrow(SnapshotValidationError);
    expect(() => parseExpectedChanges([{ change: 'upsert' }])).toThrow(/change must be/);
    expect(() => parseExpectedChanges([{ entryType: 'surprise' }])).toThrow(/entryType/);
    expect(() => parseExpectedChanges([{ keyId: 'abc' }])).toThrow(/keyId/);
  });
});

describe('snapshot validation and historical limits', () => {
  it('rejects unsupported formats, versions and tampered fingerprints', async () => {
    const snapshot = await capture(baseSource());

    expect(() => parseSnapshot({ ...snapshot, format: 'other' })).toThrow(/format/);
    expect(() => parseSnapshot({ ...snapshot, version: 2 })).toThrow(/version/);
    expect(() => parseSnapshot({ ...snapshot, contractId: 'not-a-contract' })).toThrow(
      /contract ID/,
    );
    expect(() =>
      parseSnapshot({
        ...snapshot,
        entries: [{ ...snapshot.entries[0], keyId: 'f'.repeat(64) }],
        snapshotFingerprint: snapshot.snapshotFingerprint,
      }),
    ).toThrow(/keyId/);
    expect(() =>
      parseSnapshot({
        ...snapshot,
        entries: [{ ...snapshot.entries[0], fingerprint: 'f'.repeat(64) }],
      }),
    ).toThrow(/fingerprint/);
    expect(() =>
      parseSnapshot({
        ...snapshot,
        entries: [{ ...snapshot.entries[0], valueXdr: 'not-base64-xdr' }],
      }),
    ).toThrow(/valid ScVal base64 XDR/);
    expect(() =>
      parseSnapshot({
        ...snapshot,
        snapshotFingerprint: '0'.repeat(64),
      }),
    ).toThrow(/fingerprint/);
    expect(() =>
      parseSnapshot({ ...snapshot, entries: [snapshot.entries[0], snapshot.entries[0]] }),
    ).toThrow(/duplicate/);
  });

  it('rejects malformed snapshot files', () => {
    const file = tempFile('malformed-snapshot');
    try {
      fs.writeFileSync(file, '{not json', 'utf8');
      expect(() => loadSnapshotFile(file)).toThrow(/not valid JSON/);
      fs.writeFileSync(file, JSON.stringify({ hello: 'world' }), 'utf8');
      expect(() => loadSnapshotFile(file)).toThrow(/unsupported format/);
      expect(() => loadSnapshotFile(`${file}.missing`)).toThrow(/Cannot read snapshot/);
    } finally {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  });

  it('reports unsupported historical ledger queries clearly', async () => {
    const source = baseSource();

    await expect(capture(source, { requestedLedger: 999 })).rejects.toThrow(
      UnsupportedHistoricalStateError,
    );
    await expect(capture(source, { requestedLedger: 999 })).rejects.toThrow(
      /read current ledger state only/,
    );

    const current = await capture(source, { requestedLedger: 1000 });
    expect(current.ledger).toBe(1000);
  });

  it('rejects an invalid contract ID before contacting RPC', async () => {
    const source = baseSource();
    await expect(capture(source, { contractId: 'CABC' })).rejects.toThrow(/Invalid contract ID/);
  });
});

describe('storage key parsing', () => {
  it('accepts symbols, ScVal XDR and LedgerKey XDR', () => {
    const ledgerKeyXdr = buildContractDataKey(CONTRACT_ID, symbol('LOCK'), 'temporary').toXDR(
      'base64',
    );
    const scValXdr = symbol('Admin').toXDR('base64');

    const specs = parseStorageKeySpecs(
      ['COUNTER', scValXdr, ledgerKeyXdr, 'COUNTER', '  '],
      'persistent',
    );

    expect(specs).toHaveLength(3);
    expect(specs[0]).toMatchObject({ durability: 'persistent', label: 'COUNTER' });
    expect(specs[1].label.startsWith('scval:')).toBe(true);
    expect(specs[2]).toMatchObject({ durability: 'temporary' });
    expect(specs[2].label.startsWith('ledgerKey:')).toBe(true);
  });
});

describe('documentation', () => {
  it('documents the example in README.md', () => {
    const readme = readFileSync('README.md', 'utf8');
    expect(readme).toContain('262-contract-state-snapshot');
  });
});
