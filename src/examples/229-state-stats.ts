import {
  CanonicalEntry,
  averageBigInts,
  decodeScValXdr,
  decodedValueSize,
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

export interface StatsOptions {
  snapshotFile?: string;
  contractId?: string;
  durability?: string;
  top?: number;
  referenceLedger?: string;
  ttlThreshold?: string;
  json?: boolean;
}

export interface SizeStats {
  min: number;
  max: number;
  average: number;
}

function numericStats(values: number[]): SizeStats {
  if (values.length === 0) return { min: 0, max: 0, average: 0 };
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}

function countBy(
  entries: CanonicalEntry[],
  selector: (entry: CanonicalEntry) => string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    const key = selector(entry);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export function buildStats(entries: CanonicalEntry[], options: StatsOptions = {}) {
  const filtered = filterEntries(entries, options.contractId, options.durability);
  const keySizes = filtered.map((entry) => encodedByteSize(entry.ledgerKey));
  const valueSizes = filtered.map((entry) => encodedByteSize(entry.valueXdr));
  const decoded = filtered.map((entry) => ({ entry, metrics: decodeScValXdr(entry.valueXdr) }));
  const decodedSizes = decoded
    .filter(({ metrics }) => metrics.decoded)
    .map(({ metrics }) => decodedValueSize(metrics.value));
  const typeCounts: Record<string, number> = {};
  for (const { metrics } of decoded) typeCounts[metrics.type] = (typeCounts[metrics.type] ?? 0) + 1;

  const ttlRows = filtered
    .map((entry) => ({
      entry,
      remaining: remainingTtl(entry.liveUntilLedgerSeq, options.referenceLedger),
    }))
    .filter((row) => row.entry.liveUntilLedgerSeq !== undefined);
  const ttlValues = ttlRows.map((row) => row.entry.liveUntilLedgerSeq!);
  const remainingValues = ttlRows
    .map((row) => row.remaining)
    .filter((value): value is string => value !== undefined);
  const threshold = options.ttlThreshold === undefined ? undefined : BigInt(options.ttlThreshold);
  const approachingExpiration =
    threshold === undefined
      ? []
      : ttlRows
          .filter(
            (row) =>
              row.remaining !== undefined &&
              BigInt(row.remaining) >= 0n &&
              BigInt(row.remaining) <= threshold,
          )
          .map((row) => row.entry.ledgerKey)
          .sort();

  const top = options.top ?? 10;
  const largestEncodedValues = [...filtered]
    .sort(
      (a, b) =>
        encodedByteSize(b.valueXdr) - encodedByteSize(a.valueXdr) ||
        a.ledgerKey.localeCompare(b.ledgerKey),
    )
    .slice(0, top)
    .map((entry) => ({ ledgerKey: entry.ledgerKey, bytes: encodedByteSize(entry.valueXdr) }));
  const largestDecodedCollections = decoded
    .filter(({ metrics }) => metrics.decoded)
    .sort(
      (a, b) =>
        b.metrics.collectionSize - a.metrics.collectionSize ||
        a.entry.ledgerKey.localeCompare(b.entry.ledgerKey),
    )
    .slice(0, top)
    .map(({ entry, metrics }) => ({
      ledgerKey: entry.ledgerKey,
      collectionSize: metrics.collectionSize,
    }));

  return {
    totalEntries: filtered.length,
    countsByEntryType: countBy(filtered, (entry) => entry.entryType),
    countsByDurability: countBy(filtered, (entry) => entry.durability),
    countsByContractId: countBy(filtered, (entry) => entry.contractId ?? '(unknown)'),
    scValTypes: Object.fromEntries(
      Object.entries(typeCounts).sort(([a], [b]) => a.localeCompare(b)),
    ),
    encodedKeySize: numericStats(keySizes),
    encodedValueSize: numericStats(valueSizes),
    totalEncodedStateSize: filtered.reduce(
      (sum, entry) => sum + encodedByteSize(entry.ledgerKey) + encodedByteSize(entry.valueXdr),
      0,
    ),
    decodedValueSize: numericStats(decodedSizes),
    ttl: {
      entriesWithTtl: ttlRows.length,
      entriesWithoutTtl: filtered.length - ttlRows.length,
      minLiveUntilLedgerSeq: ttlValues.length
        ? ttlValues.reduce((a, b) => (BigInt(a) < BigInt(b) ? a : b))
        : undefined,
      maxLiveUntilLedgerSeq: ttlValues.length
        ? ttlValues.reduce((a, b) => (BigInt(a) > BigInt(b) ? a : b))
        : undefined,
      averageLiveUntilLedgerSeq: averageBigInts(ttlValues),
      referenceLedger: options.referenceLedger,
      minRemainingTtl: remainingValues.length
        ? remainingValues.reduce((a, b) => (BigInt(a) < BigInt(b) ? a : b))
        : undefined,
      maxRemainingTtl: remainingValues.length
        ? remainingValues.reduce((a, b) => (BigInt(a) > BigInt(b) ? a : b))
        : undefined,
      averageRemainingTtl: averageBigInts(remainingValues),
      approachingExpiration,
    },
    largestEncodedValues,
    largestDecodedCollections,
    undecodable: decoded
      .filter(({ metrics }) => !metrics.decoded && metrics.error !== 'missing valueXdr')
      .map(({ entry, metrics }) => ({ ledgerKey: entry.ledgerKey, error: metrics.error })),
  };
}

export function parseStateStatsArgs(args: string[]): StatsOptions {
  const { positional, flags } = parseFlags(args);
  return {
    snapshotFile: positional[0],
    contractId: getFlag(flags, 'contract', 'contract-id'),
    durability: getFlag(flags, 'durability'),
    top: requirePositiveInt(getFlag(flags, 'top'), 'top', 10),
    referenceLedger: getFlag(flags, 'reference-ledger'),
    ttlThreshold: getFlag(flags, 'ttl-threshold'),
    json: hasFlag(flags, 'json'),
  };
}

export async function run(options: StatsOptions = {}) {
  const file = options.snapshotFile ?? process.argv[3];
  if (!file) throw new Error('Missing snapshot file path.');
  const report = buildStats(loadSnapshot(file).entries, options);
  if (options.json) {
    console.log(stableStringify(report));
    return report;
  }
  console.log('=== Soroban State Snapshot Statistics ===');
  console.log(`Total entries: ${report.totalEntries}`);
  console.log(`Total encoded state size: ${report.totalEncodedStateSize} bytes`);
  console.log(`Durability: ${JSON.stringify(report.countsByDurability)}`);
  console.log(`ScVal types: ${JSON.stringify(report.scValTypes)}`);
  console.log(`Entries with TTL: ${report.ttl.entriesWithTtl}`);
  console.log(`Entries without TTL: ${report.ttl.entriesWithoutTtl}`);
  console.log('Largest encoded values:');
  report.largestEncodedValues.forEach((row) =>
    console.log(`  ${row.ledgerKey}: ${row.bytes} bytes`),
  );
  console.log('Largest decoded collections:');
  report.largestDecodedCollections.forEach((row) =>
    console.log(`  ${row.ledgerKey}: ${row.collectionSize} elements`),
  );
  return report;
}

if (require.main === module) {
  run(parseStateStatsArgs(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
