import { xdr } from '@stellar/stellar-sdk';

export interface FootprintEntry {
  key: string;
  rawXdr: string;
  access: 'read-only' | 'read-write';
}

export interface FootprintSet {
  label: string;
  readOnly: string[];
  readWrite: string[];
  entries: string[];
  metric: {
    totalEntries: number;
    readOnlyCount: number;
    readWriteCount: number;
    uniqueEntries: number;
  };
  rawEntries: FootprintEntry[];
}

export interface PairwiseComparison {
  left: string;
  right: string;
  sharedEntries: string[];
  addedByRight: string[];
  removedFromRight: string[];
  changedAccess: Array<{ key: string; left: string; right: string }>;
  metrics: {
    leftTotal: number;
    rightTotal: number;
    leftReadOnly: number;
    rightReadOnly: number;
    leftReadWrite: number;
    rightReadWrite: number;
    difference: number;
  };
}

export interface FootprintComparisonReport {
  labels: string[];
  sharedEntries: string[];
  addedBySecond: string[];
  removedFromSecond: string[];
  changedAccess: Array<{ key: string; left: string; right: string }>;
  comparisons: PairwiseComparison[];
  smallestFootprint: { label: string; value: number; metric: string };
  byLabel: Record<string, FootprintSet>;
}

interface RunParams {
  inputs?: unknown[];
  json?: boolean;
}

export function normaliseFootprintSet(
  input: Partial<FootprintSet> & { label?: string },
): FootprintSet {
  const label = input.label ?? 'input';
  const readOnly = uniqueStrings(input.readOnly ?? []);
  const readWrite = uniqueStrings(input.readWrite ?? []);
  const entries = uniqueStrings([...readOnly, ...readWrite]);

  return {
    label,
    readOnly,
    readWrite,
    entries,
    metric: {
      totalEntries: entries.length,
      readOnlyCount: readOnly.length,
      readWriteCount: readWrite.length,
      uniqueEntries: entries.length,
    },
    rawEntries: [
      ...readOnly.map((key) => ({ key, rawXdr: `raw:${key}`, access: 'read-only' as const })),
      ...readWrite.map((key) => ({ key, rawXdr: `raw:${key}`, access: 'read-write' as const })),
    ],
  };
}

export function compareFootprintSets(
  footprints: Array<Partial<FootprintSet> & { label?: string }>,
  labels?: string[],
): FootprintComparisonReport {
  const resolvedLabels =
    labels && labels.length === footprints.length
      ? labels
      : footprints.map((_, index) => `Set ${index + 1}`);

  const normalised = footprints.map((entry, index) =>
    normaliseFootprintSet({ ...entry, label: resolvedLabels[index] ?? `Set ${index + 1}` }),
  );

  const first = normalised[0] ?? normaliseFootprintSet({ label: 'A', readOnly: [], readWrite: [] });
  const second = normalised[1] ?? first;

  const comparisons: PairwiseComparison[] = normalised.slice(1).map((set, index) => {
    const left = normalised[index] ?? first;
    const right = set;
    return {
      left: left.label,
      right: right.label,
      sharedEntries: intersection(left.entries, right.entries),
      addedByRight: difference(right.entries, left.entries),
      removedFromRight: difference(left.entries, right.entries),
      changedAccess: computeAccessChanges(left, right),
      metrics: {
        leftTotal: left.metric.totalEntries,
        rightTotal: right.metric.totalEntries,
        leftReadOnly: left.metric.readOnlyCount,
        rightReadOnly: right.metric.readOnlyCount,
        leftReadWrite: left.metric.readWriteCount,
        rightReadWrite: right.metric.readWriteCount,
        difference: right.metric.totalEntries - left.metric.totalEntries,
      },
    };
  });

  const smallestFootprint = normalised.reduce(
    (smallest, current) => {
      if (current.metric.totalEntries < smallest.value) {
        return { label: current.label, value: current.metric.totalEntries, metric: 'totalEntries' };
      }
      return smallest;
    },
    { label: first.label, value: first.metric.totalEntries, metric: 'totalEntries' },
  );

  return {
    labels: resolvedLabels,
    sharedEntries: intersection(...normalised.map((set) => set.entries)),
    addedBySecond: difference(second.entries, first.entries),
    removedFromSecond: difference(first.entries, second.entries),
    changedAccess: computeAccessChanges(first, second),
    comparisons,
    smallestFootprint,
    byLabel: Object.fromEntries(normalised.map((set) => [set.label, set])),
  };
}

export function extractLedgerFootprint(input: unknown, label = 'input'): FootprintSet {
  if (input == null) {
    throw new Error(`No footprint data was supplied for ${label}.`);
  }

  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) {
      throw new Error(`Empty footprint input for ${label}.`);
    }

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return extractLedgerFootprint(JSON.parse(trimmed), label);
      } catch {
        // fall through to XDR parse below
      }
    }

    try {
      const decoded = xdr.LedgerFootprint.fromXDR(trimmed, 'base64');
      return footprintFromLedgerFootprint(decoded, label);
    } catch {
      try {
        const decoded = xdr.SorobanTransactionData.fromXDR(trimmed, 'base64');
        return footprintFromTransactionData(decoded, label);
      } catch {
        return normaliseFootprintSet({ label, readOnly: [], readWrite: [trimmed] });
      }
    }
  }

  if (Array.isArray(input)) {
    return normaliseFootprintSet({
      label,
      readOnly: input
        .filter((item) => typeof item === 'string' && /read-only|readonly/i.test(String(item)))
        .map(String),
      readWrite: input.filter((item) => typeof item === 'string').map(String),
    });
  }

  if (typeof input === 'object') {
    const candidate = input as Record<string, unknown>;

    if (Array.isArray(candidate.readOnly) || Array.isArray(candidate.readWrite)) {
      return normaliseFootprintSet({
        label,
        readOnly: stringsFromValue(candidate.readOnly ?? []),
        readWrite: stringsFromValue(candidate.readWrite ?? []),
      });
    }

    if (candidate.footprint) {
      return extractLedgerFootprint(candidate.footprint, label);
    }

    if (candidate.transactionData) {
      return extractLedgerFootprint(candidate.transactionData, label);
    }

    if (candidate.resources) {
      return extractLedgerFootprint(candidate.resources, label);
    }

    if (candidate.result && typeof candidate.result === 'object') {
      const result = candidate.result as Record<string, unknown>;
      if (result.footprint) {
        return extractLedgerFootprint(result.footprint, label);
      }
    }

    if (candidate.readOnlyEntries || candidate.readWriteEntries) {
      return normaliseFootprintSet({
        label,
        readOnly: stringsFromValue(candidate.readOnlyEntries ?? []),
        readWrite: stringsFromValue(candidate.readWriteEntries ?? []),
      });
    }
  }

  throw new Error(`Could not decode a Soroban ledger footprint from ${label}.`);
}

export function extractFootprintCompareInput(rawInput: unknown, label: string): FootprintSet {
  return extractLedgerFootprint(rawInput, label);
}

function footprintFromLedgerFootprint(footprint: xdr.LedgerFootprint, label: string): FootprintSet {
  const readOnly = footprint.readOnly().map((key) => describeLedgerKey(key));
  const readWrite = footprint.readWrite().map((key) => describeLedgerKey(key));
  return normaliseFootprintSet({ label, readOnly, readWrite });
}

function footprintFromTransactionData(data: xdr.SorobanTransactionData, label: string): FootprintSet {
  return footprintFromLedgerFootprint(data.resources().footprint(), label);
}

function describeLedgerKey(key: xdr.LedgerKey): string {
  try {
    switch (key.switch()) {
      case xdr.LedgerEntryType.contractData(): {
        const data = key.contractData();
        const contract = data.contract().value().toString();
        return `contractData:${contract}:${data.durability().name}:${String(data.key().switch().name)}`;
      }
      case xdr.LedgerEntryType.contractCode():
        return `contractCode:${key.contractCode().hash().toString('hex').slice(0, 16)}`;
      case xdr.LedgerEntryType.account():
        return 'account';
      case xdr.LedgerEntryType.trustline():
        return 'trustline';
      default:
        return key.switch().name;
    }
  } catch {
    return '(undecodable ledger key)';
  }
}

function stringsFromValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry === 'object' && 'key' in (entry as Record<string, unknown>)) {
        return String((entry as Record<string, unknown>).key ?? '');
      }
      return JSON.stringify(entry);
    })
    .filter((entry) => entry.length > 0);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0))];
}

function intersection(...groups: string[][]): string[] {
  if (groups.length === 0) return [];
  const base = new Set(groups[0]);
  for (let i = 1; i < groups.length; i += 1) {
    const next = new Set<string>();
    for (const value of groups[i]) {
      if (base.has(value)) {
        next.add(value);
      }
    }
    base.clear();
    for (const value of next) base.add(value);
  }
  return [...base].sort();
}

function difference(left: string[], right: string[]): string[] {
  return uniqueStrings(left.filter((entry) => !right.includes(entry))).sort();
}

function computeAccessChanges(
  left: FootprintSet,
  right: FootprintSet,
): Array<{ key: string; left: string; right: string }> {
  const keys = uniqueStrings([...left.entries, ...right.entries]);
  const changes: Array<{ key: string; left: string; right: string }> = [];

  for (const key of keys) {
    const leftAccess = left.readOnly.includes(key)
      ? 'read-only'
      : left.readWrite.includes(key)
        ? 'read-write'
        : 'absent';
    const rightAccess = right.readOnly.includes(key)
      ? 'read-only'
      : right.readWrite.includes(key)
        ? 'read-write'
        : 'absent';

    if (leftAccess !== 'absent' && rightAccess !== 'absent' && leftAccess !== rightAccess) {
      changes.push({ key, left: leftAccess, right: rightAccess });
    }
  }

  return changes;
}

export async function run(params: RunParams = {}): Promise<void> {
  const outputJson =
    params.json === true ||
    process.env.OUTPUT_FORMAT === 'json' ||
    process.env.JSON_OUTPUT === 'true' ||
    process.argv.includes('--json');

  const rawInputs = collectFootprintInputs(params);

  if (rawInputs.length < 2) {
    rawInputs.push(
      {
        label: 'A',
        value: {
          readOnly: ['contractData:alpha:instance:0x01', 'contractData:beta:persistent:0x02'],
          readWrite: ['contractData:gamma:persistent:0x03'],
        },
      },
      {
        label: 'B',
        value: {
          readOnly: ['contractData:beta:persistent:0x02', 'contractData:delta:temporary:0x04'],
          readWrite: ['contractData:gamma:persistent:0x03', 'contractData:epsilon:persistent:0x05'],
        },
      },
    );
  }

  const footprints = rawInputs.map((entry, index) =>
    extractLedgerFootprint(entry.value, entry.label ?? `Set ${index + 1}`),
  );
  const comparison = compareFootprintSets(
    footprints,
    rawInputs.map((entry, index) => entry.label ?? `Set ${index + 1}`),
  );

  if (outputJson) {
    console.log(JSON.stringify(comparison, null, 2));
    return;
  }

  console.log('Soroban Transaction Footprint Comparison Example');
  console.log(
    'Compare multiple Soroban invocation results without submitting any transactions, then identify the smaller footprint and the access differences.',
  );

  for (const set of footprints) {
    console.log(
      `- ${set.label}: ${set.metric.totalEntries} total entries (${set.metric.readOnlyCount} read-only, ${set.metric.readWriteCount} read-write)`,
    );
    if (set.readOnly.length > 0) {
      console.log(`  read-only: ${set.readOnly.join(', ')}`);
    }
    if (set.readWrite.length > 0) {
      console.log(`  read-write: ${set.readWrite.join(', ')}`);
    }
  }

  console.log('\nShared entries:');
  if (comparison.sharedEntries.length === 0) {
    console.log('  none');
  } else {
    console.log(`  ${comparison.sharedEntries.join(', ')}`);
  }

  console.log('\nAdded by the second set:');
  if (comparison.addedBySecond.length === 0) {
    console.log('  none');
  } else {
    console.log(`  ${comparison.addedBySecond.join(', ')}`);
  }

  console.log('\nRemoved from the second set:');
  if (comparison.removedFromSecond.length === 0) {
    console.log('  none');
  } else {
    console.log(`  ${comparison.removedFromSecond.join(', ')}`);
  }

  if (comparison.changedAccess.length > 0) {
    console.log('\nAccess-mode changes:');
    for (const change of comparison.changedAccess) {
      console.log(`  ${change.key}: ${change.left} -> ${change.right}`);
    }
  }

  console.log(
    `\nSmallest footprint: ${comparison.smallestFootprint.label} (${comparison.smallestFootprint.value} entries)`,
  );
  console.log(
    'This example only inspects supplied simulation result / XDR data and never submits a Soroban transaction.',
  );
}

function collectFootprintInputs(params: RunParams): Array<{ label: string; value: unknown }> {
  const values = params.inputs && Array.isArray(params.inputs) ? [...params.inputs] : [];
  const envValues = readEnvironmentInputs();

  return [...values, ...envValues].map((entry, index) => {
    if (typeof entry === 'string') {
      return { label: `Set ${index + 1}`, value: entry };
    }
    if (entry && typeof entry === 'object' && 'label' in (entry as Record<string, unknown>)) {
      const record = entry as Record<string, unknown>;
      return { label: String(record.label), value: record.value ?? record };
    }
    return { label: `Set ${index + 1}`, value: entry };
  });
}

function readEnvironmentInputs(): Array<{ label: string; value: unknown }> {
  const inputs: Array<{ label: string; value: unknown }> = [];
  const direct =
    process.env.SOROBAN_FOOTPRINT_INPUTS ??
    process.env.FOOTPRINT_INPUTS ??
    process.env.FOOTPRINT_COMPARE_INPUTS;

  if (direct) {
    try {
      const parsed = JSON.parse(direct);
      if (Array.isArray(parsed)) {
        for (let index = 0; index < parsed.length; index += 1) {
          inputs.push({ label: `Set ${index + 1}`, value: parsed[index] });
        }
      }
    } catch {
      const split = direct
        .split(/\s*,\s*(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)/)
        .filter(Boolean);
      for (let index = 0; index < split.length; index += 1) {
        inputs.push({ label: `Set ${index + 1}`, value: split[index] });
      }
    }
  }

  for (let index = 1; index <= 10; index += 1) {
    const key = `FOOTPRINT_INPUT_${index}`;
    const value = process.env[key];
    if (value) {
      inputs.push({ label: `Set ${index}`, value });
    }
  }

  return inputs;
}
