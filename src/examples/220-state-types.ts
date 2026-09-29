import {
  filterStateEntries,
  flagBoolean,
  flagString,
  jsonSafe,
  loadStateSnapshot,
  normalizeScValType,
  parseCliFlags,
  parseDurability,
  parseNonNegativeNumberFlag,
  walkScValXdr,
  type StateDurability,
} from '../utils/soroban-state-snapshot';

export interface StateTypesParams {
  snapshotFile?: string;
  contractId?: string;
  durability?: StateDurability;
  maxDepth?: number;
  json?: boolean;
}

export interface TypeCount {
  type: string;
  count: number;
  percentage: number;
}

export interface StateTypesReport {
  totalEntries: number;
  decodedEntries: number;
  topLevelTotal: number;
  nestedTotal: number;
  topLevelTypes: TypeCount[];
  nestedTypes: TypeCount[];
  allTypes: TypeCount[];
  maximumNestingDepth: number;
  mostFrequentTypes: TypeCount[];
  deeplyNestedEntries: Array<{ ledgerKey: string; maxDepth: number }>;
  entriesByType: Record<string, string[]>;
  undecodable: Array<{ ledgerKey: string; error: string }>;
  filters: {
    contractId?: string;
    durability?: StateDurability;
    maxDepth?: number;
  };
}

function toDistribution(counts: Map<string, number>, total: number): TypeCount[] {
  return Array.from(counts.entries())
    .map(([type, count]) => ({
      type,
      count,
      percentage: total === 0 ? 0 : Number(((count * 10000) / total).toFixed(0)) / 100,
    }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

function increment(map: Map<string, number>, type: string): void {
  map.set(type, (map.get(type) ?? 0) + 1);
}

export function analyzeStateTypes(
  snapshotFile: string,
  options: Omit<StateTypesParams, 'snapshotFile' | 'json'> = {},
): StateTypesReport {
  const snapshot = loadStateSnapshot(snapshotFile);
  const entries = filterStateEntries(snapshot.entries, {
    contractId: options.contractId,
    durability: options.durability,
  });

  const topCounts = new Map<string, number>();
  const nestedCounts = new Map<string, number>();
  const allCounts = new Map<string, number>();
  const entriesByType = new Map<string, Set<string>>();
  const undecodable: Array<{ ledgerKey: string; error: string }> = [];
  const deeplyNestedEntries: Array<{ ledgerKey: string; maxDepth: number }> = [];
  let maximumNestingDepth = 0;
  let decodedEntries = 0;
  let nestedTotal = 0;

  for (const entry of entries) {
    if (!entry.valueXdr) {
      if (entry.valueScValType) {
        const type = normalizeScValType(entry.valueScValType);
        increment(topCounts, type);
        increment(allCounts, type);
        if (!entriesByType.has(type)) entriesByType.set(type, new Set());
        entriesByType.get(type)?.add(entry.ledgerKey);
        decodedEntries += 1;
      } else {
        undecodable.push({ ledgerKey: entry.ledgerKey, error: 'no valueXdr available' });
      }
      continue;
    }

    const walked = walkScValXdr(entry.valueXdr, { maxDepth: options.maxDepth });
    if (walked.error || walked.nodes.length === 0) {
      undecodable.push({
        ledgerKey: entry.ledgerKey,
        error: walked.error ?? 'value could not be decoded',
      });
      continue;
    }

    decodedEntries += 1;
    const entryMaxDepth = walked.nodes.reduce((max, node) => Math.max(max, node.depth), 0);
    maximumNestingDepth = Math.max(maximumNestingDepth, entryMaxDepth);
    if (entryMaxDepth >= 3)
      deeplyNestedEntries.push({ ledgerKey: entry.ledgerKey, maxDepth: entryMaxDepth });

    for (const node of walked.nodes) {
      const type = normalizeScValType(node.type);
      increment(allCounts, type);
      if (node.depth === 0) increment(topCounts, type);
      else {
        increment(nestedCounts, type);
        nestedTotal += 1;
      }
      if (!entriesByType.has(type)) entriesByType.set(type, new Set());
      entriesByType.get(type)?.add(entry.ledgerKey);
    }
  }

  const topLevelTotal = Array.from(topCounts.values()).reduce((sum, count) => sum + count, 0);
  const allTotal = topLevelTotal + nestedTotal;
  const allTypes = toDistribution(allCounts, allTotal);

  const entriesByTypeObject: Record<string, string[]> = {};
  for (const [type, keys] of Array.from(entriesByType.entries()).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    entriesByTypeObject[type] = Array.from(keys).sort();
  }

  deeplyNestedEntries.sort((a, b) => a.ledgerKey.localeCompare(b.ledgerKey));
  undecodable.sort((a, b) => a.ledgerKey.localeCompare(b.ledgerKey));

  return {
    totalEntries: entries.length,
    decodedEntries,
    topLevelTotal,
    nestedTotal,
    topLevelTypes: toDistribution(topCounts, topLevelTotal),
    nestedTypes: toDistribution(nestedCounts, nestedTotal),
    allTypes,
    maximumNestingDepth,
    mostFrequentTypes: allTypes.slice(0, 5),
    deeplyNestedEntries,
    entriesByType: entriesByTypeObject,
    undecodable,
    filters: {
      contractId: options.contractId,
      durability: options.durability,
      maxDepth: options.maxDepth,
    },
  };
}

export function formatStateTypesReport(report: StateTypesReport): string {
  const lines: string[] = [];
  lines.push('=== Soroban Contract State Value Type Analysis ===');
  lines.push(`Entries analyzed     : ${report.totalEntries}`);
  lines.push(`Entries decoded      : ${report.decodedEntries}`);
  lines.push(`Maximum nesting depth: ${report.maximumNestingDepth}`);
  lines.push('');

  const section = (title: string, rows: TypeCount[]): void => {
    lines.push(title);
    if (rows.length === 0) lines.push('  (none)');
    rows.forEach((row) =>
      lines.push(`  ${row.type}: ${row.count} (${row.percentage.toFixed(2)}%)`),
    );
    lines.push('');
  };

  section('Top-level ScVal types', report.topLevelTypes);
  section('Nested ScVal types', report.nestedTypes);
  section('Most frequent types', report.mostFrequentTypes);

  lines.push('Deeply nested entries');
  if (report.deeplyNestedEntries.length === 0) lines.push('  (none)');
  report.deeplyNestedEntries.forEach((entry) =>
    lines.push(`  ${entry.ledgerKey}: depth ${entry.maxDepth}`),
  );

  if (report.undecodable.length > 0) {
    lines.push('');
    lines.push('Undecodable values');
    report.undecodable.forEach((entry) => lines.push(`  ${entry.ledgerKey}: ${entry.error}`));
  }
  return lines.join('\n');
}

export function parseStateTypesArgs(args: string[]): StateTypesParams {
  const { positional, flags } = parseCliFlags(args);
  return {
    snapshotFile: positional[0],
    contractId: flagString(flags, 'contract', 'contract-id'),
    durability: parseDurability(flagString(flags, 'durability')),
    maxDepth: parseNonNegativeNumberFlag(flagString(flags, 'max-depth'), '--max-depth'),
    json: flagBoolean(flags, 'json'),
  };
}

export async function run(params: StateTypesParams = {}): Promise<void> {
  if (!params.snapshotFile) {
    throw new Error(
      'Usage: stellar-api-inspector state-types <snapshot.json> [--contract <id>] [--durability persistent|temporary] [--max-depth <n>] [--json]',
    );
  }
  const report = analyzeStateTypes(params.snapshotFile, params);
  if (params.json) console.log(JSON.stringify(jsonSafe(report), null, 2));
  else console.log(formatStateTypesReport(report));
}
