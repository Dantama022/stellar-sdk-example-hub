import {
  averageBigInt,
  bigintToJson,
  countBy,
  filterStateEntries,
  flagBoolean,
  flagString,
  jsonSafe,
  loadStateSnapshot,
  parseCliFlags,
  parseDurability,
  parseNonNegativeBigIntFlag,
  renderValue,
  type NormalizedStateEntry,
  type StateDurability,
} from '../utils/soroban-state-snapshot';

export interface StateSummaryParams {
  snapshotFile?: string;
  contractId?: string;
  durability?: StateDurability;
  referenceLedger?: bigint;
  ttlWarningThreshold?: bigint;
  longTtlThreshold?: bigint;
  json?: boolean;
}

export interface StateSummaryReport {
  snapshotLedger?: string;
  referenceLedger?: string;
  filters: {
    contractId?: string;
    durability?: StateDurability;
  };
  totalEntries: number;
  entriesWithTtl: number;
  countsByEntryType: Record<string, number>;
  countsByDurability: Record<string, number>;
  scValTypes: Record<string, number>;
  ledgerSequenceRange?: {
    minLastModified?: string;
    maxLastModified?: string;
  };
  ttl: {
    warningThreshold: string;
    longThreshold: string;
    minLiveUntil?: string;
    maxLiveUntil?: string;
    averageLiveUntil?: string;
    minRemaining?: string;
    maxRemaining?: string;
    averageRemaining?: string;
    approachingExpiration: EntryTtlWarning[];
    unusuallyShort: EntryTtlWarning[];
    unusuallyLong: EntryTtlWarning[];
  };
  entries: SummaryEntry[];
  warnings: Array<{ index: number; ledgerKey?: string; message: string }>;
}

export interface EntryTtlWarning {
  ledgerKey: string;
  contractId?: string;
  durability: StateDurability;
  liveUntilLedgerSeq: string;
  remainingLedgers?: string;
}

export interface SummaryEntry {
  ledgerKey: string;
  ledgerEntryType: string;
  contractId?: string;
  durability: StateDurability;
  keyXdr?: string;
  keyDecoded?: unknown;
  valueScValType?: string;
  lastModifiedLedgerSeq?: string;
  liveUntilLedgerSeq?: string;
  decodeErrors: string[];
}

function deriveReferenceLedger(
  entries: NormalizedStateEntry[],
  snapshotLedger?: bigint,
): bigint | undefined {
  if (snapshotLedger !== undefined) return snapshotLedger;
  const modified = entries
    .map((entry) => entry.lastModifiedLedgerSeq)
    .filter((value): value is bigint => value !== undefined);
  if (modified.length === 0) return undefined;
  return modified.reduce((max, value) => (value > max ? value : max), modified[0]);
}

function toWarning(entry: NormalizedStateEntry, referenceLedger?: bigint): EntryTtlWarning {
  const remaining =
    entry.liveUntilLedgerSeq !== undefined && referenceLedger !== undefined
      ? entry.liveUntilLedgerSeq - referenceLedger
      : undefined;
  return {
    ledgerKey: entry.ledgerKey,
    contractId: entry.contractId,
    durability: entry.durability,
    liveUntilLedgerSeq: entry.liveUntilLedgerSeq?.toString() ?? '',
    remainingLedgers: remaining?.toString(),
  };
}

export function buildStateSummary(
  snapshotFile: string,
  options: Omit<StateSummaryParams, 'snapshotFile' | 'json'> = {},
): StateSummaryReport {
  const snapshot = loadStateSnapshot(snapshotFile);
  const entries = filterStateEntries(snapshot.entries, {
    contractId: options.contractId,
    durability: options.durability,
  });

  const referenceLedger =
    options.referenceLedger ?? deriveReferenceLedger(entries, snapshot.ledger);
  const warningThreshold = options.ttlWarningThreshold ?? 1000n;
  const longThreshold = options.longTtlThreshold ?? 1_000_000n;

  const ttlEntries = entries.filter(
    (entry): entry is NormalizedStateEntry & { liveUntilLedgerSeq: bigint } =>
      entry.liveUntilLedgerSeq !== undefined,
  );
  const liveUntilValues = ttlEntries.map((entry) => entry.liveUntilLedgerSeq);
  const remainingValues =
    referenceLedger === undefined ? [] : liveUntilValues.map((value) => value - referenceLedger);

  const approachingExpiration = ttlEntries
    .filter(
      (entry) =>
        referenceLedger !== undefined &&
        entry.liveUntilLedgerSeq >= referenceLedger &&
        entry.liveUntilLedgerSeq - referenceLedger <= warningThreshold,
    )
    .map((entry) => toWarning(entry, referenceLedger));

  const unusuallyShort = approachingExpiration.slice();
  const unusuallyLong = ttlEntries
    .filter(
      (entry) =>
        referenceLedger !== undefined &&
        entry.liveUntilLedgerSeq - referenceLedger >= longThreshold,
    )
    .map((entry) => toWarning(entry, referenceLedger));

  const lastModified = entries
    .map((entry) => entry.lastModifiedLedgerSeq)
    .filter((value): value is bigint => value !== undefined);

  const summaryEntries: SummaryEntry[] = entries.map((entry) => ({
    ledgerKey: entry.ledgerKey,
    ledgerEntryType: entry.ledgerEntryType,
    contractId: entry.contractId,
    durability: entry.durability,
    keyXdr: entry.keyXdr,
    keyDecoded: entry.keyDecoded,
    valueScValType: entry.valueScValType,
    lastModifiedLedgerSeq: bigintToJson(entry.lastModifiedLedgerSeq),
    liveUntilLedgerSeq: bigintToJson(entry.liveUntilLedgerSeq),
    decodeErrors: [...entry.decodeErrors],
  }));

  return {
    snapshotLedger: bigintToJson(snapshot.ledger),
    referenceLedger: bigintToJson(referenceLedger),
    filters: {
      contractId: options.contractId,
      durability: options.durability,
    },
    totalEntries: entries.length,
    entriesWithTtl: ttlEntries.length,
    countsByEntryType: countBy(entries, (entry) => entry.ledgerEntryType),
    countsByDurability: countBy(entries, (entry) => entry.durability),
    scValTypes: countBy(entries, (entry) => entry.valueScValType ?? 'unknown'),
    ledgerSequenceRange:
      lastModified.length === 0
        ? undefined
        : {
            minLastModified: lastModified.reduce((a, b) => (a < b ? a : b)).toString(),
            maxLastModified: lastModified.reduce((a, b) => (a > b ? a : b)).toString(),
          },
    ttl: {
      warningThreshold: warningThreshold.toString(),
      longThreshold: longThreshold.toString(),
      minLiveUntil:
        liveUntilValues.length === 0
          ? undefined
          : liveUntilValues.reduce((a, b) => (a < b ? a : b)).toString(),
      maxLiveUntil:
        liveUntilValues.length === 0
          ? undefined
          : liveUntilValues.reduce((a, b) => (a > b ? a : b)).toString(),
      averageLiveUntil: averageBigInt(liveUntilValues),
      minRemaining:
        remainingValues.length === 0
          ? undefined
          : remainingValues.reduce((a, b) => (a < b ? a : b)).toString(),
      maxRemaining:
        remainingValues.length === 0
          ? undefined
          : remainingValues.reduce((a, b) => (a > b ? a : b)).toString(),
      averageRemaining: averageBigInt(remainingValues),
      approachingExpiration,
      unusuallyShort,
      unusuallyLong,
    },
    entries: summaryEntries,
    warnings: snapshot.warnings,
  };
}

export function formatStateSummary(report: StateSummaryReport): string {
  const lines: string[] = [];
  lines.push('=== Soroban Contract State Snapshot Summary ===');
  lines.push(`Total entries       : ${report.totalEntries}`);
  lines.push(`Entries with TTL    : ${report.entriesWithTtl}`);
  lines.push(`Snapshot ledger     : ${report.snapshotLedger ?? 'unknown'}`);
  lines.push(`Reference ledger    : ${report.referenceLedger ?? 'unknown'}`);
  if (report.filters.contractId) lines.push(`Contract filter     : ${report.filters.contractId}`);
  if (report.filters.durability) lines.push(`Durability filter   : ${report.filters.durability}`);
  lines.push('');

  const printCounts = (title: string, counts: Record<string, number>): void => {
    lines.push(title);
    const rows = Object.entries(counts);
    if (rows.length === 0) lines.push('  (none)');
    rows.forEach(([key, count]) => lines.push(`  ${key}: ${count}`));
    lines.push('');
  };

  printCounts('Entry types', report.countsByEntryType);
  printCounts('Durability', report.countsByDurability);
  printCounts('ScVal value types', report.scValTypes);

  lines.push('TTL statistics');
  lines.push(`  Warning threshold : ${report.ttl.warningThreshold} ledgers`);
  lines.push(`  Long threshold    : ${report.ttl.longThreshold} ledgers`);
  lines.push(`  Min live-until    : ${report.ttl.minLiveUntil ?? 'n/a'}`);
  lines.push(`  Max live-until    : ${report.ttl.maxLiveUntil ?? 'n/a'}`);
  lines.push(`  Average live-until: ${report.ttl.averageLiveUntil ?? 'n/a'}`);
  lines.push(`  Min remaining     : ${report.ttl.minRemaining ?? 'n/a'}`);
  lines.push(`  Max remaining     : ${report.ttl.maxRemaining ?? 'n/a'}`);
  lines.push(`  Average remaining : ${report.ttl.averageRemaining ?? 'n/a'}`);
  lines.push('');

  if (report.ledgerSequenceRange) {
    lines.push('Ledger sequence range');
    lines.push(`  Last modified min : ${report.ledgerSequenceRange.minLastModified ?? 'n/a'}`);
    lines.push(`  Last modified max : ${report.ledgerSequenceRange.maxLastModified ?? 'n/a'}`);
    lines.push('');
  }

  lines.push('Approaching expiration');
  if (report.ttl.approachingExpiration.length === 0) {
    lines.push('  (none)');
  } else {
    report.ttl.approachingExpiration.forEach((entry) => {
      lines.push(
        `  ${entry.ledgerKey} | ${entry.durability} | liveUntil=${entry.liveUntilLedgerSeq}` +
          (entry.remainingLedgers !== undefined ? ` | remaining=${entry.remainingLedgers}` : ''),
      );
    });
  }
  lines.push('');

  lines.push('Entries');
  if (report.entries.length === 0) {
    lines.push('  (none)');
  } else {
    report.entries.forEach((entry) => {
      lines.push(`  Key       : ${entry.ledgerKey}`);
      lines.push(`  Type      : ${entry.ledgerEntryType}`);
      lines.push(`  Contract  : ${entry.contractId ?? 'unknown'}`);
      lines.push(`  Durability: ${entry.durability}`);
      lines.push(`  ScVal type: ${entry.valueScValType ?? 'unknown'}`);
      lines.push(`  Decoded key: ${renderValue(entry.keyDecoded)}`);
      if (entry.keyXdr) lines.push(`  Encoded key: ${entry.keyXdr}`);
      if (entry.lastModifiedLedgerSeq)
        lines.push(`  Last modified: ${entry.lastModifiedLedgerSeq}`);
      if (entry.liveUntilLedgerSeq) lines.push(`  Live until: ${entry.liveUntilLedgerSeq}`);
      if (entry.decodeErrors.length > 0) {
        lines.push(`  Decode warning: ${entry.decodeErrors.join('; ')}`);
      }
      lines.push('');
    });
  }

  if (report.warnings.length > 0) {
    lines.push('Snapshot warnings');
    report.warnings.forEach((warning) => {
      lines.push(
        `  [${warning.index}] ${warning.ledgerKey ?? '(unknown key)'}: ${warning.message}`,
      );
    });
  }

  return lines.join('\n').trimEnd();
}

export function parseStateSummaryArgs(args: string[]): StateSummaryParams {
  const { positional, flags } = parseCliFlags(args);
  return {
    snapshotFile: positional[0],
    contractId: flagString(flags, 'contract', 'contract-id'),
    durability: parseDurability(flagString(flags, 'durability')),
    referenceLedger: parseNonNegativeBigIntFlag(
      flagString(flags, 'reference-ledger'),
      '--reference-ledger',
    ),
    ttlWarningThreshold: parseNonNegativeBigIntFlag(
      flagString(flags, 'ttl-warning'),
      '--ttl-warning',
    ),
    longTtlThreshold: parseNonNegativeBigIntFlag(flagString(flags, 'ttl-long'), '--ttl-long'),
    json: flagBoolean(flags, 'json'),
  };
}

export async function run(params: StateSummaryParams = {}): Promise<void> {
  const snapshotFile = params.snapshotFile;
  if (!snapshotFile) {
    throw new Error(
      'Usage: stellar-api-inspector state-summary <snapshot.json> [--contract <id>] [--durability persistent|temporary] [--reference-ledger <n>] [--ttl-warning <n>] [--ttl-long <n>] [--json]',
    );
  }

  const report = buildStateSummary(snapshotFile, params);
  if (params.json) {
    console.log(JSON.stringify(jsonSafe(report), null, 2));
  } else {
    console.log(formatStateSummary(report));
  }
}
