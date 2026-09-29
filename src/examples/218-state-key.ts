import {
  bigintToJson,
  filterStateEntries,
  flagBoolean,
  flagString,
  jsonSafe,
  loadStateSnapshot,
  normalizeDecodedQuery,
  parseCliFlags,
  parseDurability,
  parseNonNegativeBigIntFlag,
  renderValue,
  stableStringify,
  tryCanonicalLedgerKey,
  type NormalizedStateEntry,
  type StateDurability,
} from '../utils/soroban-state-snapshot';

export interface StateKeyParams {
  snapshotFile?: string;
  key?: string;
  contractId?: string;
  durability?: StateDurability;
  referenceLedger?: bigint;
  json?: boolean;
  raw?: boolean;
}

export interface StateKeyMatch {
  ledgerEntryType: string;
  contractId?: string;
  durability: StateDurability;
  ledgerKey: string;
  keyDecoded?: unknown;
  valueDecoded?: unknown;
  valueScValType?: string;
  lastModifiedLedgerSeq?: string;
  liveUntilLedgerSeq?: string;
  remainingTtl?: string;
  raw?: {
    ledgerKey: string;
    keyXdr?: string;
    valueXdr?: string;
  };
  decodeErrors: string[];
}

export interface StateKeyReport {
  query: string;
  normalizedQuery: string;
  found: boolean;
  ambiguous: boolean;
  matchCount: number;
  matches: StateKeyMatch[];
  warnings: Array<{ index: number; ledgerKey?: string; message: string }>;
}

function decodedKeyMatches(entry: NormalizedStateEntry, query: string): boolean {
  if (entry.keyDecoded === undefined) return false;
  const normalized = normalizeDecodedQuery(query);
  if (typeof normalized === 'bigint') {
    return renderValue(entry.keyDecoded) === normalized.toString();
  }
  if (stableStringify(entry.keyDecoded) === stableStringify(normalized)) return true;
  return renderValue(entry.keyDecoded) === query;
}

function buildMatch(
  entry: NormalizedStateEntry,
  referenceLedger: bigint | undefined,
  raw: boolean,
): StateKeyMatch {
  const remaining =
    referenceLedger !== undefined && entry.liveUntilLedgerSeq !== undefined
      ? entry.liveUntilLedgerSeq - referenceLedger
      : undefined;

  return {
    ledgerEntryType: entry.ledgerEntryType,
    contractId: entry.contractId,
    durability: entry.durability,
    ledgerKey: entry.ledgerKey,
    keyDecoded: entry.keyDecoded,
    valueDecoded: entry.valueDecoded,
    valueScValType: entry.valueScValType,
    lastModifiedLedgerSeq: bigintToJson(entry.lastModifiedLedgerSeq),
    liveUntilLedgerSeq: bigintToJson(entry.liveUntilLedgerSeq),
    remainingTtl: bigintToJson(remaining),
    raw: raw
      ? {
          ledgerKey: entry.ledgerKey,
          keyXdr: entry.keyXdr,
          valueXdr: entry.valueXdr,
        }
      : undefined,
    decodeErrors: [...entry.decodeErrors],
  };
}

export function queryStateKey(
  snapshotFile: string,
  query: string,
  options: Omit<StateKeyParams, 'snapshotFile' | 'key' | 'json'> = {},
): StateKeyReport {
  const snapshot = loadStateSnapshot(snapshotFile);
  const filtered = filterStateEntries(snapshot.entries, {
    contractId: options.contractId,
    durability: options.durability,
  });

  const canonical = tryCanonicalLedgerKey(query);
  const normalizedQuery = canonical ?? stableStringify(normalizeDecodedQuery(query));

  const matches = filtered.filter((entry) => {
    if (entry.ledgerKey === query || entry.canonicalLedgerKey === query) return true;
    if (canonical && entry.canonicalLedgerKey === canonical) return true;
    if (entry.keyXdr === query) return true;
    return decodedKeyMatches(entry, query);
  });

  const referenceLedger = options.referenceLedger ?? snapshot.ledger;
  const resultMatches = matches.map((entry) =>
    buildMatch(entry, referenceLedger, options.raw ?? false),
  );

  return {
    query,
    normalizedQuery,
    found: resultMatches.length > 0,
    ambiguous: resultMatches.length > 1,
    matchCount: resultMatches.length,
    matches: resultMatches,
    warnings: snapshot.warnings,
  };
}

export function formatStateKeyReport(report: StateKeyReport): string {
  const lines: string[] = [];
  lines.push('=== Soroban Contract State Key Query ===');
  lines.push(`Query: ${report.query}`);
  if (!report.found) {
    lines.push('Result: not found');
    return lines.join('\n');
  }

  lines.push(`Matches: ${report.matchCount}${report.ambiguous ? ' (ambiguous)' : ''}`);
  report.matches.forEach((match, index) => {
    lines.push('');
    lines.push(`Match ${index + 1}`);
    lines.push(`  Ledger entry type : ${match.ledgerEntryType}`);
    lines.push(`  Contract ID       : ${match.contractId ?? 'unknown'}`);
    lines.push(`  Durability        : ${match.durability}`);
    lines.push(`  Key               : ${renderValue(match.keyDecoded)}`);
    lines.push(`  Value             : ${renderValue(match.valueDecoded)}`);
    lines.push(`  ScVal type        : ${match.valueScValType ?? 'unknown'}`);
    lines.push(`  Last modified     : ${match.lastModifiedLedgerSeq ?? 'unknown'}`);
    lines.push(`  Live until        : ${match.liveUntilLedgerSeq ?? 'unknown'}`);
    lines.push(`  Remaining TTL     : ${match.remainingTtl ?? 'unknown'}`);
    if (match.raw) {
      lines.push(`  Raw ledger key    : ${match.raw.ledgerKey}`);
      if (match.raw.keyXdr) lines.push(`  Raw key ScVal     : ${match.raw.keyXdr}`);
      if (match.raw.valueXdr) lines.push(`  Raw value ScVal   : ${match.raw.valueXdr}`);
    }
    if (match.decodeErrors.length > 0) {
      lines.push(`  Decode warnings   : ${match.decodeErrors.join('; ')}`);
    }
  });

  return lines.join('\n');
}

export function parseStateKeyArgs(args: string[]): StateKeyParams {
  const { positional, flags } = parseCliFlags(args);
  return {
    snapshotFile: positional[0],
    key: positional[1],
    contractId: flagString(flags, 'contract', 'contract-id'),
    durability: parseDurability(flagString(flags, 'durability')),
    referenceLedger: parseNonNegativeBigIntFlag(
      flagString(flags, 'reference-ledger'),
      '--reference-ledger',
    ),
    json: flagBoolean(flags, 'json'),
    raw: flagBoolean(flags, 'raw'),
  };
}

export async function run(params: StateKeyParams = {}): Promise<void> {
  if (!params.snapshotFile || !params.key) {
    throw new Error(
      'Usage: stellar-api-inspector state-key <snapshot.json> <key> [--contract <id>] [--durability persistent|temporary] [--reference-ledger <n>] [--raw] [--json]',
    );
  }

  const report = queryStateKey(params.snapshotFile, params.key, params);
  if (params.json) {
    console.log(JSON.stringify(jsonSafe(report), null, 2));
  } else {
    console.log(formatStateKeyReport(report));
  }
}
