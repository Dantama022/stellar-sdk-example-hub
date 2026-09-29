import {
  filterStateEntries,
  flagBoolean,
  flagString,
  jsonSafe,
  loadStateSnapshot,
  normalizeDecodedQuery,
  normalizeScValType,
  parseCliFlags,
  parseDurability,
  renderValue,
  stableStringify,
  walkScValXdr,
  type NormalizedStateEntry,
  type ScValNode,
  type StateDurability,
} from '../utils/soroban-state-snapshot';

export interface StateSearchParams {
  snapshotFile?: string;
  query?: string;
  contractId?: string;
  durability?: StateDurability;
  entryType?: string;
  scValType?: string;
  ignoreCase?: boolean;
  json?: boolean;
  raw?: boolean;
}

export interface StateSearchMatch {
  ledgerKey: string;
  contractId?: string;
  ledgerEntryType: string;
  durability: StateDurability;
  path: string;
  scValType: string;
  matchedValue: unknown;
  decodedValue?: unknown;
  raw?: {
    ledgerKey: string;
    valueXdr?: string;
    matchedValueXdr?: string;
  };
}

export interface StateSearchReport {
  query: string;
  filters: {
    contractId?: string;
    durability?: StateDurability;
    entryType?: string;
    scValType?: string;
    ignoreCase: boolean;
  };
  matchCount: number;
  matches: StateSearchMatch[];
  undecodable: Array<{ ledgerKey: string; error: string }>;
  warnings: Array<{ index: number; ledgerKey?: string; message: string }>;
}

function normalizeComparable(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function matchesNode(node: ScValNode, query: unknown, ignoreCase: boolean): boolean {
  const value = normalizeComparable(node.value);
  const normalizedQuery = normalizeComparable(query);

  if (typeof value === 'string' && typeof normalizedQuery === 'string') {
    return ignoreCase
      ? value.toLowerCase() === normalizedQuery.toLowerCase()
      : value === normalizedQuery;
  }

  return stableStringify(value) === stableStringify(normalizedQuery);
}

function fallbackDecodedNodes(entry: NormalizedStateEntry): ScValNode[] {
  if (entry.valueDecoded === undefined) return [];
  return [
    {
      path: '$',
      depth: 0,
      type: entry.valueScValType ?? 'unknown',
      value: entry.valueDecoded,
    },
  ];
}

export function searchStateValues(
  snapshotFile: string,
  queryText: string,
  options: Omit<StateSearchParams, 'snapshotFile' | 'query' | 'json'> = {},
): StateSearchReport {
  const snapshot = loadStateSnapshot(snapshotFile);
  const entries = filterStateEntries(snapshot.entries, {
    contractId: options.contractId,
    durability: options.durability,
    entryType: options.entryType,
  });
  const query = normalizeDecodedQuery(queryText);
  const requestedType = options.scValType ? normalizeScValType(options.scValType) : undefined;
  const matches: StateSearchMatch[] = [];
  const undecodable: Array<{ ledgerKey: string; error: string }> = [];

  for (const entry of entries) {
    let nodes: ScValNode[] = [];
    if (entry.valueXdr) {
      const walked = walkScValXdr(entry.valueXdr);
      nodes = walked.nodes;
      if (walked.error) undecodable.push({ ledgerKey: entry.ledgerKey, error: walked.error });
    } else {
      nodes = fallbackDecodedNodes(entry);
      if (nodes.length === 0) {
        undecodable.push({
          ledgerKey: entry.ledgerKey,
          error: 'no decoded value or valueXdr available',
        });
      }
    }

    for (const node of nodes) {
      if (requestedType && normalizeScValType(node.type) !== requestedType) continue;
      if (!matchesNode(node, query, options.ignoreCase ?? false)) continue;
      matches.push({
        ledgerKey: entry.ledgerKey,
        contractId: entry.contractId,
        ledgerEntryType: entry.ledgerEntryType,
        durability: entry.durability,
        path: node.path,
        scValType: node.type,
        matchedValue: node.value,
        decodedValue: entry.valueDecoded,
        raw: options.raw
          ? {
              ledgerKey: entry.ledgerKey,
              valueXdr: entry.valueXdr,
              matchedValueXdr: node.rawXdr,
            }
          : undefined,
      });
    }
  }

  matches.sort((a, b) => {
    const key = a.ledgerKey.localeCompare(b.ledgerKey);
    if (key !== 0) return key;
    return a.path.localeCompare(b.path);
  });
  undecodable.sort((a, b) => a.ledgerKey.localeCompare(b.ledgerKey));

  return {
    query: queryText,
    filters: {
      contractId: options.contractId,
      durability: options.durability,
      entryType: options.entryType,
      scValType: requestedType,
      ignoreCase: options.ignoreCase ?? false,
    },
    matchCount: matches.length,
    matches,
    undecodable,
    warnings: snapshot.warnings,
  };
}

export function formatStateSearchReport(report: StateSearchReport): string {
  const lines: string[] = [];
  lines.push('=== Soroban Contract State Value Search ===');
  lines.push(`Query: ${report.query}`);
  if (report.matchCount === 0) {
    lines.push('No matches found.');
  } else {
    lines.push(`Matches: ${report.matchCount}`);
    report.matches.forEach((match, index) => {
      lines.push('');
      lines.push(`Match ${index + 1}`);
      lines.push(`  Contract   : ${match.contractId ?? 'unknown'}`);
      lines.push(`  Ledger key : ${match.ledgerKey}`);
      lines.push(`  Entry type : ${match.ledgerEntryType}`);
      lines.push(`  Durability : ${match.durability}`);
      lines.push(`  Path       : ${match.path}`);
      lines.push(`  ScVal type : ${match.scValType}`);
      lines.push(`  Match      : ${renderValue(match.matchedValue)}`);
      if (match.raw) {
        if (match.raw.valueXdr) lines.push(`  Raw value  : ${match.raw.valueXdr}`);
        if (match.raw.matchedValueXdr) lines.push(`  Raw match  : ${match.raw.matchedValueXdr}`);
      }
    });
  }

  if (report.undecodable.length > 0) {
    lines.push('');
    lines.push('Undecodable entries');
    report.undecodable.forEach((entry) => lines.push(`  ${entry.ledgerKey}: ${entry.error}`));
  }
  return lines.join('\n');
}

export function parseStateSearchArgs(args: string[]): StateSearchParams {
  const { positional, flags } = parseCliFlags(args);
  return {
    snapshotFile: positional[0],
    query: positional[1],
    contractId: flagString(flags, 'contract', 'contract-id'),
    durability: parseDurability(flagString(flags, 'durability')),
    entryType: flagString(flags, 'entry-type'),
    scValType: flagString(flags, 'type', 'scval-type'),
    ignoreCase: flagBoolean(flags, 'ignore-case', 'insensitive'),
    json: flagBoolean(flags, 'json'),
    raw: flagBoolean(flags, 'raw'),
  };
}

export async function run(params: StateSearchParams = {}): Promise<void> {
  if (!params.snapshotFile || params.query === undefined) {
    throw new Error(
      'Usage: stellar-api-inspector state-search <snapshot.json> <value> [--ignore-case] [--type <scval-type>] [--contract <id>] [--entry-type <type>] [--durability persistent|temporary] [--raw] [--json]',
    );
  }
  const report = searchStateValues(params.snapshotFile, params.query, params);
  if (params.json) console.log(JSON.stringify(jsonSafe(report), null, 2));
  else console.log(formatStateSearchReport(report));
}
