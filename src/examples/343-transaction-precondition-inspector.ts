/** ISSUE-343: Read-only local inspection. Never signs or submits transactions. */
import { Account, Asset, Keypair, Networks, Operation, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';

export interface PreconditionsView {
  kind: 'none' | 'time' | 'v2';
  timeBounds?: { minTime: string; maxTime: string };
  ledgerBounds?: { minLedger: number; maxLedger: number };
  minAccountSequence?: string;
  minAccountSequenceAge?: string;
  minAccountSequenceLedgerGap?: number;
  extraSignerCount: number;
  transactionSequence: string;
}

export function inspectXdr(envelope: string, networkPassphrase = Networks.TESTNET): PreconditionsView {
  let parsed: Transaction;
  try {
    if (!envelope || typeof envelope !== 'string') throw new Error('empty');
    const tx = TransactionBuilder.fromXDR(envelope, networkPassphrase);
    if (!(tx instanceof Transaction)) throw new Error('unsupported fee-bump envelope');
    parsed = tx;
  } catch { throw new Error('Invalid or unsupported Stellar transaction envelope XDR'); }
  return inspectTransaction(parsed);
}

export function inspectTransaction(tx: Transaction): PreconditionsView {
  const timeBounds = tx.timeBounds ?? undefined;
  const ledgerBounds = tx.ledgerBounds ?? undefined;
  const age = tx.minAccountSequenceAge;
  const gap = tx.minAccountSequenceLedgerGap;
  const sequence = tx.minAccountSequence ?? undefined;
  const signerCount = tx.extraSigners?.length ?? 0;
  const variant = tx.tx.cond().switch().name;
  if (!['precondNone', 'precondTime', 'precondV2'].includes(variant)) {
    throw new Error('Unsupported transaction precondition variant');
  }
  const kind = variant === 'precondV2' ? 'v2' : variant === 'precondTime' ? 'time' : 'none';
  return {
    kind,
    ...(timeBounds ? { timeBounds: {minTime: String(timeBounds.minTime), maxTime: String(timeBounds.maxTime)} } : {}),
    ...(ledgerBounds ? { ledgerBounds: {minLedger: ledgerBounds.minLedger, maxLedger: ledgerBounds.maxLedger} } : {}),
    ...(sequence ? {minAccountSequence: String(sequence)} : {}),
    ...(age !== undefined && age !== null ? {minAccountSequenceAge: String(age)} : {}),
    ...(gap !== undefined && gap !== null ? {minAccountSequenceLedgerGap: gap} : {}),
    extraSignerCount: signerCount,
    transactionSequence: tx.sequence,
  };
}
export interface ValidationContext {
  nowSeconds: bigint;
  requireExpiry?: boolean;
  currentLedger?: number;
  accountSequence?: bigint;
  accountSequenceTime?: bigint;
  accountSequenceLedger?: number;
}
export function validatePreconditions(view: PreconditionsView, ctx: ValidationContext): string[] {
  const errors: string[] = [];
  if (ctx.nowSeconds < 0n) throw new Error('Invalid clock');
  if (!view.timeBounds) {
    if (ctx.requireExpiry) errors.push('Policy requires explicit expiring time bounds');
  } else {
    const {minTime, maxTime} = view.timeBounds;
    if (!/^\d+$/.test(minTime) || !/^\d+$/.test(maxTime)) { errors.push('Malformed time bounds'); }
    else {
      const min = BigInt(minTime), max = BigInt(maxTime);
      if (max !== 0n && min > max) errors.push('Reversed time bounds');
      if (min > ctx.nowSeconds) errors.push('Transaction is too early');
      // Protocol defines maxTime inclusive; equality is not expired.
      if (max !== 0n && ctx.nowSeconds > max) errors.push('Transaction has expired');
      if (max === 0n && ctx.requireExpiry) errors.push('Policy requires finite maxTime');
    }
  }
  if (view.ledgerBounds) {
    const {minLedger, maxLedger} = view.ledgerBounds;
    if (minLedger < 0 || maxLedger < 0 || (maxLedger !== 0 && minLedger >= maxLedger)) {
      errors.push('Invalid ledger bounds (upper bound is exclusive)');
    } else if (ctx.currentLedger !== undefined) {
      if (ctx.currentLedger < minLedger) errors.push('Ledger bound not reached');
      if (maxLedger !== 0 && ctx.currentLedger >= maxLedger) errors.push('Ledger bound exceeded');
    }
  }
  if (view.minAccountSequence !== undefined && !/^\d+$/.test(view.minAccountSequence)) errors.push('Invalid minimum account sequence');
  if (view.minAccountSequenceAge !== undefined && !/^\d+$/.test(view.minAccountSequenceAge)) errors.push('Invalid sequence age');
  if (view.minAccountSequenceLedgerGap !== undefined && (!Number.isInteger(view.minAccountSequenceLedgerGap) || view.minAccountSequenceLedgerGap < 0)) {
    errors.push('Invalid sequence ledger gap');
  }
  if (ctx.accountSequence !== undefined) {
    const sequence = BigInt(view.transactionSequence);
    if (view.minAccountSequence === undefined) {
      if (ctx.accountSequence + 1n !== sequence) errors.push('Account sequence must immediately precede transaction sequence');
    } else if (/^\d+$/.test(view.minAccountSequence)) {
      if (ctx.accountSequence < BigInt(view.minAccountSequence) || ctx.accountSequence >= sequence) errors.push('Account sequence does not meet relaxed minimum');
    }
  }
  if (ctx.accountSequenceTime !== undefined && view.minAccountSequenceAge !== undefined && /^\d+$/.test(view.minAccountSequenceAge)) {
    if (ctx.nowSeconds - ctx.accountSequenceTime < BigInt(view.minAccountSequenceAge)) errors.push('Minimum sequence age not met');
  }
  if (ctx.currentLedger !== undefined && ctx.accountSequenceLedger !== undefined && view.minAccountSequenceLedgerGap !== undefined) {
    if (ctx.currentLedger - ctx.accountSequenceLedger < view.minAccountSequenceLedgerGap) errors.push('Minimum sequence ledger gap not met');
  }
  return errors;
}

export function demoEnvelope(): string {
  const account = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 11)).publicKey(); // public-only fixture, never funded
  return new TransactionBuilder(new Account(account, '100'), { fee: '100', networkPassphrase: Networks.TESTNET,
    timebounds: {minTime: 1000, maxTime: 1200} })
    .addOperation(Operation.payment({destination: account, asset: Asset.native(), amount: '1'})).build().toXDR();
}
export async function run(): Promise<void> {
  const parsed = inspectXdr(demoEnvelope());
  const errors = validatePreconditions(parsed, {nowSeconds: 1100n, requireExpiry: true});
  console.log(JSON.stringify({preconditions: parsed, locallyValid: errors.length === 0, errors,
    networkChecksRemaining: ['account sequence', 'ledger close time', 'signatures and balances'], submitted: false}, null, 2));
}
