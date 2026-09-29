import {
  decodeScVal,
  filterEntries,
  getFlag,
  hasFlag,
  inferSchema,
  parseFlags,
  positiveInt,
  readSnapshotFile,
  stableStringify,
} from '../utils/soroban-state-analysis';
export interface SchemaOptions {
  snapshotFile?: string;
  contractId?: string;
  durability?: string;
  maxDepth?: number;
  json?: boolean;
}
export function buildSchemaReport(snapshotFile: string, options: SchemaOptions = {}) {
  const snapshot = readSnapshotFile(snapshotFile);
  const entries = filterEntries(snapshot.entries, options.contractId, options.durability);
  const rows = entries.map((entry) => ({ entry, result: decodeScVal(entry.valueXdr) }));
  const usable = rows.filter((r) => r.result.decoded && r.result.value !== undefined);
  const values = usable.map((r) => r.result.value);
  const schema = inferSchema(values, options.maxDepth ?? 10);
  return {
    authoritative: false,
    basis: 'observed snapshot values only',
    observedEntryCount: entries.length,
    decodedEntryCount: usable.length,
    schema,
    observedLedgerKeys: usable.map((r) => r.entry.ledgerKey).sort(),
    observations: usable
      .map((r) => ({
        ledgerKey: r.entry.ledgerKey,
        contractId: r.entry.contractId,
        durability: r.entry.durability,
        observedType: r.result.type,
      }))
      .sort((a, b) => a.ledgerKey.localeCompare(b.ledgerKey)),
    ambiguousObservations: schema.conflicts ?? [],
    undecodable: rows
      .filter((r) => !r.result.decoded)
      .map((r) => ({ ledgerKey: r.entry.ledgerKey, error: r.result.error }))
      .sort((a, b) => a.ledgerKey.localeCompare(b.ledgerKey)),
  };
}
export function parseStateSchemaArgs(args: string[]): SchemaOptions {
  const { positional, flags } = parseFlags(args);
  return {
    snapshotFile: positional[0],
    contractId: getFlag(flags, 'contract', 'contract-id'),
    durability: getFlag(flags, 'durability'),
    maxDepth: positiveInt(getFlag(flags, 'max-depth'), 'max-depth', 10),
    json: hasFlag(flags, 'json'),
  };
}
export async function run(options: SchemaOptions = {}) {
  const file = options.snapshotFile ?? process.argv[3];
  if (!file) throw new Error('Missing snapshot file path.');
  const report = buildSchemaReport(file, options);
  if (options.json) console.log(stableStringify(report));
  else {
    console.log('=== Soroban Contract State Schema Inference ===');
    console.log(
      'NOTE: inferred from observed snapshot values; not authoritative contract metadata.',
    );
    console.log(stableStringify(report.schema));
  }
  return report;
}
