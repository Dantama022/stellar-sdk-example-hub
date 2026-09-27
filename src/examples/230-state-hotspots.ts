import {
  CanonicalEntry,
  decodeScValXdr,
  encodedByteSize,
  filterEntries,
  getFlag,
  hasFlag,
  loadSnapshot,
  parseFlags,
  remainingTtl,
  requirePositiveInt,
  stableStringify,
} from '../utils/soroban-state-snapshot';

export type HotspotCriterion = 'size' | 'value-size' | 'collection' | 'depth' | 'ttl';

export interface HotspotOptions {
  snapshotFile?: string;
  by?: HotspotCriterion;
  top?: number;
  contractId?: string;
  durability?: string;
  referenceLedger?: string;
  minSize?: number;
  minCollection?: number;
  minDepth?: number;
  maxTtl?: string;
  json?: boolean;
}

export interface HotspotRow {
  ledgerKey: string;
  contractId?: string;
  durability: string;
  encodedKeySize: number;
  encodedValueSize: number;
  combinedEncodedSize: number;
  collectionSize: number;
  nestingDepth: number;
  liveUntilLedgerSeq?: string;
  remainingTtl?: string;
  decoded: boolean;
  decodeError?: string;
}

export function analyzeHotspots(entries: CanonicalEntry[], options: HotspotOptions = {}) {
  const rows: HotspotRow[] = filterEntries(entries, options.contractId, options.durability).map(
    (entry) => {
      const decoded = decodeScValXdr(entry.valueXdr);
      const encodedKeySize = encodedByteSize(entry.ledgerKey);
      const encodedValueSize = encodedByteSize(entry.valueXdr);
      return {
        ledgerKey: entry.ledgerKey,
        contractId: entry.contractId,
        durability: entry.durability,
        encodedKeySize,
        encodedValueSize,
        combinedEncodedSize: encodedKeySize + encodedValueSize,
        collectionSize: decoded.collectionSize,
        nestingDepth: decoded.maxDepth,
        liveUntilLedgerSeq: entry.liveUntilLedgerSeq,
        remainingTtl: remainingTtl(entry.liveUntilLedgerSeq, options.referenceLedger),
        decoded: decoded.decoded,
        decodeError: decoded.error,
      };
    },
  );

  const filtered = rows.filter((row) => {
    if (options.minSize !== undefined && row.combinedEncodedSize < options.minSize) return false;
    if (options.minCollection !== undefined && row.collectionSize < options.minCollection)
      return false;
    if (options.minDepth !== undefined && row.nestingDepth < options.minDepth) return false;
    if (
      options.maxTtl !== undefined &&
      (row.remainingTtl === undefined || BigInt(row.remainingTtl) > BigInt(options.maxTtl))
    ) {
      return false;
    }
    return true;
  });

  const criterion = options.by ?? 'size';
  filtered.sort((a, b) => compareRows(a, b, criterion));
  return {
    criterion,
    totalCandidates: rows.length,
    matchedThresholds: filtered.length,
    results: filtered.slice(0, options.top ?? 10),
  };
}

function compareRows(a: HotspotRow, b: HotspotRow, criterion: HotspotCriterion): number {
  let primary = 0;
  if (criterion === 'size') primary = b.combinedEncodedSize - a.combinedEncodedSize;
  else if (criterion === 'value-size') primary = b.encodedValueSize - a.encodedValueSize;
  else if (criterion === 'collection') primary = b.collectionSize - a.collectionSize;
  else if (criterion === 'depth') primary = b.nestingDepth - a.nestingDepth;
  else {
    if (a.remainingTtl === undefined && b.remainingTtl !== undefined) primary = 1;
    else if (a.remainingTtl !== undefined && b.remainingTtl === undefined) primary = -1;
    else if (a.remainingTtl !== undefined && b.remainingTtl !== undefined) {
      const aa = BigInt(a.remainingTtl);
      const bb = BigInt(b.remainingTtl);
      primary = aa < bb ? -1 : aa > bb ? 1 : 0;
    }
  }
  return primary || a.ledgerKey.localeCompare(b.ledgerKey);
}

export function parseStateHotspotsArgs(args: string[]): HotspotOptions {
  const { positional, flags } = parseFlags(args);
  const by = (getFlag(flags, 'by') ?? 'size') as HotspotCriterion;
  if (!['size', 'value-size', 'collection', 'depth', 'ttl'].includes(by)) {
    throw new Error('--by must be size, value-size, collection, depth, or ttl');
  }
  const parseOptionalInt = (name: string): number | undefined => {
    const value = getFlag(flags, name);
    return value === undefined ? undefined : requirePositiveInt(value, name, 1);
  };
  return {
    snapshotFile: positional[0],
    by,
    top: requirePositiveInt(getFlag(flags, 'top'), 'top', 10),
    contractId: getFlag(flags, 'contract', 'contract-id'),
    durability: getFlag(flags, 'durability'),
    referenceLedger: getFlag(flags, 'reference-ledger'),
    minSize: parseOptionalInt('min-size'),
    minCollection: parseOptionalInt('min-collection'),
    minDepth: parseOptionalInt('min-depth'),
    maxTtl: getFlag(flags, 'max-ttl'),
    json: hasFlag(flags, 'json'),
  };
}

export async function run(options: HotspotOptions = {}) {
  const file = options.snapshotFile ?? process.argv[3];
  if (!file) throw new Error('Missing snapshot file path.');
  if ((options.by ?? 'size') === 'ttl' && !options.referenceLedger) {
    throw new Error('TTL ranking requires --reference-ledger');
  }
  const report = analyzeHotspots(loadSnapshot(file).entries, options);
  if (options.json) {
    console.log(stableStringify(report));
    return report;
  }
  console.log(`=== Soroban State Storage Hotspots (by ${report.criterion}) ===`);
  if (report.results.length === 0) console.log('No entries matched the requested thresholds.');
  report.results.forEach((row, index) => {
    console.log(
      `${index + 1}. ${row.ledgerKey} contract=${row.contractId ?? '(unknown)'} durability=${row.durability}`,
    );
    console.log(
      `   key=${row.encodedKeySize}B value=${row.encodedValueSize}B total=${row.combinedEncodedSize}B collection=${row.collectionSize} depth=${row.nestingDepth} ttl=${row.remainingTtl ?? 'n/a'}`,
    );
  });
  return report;
}

if (require.main === module) {
  run(parseStateHotspotsArgs(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
