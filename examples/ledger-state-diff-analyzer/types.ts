import type { Fetcher } from '../_multi-analyzer/common';
export type EntryStatus = 'present' | 'absent' | 'unavailable';
export interface SnapshotEntry {
  id: string; type: string; status: EntryStatus;
  value?: unknown; lastModifiedLedger?: number;
  error?: string;
}
export interface Snapshot {
  ledger: number | null; observedAt: string; source: string;
  entries: SnapshotEntry[]; warnings?: string[];
}
export interface DiffField { path: string; before: unknown; after: unknown }
export interface EntryDifference { id: string; type: string; status: 'added' | 'modified' | 'removed' | 'unchanged' | 'inconclusive'; fields: DiffField[]; warning?: string }
export interface DiffReport {
  fromLedger: number | null; toLedger: number | null; entries: EntryDifference[];
  counts: Record<EntryDifference['status'], number>; warnings: string[];
  meaning: string;
}
export interface CaptureOptions { rpcUrl: string; keys: string[]; fetcher?: Fetcher }
