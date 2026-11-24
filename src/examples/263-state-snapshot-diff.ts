import fs from 'fs';
import path from 'path';

import {
  computeFingerprint,
  ContractStateSnapshot,
  loadContractSnapshot,
  makeJsonSafe,
  SnapshotEntry,
  stableStringify,
} from './262-contract-state-snapshot';

/**
 * State Snapshot Diff
 *
 * Compares two `ContractStateSnapshot` objects produced by
 * `262-contract-state-snapshot` and generates a structured report.
 *
 * The comparison is deterministic: entries are matched by their stable
 * `ledgerKey` identifier, and change classification uses the per-entry SHA-256
 * fingerprint.  Fingerprint equality means the value XDR is unchanged; a
 * differing fingerprint means the value changed.
 *
 * Upgrade-review mode
 * -------------------
 * When `upgradeReview: true` is set in `DiffOptions`, the report additionally:
 *   - Flags changes to the `instance` and `code` entries.
 *   - Accepts an optional `allowlist` of ledger keys whose changes are
 *     expected.
 *   - Lists all unexpected modifications and removals.
 *
 * Important: a detected change does not by itself establish that a contract
 * upgrade caused it.  State can change for many reasons (normal invocations,
 * TTL bumps, independent operations).  This tool reports observations only.
 *
 * Report structure
 * ----------------
 *   contractId          Contract address (must match between snapshots).
 *   network             Network identifier.
 *   baseLedger          Ledger sequence of the baseline snapshot.
 *   compareLedger       Ledger sequence of the comparison snapshot.
 *   baseFingerprint     Top-level fingerprint of the baseline snapshot.
 *   compareFingerprint  Top-level fingerprint of the comparison snapshot.
 *   totalInspected      Total entries considered.
 *   created             Entries present only in the comparison snapshot.
 *   modified            Entries whose value fingerprint changed.
 *   removed             Entries present only in the baseline snapshot.
 *   unchanged           Entries whose fingerprints match.
 *   unverifiable        Entries that cannot be compared (unavailable in both).
 *   upgradeReview       Present when upgradeReview mode was requested.
 *   status              'identical' | 'changed' | 'incompatible'
 */

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export type ChangeKind = 'created' | 'modified' | 'removed' | 'unchanged' | 'unverifiable';

export interface EntryDiff {
  ledgerKey: string;
  kind: ChangeKind;
  role: string;
  durability: string;
  baseFingerprint?: string;
  compareFingerprint?: string;
  /** Present only when both entries were found. */
  baseLedgerKey?: string;
  compareLedgerKey?: string;
}

export interface UpgradeReviewSection {
  instanceChanged: boolean;
  codeChanged: boolean;
  allowlist: string[];
  unexpectedModifications: string[];
  unexpectedRemovals: string[];
}

export type DiffStatus = 'identical' | 'changed' | 'incompatible';

export interface DiffReport {
  contractId: string;
  network: string;
  baseLedger: number;
  compareLedger: number;
  baseFingerprint: string;
  compareFingerprint: string;
  reportFingerprint: string;
  totalInspected: number;
  created: EntryDiff[];
  modified: EntryDiff[];
  removed: EntryDiff[];
  unchanged: EntryDiff[];
  unverifiable: EntryDiff[];
  upgradeReview?: UpgradeReviewSection;
  status: DiffStatus;
}

export interface DiffOptions {
  /** Whether to include upgrade-review analysis. */
  upgradeReview?: boolean;
  /**
   * Ledger keys (base64 XDR) whose changes are considered expected during an
   * upgrade review.  Has no effect when `upgradeReview` is false.
   */
  allowlist?: string[];
  /** File path to write the report JSON to.  Optional. */
  outputFile?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure comparison helpers (exported for tests)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Guard that two snapshots refer to the same contract and network.
 * Throws a descriptive error on mismatch.
 */
export function assertCompatible(
  base: ContractStateSnapshot,
  compare: ContractStateSnapshot,
): void {
  if (base.contractId !== compare.contractId) {
    throw new Error(
      `Contract ID mismatch: baseline is "${base.contractId}", comparison is "${compare.contractId}".`,
    );
  }
  if (base.network !== compare.network) {
    throw new Error(
      `Network mismatch: baseline is "${base.network}", comparison is "${compare.network}".`,
    );
  }
}

/**
 * Classify a single entry pair.
 *
 * Rules:
 *   - Present in compare only → 'created'.
 *   - Present in base only → 'removed'.
 *   - Unavailable in both → 'unverifiable'.
 *   - Fingerprints match → 'unchanged'.
 *   - Fingerprints differ → 'modified'.
 */
export function classifyDiff(
  base: SnapshotEntry | undefined,
  compare: SnapshotEntry | undefined,
): ChangeKind {
  if (!base) return 'created';
  if (!compare) return 'removed';
  if (base.status === 'unavailable' && compare.status === 'unavailable') return 'unverifiable';
  if (base.fingerprint === compare.fingerprint) return 'unchanged';
  return 'modified';
}

/**
 * Build an `EntryDiff` record for a matched or unmatched entry pair.
 */
export function buildEntryDiff(
  ledgerKey: string,
  base: SnapshotEntry | undefined,
  compare: SnapshotEntry | undefined,
): EntryDiff {
  const kind = classifyDiff(base, compare);
  const representative = compare ?? base!;
  return {
    ledgerKey,
    kind,
    role: representative.role,
    durability: representative.durability,
    baseFingerprint: base?.fingerprint,
    compareFingerprint: compare?.fingerprint,
  };
}

/**
 * Compute the full diff between two snapshots.
 * Returns the categorised `EntryDiff` lists plus upgrade-review data if
 * requested.
 */
export function diffSnapshots(
  base: ContractStateSnapshot,
  compare: ContractStateSnapshot,
  options: DiffOptions = {},
): DiffReport {
  assertCompatible(base, compare);

  const baseMap = new Map<string, SnapshotEntry>(base.entries.map((e) => [e.ledgerKey, e]));
  const compareMap = new Map<string, SnapshotEntry>(compare.entries.map((e) => [e.ledgerKey, e]));

  // All unique keys
  const allKeys = new Set<string>([...baseMap.keys(), ...compareMap.keys()]);

  const created: EntryDiff[] = [];
  const modified: EntryDiff[] = [];
  const removed: EntryDiff[] = [];
  const unchanged: EntryDiff[] = [];
  const unverifiable: EntryDiff[] = [];

  for (const key of Array.from(allKeys).sort()) {
    const diff = buildEntryDiff(key, baseMap.get(key), compareMap.get(key));
    switch (diff.kind) {
      case 'created':
        created.push(diff);
        break;
      case 'modified':
        modified.push(diff);
        break;
      case 'removed':
        removed.push(diff);
        break;
      case 'unchanged':
        unchanged.push(diff);
        break;
      case 'unverifiable':
        unverifiable.push(diff);
        break;
    }
  }

  const totalInspected = created.length + modified.length + removed.length + unchanged.length + unverifiable.length;
  const hasChanges = created.length + modified.length + removed.length > 0;

  // Upgrade review
  let upgradeReview: UpgradeReviewSection | undefined;
  if (options.upgradeReview) {
    const allowlistSet = new Set<string>(options.allowlist ?? []);

    const isInstanceChange = (d: EntryDiff) => d.role === 'instance';
    const isCodeChange = (d: EntryDiff) => d.role === 'code';

    const instanceChanged =
      [...modified, ...created, ...removed].some(isInstanceChange);
    const codeChanged =
      [...modified, ...created, ...removed].some(isCodeChange);

    const unexpectedModifications = modified
      .filter((d) => !allowlistSet.has(d.ledgerKey))
      .map((d) => d.ledgerKey);

    const unexpectedRemovals = removed
      .filter((d) => !allowlistSet.has(d.ledgerKey))
      .map((d) => d.ledgerKey);

    upgradeReview = {
      instanceChanged,
      codeChanged,
      allowlist: Array.from(allowlistSet).sort(),
      unexpectedModifications,
      unexpectedRemovals,
    };
  }

  const report: Omit<DiffReport, 'reportFingerprint'> = {
    contractId: base.contractId,
    network: base.network,
    baseLedger: base.ledgerSequence,
    compareLedger: compare.ledgerSequence,
    baseFingerprint: base.fingerprint,
    compareFingerprint: compare.fingerprint,
    totalInspected,
    created,
    modified,
    removed,
    unchanged,
    unverifiable,
    upgradeReview,
    status: hasChanges ? 'changed' : 'identical',
  };

  const full: DiffReport = {
    ...report,
    reportFingerprint: computeFingerprint({
      contractId: report.contractId,
      baseLedger: report.baseLedger,
      compareLedger: report.compareLedger,
      baseFingerprint: report.baseFingerprint,
      compareFingerprint: report.compareFingerprint,
    }),
  };

  return full;
}

// ─────────────────────────────────────────────────────────────────────────────
// File-based interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load two snapshot files, compare them, and optionally write the report.
 */
export function compareSnapshotFiles(
  basePath: string,
  comparePath: string,
  options: DiffOptions = {},
): DiffReport {
  const base = loadContractSnapshot(basePath);
  const compare = loadContractSnapshot(comparePath);
  const report = diffSnapshots(base, compare, options);

  if (options.outputFile) {
    const resolved = path.resolve(options.outputFile);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, stableStringify(makeJsonSafe(report)) + '\n', 'utf8');
  }

  return report;
}

// ─────────────────────────────────────────────────────────────────────────────
// Report rendering
// ─────────────────────────────────────────────────────────────────────────────

export function renderReport(report: DiffReport): string {
  const lines: string[] = [];
  lines.push('=== Contract State Comparison Report ===');
  lines.push(`Contract : ${report.contractId}`);
  lines.push(`Network  : ${report.network}`);
  lines.push(`Ledger   : ${report.baseLedger} → ${report.compareLedger}`);
  lines.push(`Status   : ${report.status.toUpperCase()}`);
  lines.push('');
  lines.push(`Total inspected : ${report.totalInspected}`);
  lines.push(`  Created       : ${report.created.length}`);
  lines.push(`  Modified      : ${report.modified.length}`);
  lines.push(`  Removed       : ${report.removed.length}`);
  lines.push(`  Unchanged     : ${report.unchanged.length}`);
  lines.push(`  Unverifiable  : ${report.unverifiable.length}`);
  lines.push('');
  lines.push(`Base fingerprint    : ${report.baseFingerprint}`);
  lines.push(`Compare fingerprint : ${report.compareFingerprint}`);
  lines.push(`Report fingerprint  : ${report.reportFingerprint}`);

  if (report.upgradeReview) {
    const ur = report.upgradeReview;
    lines.push('');
    lines.push('--- Upgrade Review ---');
    lines.push(`Instance entry changed : ${ur.instanceChanged}`);
    lines.push(`Code entry changed     : ${ur.codeChanged}`);
    if (ur.unexpectedModifications.length > 0) {
      lines.push(`Unexpected modifications (${ur.unexpectedModifications.length}):`);
      ur.unexpectedModifications.forEach((k) => lines.push(`  ${k}`));
    }
    if (ur.unexpectedRemovals.length > 0) {
      lines.push(`Unexpected removals (${ur.unexpectedRemovals.length}):`);
      ur.unexpectedRemovals.forEach((k) => lines.push(`  ${k}`));
    }
    if (ur.unexpectedModifications.length === 0 && ur.unexpectedRemovals.length === 0) {
      lines.push('No unexpected changes detected.');
    }
    lines.push('');
    lines.push(
      'Note: A detected state change does not by itself indicate that a contract',
    );
    lines.push(
      'upgrade caused it.  State changes can result from normal contract invocations',
    );
    lines.push('or other operations unrelated to an upgrade.');
  }

  if (report.created.length > 0) {
    lines.push('');
    lines.push(`--- Created (${report.created.length}) ---`);
    report.created.forEach((d) => lines.push(`  + ${d.ledgerKey}  [${d.role}/${d.durability}]`));
  }
  if (report.modified.length > 0) {
    lines.push('');
    lines.push(`--- Modified (${report.modified.length}) ---`);
    report.modified.forEach((d) =>
      lines.push(`  ~ ${d.ledgerKey}  [${d.role}/${d.durability}]`),
    );
  }
  if (report.removed.length > 0) {
    lines.push('');
    lines.push(`--- Removed (${report.removed.length}) ---`);
    report.removed.forEach((d) => lines.push(`  - ${d.ledgerKey}  [${d.role}/${d.durability}]`));
  }
  if (report.unverifiable.length > 0) {
    lines.push('');
    lines.push(`--- Unverifiable (${report.unverifiable.length}) ---`);
    report.unverifiable.forEach((d) => lines.push(`  ? ${d.ledgerKey}`));
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function run(params: {
  basePath?: string;
  comparePath?: string;
  upgradeReview?: boolean;
  allowlist?: string[];
  outputFile?: string;
  json?: boolean;
} = {}): Promise<DiffReport> {
  const basePath = params.basePath ?? process.argv[3] ?? '';
  const comparePath = params.comparePath ?? process.argv[4] ?? '';

  if (!basePath || !comparePath) {
    throw new Error('Usage: 263-state-snapshot-diff <baseline.json> <comparison.json>');
  }

  const report = compareSnapshotFiles(basePath, comparePath, {
    upgradeReview: params.upgradeReview,
    allowlist: params.allowlist,
    outputFile: params.outputFile,
  });

  if (params.json) {
    console.log(stableStringify(makeJsonSafe(report)));
  } else {
    console.log(renderReport(report));
  }

  return report;
}

if (require.main === module) {
  run({ json: process.argv.includes('--json') }).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
