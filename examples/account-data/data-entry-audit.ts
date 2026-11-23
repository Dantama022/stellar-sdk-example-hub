import { DataChange, CurrentAccountData, RetrievedHistory } from './data-entry-history';
import { Network, validateRange } from '../_analysis/core';

export interface AuditFilter { key?: string; type?: DataChange['type']; transactionHash?: string; start?: number; end?: number }
export interface AuditRow extends DataChange { previousValueBase64: string | null; previousKnown: boolean }
export interface AuditReport {
  accountId: string; network: Network; range: { start: number; end: number };
  counts: { examined: number; created: number; updated: number; removed: number };
  timeline: AuditRow[]; reconstructed: Record<string, string>;
  currentComparison: 'matches' | 'differs' | 'inconclusive'; complete: boolean; warnings: string[];
}
/** Reconstruct only from an explicitly known state; null means unknown earlier state. */
export function buildAudit(options: {
  account: string; network: Network; start: number; end: number;
  history: RetrievedHistory; initialState?: Record<string, string>;
  current?: CurrentAccountData; filter?: AuditFilter;
}): AuditReport {
  validateRange(options.start, options.end, 50_000_000);
  const known = options.initialState !== undefined;
  const state: Record<string, string> = { ...(options.initialState ?? {}) };
  const warnings = [...options.history.warnings];
  const seen = new Set<string>();
  const timeline: AuditRow[] = [];
  const sorted = [...options.history.changes].sort((a, b) => (a.ledger ?? Infinity) - (b.ledger ?? Infinity) || a.id.localeCompare(b.id));
  for (const item of sorted) {
    if (item.account !== options.account || item.ledger === null || item.ledger < options.start || item.ledger > options.end || seen.has(item.id)) continue;
    seen.add(item.id);
    const previousKnown = Object.prototype.hasOwnProperty.call(state, item.key) || known;
    const previousValueBase64 = state[item.key] ?? null;
    if (item.type === 'remove') delete state[item.key];
    else if (item.valueBase64 !== null) state[item.key] = item.valueBase64;
    else warnings.push(`No value on ${item.id}; state incomplete`);
    if (options.filter?.key && item.key !== options.filter.key) continue;
    if (options.filter?.type && item.type !== options.filter.type) continue;
    if (options.filter?.transactionHash && item.transactionHash !== options.filter.transactionHash) continue;
    if (options.filter?.start !== undefined && item.ledger < options.filter.start) continue;
    if (options.filter?.end !== undefined && item.ledger > options.filter.end) continue;
    timeline.push({ ...item, previousValueBase64, previousKnown });
  }
  const complete = known && options.history.complete && warnings.length === 0;
  const currentEntries = options.current?.entries;
  const isEqual = currentEntries !== undefined && JSON.stringify(Object.entries(state).sort()) === JSON.stringify(Object.entries(currentEntries).map(([k,v]) => [k,v.base64]).sort());
  const currentComparison = !complete || !currentEntries ? 'inconclusive' : isEqual ? 'matches' : 'differs';
  if (!known) warnings.push('No verified starting snapshot supplied: previous values and resulting state can be incomplete.');
  if (!complete) warnings.push('This is an observation timeline, not a complete verified historical audit.');
  return {
    accountId: options.account, network: options.network, range: { start: options.start, end: options.end },
    counts: { examined: timeline.length, created: timeline.filter((row) => row.type === 'create').length,
      updated: timeline.filter((row) => row.type === 'update').length, removed: timeline.filter((row) => row.type === 'remove').length },
    timeline, reconstructed: state, currentComparison, complete, warnings,
  };
}
