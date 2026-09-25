import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

/**
 * Example 197: Soroban Contract State Entry Lifecycle Analysis
 *
 * Soroban contract-data entries carry observable properties: the ledger at
 * which they were last modified, their durability (persistent / temporary),
 * and their TTL (liveUntilLedgerSeq).  When multiple chronologically ordered
 * snapshots of ledger state are available, these properties can be compared
 * entry-by-entry to describe how individual state entries evolve over time.
 *
 * This example accepts two or more JSON snapshot files, matches entries across
 * snapshots using stable ledger-key identifiers, and produces an observable
 * lifecycle report describing:
 *
 *   • First-observed entries
 *   • Persisting entries (present in every snapshot)
 *   • Modified entries (value, durability, or lastModifiedLedgerSeq changed)
 *   • Removed entries (present then absent)
 *   • Reappearing entries (absent in ≥1 intermediate snapshot, then present again)
 *   • TTL increases, decreases, and unchanged TTLs
 *   • Observed lifetime ranges where ledger information exists
 *
 * The analysis is completely offline.  It does not connect to any network.
 * It describes recorded observations without inferring contract intent.
 *
 * Snapshot JSON format (array of entry objects):
 * [
 *   {
 *     "ledgerKey": "<base64 or human-readable stable identifier>",
 *     "contractId": "<optional C… address>",
 *     "durability": "persistent" | "temporary",
 *     "lastModifiedLedgerSeq": 12345,
 *     "liveUntilLedgerSeq": 12999,
 *     "valueXdr": "<base64 XDR of the SCVal — optional>",
 *     "valueDecoded": "<human-readable representation — optional>"
 *   },
 *   …
 * ]
 *
 * Snapshot files may optionally include top-level metadata:
 * {
 *   "ledger": 12500,          // ledger at which this snapshot was taken
 *   "entries": [ … ]
 * }
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Durability = 'persistent' | 'temporary' | 'unknown';

export type LifecycleTransition =
  | 'first-observed'
  | 'persisting'
  | 'modified'
  | 'removed'
  | 'reappearing';

export type TtlTrend = 'increasing' | 'decreasing' | 'unchanged' | 'unknown';

/** A single entry observation within one snapshot. */
export interface EntryObservation {
  /** Stable identifier used to match entries across snapshots. */
  ledgerKey: string;
  /** Optional contract address this entry belongs to. */
  contractId?: string;
  /** Durability of the entry at this observation. */
  durability: Durability;
  /** Ledger at which the entry was last modified, if available. */
  lastModifiedLedgerSeq?: number;
  /** Ledger up to which the entry is live, if available. */
  liveUntilLedgerSeq?: number;
  /** Raw XDR value (preserved without interpretation). */
  valueXdr?: string;
  /** Human-readable decoded value (optional, may be absent or partial). */
  valueDecoded?: string;
}

/** One parsed snapshot with optional ledger metadata. */
export interface Snapshot {
  /** Ledger sequence at which this snapshot was taken (if provided). */
  ledger?: number;
  /** All entries present in this snapshot. */
  entries: EntryObservation[];
}

/** Per-field change between two consecutive observations of the same entry. */
export interface EntryDelta {
  valueChanged: boolean;
  durabilityChanged: boolean;
  lastModifiedChanged: boolean;
  ttlChanged: boolean;
  ttlDelta?: number; // positive = increased, negative = decreased
  previousValueXdr?: string;
  currentValueXdr?: string;
  previousDurability?: Durability;
  currentDurability?: Durability;
  previousLastModified?: number;
  currentLastModified?: number;
  previousLiveUntil?: number;
  currentLiveUntil?: number;
}

/** Lifecycle record accumulated for one ledger key across all snapshots. */
export interface EntryLifecycle {
  ledgerKey: string;
  contractId?: string;
  /** Number of snapshots in which this entry was present. */
  presentCount: number;
  /** Total number of snapshots analyzed. */
  totalSnapshots: number;
  /** Primary lifecycle transition classification. */
  transition: LifecycleTransition;
  /** Observable TTL trend across the most recent consecutive observations. */
  ttlTrend: TtlTrend;
  /** Observed lifetime: first-seen ledger → last-seen ledger (from entry metadata). */
  firstObservedModifiedLedger?: number;
  lastObservedModifiedLedger?: number;
  /** All per-snapshot deltas (one per consecutive pair where entry was present in both). */
  deltas: EntryDelta[];
  /** Latest observation (last snapshot in which entry appears). */
  latestObservation?: EntryObservation;
  /** Whether the entry was present in an intermediate snapshot gap. */
  hadIntermediateGap: boolean;
}

/** Full lifecycle report for a set of snapshots. */
export interface LifecycleReport {
  snapshotCount: number;
  snapshotLedgers: Array<number | undefined>;
  totalUniqueKeys: number;
  entries: EntryLifecycle[];
  summary: {
    firstObservedCount: number;
    persistingCount: number;
    modifiedCount: number;
    removedCount: number;
    reappearingCount: number;
    ttlIncreasingCount: number;
    ttlDecreasingCount: number;
    ttlUnchangedCount: number;
  };
}

/** Options controlling lifecycle analysis. */
export interface LifecycleOptions {
  /** Only include entries belonging to this contract ID. */
  contractIdFilter?: string;
  /** Only include entries with this durability. */
  durabilityFilter?: Durability;
  /** Only include entries with this lifecycle transition. */
  transitionFilter?: LifecycleTransition;
  /** When true, validate that snapshot ledger numbers are strictly increasing. */
  validateSnapshotOrder?: boolean;
  /** Output JSON instead of human-readable text. */
  jsonOutput?: boolean;
}

// ---------------------------------------------------------------------------
// Snapshot parsing
// ---------------------------------------------------------------------------

/**
 * Normalise a raw parsed object from a snapshot JSON file into a typed
 * EntryObservation.  Missing or unrecognised fields fall back to safe
 * defaults so that a partially-decoded entry does not terminate the analysis.
 */
export function normalizeObservation(raw: unknown): EntryObservation | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const obj = raw as Record<string, unknown>;

  const ledgerKey = typeof obj['ledgerKey'] === 'string' ? obj['ledgerKey'].trim() : '';
  if (!ledgerKey) {
    // A stable key is required for matching.
    return null;
  }

  const contractId =
    typeof obj['contractId'] === 'string' && obj['contractId'].trim()
      ? obj['contractId'].trim()
      : undefined;

  let durability: Durability = 'unknown';
  if (obj['durability'] === 'persistent' || obj['durability'] === 'temporary') {
    durability = obj['durability'];
  }

  const lastModifiedLedgerSeq =
    typeof obj['lastModifiedLedgerSeq'] === 'number' &&
    Number.isInteger(obj['lastModifiedLedgerSeq']) &&
    obj['lastModifiedLedgerSeq'] >= 0
      ? (obj['lastModifiedLedgerSeq'] as number)
      : undefined;

  const liveUntilLedgerSeq =
    typeof obj['liveUntilLedgerSeq'] === 'number' &&
    Number.isInteger(obj['liveUntilLedgerSeq']) &&
    obj['liveUntilLedgerSeq'] >= 0
      ? (obj['liveUntilLedgerSeq'] as number)
      : undefined;

  const valueXdr =
    typeof obj['valueXdr'] === 'string' && obj['valueXdr'].trim()
      ? obj['valueXdr'].trim()
      : undefined;

  const valueDecoded =
    typeof obj['valueDecoded'] === 'string' && obj['valueDecoded'].trim()
      ? obj['valueDecoded'].trim()
      : undefined;

  return {
    ledgerKey,
    contractId,
    durability,
    lastModifiedLedgerSeq,
    liveUntilLedgerSeq,
    valueXdr,
    valueDecoded,
  };
}

/**
 * Parse a raw JSON value (already parsed from disk) into a typed Snapshot.
 * Accepts both the array form (entries only) and the object form (with
 * optional top-level `ledger` metadata).
 *
 * Throws a descriptive error when the value is structurally unusable.
 */
export function parseSnapshot(raw: unknown, label: string): Snapshot {
  if (raw === null || raw === undefined) {
    throw new Error(`Snapshot "${label}": content is null or undefined.`);
  }

  // Array form: [ entry, entry, … ]
  if (Array.isArray(raw)) {
    const entries = parseEntryArray(raw, label);
    return { entries };
  }

  if (typeof raw !== 'object') {
    throw new Error(`Snapshot "${label}": expected an object or array, got ${typeof raw}.`);
  }

  const obj = raw as Record<string, unknown>;

  // Object form: { ledger?: number, entries: [ … ] }
  let ledger: number | undefined;
  if (
    'ledger' in obj &&
    typeof obj['ledger'] === 'number' &&
    Number.isInteger(obj['ledger']) &&
    obj['ledger'] >= 0
  ) {
    ledger = obj['ledger'] as number;
  }

  if (!('entries' in obj)) {
    throw new Error(`Snapshot "${label}": object form requires an "entries" array.`);
  }

  if (!Array.isArray(obj['entries'])) {
    throw new Error(`Snapshot "${label}": "entries" must be an array.`);
  }

  const entries = parseEntryArray(obj['entries'] as unknown[], label);
  return { ledger, entries };
}

function parseEntryArray(arr: unknown[], _label: string): EntryObservation[] {
  const entries: EntryObservation[] = [];
  for (let i = 0; i < arr.length; i++) {
    const obs = normalizeObservation(arr[i]);
    if (obs === null) {
      // Partially decoded entries are skipped with a warning but do not abort.
      // The caller can detect this from a shorter entry array.
      continue;
    }
    entries.push(obs);
  }
  return entries;
}

/**
 * Load and parse a snapshot file from disk.
 *
 * Throws a descriptive error when the file does not exist, is not valid JSON,
 * or is structurally incompatible.
 */
export function loadSnapshot(filePath: string): Snapshot {
  const resolved = path.resolve(filePath);

  let content: string;
  try {
    content = fs.readFileSync(resolved, 'utf8');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot read snapshot file "${filePath}": ${message}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Snapshot file "${filePath}" is not valid JSON: ${message}`);
  }

  return parseSnapshot(raw, filePath);
}

// ---------------------------------------------------------------------------
// Snapshot ordering validation
// ---------------------------------------------------------------------------

/**
 * Validate that snapshot ledgers are strictly increasing when metadata is
 * available.  Returns a list of violation descriptions (empty = valid).
 */
export function validateSnapshotOrder(snapshots: Snapshot[]): string[] {
  const violations: string[] = [];
  let lastLedger: number | undefined;

  for (let i = 0; i < snapshots.length; i++) {
    const current = snapshots[i].ledger;
    if (current === undefined) {
      // No ledger metadata — cannot validate this position.
      lastLedger = undefined;
      continue;
    }
    if (lastLedger !== undefined && current <= lastLedger) {
      violations.push(
        `Snapshot ${i + 1} (ledger ${current}) is not after snapshot ${i} (ledger ${lastLedger}).`,
      );
    }
    lastLedger = current;
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Entry matching and delta calculation
// ---------------------------------------------------------------------------

/**
 * Build a map from ledger key to observation for a single snapshot.
 * Duplicate keys within one snapshot: the last occurrence wins (deterministic).
 */
export function indexSnapshot(snapshot: Snapshot): Map<string, EntryObservation> {
  const index = new Map<string, EntryObservation>();
  for (const entry of snapshot.entries) {
    index.set(entry.ledgerKey, entry);
  }
  return index;
}

/**
 * Compute the observable delta between two consecutive observations of the
 * same ledger key.  Both arguments must be defined (i.e. the entry was present
 * in both snapshots).
 */
export function computeDelta(prev: EntryObservation, curr: EntryObservation): EntryDelta {
  const valueChanged = prev.valueXdr !== curr.valueXdr;
  const durabilityChanged = prev.durability !== curr.durability;
  const lastModifiedChanged = prev.lastModifiedLedgerSeq !== curr.lastModifiedLedgerSeq;

  const prevTtl = prev.liveUntilLedgerSeq;
  const currTtl = curr.liveUntilLedgerSeq;
  const ttlChanged = prevTtl !== currTtl;
  const ttlDelta = prevTtl !== undefined && currTtl !== undefined ? currTtl - prevTtl : undefined;

  return {
    valueChanged,
    durabilityChanged,
    lastModifiedChanged,
    ttlChanged,
    ttlDelta,
    previousValueXdr: prev.valueXdr,
    currentValueXdr: curr.valueXdr,
    previousDurability: prev.durability,
    currentDurability: curr.durability,
    previousLastModified: prev.lastModifiedLedgerSeq,
    currentLastModified: curr.lastModifiedLedgerSeq,
    previousLiveUntil: prev.liveUntilLedgerSeq,
    currentLiveUntil: curr.liveUntilLedgerSeq,
  };
}

/**
 * Determine the TTL trend from the deltas accumulated for one entry.
 * Uses the last consecutive delta where TTL data is available.
 */
export function computeTtlTrend(deltas: EntryDelta[]): TtlTrend {
  for (let i = deltas.length - 1; i >= 0; i--) {
    const delta = deltas[i];
    if (delta.ttlDelta === undefined) continue;
    if (delta.ttlDelta > 0) return 'increasing';
    if (delta.ttlDelta < 0) return 'decreasing';
    return 'unchanged';
  }
  return 'unknown';
}

/**
 * Classify the primary lifecycle transition for an entry given the boolean
 * presence vector across all snapshots.
 *
 * Rules (applied in priority order):
 *   reappearing    — entry was absent in at least one intermediate snapshot but is
 *                    present in the last snapshot
 *   removed        — entry was present at some point but absent in the last snapshot
 *   first-observed — entry appears only in the most recent contiguous run of
 *                    snapshots (i.e. was never seen before the first gap or before
 *                    the first snapshot it appears in, and the last-seen position
 *                    has no prior presence)
 *   modified       — present in every snapshot it appeared in and at least one delta
 *                    indicates a change
 *   persisting     — present in every snapshot, no changes detected
 */
export function classifyTransition(
  presenceVector: boolean[],
  deltas: EntryDelta[],
): LifecycleTransition {
  const presentCount = presenceVector.filter(Boolean).length;
  const lastPresent = presenceVector[presenceVector.length - 1];
  const total = presenceVector.length;

  // Entry never present (should not happen — we only process keys seen at least once).
  if (presentCount === 0) return 'first-observed';

  // Absent in the last snapshot → removed.
  if (!lastPresent) return 'removed';

  // Find the index of the first presence.
  const firstPresentIndex = presenceVector.indexOf(true);

  // Detect intermediate gaps: a snapshot that is absent between two present snapshots.
  let hasGap = false;
  for (let i = firstPresentIndex + 1; i < total - 1; i++) {
    if (!presenceVector[i]) {
      hasGap = true;
      break;
    }
  }

  if (hasGap) return 'reappearing';

  // Present in last snapshot, no gap between first presence and end.
  // If there are snapshots before the first presence where the entry was absent,
  // it is first-observed (newly appeared at some point, never seen before).
  if (firstPresentIndex > 0) return 'first-observed';

  // Entry has been present since the first snapshot.
  // If it only appeared once total, it's first-observed.
  if (presentCount === 1) return 'first-observed';

  // Check if any delta shows a change.
  const wasModified = deltas.some(
    (d) => d.valueChanged || d.durabilityChanged || d.lastModifiedChanged || d.ttlChanged,
  );

  if (wasModified) return 'modified';
  return 'persisting';
}

// ---------------------------------------------------------------------------
// Core analysis
// ---------------------------------------------------------------------------

/**
 * Analyse lifecycle across multiple ordered snapshots.
 *
 * Returns a deterministic LifecycleReport.  Entries are sorted by ledgerKey
 * so that identical inputs always produce identical outputs.
 */
export function analyzeLifecycle(
  snapshots: Snapshot[],
  options: LifecycleOptions = {},
): LifecycleReport {
  if (snapshots.length < 2) {
    throw new Error('At least two snapshots are required for lifecycle analysis.');
  }

  // Build per-snapshot indexes.
  const indexes = snapshots.map(indexSnapshot);

  // Collect the union of all ledger keys seen across all snapshots.
  const allKeys = new Set<string>();
  for (const idx of indexes) {
    for (const key of idx.keys()) {
      allKeys.add(key);
    }
  }

  // Build lifecycle records, sorted for determinism.
  const sortedKeys = Array.from(allKeys).sort();
  const entries: EntryLifecycle[] = [];

  for (const key of sortedKeys) {
    // Collect presence vector and observations per snapshot.
    const presenceVector: boolean[] = [];
    const observations: Array<EntryObservation | undefined> = [];

    for (const idx of indexes) {
      const obs = idx.get(key);
      presenceVector.push(obs !== undefined);
      observations.push(obs);
    }

    // Find the first observation to extract contractId.
    const firstObs = observations.find((o) => o !== undefined);
    const contractId = firstObs?.contractId;

    // Apply contract ID filter.
    if (options.contractIdFilter && contractId !== options.contractIdFilter) {
      continue;
    }

    // Apply durability filter (uses latest observation's durability).
    const latestObs = [...observations].reverse().find((o) => o !== undefined);
    if (options.durabilityFilter) {
      const effectiveDurability = latestObs?.durability ?? 'unknown';
      if (effectiveDurability !== options.durabilityFilter) {
        continue;
      }
    }

    // Compute consecutive deltas for snapshots where both prev and curr have the entry.
    const deltas: EntryDelta[] = [];
    for (let i = 1; i < snapshots.length; i++) {
      const prev = observations[i - 1];
      const curr = observations[i];
      if (prev !== undefined && curr !== undefined) {
        deltas.push(computeDelta(prev, curr));
      }
    }

    const presentCount = presenceVector.filter(Boolean).length;
    const transition = classifyTransition(presenceVector, deltas);
    const ttlTrend = computeTtlTrend(deltas);

    // Apply transition filter.
    if (options.transitionFilter && transition !== options.transitionFilter) {
      continue;
    }

    // Compute observed lifetime range from lastModifiedLedgerSeq across present observations.
    const modifiedLedgers = observations
      .filter((o): o is EntryObservation => o?.lastModifiedLedgerSeq !== undefined)
      .map((o) => o.lastModifiedLedgerSeq as number);

    const firstObservedModifiedLedger =
      modifiedLedgers.length > 0 ? Math.min(...modifiedLedgers) : undefined;
    const lastObservedModifiedLedger =
      modifiedLedgers.length > 0 ? Math.max(...modifiedLedgers) : undefined;

    // Detect intermediate gaps for this entry.
    let hadIntermediateGap = false;
    let foundPresent = false;
    for (let i = 0; i < presenceVector.length; i++) {
      if (presenceVector[i]) {
        foundPresent = true;
      } else if (foundPresent && i < presenceVector.length - 1) {
        hadIntermediateGap = true;
        break;
      }
    }

    entries.push({
      ledgerKey: key,
      contractId,
      presentCount,
      totalSnapshots: snapshots.length,
      transition,
      ttlTrend,
      firstObservedModifiedLedger,
      lastObservedModifiedLedger,
      deltas,
      latestObservation: latestObs,
      hadIntermediateGap,
    });
  }

  // Build summary counts.
  const summary = {
    firstObservedCount: entries.filter((e) => e.transition === 'first-observed').length,
    persistingCount: entries.filter((e) => e.transition === 'persisting').length,
    modifiedCount: entries.filter((e) => e.transition === 'modified').length,
    removedCount: entries.filter((e) => e.transition === 'removed').length,
    reappearingCount: entries.filter((e) => e.transition === 'reappearing').length,
    ttlIncreasingCount: entries.filter((e) => e.ttlTrend === 'increasing').length,
    ttlDecreasingCount: entries.filter((e) => e.ttlTrend === 'decreasing').length,
    ttlUnchangedCount: entries.filter((e) => e.ttlTrend === 'unchanged').length,
  };

  return {
    snapshotCount: snapshots.length,
    snapshotLedgers: snapshots.map((s) => s.ledger),
    totalUniqueKeys: allKeys.size,
    entries,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Render a lifecycle report as a human-readable string.
 */
export function formatReport(report: LifecycleReport): string {
  const lines: string[] = [];

  lines.push('Soroban Contract State Entry Lifecycle Analysis');
  lines.push('='.repeat(55));
  lines.push('');
  lines.push(`Snapshots analyzed : ${report.snapshotCount}`);

  const ledgerInfo = report.snapshotLedgers
    .map((l, i) => (l !== undefined ? `S${i + 1}=ledger ${l}` : `S${i + 1}=unknown`))
    .join(', ');
  lines.push(`Snapshot ledgers   : ${ledgerInfo}`);
  lines.push(`Total unique keys  : ${report.totalUniqueKeys}`);
  lines.push('');
  lines.push('Summary');
  lines.push('-'.repeat(30));
  lines.push(`  First observed : ${report.summary.firstObservedCount}`);
  lines.push(`  Persisting     : ${report.summary.persistingCount}`);
  lines.push(`  Modified       : ${report.summary.modifiedCount}`);
  lines.push(`  Removed        : ${report.summary.removedCount}`);
  lines.push(`  Reappearing    : ${report.summary.reappearingCount}`);
  lines.push(`  TTL increasing : ${report.summary.ttlIncreasingCount}`);
  lines.push(`  TTL decreasing : ${report.summary.ttlDecreasingCount}`);
  lines.push(`  TTL unchanged  : ${report.summary.ttlUnchangedCount}`);
  lines.push('');

  if (report.entries.length === 0) {
    lines.push('No entries match the applied filters.');
    return lines.join('\n');
  }

  lines.push('Entry Details');
  lines.push('-'.repeat(30));

  for (const entry of report.entries) {
    lines.push('');
    lines.push(`Key        : ${entry.ledgerKey}`);
    if (entry.contractId) {
      lines.push(`Contract   : ${entry.contractId}`);
    }
    lines.push(`Transition : ${entry.transition}`);
    lines.push(`Present in : ${entry.presentCount} / ${entry.totalSnapshots} snapshots`);
    lines.push(`TTL trend  : ${entry.ttlTrend}`);

    if (entry.firstObservedModifiedLedger !== undefined) {
      lines.push(
        `Modified   : ledger ${entry.firstObservedModifiedLedger}` +
          (entry.lastObservedModifiedLedger !== entry.firstObservedModifiedLedger
            ? ` → ${entry.lastObservedModifiedLedger}`
            : ''),
      );
    }

    if (entry.hadIntermediateGap) {
      lines.push('  [intermediate gap detected]');
    }

    if (entry.latestObservation) {
      const obs = entry.latestObservation;
      lines.push(`Durability : ${obs.durability}`);
      if (obs.liveUntilLedgerSeq !== undefined) {
        lines.push(`Live until : ledger ${obs.liveUntilLedgerSeq}`);
      }
      if (obs.valueXdr) {
        lines.push(`Value XDR  : ${obs.valueXdr}`);
      }
      if (obs.valueDecoded) {
        lines.push(`Value      : ${obs.valueDecoded}`);
      }
    }

    if (entry.deltas.length > 0) {
      lines.push('Deltas:');
      for (let i = 0; i < entry.deltas.length; i++) {
        const d = entry.deltas[i];
        const changes: string[] = [];
        if (d.valueChanged) {
          changes.push(
            `value: ${d.previousValueXdr ?? '(none)'} → ${d.currentValueXdr ?? '(none)'}`,
          );
        }
        if (d.durabilityChanged) {
          changes.push(`durability: ${d.previousDurability} → ${d.currentDurability}`);
        }
        if (d.lastModifiedChanged) {
          changes.push(
            `lastModified: ${d.previousLastModified ?? '?'} → ${d.currentLastModified ?? '?'}`,
          );
        }
        if (d.ttlChanged) {
          const sign = (d.ttlDelta ?? 0) > 0 ? '+' : '';
          const deltaStr = d.ttlDelta !== undefined ? ` (${sign}${d.ttlDelta})` : '';
          changes.push(
            `liveUntil: ${d.previousLiveUntil ?? '?'} → ${d.currentLiveUntil ?? '?'}${deltaStr}`,
          );
        }
        if (changes.length > 0) {
          lines.push(`  [delta ${i + 1}] ${changes.join('; ')}`);
        } else {
          lines.push(`  [delta ${i + 1}] no observable change`);
        }
      }
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export interface StateLifecycleParams {
  snapshotFiles?: string[];
  contractIdFilter?: string;
  durabilityFilter?: Durability;
  transitionFilter?: LifecycleTransition;
  validateOrder?: boolean;
  jsonOutput?: boolean;
}

/**
 * Parse snapshot file paths from process.argv when the module is invoked via
 * stellar-api-inspector state-lifecycle <file1> <file2> …
 */
function resolveSnapshotFiles(params: StateLifecycleParams): string[] {
  if (params.snapshotFiles && params.snapshotFiles.length > 0) {
    return params.snapshotFiles;
  }

  // Accept args after any leading flags: stellar-api-inspector state-lifecycle <f1> <f2>
  const argv = process.argv.slice(2);
  // Strip the subcommand name if present.
  const files = argv.filter((a) => !a.startsWith('--') && a !== 'state-lifecycle');
  return files;
}

function resolveBooleanEnv(key: string): boolean {
  return process.env[key]?.toLowerCase() === 'true';
}

/**
 * Run the state-lifecycle analysis example.
 *
 * Inputs:
 *   params.snapshotFiles  — file paths to JSON snapshots
 *   CONTRACT_ID_FILTER    — env var contract ID filter
 *   DURABILITY_FILTER     — env var durability filter ('persistent' | 'temporary')
 *   TRANSITION_FILTER     — env var lifecycle transition filter
 *   VALIDATE_SNAPSHOT_ORDER — env var to enable ordering validation ('true')
 *   JSON_OUTPUT           — env var for JSON output ('true')
 */
export async function run(params: StateLifecycleParams = {}): Promise<void> {
  const jsonOutput = params.jsonOutput ?? resolveBooleanEnv('JSON_OUTPUT');

  const contractIdFilter =
    params.contractIdFilter?.trim() || process.env['CONTRACT_ID_FILTER']?.trim() || undefined;

  const rawDurability =
    params.durabilityFilter || (process.env['DURABILITY_FILTER']?.trim() as Durability | undefined);
  const durabilityFilter: Durability | undefined =
    rawDurability === 'persistent' || rawDurability === 'temporary' ? rawDurability : undefined;

  const rawTransition =
    params.transitionFilter ||
    (process.env['TRANSITION_FILTER']?.trim() as LifecycleTransition | undefined);

  const validTransitions: LifecycleTransition[] = [
    'first-observed',
    'persisting',
    'modified',
    'removed',
    'reappearing',
  ];
  const transitionFilter: LifecycleTransition | undefined =
    rawTransition && validTransitions.includes(rawTransition) ? rawTransition : undefined;

  const validateOrder = params.validateOrder ?? resolveBooleanEnv('VALIDATE_SNAPSHOT_ORDER');

  const snapshotFiles = resolveSnapshotFiles(params);

  if (!jsonOutput) {
    console.log(chalk.bold('\nSoroban Contract State Entry Lifecycle Analysis'));
    console.log(chalk.gray('Offline analysis — no network connection required.'));
    console.log('');
  }

  // Validate that we have at least two snapshots.
  if (snapshotFiles.length < 2) {
    const msg =
      'At least two snapshot files are required.\n' +
      'Usage: stellar-api-inspector state-lifecycle <snapshot-001.json> <snapshot-002.json> …';
    if (jsonOutput) {
      console.log(JSON.stringify({ error: msg }));
    } else {
      console.error(chalk.red(msg));
    }
    return;
  }

  if (!jsonOutput) {
    console.log(chalk.yellow(`Loading ${snapshotFiles.length} snapshot(s)...`));
  }

  // Load all snapshots.
  const snapshots: Snapshot[] = [];
  for (const file of snapshotFiles) {
    try {
      const snapshot = loadSnapshot(file);
      snapshots.push(snapshot);
      if (!jsonOutput) {
        const ledgerInfo = snapshot.ledger !== undefined ? ` (ledger ${snapshot.ledger})` : '';
        console.log(
          chalk.green(`  Loaded ${file}${ledgerInfo}: ${snapshot.entries.length} entries`),
        );
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (jsonOutput) {
        console.log(JSON.stringify({ error: message }));
      } else {
        console.error(chalk.red(`  Error loading snapshot: ${message}`));
      }
      return;
    }
  }

  // Validate snapshot ordering when requested.
  if (validateOrder) {
    const violations = validateSnapshotOrder(snapshots);
    if (violations.length > 0) {
      const msg =
        'Snapshot ordering validation failed:\n' + violations.map((v) => `  • ${v}`).join('\n');
      if (jsonOutput) {
        console.log(JSON.stringify({ error: msg, violations }));
      } else {
        console.error(chalk.red(msg));
      }
      return;
    }
    if (!jsonOutput) {
      console.log(chalk.green('  Snapshot ordering validated.'));
    }
  }

  if (!jsonOutput) {
    console.log('');
    console.log(chalk.yellow('Analyzing lifecycle...'));
  }

  // Run the core analysis.
  let report: LifecycleReport;
  try {
    report = analyzeLifecycle(snapshots, {
      contractIdFilter,
      durabilityFilter,
      transitionFilter,
      validateSnapshotOrder: validateOrder,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (jsonOutput) {
      console.log(JSON.stringify({ error: message }));
    } else {
      console.error(chalk.red(`Analysis error: ${message}`));
    }
    return;
  }

  if (jsonOutput) {
    // JSON output serialises BigInt-free objects directly.
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // Human-readable output.
  console.log('');
  console.log(formatReport(report));
  console.log('');
  console.log(chalk.bold.green('Lifecycle analysis complete.'));
}
