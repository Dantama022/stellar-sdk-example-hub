import {
  decodeScVal,
  duplicateKeys,
  filterEntries,
  getFlag,
  hasFlag,
  ledgerRelationshipInvalid,
  parseFlags,
  readSnapshotFile,
  representationsConflict,
  stableStringify,
  ttlRelationshipInvalid,
} from '../utils/soroban-state-analysis';
export type FindingCategory =
  | 'structural-error'
  | 'conflicting-observation'
  | 'ttl-inconsistency'
  | 'unsupported-value'
  | 'informational';
export interface Finding {
  category: FindingCategory;
  ledgerKey?: string;
  message: string;
}
export interface CheckOptions {
  snapshotFile?: string;
  contractId?: string;
  strictness?: 'basic' | 'normal' | 'strict';
  json?: boolean;
}
export function buildConsistencyReport(snapshotFile: string, options: CheckOptions = {}) {
  const snapshot = readSnapshotFile(snapshotFile);
  const entries = filterEntries(snapshot.entries, options.contractId);
  const findings: Finding[] = [];
  for (const key of duplicateKeys(entries))
    findings.push({
      category: 'conflicting-observation',
      ledgerKey: key,
      message: 'Duplicate normalized ledger key detected.',
    });
  for (const entry of entries) {
    if (representationsConflict(entry))
      findings.push({
        category: 'conflicting-observation',
        ledgerKey: entry.ledgerKey,
        message: 'Encoded and decoded value representations conflict.',
      });
    if (ttlRelationshipInvalid(entry))
      findings.push({
        category: 'ttl-inconsistency',
        ledgerKey: entry.ledgerKey,
        message: 'liveUntilLedgerSeq is earlier than lastModifiedLedgerSeq.',
      });
    if (ledgerRelationshipInvalid(snapshot, entry))
      findings.push({
        category: 'structural-error',
        ledgerKey: entry.ledgerKey,
        message: 'lastModifiedLedgerSeq is later than snapshot ledger.',
      });
    const d = decodeScVal(entry.valueXdr);
    if (!d.decoded)
      findings.push({
        category: 'unsupported-value',
        ledgerKey: entry.ledgerKey,
        message: d.error ?? 'Value could not be decoded.',
      });
  }
  findings.sort(
    (a, b) =>
      a.category.localeCompare(b.category) ||
      (a.ledgerKey ?? '').localeCompare(b.ledgerKey ?? '') ||
      a.message.localeCompare(b.message),
  );
  const cats: FindingCategory[] = [
    'structural-error',
    'conflicting-observation',
    'ttl-inconsistency',
    'unsupported-value',
    'informational',
  ];
  return {
    strictness: options.strictness ?? 'normal',
    analyzedEntries: entries.length,
    findings,
    counts: Object.fromEntries(
      cats.map((c) => [c, findings.filter((f) => f.category === c).length]),
    ),
  };
}
export function parseStateCheckArgs(args: string[]): CheckOptions {
  const { positional, flags } = parseFlags(args);
  const strictness = (getFlag(flags, 'strictness') ?? 'normal') as CheckOptions['strictness'];
  if (!['basic', 'normal', 'strict'].includes(strictness ?? ''))
    throw new Error('--strictness must be basic, normal, or strict');
  return {
    snapshotFile: positional[0],
    contractId: getFlag(flags, 'contract', 'contract-id'),
    strictness,
    json: hasFlag(flags, 'json'),
  };
}
export async function run(options: CheckOptions = {}) {
  const file = options.snapshotFile ?? process.argv[3];
  if (!file) throw new Error('Missing snapshot file path.');
  const report = buildConsistencyReport(file, options);
  if (options.json) console.log(stableStringify(report));
  else {
    console.log('=== Soroban Contract State Consistency Check ===');
    if (!report.findings.length) console.log('No consistency findings.');
    else
      report.findings.forEach((f) =>
        console.log(`${f.category}: ${f.ledgerKey ?? '(snapshot)'}: ${f.message}`),
      );
  }
  return report;
}
