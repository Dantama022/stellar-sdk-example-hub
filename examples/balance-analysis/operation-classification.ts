/** #575: deterministic, conservative interpretation of Horizon operations. */
import { amountToUnits, assetId, unitsToAmount } from '../_shared/horizon-readonly';

export interface ActivityOperation {
  id: string; type: string; transaction_hash: string; ledger?: number; created_at?: string;
  transaction_successful?: boolean; source_account?: string; from?: string; to?: string;
  amount?: string; asset_type?: string; asset_code?: string; asset_issuer?: string;
  source_amount?: string; source_asset_type?: string; source_asset_code?: string;
  source_asset_issuer?: string; funder?: string; account?: string; starting_balance?: string;
  into?: string; asset?: string; liquidity_pool_id?: string; shares_received?: string; shares?: string;
  reserves_deposited?: Array<{ asset: string; amount: string }>;
  reserves_received?: Array<{ asset: string; amount: string }>;
  sponsor?: string;
}
export interface Movement {
  hash: string; operationId: string; type: string; ledger: number | null; timestamp: string | null;
  asset: string; direction: 'incoming' | 'outgoing'; amount: string; source: string | null;
  destination: string | null; confidence: 'direct' | 'reported-liquidity-pool';
}
export interface Classified { movements: Movement[]; notes: string[]; classification: string }

/** Interpret only the balance movements that Horizon operation fields actually support. */
export function classifyOperation(op: ActivityOperation, accountId: string): Classified {
  const movements: Movement[] = [];
  const notes: string[] = [];
  const base = { hash: op.transaction_hash, operationId: op.id, type: op.type,
    ledger: op.ledger ?? null, timestamp: op.created_at ?? null };
  const add = (asset: string, raw: string | undefined, direction: Movement['direction'],
    source: string | null, destination: string | null, confidence: Movement['confidence'] = 'direct') => {
    if (!raw) { notes.push(`${op.type}: missing amount, cannot attribute movement`); return; }
    try {
      const n = amountToUnits(raw);
      if (n > 0n) movements.push({ ...base, asset, amount: unitsToAmount(n), direction, source, destination, confidence });
    } catch { notes.push(`${op.type}: malformed amount ${raw}`); }
  };
  const getAsset = (prefix = '') => assetId(
    (op as unknown as Record<string, string>)[`${prefix}asset_type`] ?? '',
    (op as unknown as Record<string, string>)[`${prefix}asset_code`],
    (op as unknown as Record<string, string>)[`${prefix}asset_issuer`],
  );
  try {
    switch (op.type) {
      case 'payment':
      case 'path_payment_strict_receive':
      case 'path_payment_strict_send': {
        const from = op.from ?? op.source_account ?? null;
        const to = op.to ?? null;
        if (!from || !to) { notes.push('Payment source/destination is missing.'); break; }
        if (from === accountId) {
          const path = op.type !== 'payment';
          add(path ? getAsset('source_') : getAsset(), path ? op.source_amount : op.amount, 'outgoing', from, to);
        }
        if (to === accountId) add(getAsset(), op.amount, 'incoming', from, to);
        break;
      }
      case 'create_account': {
        const from = op.funder ?? op.source_account ?? null;
        const to = op.account ?? null;
        if (!from || !to) { notes.push('Missing account creation participants.'); break; }
        if (from === accountId) add('XLM', op.starting_balance, 'outgoing', from, to);
        if (to === accountId) add('XLM', op.starting_balance, 'incoming', from, to);
        break;
      }
      case 'create_claimable_balance':
        if (op.source_account === accountId) {
          if (!op.asset) notes.push('Missing claimable balance asset');
          else add(op.asset === 'native' ? 'XLM' : op.asset, op.amount, 'outgoing', accountId, 'claimable balance');
        }
        break;
      case 'clawback':
        if (op.from === accountId) add(getAsset(), op.amount, 'outgoing', accountId, op.source_account ?? null);
        break;
      case 'liquidity_pool_deposit':
      case 'liquidity_pool_withdraw': {
        if (op.source_account !== accountId) break;
        const isDeposit = op.type === 'liquidity_pool_deposit';
        const reserves = isDeposit ? op.reserves_deposited : op.reserves_received;
        if (!reserves || !op.liquidity_pool_id) { notes.push('Pool reserve/ID metadata incomplete.'); break; }
        for (const r of reserves) {
          // Horizon `asset` uses native or CODE:ISSUER (not a market quote).
          const token = r.asset === 'native' ? 'XLM' : r.asset;
          add(token, r.amount, isDeposit ? 'outgoing' : 'incoming', accountId, 'liquidity pool', 'reported-liquidity-pool');
        }
        add(`POOL:${op.liquidity_pool_id}`, isDeposit ? op.shares_received : op.shares,
          isDeposit ? 'incoming' : 'outgoing', accountId, 'liquidity pool', 'reported-liquidity-pool');
        break;
      }
      case 'account_merge':
        notes.push('Account merge transfers remaining XLM, but operation data does not include its exact amount.');
        break;
      case 'manage_sell_offer': case 'manage_buy_offer': case 'create_passive_sell_offer':
        notes.push('Offers can change liabilities or execute trades; inspect trade/effect records for actual balance changes.');
        break;
      case 'change_trust': case 'set_options': case 'manage_data':
      case 'begin_sponsoring_future_reserves': case 'end_sponsoring_future_reserves':
      case 'revoke_sponsorship':
        notes.push('Reserve/configuration impact only; not recorded as a direct token transfer.');
        break;
      case 'claim_claimable_balance':
        notes.push('Claim amount and asset require claimable balance/effects lookup; not inferred from operation alone.');
        break;
      default: notes.push(`Unsupported/ambiguous operation type: ${op.type}`);
    }
  } catch (error) { notes.push(`Cannot classify ${op.type}: ${String(error)}`); }
  return { movements, notes, classification: movements.length ? 'direct-balance-movement' : 'requires-context-or-no-direct-movement' };
}
