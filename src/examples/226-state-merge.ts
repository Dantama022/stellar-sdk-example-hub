import * as fs from 'fs';
import {
  Snapshot,
  SnapshotEntry,
  entriesEquivalent,
  filterEntries,
  getFlag,
  hasFlag,
  parseFlags,
  readSnapshotFile,
  stableStringify,
} from '../utils/soroban-state-analysis';
export type ConflictStrategy = 'error' | 'latest' | 'first';
export interface MergeOptions {
  snapshotFiles?: string[];
  outputFile?: string;
  conflict?: ConflictStrategy;
  contractId?: string;
  durability?: string;
  json?: boolean;
}
export interface ConflictRecord {
  ledgerKey: string;
  strategy: ConflictStrategy;
  first: SnapshotEntry;
  incoming: SnapshotEntry;
  selected?: SnapshotEntry;
}
function chooseLatest(a: SnapshotEntry, b: SnapshotEntry): SnapshotEntry {
  const x = a.lastModifiedLedgerSeq,
    y = b.lastModifiedLedgerSeq;
  if (x === undefined) return b;
  if (y === undefined) return a;
  return BigInt(y) > BigInt(x) ? b : a;
}
export function mergeSnapshots(snapshots: Snapshot[], options: MergeOptions = {}) {
  if (snapshots.length < 2) throw new Error('state-merge requires at least two snapshots');
  const strategy = options.conflict ?? 'error',
    merged = new Map<string, SnapshotEntry>(),
    conflicts: ConflictRecord[] = [];
  let deduplicatedEntries = 0,
    invalidEntries = 0;
  for (const snap of snapshots) {
    for (const entry of filterEntries(snap.entries, options.contractId, options.durability)) {
      if (!entry.ledgerKey) {
        invalidEntries++;
        continue;
      }
      const existing = merged.get(entry.ledgerKey);
      if (!existing) {
        merged.set(entry.ledgerKey, entry);
        continue;
      }
      if (entriesEquivalent(existing, entry)) {
        deduplicatedEntries++;
        continue;
      }
      const c: ConflictRecord = {
        ledgerKey: entry.ledgerKey,
        strategy,
        first: existing,
        incoming: entry,
      };
      if (strategy === 'error') {
        conflicts.push(c);
        continue;
      }
      if (strategy === 'first') {
        c.selected = existing;
        conflicts.push(c);
        continue;
      }
      c.selected = chooseLatest(existing, entry);
      conflicts.push(c);
      merged.set(entry.ledgerKey, c.selected);
    }
  }
  if (strategy === 'error' && conflicts.length)
    throw new Error(
      `Merge conflicts detected for ledger keys: ${conflicts
        .map((c) => c.ledgerKey)
        .sort()
        .join(', ')}`,
    );
  const ledgers = snapshots.map((s) => s.ledger).filter((v): v is string => v !== undefined);
  const snapshot: Snapshot = {
    ledger: ledgers.length ? ledgers.reduce((a, b) => (BigInt(a) > BigInt(b) ? a : b)) : undefined,
    entries: [...merged.values()].sort((a, b) => a.ledgerKey.localeCompare(b.ledgerKey)),
  };
  return {
    snapshot,
    report: {
      inputSnapshotCount: snapshots.length,
      uniqueEntries: snapshot.entries.length,
      deduplicatedEntries,
      conflicts: conflicts.sort((a, b) => a.ledgerKey.localeCompare(b.ledgerKey)),
      invalidEntries,
    },
  };
}
export function parseStateMergeArgs(args: string[]): MergeOptions {
  const { positional, flags } = parseFlags(args);
  const conflict = (getFlag(flags, 'conflict') ?? 'error') as ConflictStrategy;
  if (!['error', 'latest', 'first'].includes(conflict))
    throw new Error('--conflict must be error, latest, or first');
  return {
    snapshotFiles: positional,
    outputFile: getFlag(flags, 'o', 'output'),
    conflict,
    contractId: getFlag(flags, 'contract', 'contract-id'),
    durability: getFlag(flags, 'durability'),
    json: hasFlag(flags, 'json'),
  };
}
export async function run(options: MergeOptions = {}) {
  const files = options.snapshotFiles ?? process.argv.slice(3);
  if (files.length < 2) throw new Error('state-merge requires at least two snapshot files');
  const result = mergeSnapshots(files.map(readSnapshotFile), options);
  const text = `${stableStringify(result.snapshot)}\n`;
  if (options.outputFile) fs.writeFileSync(options.outputFile, text, 'utf8');
  if (options.json) console.log(stableStringify(result));
  else {
    console.log('=== Soroban State Snapshot Merge ===');
    console.log(`Input snapshots: ${result.report.inputSnapshotCount}`);
    console.log(`Unique entries: ${result.report.uniqueEntries}`);
    console.log(`Deduplicated entries: ${result.report.deduplicatedEntries}`);
    console.log(`Conflicts: ${result.report.conflicts.length}`);
    if (options.outputFile) console.log(`Merged snapshot written to ${options.outputFile}`);
    else console.log(text.trimEnd());
  }
  return result;
}
