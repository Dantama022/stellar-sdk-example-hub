import type { Fetcher, Network } from '../_multi-analyzer/common';
export interface AssetSpec { type: 'native' | 'credit_alphanum4' | 'credit_alphanum12'; code?: string; issuer?: string; id: string }
export interface OrderbookOptions {
  network: Network; selling: string; buying: string;
  horizonUrl?: string; limit?: number; priceLimits?: string[]; fetcher?: Fetcher;
}
export interface RawOffer { price: string; amount: string; price_r: { n: number; d: number } }
export interface Orderbook { bids: RawOffer[]; asks: RawOffer[] }
export interface PriceLevel {
  price: string; originalPrice: string; priceRatio: { n: string; d: string }; counterAmount: string; cumulativeCounterAmount: string;
  estimatedBaseAmount: string; offerCount: number; gapFromPriorPercent: string | null;
}
export interface SideReport {
  levels: PriceLevel[]; totalCounterAmount: string; totalEstimatedBaseAmount: string;
  depthAtPrices: { threshold: string; cumulativeCounterAmount: string }[];
}
export interface OrderbookReport {
  network: Network; selling: string; buying: string; observedAt: string;
  units: string; bestBid: string | null; bestAsk: string | null;
  spreadAbsolute: string | null; spreadPercent: string | null; midpoint: string | null;
  bids: SideReport; asks: SideReport; warnings: string[];
  interpretation: string;
}
