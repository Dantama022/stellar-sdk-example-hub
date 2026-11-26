import { xdr } from '@stellar/stellar-sdk';
import { rpcCall } from '../_multi-analyzer/common';
import type { CaptureOptions, DiffField, DiffReport, EntryDifference, Snapshot, SnapshotEntry } from './types';

/** Canonicalize JSON property ordering so serialization/key order does not produce false differences. */
export function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, normalized(v)]));
  }
  return value;
}

export function changedFields(before: unknown, after: unknown, path = '$'): DiffField[] {
  if (JSON.stringify(normalized(before)) === JSON.stringify(normalized(after))) return [];
  const objectBefore = !!before && typeof before === 'object' && !Array.isArray(before);
  const objectAfter = !!after && typeof after === 'object' && !Array.isArray(after);
  if (objectBefore && objectAfter) {
    const a = before as Record<string, unknown>; const b = after as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
      .flatMap(key => changedFields(a[key], b[key], `${path}.${key}`));
  }
  return [{ path, before: before === undefined ? null : before, after: after === undefined ? null : after }];
}

export function compareSnapshots(before: Snapshot, after: Snapshot): DiffReport {
  const validStatus = new Set(['present', 'absent', 'unavailable']);
  const warnings = [...(before.warnings ?? []), ...(after.warnings ?? [])];
  const index = (snapshot: Snapshot): Map<string, SnapshotEntry> => {
    const map = new Map<string, SnapshotEntry>();
    for (const entry of snapshot.entries) {
      if (!entry.id || !validStatus.has(entry.status)) throw new Error('Malformed snapshot entry');
      if (map.has(entry.id)) warnings.push(`Duplicate entry ID in ${snapshot.source}: ${entry.id}`);
      else map.set(entry.id, entry);
    }
    return map;
  };
  const left = index(before); const right = index(after);
  const entries: EntryDifference[] = [];
  for (const id of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const a = left.get(id); const b = right.get(id);
    const type = b?.type ?? a?.type ?? 'unknown';
    if (!a || !b || a.status === 'unavailable' || b.status === 'unavailable') {
      entries.push({ id, type, status: 'inconclusive', fields: [], warning: 'A snapshot entry or historical state is unavailable; no deletion is inferred' });
      continue;
    }
    if (a.status === 'absent' && b.status === 'present') entries.push({ id, type, status: 'added', fields: [] });
    else if (a.status === 'present' && b.status === 'absent') entries.push({ id, type, status: 'removed', fields: [] });
    else if (a.status === 'absent' && b.status === 'absent') entries.push({ id, type, status: 'unchanged', fields: [] });
    else if (a.status === 'present' && b.status === 'present') {
      if (a.value === undefined || b.value === undefined) {
        entries.push({ id, type, status: 'inconclusive', fields: [], warning: 'Present entry lacks normalized value' });
        continue;
      }
      const fields = changedFields({ type: a.type, value: a.value }, { type: b.type, value: b.value });
      entries.push({ id, type, status: fields.length ? 'modified' : 'unchanged', fields });
    }
  }
  const counts: DiffReport['counts'] = { added: 0, modified: 0, removed: 0, unchanged: 0, inconclusive: 0 };
  for (const entry of entries) counts[entry.status]++;
  if (before.ledger !== null && after.ledger !== null && before.ledger > after.ledger) warnings.push('Snapshots are in reverse ledger order');
  return { fromLedger: before.ledger, toLedger: after.ledger, entries, counts, warnings,
    meaning: 'Observed differences between TWO states only; intermediate changes, re-creations and every event between observations are not reconstructed.' };
}

interface RpcEntry { key: string; xdr: string; lastModifiedLedgerSeq?: number }
interface RpcResponse { latestLedger: number; entries: RpcEntry[] }
/** The documented getLedgerEntries RPC method serves CURRENT state, not an arbitrary historical ledger. */
export async function captureCurrent(options: CaptureOptions): Promise<Snapshot> {
  const keys = [...new Set(options.keys)];
  if (!keys.length || keys.length > 200) throw new Error('Supply 1..200 ledger keys');
  for (const key of keys) {
    try { xdr.LedgerKey.fromXDR(key, 'base64'); }
    catch { throw new Error(`Invalid base64 ledger-key XDR: ${key.slice(0, 20)}`); }
  }
  const result = await rpcCall<RpcResponse>(options.rpcUrl, 'getLedgerEntries', { keys }, options.fetcher);
  if (!Number.isSafeInteger(result.latestLedger) || !Array.isArray(result.entries)) throw new Error('Incomplete RPC snapshot response');
  const fetched = new Map(result.entries.map(entry => [entry.key, entry]));
  const entries: SnapshotEntry[] = keys.map(key => {
    const entry = fetched.get(key);
    if (!entry) return { id: key, type: 'unknown', status: 'absent' };
    try {
      const data = xdr.LedgerEntryData.fromXDR(entry.xdr, 'base64');
      const sw = data.switch() as unknown as { name?: string };
      // Canonical XDR permits exact comparison, without assuming unstable RPC JSON schemas.
      return {
        id: key, type: typeof sw.name === 'string' ? sw.name : 'unknown', status: 'present',
        value: { canonicalXdr: data.toXDR('base64') },
        lastModifiedLedger: entry.lastModifiedLedgerSeq,
      };
    } catch (error) {
      return { id: key, type: 'unknown', status: 'unavailable', error: `Unable to decode ledger data: ${String(error)}` };
    }
  });
  return { ledger: result.latestLedger, observedAt: new Date().toISOString(), source: 'rpc-current-getLedgerEntries', entries,
    warnings: entries.some(entry => entry.status === 'unavailable') ? ['One or more entries could not be decoded'] : [] };
}
