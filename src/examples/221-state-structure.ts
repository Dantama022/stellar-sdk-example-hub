import {
  analyzeStructure,
  decodeScVal,
  filterEntries,
  getFlag,
  hasFlag,
  parseFlags,
  positiveInt,
  readSnapshotFile,
  stableStringify,
} from '../utils/soroban-state-analysis';
export interface StructureOptions {
  snapshotFile?: string;
  contractId?: string;
  durability?: string;
  collectionThreshold?: number;
  depthThreshold?: number;
  json?: boolean;
}
export function buildStructureReport(snapshotFile: string, options: StructureOptions = {}) {
  const snapshot = readSnapshotFile(snapshotFile);
  const entries = filterEntries(snapshot.entries, options.contractId, options.durability);
  const decoded = entries.map((entry) => ({ entry, result: decodeScVal(entry.valueXdr) }));
  const usable = decoded
    .filter((r) => r.result.decoded && r.result.value !== undefined)
    .map((r) => ({ entry: r.entry, analysis: analyzeStructure(r.result.value) }));
  const depths = usable.map((r) => r.analysis.depth);
  const patterns: Record<string, number> = {},
    pairs: Record<string, number> = {};
  for (const r of usable) {
    patterns[r.analysis.pattern] = (patterns[r.analysis.pattern] ?? 0) + 1;
    for (const [k, v] of Object.entries(r.analysis.mapTypePairs)) pairs[k] = (pairs[k] ?? 0) + v;
  }
  const ct = options.collectionThreshold ?? 10,
    dt = options.depthThreshold ?? 5;
  return {
    totalEntries: entries.length,
    decodedEntries: usable.length,
    undecodableEntries: decoded
      .filter((r) => !r.result.decoded)
      .map((r) => ({ ledgerKey: r.entry.ledgerKey, error: r.result.error })),
    scalarValues: usable.reduce((s, r) => s + r.analysis.scalarCount, 0),
    compositeValues: usable.reduce((s, r) => s + r.analysis.compositeCount, 0),
    maximumDepth: depths.length ? Math.max(...depths) : 0,
    averageDepth: depths.length ? depths.reduce((a, b) => a + b, 0) / depths.length : 0,
    vectorSizes: usable.flatMap((r) => r.analysis.vectorSizes).sort((a, b) => a - b),
    mapSizes: usable.flatMap((r) => r.analysis.mapSizes).sort((a, b) => a - b),
    emptyVectors: usable.reduce((s, r) => s + r.analysis.emptyVectors, 0),
    emptyMaps: usable.reduce((s, r) => s + r.analysis.emptyMaps, 0),
    largeCollections: usable
      .flatMap((r) =>
        [...r.analysis.vectorSizes, ...r.analysis.mapSizes]
          .filter((size) => size >= ct)
          .map((size) => ({ ledgerKey: r.entry.ledgerKey, size })),
      )
      .sort((a, b) => b.size - a.size || a.ledgerKey.localeCompare(b.ledgerKey)),
    deepEntries: usable
      .filter((r) => r.analysis.depth >= dt)
      .map((r) => ({ ledgerKey: r.entry.ledgerKey, depth: r.analysis.depth }))
      .sort((a, b) => b.depth - a.depth || a.ledgerKey.localeCompare(b.ledgerKey)),
    mapKeyValueTypeCombinations: Object.fromEntries(
      Object.entries(pairs).sort(([a], [b]) => a.localeCompare(b)),
    ),
    structuralPatterns: Object.entries(patterns)
      .map(([pattern, count]) => ({ pattern, count }))
      .sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern)),
    entries: usable
      .map((r) => ({
        ledgerKey: r.entry.ledgerKey,
        contractId: r.entry.contractId,
        durability: r.entry.durability,
        depth: r.analysis.depth,
        vectorSizes: r.analysis.vectorSizes,
        mapSizes: r.analysis.mapSizes,
        pattern: r.analysis.pattern,
      }))
      .sort((a, b) => a.ledgerKey.localeCompare(b.ledgerKey)),
  };
}
export function parseStateStructureArgs(args: string[]): StructureOptions {
  const { positional, flags } = parseFlags(args);
  return {
    snapshotFile: positional[0],
    contractId: getFlag(flags, 'contract', 'contract-id'),
    durability: getFlag(flags, 'durability'),
    collectionThreshold: positiveInt(
      getFlag(flags, 'collection-threshold'),
      'collection-threshold',
      10,
    ),
    depthThreshold: positiveInt(getFlag(flags, 'depth-threshold'), 'depth-threshold', 5),
    json: hasFlag(flags, 'json'),
  };
}
export async function run(options: StructureOptions = {}) {
  const file = options.snapshotFile ?? process.argv[3];
  if (!file) throw new Error('Missing snapshot file path.');
  const report = buildStructureReport(file, options);
  if (options.json) console.log(stableStringify(report));
  else {
    console.log('=== Soroban Contract State Structure Analysis ===');
    console.log(`Entries: ${report.totalEntries}`);
    console.log(`Decoded entries: ${report.decodedEntries}`);
    console.log(`Maximum depth: ${report.maximumDepth}`);
    console.log(`Average depth: ${report.averageDepth.toFixed(2)}`);
  }
  return report;
}
