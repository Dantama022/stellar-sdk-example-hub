import type { Fetcher, Network } from '../_multi-analyzer/common';
export interface PoolOptions { poolId: string; account?: string; network: Network; horizonUrl?: string; fetcher?: Fetcher }
export interface PoolReserve { asset: string; amount: string }
export interface PoolRecord { id: string; reserves: PoolReserve[]; total_shares: string; fee_bp?: number; last_modified_ledger?: number; last_modified_time?: string }
export interface PoolBalance { asset_type: string; liquidity_pool_id?: string; balance: string }
export interface PoolReport {
  poolId: string; network: Network; observedAt: string; lastModifiedLedger: number | null; lastModifiedTime: string | null;
  reserves: PoolReserve[]; totalShares: string | null;
  account: string | null; accountShares: string | null; ownershipPercent: string | null;
  estimatedExposure: PoolReserve[] | null; complete: boolean; warnings: string[];
  interpretation: string;
}
