import * as fs from 'fs';
import * as path from 'path';
import {
  ContractStateSnapshot,
  SnapshotCompatibilityError,
  SnapshotDurability,
  SnapshotEntry,
  SnapshotEntryType,
  SnapshotValidationError,
  UnavailableSnapshotEntry,
} from './contract-state-snapshot';

/**
 * ISSUE-417: comparing two Soroban contract state snapshots.
 *
 * The comparison is intentionally conservative:
 *   - entries are matched by a stable key ID (hash of canonical ledger key XDR)
 *   - fingerprints decide content changes; metadata is compared separately
 *   - entries that could not be normalized, or were unavailable on either side,
 *     are reported as unverifiable instead of guessed as created/removed
 *   - an allowlist classifies observed changes as expected or unexpected; it
 *     never claims that an upgrade caused them
 */

export type ChangeKind = 'created' | 'modified' | 'removed';

export interface EntryChange {
  kind: ChangeKind;
  keyId: string;
  entryType: SnapshotEntryType;
  durability: SnapshotDurability;
  ledgerEntryType: string;
  keyLabel?: string;
  keyDecoded?: unknown;
  baselineFingerprint?: string;
  comparisonFingerprint?: string;
  contentChanged: boolean;
  metadataChanges: string[];
  expected: boolean;
  expectedReason?: string;
}

export interface UnverifiableEntry {
  keyId: string;
  entryType?: SnapshotEntryType;
  keyLabel?: string;
  baselineStatus: 'present' | 'unavailable' | 'missing';
  comparisonStatus: 'present' | 'unavailable' | 'missing';
  reason: string;
}

export interface ExpectedChangeRule {
  change: ChangeKind | 'any';
  entryType?: SnapshotEntryType;
  durability?: SnapshotDurability;
  keyId?: string;
  key?: string;
  fingerprint?: string;
  reason?: string;
}

export interface UpgradeReviewSummary {
  enabled: boolean;
  instanceChanged: boolean;
  wasmChanged: boolean;
  wasmHashBefore?: string;
  wasmHashAfter?: string;
  storageChanges: number;
  notes: string[];
}

export interface SnapshotComparisonCounts {
  baselineEntries: number;
  comparisonEntries: number;
  uniqueKeys: number;
  created: number;
  modified: number;
  removed: number;
  unchanged: number;
  metadataOnly: number;
  unverifiable: number;
  expected: number;
  unexpected: number;
}

export type ComparisonStatus =
  | 'identical'
  | 'changed'
  | 'expected-changes-only'
  | 'unexpected-changes'
  | 'incomplete';

export interface SnapshotComparison {
  contractId: string;
  networkId: string;
  networkPassphrase: string;
  baselineLedger: number;
  comparisonLedger: number;
  baselineFingerprint: string;
  comparisonFingerprint: string;
  counts: SnapshotComparisonCounts;
  status: ComparisonStatus;
  created: EntryChange[];
  modified: EntryChange[];
  removed: EntryChange[];
  unchanged: SnapshotEntry[];
  metadataOnly: EntryChange[];
  unverifiable: UnverifiableEntry[];
  expectedChanges: EntryChange[];
  unexpectedChanges: EntryChange[];
  allowlistSupplied: boolean;
  upgradeReview: UpgradeReviewSummary;
  warnings: string[];
  assumptions: string[];
}

export interface CompareSnapshotsOptions {
  upgradeReview?: boolean;
  expectedChanges?: ExpectedChangeRule[];
}

function requireCompatible(
  baseline: ContractStateSnapshot,
  comparison: ContractStateSnapshot,
): void {
  if (baseline.contractId !== comparison.contractId) {
    throw new SnapshotCompatibilityError(
      `Cannot compare snapshots from different contracts: baseline ${baseline.contractId}, ` +
        `comparison ${comparison.contractId}.`,
    );
  }
  if (
    baseline.network.id !== comparison.network.id ||
    baseline.network.passphrase !== comparison.network.passphrase
  ) {
    throw new SnapshotCompatibilityError(
      `Cannot compare snapshots from different networks: baseline ${baseline.network.id} ` +
        `(${baseline.network.passphrase}), comparison ${comparison.network.id} ` +
        `(${comparison.network.passphrase}).`,
    );
  }
}

function keysById(entries: SnapshotEntry[]): Map<string, SnapshotEntry> {
  return new Map(entries.map((entry) => [entry.keyId, entry]));
}

function unavailableById(snapshot: ContractStateSnapshot): Map<string, UnavailableSnapshotEntry> {
  return new Map(snapshot.unavailable.map((entry) => [entry.keyId, entry]));
}

/**
 * A `not-found` response is treated as observed absence so a genuinely new key
 * can be reported as created. Archived entries and RPC failures are not: those
 * cannot be compared reliably.
 */
function isHardUnavailable(
  unavailable: Map<string, UnavailableSnapshotEntry>,
  keyId: string,
): boolean {
  const entry = unavailable.get(keyId);
  return entry !== undefined && entry.reason !== 'not-found';
}

function metadataChanges(baseline: SnapshotEntry, comparison: SnapshotEntry): string[] {
  const changes: string[] = [];
  const compare = (field: string, left: unknown, right: unknown): void => {
    if (left !== right) changes.push(`${field}: ${String(left)} -> ${String(right)}`);
  };
  compare('ledgerEntryType', baseline.ledgerEntryType, comparison.ledgerEntryType);
  compare('durability', baseline.durability, comparison.durability);
  compare('sizeBytes', baseline.sizeBytes, comparison.sizeBytes);
  compare(
    'lastModifiedLedgerSeq',
    baseline.lastModifiedLedgerSeq,
    comparison.lastModifiedLedgerSeq,
  );
  compare('liveUntilLedgerSeq', baseline.liveUntilLedgerSeq, comparison.liveUntilLedgerSeq);
  return changes;
}

function matchesRule(change: EntryChange, rule: ExpectedChangeRule): boolean {
  if (rule.change !== 'any' && rule.change !== change.kind) return false;
  if (rule.entryType && rule.entryType !== change.entryType) return false;
  if (rule.durability && rule.durability !== change.durability) return false;
  if (rule.keyId && rule.keyId !== change.keyId) return false;
  if (rule.fingerprint) {
    if (
      rule.fingerprint !== change.baselineFingerprint &&
      rule.fingerprint !== change.comparisonFingerprint
    ) {
      return false;
    }
  }
  if (rule.key) {
    const decoded =
      change.keyDecoded === undefined
        ? ''
        : typeof change.keyDecoded === 'string'
          ? change.keyDecoded
          : JSON.stringify(change.keyDecoded);
    const candidates = [change.keyLabel, decoded]
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toLowerCase());
    if (!candidates.includes(rule.key.toLowerCase())) return false;
  }
  return true;
}

function changeFromEntry(
  kind: ChangeKind,
  entry: SnapshotEntry,
  baseline?: SnapshotEntry,
): EntryChange {
  return {
    kind,
    keyId: entry.keyId,
    entryType: entry.entryType,
    durability: entry.durability,
    ledgerEntryType: entry.ledgerEntryType,
    keyLabel: entry.keyLabel,
    keyDecoded: entry.keyDecoded,
    baselineFingerprint: kind === 'removed' ? entry.fingerprint : baseline?.fingerprint,
    comparisonFingerprint: kind === 'removed' ? undefined : entry.fingerprint,
    contentChanged: kind === 'modified',
    metadataChanges: baseline ? metadataChanges(baseline, entry) : [],
    expected: false,
  };
}

function describeUnverifiable(
  keyId: string,
  baseline: SnapshotEntry | undefined,
  comparison: SnapshotEntry | undefined,
  baselineUnavailable: Map<string, UnavailableSnapshotEntry>,
  comparisonUnavailable: Map<string, UnavailableSnapshotEntry>,
): UnverifiableEntry {
  const base = baseline ?? comparison;
  const baselineStatus = baseline
    ? 'present'
    : baselineUnavailable.has(keyId)
      ? 'unavailable'
      : 'missing';
  const comparisonStatus = comparison
    ? 'present'
    : comparisonUnavailable.has(keyId)
      ? 'unavailable'
      : 'missing';

  const reasons: string[] = [];
  const baselineEntry = baselineUnavailable.get(keyId);
  const comparisonEntry = comparisonUnavailable.get(keyId);
  if (baselineEntry) {
    reasons.push(
      `baseline ${baselineEntry.label} unavailable (${baselineEntry.reason}): ${baselineEntry.message}`,
    );
  }
  if (comparisonEntry) {
    reasons.push(
      `comparison ${comparisonEntry.label} unavailable (${comparisonEntry.reason}): ${comparisonEntry.message}`,
    );
  }
  if (baseline && !baseline.comparable) {
    reasons.push(`baseline entry is not comparable (${baseline.decodeErrors.join('; ')})`);
  }
  if (comparison && !comparison.comparable) {
    reasons.push(`comparison entry is not comparable (${comparison.decodeErrors.join('; ')})`);
  }
  if (reasons.length === 0) reasons.push('entry could not be compared reliably');

  return {
    keyId,
    entryType: base?.entryType,
    keyLabel: base?.keyLabel,
    baselineStatus,
    comparisonStatus,
    reason: reasons.join('; '),
  };
}

/**
 * Compare two validated, compatible snapshots. Throws
 * SnapshotCompatibilityError for contract or network mismatches.
 */
export function compareSnapshots(
  baseline: ContractStateSnapshot,
  comparison: ContractStateSnapshot,
  options: CompareSnapshotsOptions = {},
): SnapshotComparison {
  requireCompatible(baseline, comparison);

  const warnings: string[] = [];
  if (comparison.ledger < baseline.ledger) {
    warnings.push(
      `The comparison snapshot (ledger ${comparison.ledger}) is older than the baseline ` +
        `(ledger ${baseline.ledger}). Created/removed directions follow snapshot order.`,
    );
  }

  const baselineById = keysById(baseline.entries);
  const comparisonById = keysById(comparison.entries);
  const baselineUnavailable = unavailableById(baseline);
  const comparisonUnavailable = unavailableById(comparison);

  const allKeys = Array.from(
    new Set([
      ...baselineById.keys(),
      ...comparisonById.keys(),
      ...baselineUnavailable.keys(),
      ...comparisonUnavailable.keys(),
    ]),
  ).sort();

  const created: EntryChange[] = [];
  const modified: EntryChange[] = [];
  const removed: EntryChange[] = [];
  const unchanged: SnapshotEntry[] = [];
  const metadataOnly: EntryChange[] = [];
  const unverifiable: UnverifiableEntry[] = [];

  for (const keyId of allKeys) {
    const before = baselineById.get(keyId);
    const after = comparisonById.get(keyId);

    if (before && after) {
      if (!before.comparable || !after.comparable) {
        unverifiable.push(
          describeUnverifiable(keyId, before, after, baselineUnavailable, comparisonUnavailable),
        );
        continue;
      }

      const meta = metadataChanges(before, after);
      if (before.fingerprint !== after.fingerprint) {
        const change = changeFromEntry('modified', after, before);
        change.metadataChanges = meta;
        modified.push(change);
      } else if (meta.length > 0) {
        const change = changeFromEntry('modified', after, before);
        change.contentChanged = false;
        metadataOnly.push(change);
      } else {
        unchanged.push(before);
      }
      continue;
    }

    if (after) {
      if (!after.comparable || isHardUnavailable(baselineUnavailable, keyId)) {
        unverifiable.push(
          describeUnverifiable(keyId, undefined, after, baselineUnavailable, comparisonUnavailable),
        );
        continue;
      }
      const baselineGap = baselineUnavailable.get(keyId);
      if (baselineGap) {
        warnings.push(
          `Key ${after.keyLabel ?? keyId.slice(0, 12)} was not found in the baseline and is ` +
            'reported as created. A not-found response cannot distinguish a key that never ' +
            'existed from one the provider could not serve.',
        );
      }
      created.push(changeFromEntry('created', after));
      continue;
    }

    if (before) {
      if (!before.comparable || isHardUnavailable(comparisonUnavailable, keyId)) {
        unverifiable.push(
          describeUnverifiable(
            keyId,
            before,
            undefined,
            baselineUnavailable,
            comparisonUnavailable,
          ),
        );
        continue;
      }
      const comparisonGap = comparisonUnavailable.get(keyId);
      if (comparisonGap) {
        warnings.push(
          `Key ${before.keyLabel ?? keyId.slice(0, 12)} was not found in the comparison and is ` +
            'reported as removed. A not-found response cannot distinguish a deleted key from ' +
            'one the provider could not serve.',
        );
      }
      removed.push(changeFromEntry('removed', before));
    }
  }

  const sortChanges = (changes: EntryChange[]): EntryChange[] =>
    changes.sort(
      (a, b) => a.entryType.localeCompare(b.entryType) || a.keyId.localeCompare(b.keyId),
    );
  sortChanges(created);
  sortChanges(modified);
  sortChanges(removed);
  sortChanges(metadataOnly);
  unchanged.sort((a, b) => a.keyId.localeCompare(b.keyId));

  const allChanges = [...created, ...modified, ...removed];
  const allowlist = options.expectedChanges ?? [];
  for (const change of allChanges) {
    const rule = allowlist.find((candidate) => matchesRule(change, candidate));
    if (rule) {
      change.expected = true;
      change.expectedReason = rule.reason;
    }
  }

  const expectedChanges = allChanges.filter((change) => change.expected);
  const unexpectedChanges = allChanges.filter((change) => !change.expected);

  const instanceChanges = allChanges.filter((change) => change.entryType === 'instance');
  const wasmChanged =
    baseline.wasmHash !== comparison.wasmHash &&
    (baseline.wasmHash !== undefined || comparison.wasmHash !== undefined);

  const upgradeReview: UpgradeReviewSummary = {
    enabled: Boolean(options.upgradeReview),
    instanceChanged: instanceChanges.length > 0,
    wasmChanged,
    wasmHashBefore: baseline.wasmHash,
    wasmHashAfter: comparison.wasmHash,
    storageChanges: allChanges.filter((change) => change.entryType !== 'instance').length,
    notes: [
      'Observed state changes are facts about the two snapshots; they do not by themselves ' +
        'establish that a contract upgrade caused them.',
    ],
  };
  if (!upgradeReview.enabled) {
    upgradeReview.notes.push(
      'Upgrade review was not requested; changes are reported as observations only.',
    );
  }

  const status: ComparisonStatus =
    unverifiable.length > 0
      ? 'incomplete'
      : allChanges.length === 0
        ? metadataOnly.length > 0
          ? 'changed'
          : 'identical'
        : allowlist.length > 0
          ? unexpectedChanges.length > 0
            ? 'unexpected-changes'
            : 'expected-changes-only'
          : 'changed';

  return {
    contractId: baseline.contractId,
    networkId: baseline.network.id,
    networkPassphrase: baseline.network.passphrase,
    baselineLedger: baseline.ledger,
    comparisonLedger: comparison.ledger,
    baselineFingerprint: baseline.snapshotFingerprint,
    comparisonFingerprint: comparison.snapshotFingerprint,
    counts: {
      baselineEntries: baseline.entries.length,
      comparisonEntries: comparison.entries.length,
      uniqueKeys: allKeys.length,
      created: created.length,
      modified: modified.length,
      removed: removed.length,
      unchanged: unchanged.length,
      metadataOnly: metadataOnly.length,
      unverifiable: unverifiable.length,
      expected: expectedChanges.length,
      unexpected: unexpectedChanges.length,
    },
    status,
    created,
    modified,
    removed,
    unchanged,
    metadataOnly,
    unverifiable,
    expectedChanges,
    unexpectedChanges,
    allowlistSupplied: allowlist.length > 0,
    upgradeReview,
    warnings,
    assumptions: [
      'Entries are matched by the hash of their canonical ledger-key XDR.',
      'A not-found entry is treated as an observed absence so created/removed changes can be ' +
        'reported; archived entries and RPC failures are reported as unverifiable.',
      'Soroban RPC reads current ledger state only, so snapshots must be captured at the ' +
        'times being compared.',
    ],
  };
}

function formatChange(change: EntryChange): string[] {
  const lines = [
    `  ${change.kind.toUpperCase().padEnd(9)} ${change.entryType.padEnd(12)} ${
      change.keyLabel ? `key=${change.keyLabel} ` : ''
    }keyId=${change.keyId.slice(0, 16)}`,
    `    fingerprint: ${change.baselineFingerprint?.slice(0, 16) ?? '(none)'} -> ${
      change.comparisonFingerprint?.slice(0, 16) ?? '(none)'
    }`,
  ];
  for (const metadata of change.metadataChanges) {
    lines.push(`    metadata   : ${metadata}`);
  }
  if (change.expected) {
    lines.push(`    expected   : ${change.expectedReason ?? 'matched allowlist'}`);
  }
  return lines;
}

/**
 * Human-readable comparison report. It includes every field required by the
 * issue and keeps observed changes separate from causal assumptions.
 */
export function formatComparisonReport(report: SnapshotComparison): string {
  const lines: string[] = [];
  const statusLabel = report.status.replace(/-/g, ' ').toUpperCase();

  lines.push('=== Soroban Contract State Comparison ===');
  lines.push(`Contract ID            : ${report.contractId}`);
  lines.push(`Network                : ${report.networkId}`);
  lines.push(`Network passphrase     : ${report.networkPassphrase}`);
  lines.push(`Baseline ledger        : ${report.baselineLedger}`);
  lines.push(`Comparison ledger      : ${report.comparisonLedger}`);
  lines.push(`Baseline fingerprint   : ${report.baselineFingerprint}`);
  lines.push(`Comparison fingerprint : ${report.comparisonFingerprint}`);
  lines.push(`Overall status         : ${statusLabel}`);
  lines.push('');
  lines.push(
    `Entries inspected      : ${report.counts.baselineEntries} baseline / ` +
      `${report.counts.comparisonEntries} comparison / ${report.counts.uniqueKeys} unique keys`,
  );
  lines.push(`Created                : ${report.counts.created}`);
  lines.push(`Modified               : ${report.counts.modified}`);
  lines.push(`Removed                : ${report.counts.removed}`);
  lines.push(`Unchanged              : ${report.counts.unchanged}`);
  lines.push(`Metadata-only changes  : ${report.counts.metadataOnly}`);
  lines.push(`Unverifiable           : ${report.counts.unverifiable}`);
  lines.push(`Expected changes       : ${report.counts.expected}`);
  lines.push(`Unexpected changes     : ${report.counts.unexpected}`);
  lines.push('');

  const review = report.upgradeReview;
  lines.push('Upgrade review');
  lines.push(`  Enabled             : ${review.enabled ? 'yes' : 'no'}`);
  lines.push(`  Contract instance   : ${review.instanceChanged ? 'changed' : 'unchanged'}`);
  lines.push(
    `  WASM reference      : ${
      review.wasmChanged
        ? `changed (${review.wasmHashBefore ?? 'none'} -> ${review.wasmHashAfter ?? 'none'})`
        : 'unchanged'
    }`,
  );
  lines.push(`  Storage changes     : ${review.storageChanges}`);
  for (const note of review.notes) lines.push(`  Note: ${note}`);
  lines.push('');

  const sections: Array<[string, EntryChange[]]> = [
    ['Created entries', report.created],
    ['Modified entries', report.modified],
    ['Removed entries', report.removed],
    ['Metadata-only changes', report.metadataOnly],
  ];
  for (const [title, changes] of sections) {
    if (changes.length === 0) continue;
    lines.push(title);
    changes.forEach((change) => lines.push(...formatChange(change)));
    lines.push('');
  }

  if (report.unverifiable.length > 0) {
    lines.push('Unverifiable entries');
    for (const entry of report.unverifiable) {
      lines.push(
        `  ${entry.keyId.slice(0, 16)} ${entry.entryType ?? 'unknown'} ` +
          `(baseline: ${entry.baselineStatus}, comparison: ${entry.comparisonStatus})`,
      );
      lines.push(`    reason: ${entry.reason}`);
    }
    lines.push('');
  }

  if (report.unexpectedChanges.length > 0) {
    lines.push('Unexpected changes (not covered by the allowlist)');
    report.unexpectedChanges.forEach((change) => lines.push(...formatChange(change)));
    lines.push('');
  }

  if (report.warnings.length > 0) {
    lines.push('Warnings');
    report.warnings.forEach((warning) => lines.push(`  - ${warning}`));
    lines.push('');
  }

  lines.push('Assumptions and limits');
  report.assumptions.forEach((assumption) => lines.push(`  - ${assumption}`));
  lines.push(
    '  - A detected state change does not by itself establish that a contract upgrade caused it.',
  );

  return lines.join('\n').trimEnd();
}

function validEntryType(value: unknown): value is SnapshotEntryType {
  return (
    value === 'instance' ||
    value === 'persistent' ||
    value === 'temporary' ||
    value === 'contractCode' ||
    value === 'other'
  );
}

function validDurability(value: unknown): value is SnapshotDurability {
  return (
    value === 'instance' || value === 'persistent' || value === 'temporary' || value === 'unknown'
  );
}

/**
 * Parse and validate an expected-change allowlist. Accepted shapes:
 *   [ { "change": "modified", "key": "COUNTER", "reason": "..." } ]
 *   { "expectedChanges": [ ... ] }
 */
export function parseExpectedChanges(raw: unknown): ExpectedChangeRule[] {
  const list = Array.isArray(raw)
    ? raw
    : raw &&
        typeof raw === 'object' &&
        Array.isArray((raw as { expectedChanges?: unknown }).expectedChanges)
      ? (raw as { expectedChanges: unknown[] }).expectedChanges
      : undefined;

  if (!list) {
    throw new SnapshotValidationError(
      'Expected-change rules must be an array, or an object with an expectedChanges array.',
    );
  }

  return list.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new SnapshotValidationError(`expectedChanges[${index}] must be an object.`);
    }
    const rule = entry as Record<string, unknown>;
    const change = rule.change ?? 'any';
    if (change !== 'created' && change !== 'modified' && change !== 'removed' && change !== 'any') {
      throw new SnapshotValidationError(
        `expectedChanges[${index}].change must be created, modified, removed or any.`,
      );
    }
    if (rule.entryType !== undefined && !validEntryType(rule.entryType)) {
      throw new SnapshotValidationError(
        `expectedChanges[${index}].entryType is not a recognized entry type.`,
      );
    }
    if (rule.durability !== undefined && !validDurability(rule.durability)) {
      throw new SnapshotValidationError(
        `expectedChanges[${index}].durability is not a recognized durability.`,
      );
    }
    if (rule.keyId !== undefined && !/^[0-9a-f]{64}$/.test(String(rule.keyId))) {
      throw new SnapshotValidationError(
        `expectedChanges[${index}].keyId must be 64 lowercase hex characters.`,
      );
    }
    if (rule.key !== undefined && typeof rule.key !== 'string') {
      throw new SnapshotValidationError(`expectedChanges[${index}].key must be a string.`);
    }
    if (rule.fingerprint !== undefined && !/^[0-9a-f]{64}$/.test(String(rule.fingerprint))) {
      throw new SnapshotValidationError(
        `expectedChanges[${index}].fingerprint must be 64 lowercase hex characters.`,
      );
    }
    if (rule.reason !== undefined && typeof rule.reason !== 'string') {
      throw new SnapshotValidationError(`expectedChanges[${index}].reason must be a string.`);
    }

    return {
      change: change as ExpectedChangeRule['change'],
      entryType: rule.entryType as SnapshotEntryType | undefined,
      durability: rule.durability as SnapshotDurability | undefined,
      keyId: rule.keyId as string | undefined,
      key: rule.key as string | undefined,
      fingerprint: rule.fingerprint as string | undefined,
      reason: rule.reason as string | undefined,
    };
  });
}

export function loadExpectedChangesFile(filePath: string): ExpectedChangeRule[] {
  const resolved = path.resolve(filePath);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error: unknown) {
    throw new SnapshotValidationError(
      `Cannot load expected-change allowlist "${filePath}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return parseExpectedChanges(raw);
}
