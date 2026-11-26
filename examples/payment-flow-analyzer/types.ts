import type { Fetcher, Network } from '../_multi-analyzer/common';

export interface FlowOptions {
  accounts: string[];
  network: Network;
  horizonUrl?: string;
  fromLedger?: number;
  toLedger?: number;
  fromTime?: string;
  toTime?: string;
  maxPages?: number;
  fetcher?: Fetcher;
}
export interface RawOperation {
  id: string | number; paging_token?: string; type: string;
  source_account?: string; from?: string; to?: string; account?: string;
  starting_balance?: string; amount?: string; source_amount?: string;
  asset_type?: string; asset_code?: string; asset_issuer?: string;
  source_asset_type?: string; source_asset_code?: string; source_asset_issuer?: string;
  transaction_hash?: string; transaction_successful?: boolean;
  created_at?: string; ledger?: number;
}
export interface FlowEdge {
  operationId: string; transactionHash: string; ledger: number | null;
  timestamp: string | null; kind: 'direct' | 'path' | 'account_funding';
  from: string; to: string;
  sentAsset: string; sentAmount: string;
  receivedAsset: string; receivedAmount: string;
  interpretation: string;
}
export interface FlowReport {
  network: Network; accounts: string[]; range: object;
  inspectedOperations: number; transactions: { hash: string; operations: string[] }[];
  relationships: FlowEdge[];
  accountsSummary: Record<string, { incoming: Record<string, string>; outgoing: Record<string, string>; relatedOperations: number }>;
  repeatParticipants: { account: string; observations: number }[];
  pagination: { complete: boolean; pages: number; accountPages: Record<string, number> };
  unsupportedOperations: Record<string, number>;
  warnings: string[];
}
