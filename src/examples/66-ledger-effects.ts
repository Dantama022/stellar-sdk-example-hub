import { Horizon, Networks } from '@stellar/stellar-sdk';

/**
 * Example 66: Ledger Effects
 *
 * Every closed ledger is a batch. The network closes one roughly every five
 * seconds, applies whatever transactions made it into that ledger, and writes
 * the resulting state to the ledger header. Asking Horizon for the *effects* of
 * a ledger returns every state change that ledger produced, across all of its
 * transactions and all of their operations, in application order.
 *
 * That makes this the natural query for anything that reasons about the network
 * as a whole rather than about one account: block explorers rendering a ledger
 * page, indexers replaying history ledger by ledger, and analytics jobs asking
 * what actually changed during a window of time.
 *
 * Ledgers, transactions, operations, effects
 * ------------------------------------------
 * These four resources form a strict hierarchy, and effects sit at the bottom:
 *
 *   Ledger      — a closed block of network history, identified by a sequence
 *                 number. Contains 0..n transactions.
 *   Transaction — a signed, atomic bundle submitted by one source account.
 *                 Contains 1..100 operations. Either all of its operations
 *                 applied or none did.
 *   Operation   — a single requested action: pay, change trust, create offer.
 *                 This is *intent*, expressed by the submitter.
 *   Effect      — a single state change that actually happened as a result.
 *                 This is *outcome*, derived by Horizon from transaction meta.
 *
 * Operations and effects are not one-to-one, which is the whole reason effects
 * exist as a separate resource:
 *
 *   - One `payment` operation produces two effects: `account_debited` on the
 *     sender and `account_credited` on the receiver.
 *   - One `createAccount` operation produces `account_created` plus the debit
 *     and credit that funded it.
 *   - One `pathPaymentStrictSend` crossing three order books produces a `trade`
 *     effect per hop, on both sides of each hop, plus the end-to-end debit and
 *     credit — a dozen effects from a single operation.
 *   - One `manageSellOffer` that crosses nothing at all produces a single
 *     `offer_created` effect, and one that is fully consumed on the spot
 *     produces trades and no resting offer.
 *
 * So operation count tells you what was asked for, and effect count tells you
 * what the ledger actually did. Only the second one describes state.
 *
 * Ledger effects vs. transaction effects vs. account effects
 * ----------------------------------------------------------
 * Horizon exposes the same effect records under three different scopes. They
 * differ in what they include, not in the shape of the records:
 *
 *   Ledger effects — `/ledgers/{sequence}/effects` (this example)
 *     Every effect from every transaction in one ledger, including effects on
 *     accounts you have never heard of. Scoped by *time*: a fixed, complete,
 *     bounded slice of history that will never change or grow. This is the only
 *     one of the three that gives a full picture of a moment on the network.
 *
 *   Transaction effects — `/transactions/{hash}/effects` (example
 *   `45-horizon-effects`)
 *     Every effect produced by one transaction, across all of its operations.
 *     Scoped by *submission*: it answers "what did this transaction do", which
 *     is what you want after submitting one. A ledger's effects are the
 *     concatenation of its transactions' effects.
 *
 *   Account effects — `/accounts/{id}/effects`
 *     Every effect that touched one account, from its creation to now. Scoped
 *     by *participant*, and unbounded in both directions: it spans many ledgers
 *     and keeps growing. Note that this is a filter across history, not a
 *     subset of any single ledger.
 *
 * A single `account_credited` record can be returned by all three endpoints. It
 * is the same effect, with the same ID; only the question being asked differs.
 *
 * Where the ledger sequence comes from
 * ------------------------------------
 * Effect records do not carry a `ledger` field. They carry an ID, and that ID
 * encodes the position of the effect in history — see `parseEffectId` below.
 * Decoding it recovers the ledger sequence, the transaction's application order
 * within that ledger, and the operation's index within that transaction, which
 * is how this example reports a ledger sequence per effect and counts distinct
 * transactions without fetching them.
 *
 * This example is read-only. It submits no transactions and needs no funded
 * account.
 */

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';

/** Horizon rejects a per-request `limit` above this, so pages are capped here. */
const HORIZON_PAGE_LIMIT = 200;

const DEFAULT_LIMIT = 25;

/**
 * Ceiling on the total number of effects retrieved across pages.
 *
 * A busy Pubnet ledger can produce thousands of effects. The example prints
 * every retrieved effect individually, so an upper bound keeps the output
 * readable; the summary counts still describe everything that was fetched.
 */
const MAX_LIMIT = 500;

/**
 * Largest sequence Horizon will interpret correctly.
 *
 * The protocol's ledger sequence is unsigned 32-bit, but Horizon parses the URL
 * segment as a *signed* 32-bit integer: anything above this wraps to a negative
 * number and comes back as `410 Gone`, as if the ledger had been pruned. That
 * response is actively misleading, so the value is rejected here instead.
 */
const MAX_LEDGER_SEQUENCE = 2147483647;

export interface LedgerEffectsParams {
  /** Ledger sequence to inspect. Blank uses the latest closed ledger. */
  ledgerSequence?: number | string;
  /** Maximum number of effects to retrieve (1-500). */
  limit?: number | string;
  horizonUrl?: string;
}

/**
 * The subset of a Horizon effect record this example reads.
 *
 * Effect payloads are polymorphic — each of the ~50 effect types adds its own
 * fields — so the shared fields are required and the type-specific ones are
 * optional rather than modelled as a union.
 */
export interface LedgerEffectLike {
  id: string;
  type: string;
  type_i?: number;
  account?: string;
  created_at?: string;
  /** Present on liquidity pool and contract effects instead of `account`. */
  contract?: string;
  liquidity_pool?: { id?: string };
  asset_code?: string;
  asset_issuer?: string;
  asset_type?: string;
  amount?: string;
  starting_balance?: string;
  trustor?: string;
  offer_id?: string | number;
  seller?: string;
  sponsor?: string;
  new_sponsor?: string;
  former_sponsor?: string;
  balance_id?: string;
  weight?: number;
  name?: string;
}

/** Positional information decoded from an effect ID. */
export interface EffectIdParts {
  /** The TOID of the operation that produced the effect. */
  operationId: string;
  /** Ledger the effect belongs to. */
  ledgerSequence: number;
  /** 1-based application order of the transaction within the ledger. */
  transactionOrder: number;
  /** 1-based index of the operation within the transaction. */
  operationIndex: number;
  /** 1-based index of the effect within the operation. */
  effectIndex: number;
}

/** Aggregate statistics over one ledger's effects. */
export interface LedgerEffectsSummary {
  effectCount: number;
  /** Effect counts keyed by Horizon effect type, e.g. `account_credited`. */
  countsByType: Record<string, number>;
  /** Effect counts keyed by the broader category the type belongs to. */
  countsByCategory: Record<string, number>;
  /** Distinct effect types present. */
  distinctTypeCount: number;
  /** Distinct accounts touched by at least one effect. */
  accountCount: number;
  /** Distinct operations that produced the effects, decoded from effect IDs. */
  operationCount: number;
  /** Distinct transactions that produced the effects, decoded from effect IDs. */
  transactionCount: number;
  /** Ledger sequences seen in the effect IDs; normally exactly one. */
  ledgerSequences: number[];
}

/** Metadata from the ledger header, used to frame the effect counts. */
export interface LedgerHeaderSummary {
  sequence: number;
  closedAt: string;
  successfulTransactionCount: number;
  failedTransactionCount: number;
  operationCount: number;
}

/**
 * Broad grouping applied on top of Horizon's effect types.
 *
 * Horizon defines around fifty effect types, which is too granular to read at a
 * glance. Categories answer "what kind of thing changed in this ledger" —
 * payments, DEX activity, trust, sponsorship — before the per-type breakdown
 * answers "specifically what".
 */
export const EFFECT_CATEGORIES = {
  ACCOUNT: 'Account balances & settings',
  SIGNER: 'Signers',
  TRUSTLINE: 'Trustlines',
  DEX: 'DEX offers & trades',
  DATA: 'Data entries',
  CLAIMABLE_BALANCE: 'Claimable balances',
  LIQUIDITY_POOL: 'Liquidity pools',
  SPONSORSHIP: 'Sponsorship',
  CONTRACT: 'Smart contracts',
  OTHER: 'Other',
} as const;

export type EffectCategory = (typeof EFFECT_CATEGORIES)[keyof typeof EFFECT_CATEGORIES];

/**
 * Short explanations for the effect types a typical ledger contains.
 *
 * Only the common ones are listed. Anything missing still gets categorised by
 * `categorizeEffectType`, so an unrecognised type degrades to a bare name
 * rather than being dropped.
 */
export const EFFECT_TYPE_EXPLANATIONS: Record<string, string> = {
  account_created: 'a new account entry was funded into existence',
  account_removed: 'an account entry was merged away',
  account_credited: 'an account balance increased',
  account_debited: 'an account balance decreased',
  account_thresholds_updated: 'the low/medium/high signing thresholds changed',
  account_home_domain_updated: 'the home domain changed',
  account_flags_updated: 'issuer authorization flags changed',
  sequence_bumped: 'the account sequence number was bumped forward',
  signer_created: 'a signer was added to an account',
  signer_removed: 'a signer was removed from an account',
  signer_updated: 'a signer weight changed',
  trustline_created: 'an account began trusting an asset',
  trustline_removed: 'a trustline was deleted',
  trustline_updated: 'a trustline limit changed',
  trustline_authorized: 'an issuer authorized a holder to use the asset',
  trustline_deauthorized: 'an issuer revoked a holder authorization',
  trustline_flags_updated: 'trustline authorization flags changed',
  offer_created: 'a new offer was placed on the order book',
  offer_removed: 'an offer left the order book, filled or cancelled',
  offer_updated: 'an existing offer was modified or partially filled',
  trade: 'two offers crossed and assets changed hands',
  data_created: 'a key/value data entry was written to an account',
  data_removed: 'a data entry was deleted',
  data_updated: 'a data entry value changed',
  claimable_balance_created: 'a claimable balance entry was created',
  claimable_balance_claimed: 'a claimable balance was claimed and removed',
  claimable_balance_claimant_created: 'an account became eligible to claim a balance',
  claimable_balance_clawed_back: 'an issuer clawed back a claimable balance',
  liquidity_pool_created: 'a liquidity pool was established',
  liquidity_pool_deposited: 'assets were deposited into a liquidity pool',
  liquidity_pool_withdrew: 'assets were withdrawn from a liquidity pool',
  liquidity_pool_trade: 'a trade executed against a liquidity pool',
  liquidity_pool_removed: 'an empty liquidity pool was deleted',
  liquidity_pool_revoked: 'pool shares were revoked into claimable balances',
  contract_credited: 'a contract balance increased',
  contract_debited: 'a contract balance decreased',
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Digs the HTTP status out of the several shapes Horizon errors arrive in. */
export function getHorizonStatusCode(error: unknown): number | null {
  if (!isRecord(error)) {
    return null;
  }

  if (typeof error.status === 'number') {
    return error.status;
  }

  if (isRecord(error.response) && typeof error.response.status === 'number') {
    return error.response.status;
  }

  return null;
}

/**
 * Detects the `NotFoundError` the SDK raises for a Horizon 404.
 *
 * For a ledger request a 404 means the ledger has not closed yet. It has to be
 * separated both from network and server errors, which say nothing about the
 * ledger, and from the 410 below, which means the opposite thing.
 */
export function isHorizonNotFoundError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'NotFoundError') {
    return true;
  }

  return getHorizonStatusCode(error) === 404;
}

/**
 * Detects the Horizon 410 for a ledger that has been pruned.
 *
 * Horizon answers a request for a ledger below its retained history with `410
 * Gone` rather than `404`, which is a genuinely useful distinction: 404 means
 * the ledger does not exist yet, 410 means it existed and this particular
 * instance no longer serves it. Only the second one is worth retrying against a
 * different Horizon.
 */
export function isHorizonGoneError(error: unknown): boolean {
  return getHorizonStatusCode(error) === 410;
}

/**
 * Validates a ledger sequence and returns it as a number.
 *
 * Every rejection is caught here rather than sent to Horizon, because Horizon's
 * own responses for bad sequences are unhelpful: a non-numeric path segment is
 * a 400 with no explanation, and a sequence in the far future is an ordinary
 * 404 indistinguishable from a ledger that has simply been pruned.
 */
export function normalizeLedgerSequence(value: number | string): number {
  const raw = typeof value === 'string' ? value.trim() : value;

  if (raw === '' || raw === undefined || raw === null) {
    throw new Error('Missing ledger sequence. Provide a positive integer, for example 1234567.');
  }

  // Reject `12abc` and `1.5` outright: Number() would silently accept the
  // second, and a truncated sequence would query the wrong ledger.
  if (typeof raw === 'string' && !/^\d+$/.test(raw)) {
    throw new Error(
      `Invalid ledger sequence "${raw}". A ledger sequence is a positive whole number, for example 1234567.`,
    );
  }

  const parsed = typeof raw === 'string' ? Number(raw) : raw;

  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(
      `Invalid ledger sequence "${String(value)}". A ledger sequence is a positive whole number.`,
    );
  }

  if (parsed < 1) {
    throw new Error(
      `Invalid ledger sequence ${parsed}. Ledger sequences start at 1 (the genesis ledger).`,
    );
  }

  if (parsed > MAX_LEDGER_SEQUENCE) {
    throw new Error(
      `Invalid ledger sequence ${parsed}. Horizon reads the sequence as a signed 32-bit integer, so the maximum is ${MAX_LEDGER_SEQUENCE}.`,
    );
  }

  return parsed;
}

/** Clamps a requested result limit into the range this example can print. */
export function normalizeLimit(value?: number | string): number {
  const parsed = typeof value === 'string' ? parseInt(value.trim(), 10) : value;

  if (parsed === undefined || parsed === null || Number.isNaN(parsed)) {
    return DEFAULT_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_LIMIT);
}

/**
 * Decodes the position encoded in an effect ID.
 *
 * An effect ID is `<operationId>-<effectIndex>`, where the operation ID is a
 * TOID: a 64-bit integer packing three fields, most significant first.
 *
 *   bits 63..32 (32 bits) — ledger sequence
 *   bits 31..12 (20 bits) — transaction application order within the ledger
 *   bits 11..0  (12 bits) — operation index within the transaction
 *
 * The field widths are the reason for the protocol limits they mirror: 20 bits
 * caps a ledger at ~1M transactions and 12 bits caps a transaction at 4096
 * operations.
 *
 * `BigInt` is required. A TOID for any real ledger exceeds `Number.MAX_SAFE_INTEGER`,
 * so parsing one as a `Number` silently loses the low bits — precisely the
 * transaction and operation fields being read here.
 *
 * Returns null rather than throwing for anything that does not parse, so one
 * malformed record cannot abort a report over hundreds of good ones.
 */
export function parseEffectId(id: string | undefined): EffectIdParts | null {
  if (!id) {
    return null;
  }

  const [operationId, effectIndex] = id.split('-');

  if (!operationId || !/^\d+$/.test(operationId) || !effectIndex || !/^\d+$/.test(effectIndex)) {
    return null;
  }

  let toid: bigint;
  try {
    toid = BigInt(operationId);
  } catch {
    return null;
  }

  return {
    operationId,
    ledgerSequence: Number(toid >> 32n),
    transactionOrder: Number((toid >> 12n) & 0xfffffn),
    operationIndex: Number(toid & 0xfffn),
    effectIndex: Number(effectIndex),
  };
}

/**
 * Maps an effect type to its broad category.
 *
 * Sponsorship is tested first on purpose: `account_sponsorship_created` and
 * `trustline_sponsorship_removed` both start with the prefix of another
 * category, and they describe who pays the reserve rather than a change to the
 * account or trustline itself.
 *
 * The checks are prefix-based rather than a lookup table so that effect types
 * added by future protocol versions land in the right category instead of
 * falling through to `Other`.
 */
export function categorizeEffectType(type: string): EffectCategory {
  if (type.includes('sponsorship')) {
    return EFFECT_CATEGORIES.SPONSORSHIP;
  }
  if (type.startsWith('signer_')) {
    return EFFECT_CATEGORIES.SIGNER;
  }
  if (type.startsWith('trustline_')) {
    return EFFECT_CATEGORIES.TRUSTLINE;
  }
  if (type.startsWith('claimable_balance_')) {
    return EFFECT_CATEGORIES.CLAIMABLE_BALANCE;
  }
  if (type.startsWith('liquidity_pool_')) {
    return EFFECT_CATEGORIES.LIQUIDITY_POOL;
  }
  if (type.startsWith('offer_') || type === 'trade') {
    return EFFECT_CATEGORIES.DEX;
  }
  if (type.startsWith('data_')) {
    return EFFECT_CATEGORIES.DATA;
  }
  if (type.startsWith('contract_')) {
    return EFFECT_CATEGORIES.CONTRACT;
  }
  if (type.startsWith('account_') || type === 'sequence_bumped') {
    return EFFECT_CATEGORIES.ACCOUNT;
  }

  return EFFECT_CATEGORIES.OTHER;
}

/**
 * Identifies the party an effect applied to.
 *
 * Most effects carry `account`, but not all: liquidity pool effects identify a
 * pool, contract balance effects identify a contract, and issuer-driven
 * trustline effects name the `trustor`. Falling back through those keeps the
 * "affected account" column populated instead of showing gaps.
 */
export function describeEffectSubject(effect: LedgerEffectLike): string {
  if (effect.account) {
    return effect.account;
  }
  if (effect.trustor) {
    return effect.trustor;
  }
  if (effect.seller) {
    return effect.seller;
  }
  if (effect.contract) {
    return effect.contract;
  }
  if (effect.liquidity_pool?.id) {
    return `pool:${effect.liquidity_pool.id}`;
  }

  return '(none)';
}

/** Renders an asset as `XLM` or `CODE:ISSUER`, when the effect names one. */
export function describeEffectAsset(effect: LedgerEffectLike): string | null {
  if (effect.asset_type === 'native') {
    return 'XLM';
  }
  if (effect.asset_code) {
    return effect.asset_issuer ? `${effect.asset_code}:${effect.asset_issuer}` : effect.asset_code;
  }

  return null;
}

/** Groups effects by Horizon effect type, preserving retrieval order within each group. */
export function groupEffectsByType(
  effects: LedgerEffectLike[],
): Record<string, LedgerEffectLike[]> {
  const groups: Record<string, LedgerEffectLike[]> = {};

  for (const effect of effects) {
    const type = effect.type || 'unknown';
    (groups[type] ??= []).push(effect);
  }

  return groups;
}

/**
 * Aggregates a ledger's effects into per-type, per-category, and participant
 * counts.
 *
 * Operation and transaction counts come from the effect IDs rather than from
 * extra Horizon requests, and count only what actually produced an effect. They
 * are therefore floors, not totals: the ledger header's `operation_count` is
 * higher whenever an applied operation changed no classic state — a Soroban
 * `invokeHostFunction` being the usual case — and both counts exclude failed
 * transactions entirely, which are recorded and pay their fee but emit nothing.
 */
export function summarizeLedgerEffects(effects: LedgerEffectLike[]): LedgerEffectsSummary {
  const countsByType: Record<string, number> = {};
  const countsByCategory: Record<string, number> = {};
  const accounts = new Set<string>();
  const operations = new Set<string>();
  const transactions = new Set<string>();
  const ledgers = new Set<number>();

  for (const effect of effects) {
    const type = effect.type || 'unknown';
    countsByType[type] = (countsByType[type] ?? 0) + 1;

    const category = categorizeEffectType(type);
    countsByCategory[category] = (countsByCategory[category] ?? 0) + 1;

    const subject = describeEffectSubject(effect);
    if (subject !== '(none)') {
      accounts.add(subject);
    }

    const parts = parseEffectId(effect.id);
    if (parts) {
      operations.add(parts.operationId);
      // Transaction order repeats across ledgers, so it is only unique when
      // paired with the ledger sequence.
      transactions.add(`${parts.ledgerSequence}:${parts.transactionOrder}`);
      ledgers.add(parts.ledgerSequence);
    }
  }

  return {
    effectCount: effects.length,
    countsByType,
    countsByCategory,
    distinctTypeCount: Object.keys(countsByType).length,
    accountCount: accounts.size,
    operationCount: operations.size,
    transactionCount: transactions.size,
    ledgerSequences: Array.from(ledgers).sort((a, b) => a - b),
  };
}

/** Formats one effect as a single line: type, subject, ledger, and details. */
export function formatEffectLine(effect: LedgerEffectLike): string {
  const parts = parseEffectId(effect.id);
  const details: string[] = [
    `type=${effect.type || 'unknown'}`,
    `account=${describeEffectSubject(effect)}`,
    `ledger=${parts ? parts.ledgerSequence : 'unknown'}`,
  ];

  if (parts) {
    details.push(`tx=#${parts.transactionOrder}`, `op=#${parts.operationIndex}`);
  }

  const asset = describeEffectAsset(effect);
  if (asset) {
    details.push(`asset=${asset}`);
  }

  const amount = effect.amount ?? effect.starting_balance;
  if (amount) {
    details.push(`amount=${amount}`);
  }

  return details.join(' | ');
}

/** Sorts a count map into descending order, breaking ties by name. */
function sortCounts(counts: Record<string, number>): Array<[string, number]> {
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * Renders the full ledger effects report.
 *
 * Built as a string rather than printed directly so the layout can be asserted
 * on in tests without capturing console output.
 */
export function formatLedgerEffectsReport(
  ledgerSequence: number,
  effects: LedgerEffectLike[],
  summary: LedgerEffectsSummary,
  context: {
    limit: number;
    header?: LedgerHeaderSummary | null;
    truncated?: boolean;
  } = { limit: DEFAULT_LIMIT },
): string {
  const lines: string[] = [];
  const header = context.header;

  lines.push('=== Ledger Effects ===');
  lines.push(`Ledger Sequence: ${ledgerSequence}`);

  if (header) {
    const transactionCount = header.successfulTransactionCount + header.failedTransactionCount;
    lines.push(`Closed At:       ${header.closedAt}`);
    lines.push(
      `Transactions:    ${transactionCount} (${header.successfulTransactionCount} successful, ` +
        `${header.failedTransactionCount} failed)`,
    );
    lines.push(`Operations:      ${header.operationCount} (from successful transactions)`);
  }

  lines.push(`Result Limit:    ${context.limit}`);

  if (effects.length === 0) {
    lines.push('');
    lines.push('This ledger produced no effects.');
    lines.push('');
    lines.push('That is a normal result, not an error. The network closes a ledger every few');
    lines.push('seconds whether or not anyone submitted anything, so empty ledgers are common');
    lines.push('on quiet networks. A ledger also has no effects when every transaction in it');
    lines.push('failed: failed transactions are still recorded and still pay their fee, but');
    lines.push('they change no state, so Horizon derives no effects from them.');
    return lines.join('\n');
  }

  lines.push('');
  lines.push(`Effects Retrieved: ${effects.length}`);

  if (context.truncated) {
    lines.push(
      `NOTE: this ledger produced more than ${context.limit} effects; the report covers the first ${context.limit}.`,
    );
    lines.push('Raise the limit to widen the window, or page with a cursor for the full set.');
  }

  lines.push('');
  lines.push('Effect Records (application order):');
  effects.forEach((effect, index) => {
    lines.push(`  ${String(index + 1).padStart(3)}. ${formatEffectLine(effect)}`);
  });

  lines.push('');
  lines.push('Effects Grouped By Type:');
  const groups = groupEffectsByType(effects);
  for (const [type, count] of sortCounts(summary.countsByType)) {
    const explanation = EFFECT_TYPE_EXPLANATIONS[type];
    lines.push(`  ${type.padEnd(38)} ${String(count).padStart(5)}`);
    if (explanation) {
      lines.push(`      ${explanation}`);
    }

    const subjects = new Set(groups[type].map(describeEffectSubject));
    subjects.delete('(none)');
    lines.push(`      accounts touched: ${subjects.size}`);
  }

  lines.push('');
  lines.push('Effects Grouped By Category:');
  for (const [category, count] of sortCounts(summary.countsByCategory)) {
    const share = ((count / summary.effectCount) * 100).toFixed(1);
    lines.push(`  ${category.padEnd(30)} ${String(count).padStart(5)}  (${share}%)`);
  }

  lines.push('');
  lines.push('Summary Statistics:');
  const stat = (label: string, value: string | number): string =>
    `  ${`${label}:`.padEnd(23)}${value}`;
  lines.push(stat('Effects', summary.effectCount));
  lines.push(stat('Distinct types', summary.distinctTypeCount));
  lines.push(stat('Accounts touched', summary.accountCount));
  lines.push(stat('Operations involved', summary.operationCount));
  lines.push(stat('Transactions involved', summary.transactionCount));

  if (summary.operationCount > 0) {
    lines.push(
      stat('Effects per operation', (summary.effectCount / summary.operationCount).toFixed(2)),
    );
  }

  if (summary.ledgerSequences.length > 1) {
    // Every effect in a ledger query must decode to the queried ledger, so more
    // than one sequence means the records did not come from where we think.
    lines.push(
      `  WARNING: effects decoded to multiple ledgers: ${summary.ledgerSequences.join(', ')}`,
    );
  }

  if (header) {
    const withoutEffects = header.operationCount - summary.operationCount;
    if (withoutEffects > 0 && !context.truncated) {
      lines.push('');
      lines.push(
        `  ${withoutEffects} of the ledger's ${header.operationCount} operations produced no effects.`,
      );
      lines.push('  An operation emits no effect when it changes no classic ledger state. The');
      lines.push('  common case is a Soroban invokeHostFunction, whose activity is published as');
      lines.push('  contract events instead (see example 67-soroban-contract-events); another is');
      lines.push('  a setOptions that sets a value the account already had. Requested actions and');
      lines.push('  applied state changes are counted separately.');
    }
  }

  return lines.join('\n');
}

/** Reduces a Horizon ledger record to the header fields reported here. */
export function summarizeLedgerHeader(record: {
  sequence: number;
  closed_at: string;
  successful_transaction_count: number;
  failed_transaction_count: number;
  operation_count: number;
}): LedgerHeaderSummary {
  return {
    sequence: record.sequence,
    closedAt: record.closed_at,
    successfulTransactionCount: record.successful_transaction_count,
    failedTransactionCount: record.failed_transaction_count,
    operationCount: record.operation_count,
  };
}

/** Minimal call-builder surface used for retrieval, so tests can substitute a stub. */
export interface EffectsPageLike {
  records: LedgerEffectLike[];
  next?: () => Promise<EffectsPageLike>;
}

export interface LedgerEffectsServerLike {
  effects: () => {
    forLedger: (sequence: number | string) => {
      limit: (count: number) => {
        call: () => Promise<EffectsPageLike>;
      };
    };
  };
}

/**
 * Retrieves up to `limit` effects for a ledger, following pages as needed.
 *
 * Horizon caps a single response at 200 records, so any limit above that
 * requires walking `next()` links. One record beyond the limit is requested so
 * that "there were exactly `limit` effects" can be told apart from "the report
 * was cut short", which is the difference between a complete summary and a
 * misleading one.
 *
 * The loop stops on a short page. Horizon signals exhaustion by returning fewer
 * records than requested rather than by omitting the `next` link — following
 * that link past the end yields empty pages indefinitely.
 */
export async function retrieveLedgerEffects(
  server: LedgerEffectsServerLike,
  ledgerSequence: number,
  limit: number,
): Promise<{ effects: LedgerEffectLike[]; truncated: boolean }> {
  const collected: LedgerEffectLike[] = [];
  const pageSize = Math.min(limit + 1, HORIZON_PAGE_LIMIT);

  let page: EffectsPageLike | undefined = await server
    .effects()
    .forLedger(ledgerSequence)
    .limit(pageSize)
    .call();

  while (page) {
    const records = page.records ?? [];
    collected.push(...records);

    if (collected.length > limit) {
      return { effects: collected.slice(0, limit), truncated: true };
    }

    if (records.length < pageSize || !page.next) {
      return { effects: collected, truncated: false };
    }

    page = await page.next();
  }

  return { effects: collected, truncated: false };
}

/**
 * Reads the ledger sequence from the runner params, the environment, or argv.
 *
 * Returns undefined when nothing was supplied, which the caller turns into "use
 * the latest closed ledger" so the example runs with no arguments.
 */
export function resolveLedgerInput(params: LedgerEffectsParams): number | string | undefined {
  const candidates = [params.ledgerSequence, process.env.LEDGER_SEQUENCE, process.argv[3]];

  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) {
      continue;
    }
    if (typeof candidate === 'string' && candidate.trim() === '') {
      continue;
    }
    return candidate;
  }

  return undefined;
}

/**
 * Prints the ledger range this Horizon instance can actually serve.
 *
 * Shown after a ledger lookup fails so the next attempt can be a valid one.
 * Failures here are swallowed: the error that triggered this call is already
 * actionable, and a second one would only bury it.
 */
async function reportAvailableLedgerRange(server: Horizon.Server): Promise<void> {
  try {
    const [oldestPage, latestPage] = await Promise.all([
      server.ledgers().order('asc').limit(1).call(),
      server.ledgers().order('desc').limit(1).call(),
    ]);

    const oldest = oldestPage.records[0];
    const latest = latestPage.records[0];

    if (oldest && latest) {
      console.log(`\nThis instance serves ledgers ${oldest.sequence} through ${latest.sequence}.`);
    }
  } catch {
    // Best-effort context only.
  }
}

/**
 * Runs the ledger effects example.
 *
 * Inputs come from the runner prompts, the `LEDGER_SEQUENCE` and `EFFECT_LIMIT`
 * environment variables, or CLI arguments:
 *
 *   npm run run-example -- 66-ledger-effects <ledgerSequence> <limit>
 *
 * With no ledger sequence the latest closed ledger is inspected.
 */
export async function run(params: LedgerEffectsParams = {}): Promise<void> {
  const horizonUrl = params.horizonUrl || process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const networkPassphrase = process.env.NETWORK_PASSPHRASE || Networks.TESTNET;
  const server = new Horizon.Server(horizonUrl);

  const limit = normalizeLimit(params.limit ?? process.env.EFFECT_LIMIT ?? process.argv[4]);

  console.log('Starting Ledger Effects Example...');
  console.log(`Using Horizon: ${horizonUrl}`);
  console.log(`Network passphrase: ${networkPassphrase}`);
  console.log('');
  console.log('A ledger contains transactions, a transaction contains operations, and an');
  console.log('operation produces effects. Operations are the actions that were requested;');
  console.log('effects are the state changes that actually resulted, so the two counts differ.');

  const ledgerInput = resolveLedgerInput(params);
  let ledgerSequence: number;

  if (ledgerInput === undefined) {
    console.log('\nNo ledger sequence supplied. Using the latest closed ledger.');

    try {
      const latestPage = await server.ledgers().order('desc').limit(1).call();
      const latest = latestPage.records[0];

      if (!latest) {
        console.log('Horizon returned no ledgers. Check the HORIZON_URL setting.');
        return;
      }

      ledgerSequence = latest.sequence;
    } catch (error: unknown) {
      console.log(`Could not reach Horizon: ${getErrorMessage(error)}`);
      console.log('Check HORIZON_URL, or try https://horizon-testnet.stellar.org.');
      return;
    }
  } else {
    try {
      ledgerSequence = normalizeLedgerSequence(ledgerInput);
    } catch (error: unknown) {
      console.log(`\n${getErrorMessage(error)}`);
      console.log('\nUsage:');
      console.log('  npm run run-example -- 66-ledger-effects <ledgerSequence> [limit]');
      console.log('  LEDGER_SEQUENCE=1234567 npm run run-example 66-ledger-effects');
      return;
    }
  }

  console.log(`\nInspecting ledger ${ledgerSequence} (result limit: ${limit})`);

  // Fetched first: a 404 here identifies a missing ledger unambiguously, while
  // the effects endpoint answers an unknown ledger with an empty page that
  // looks identical to a genuinely empty one.
  let header: LedgerHeaderSummary | null = null;
  try {
    const record = await server.ledgers().ledger(ledgerSequence).call();
    header = summarizeLedgerHeader(
      record as unknown as Parameters<typeof summarizeLedgerHeader>[0],
    );
  } catch (error: unknown) {
    if (isHorizonGoneError(error)) {
      console.log(
        `\nLedger ${ledgerSequence} is no longer served by this Horizon instance (HTTP 410 Gone).`,
      );
      console.log('The ledger did close — this instance has simply pruned it. Operators choose');
      console.log('how much history to retain, so a full-history Horizon still has it.');
      await reportAvailableLedgerRange(server);
      return;
    }

    if (isHorizonNotFoundError(error)) {
      console.log(`\nLedger ${ledgerSequence} was not found on this Horizon instance.`);
      console.log('For a ledger request that means it has not closed yet: the sequence is in the');
      console.log('future, or ahead of what this instance has ingested so far.');
      await reportAvailableLedgerRange(server);
      return;
    }

    console.log(`\nCould not read ledger ${ledgerSequence}: ${getErrorMessage(error)}`);
    return;
  }

  let effects: LedgerEffectLike[];
  let truncated: boolean;

  try {
    const result = await retrieveLedgerEffects(
      server as unknown as LedgerEffectsServerLike,
      ledgerSequence,
      limit,
    );
    effects = result.effects;
    truncated = result.truncated;
  } catch (error: unknown) {
    console.log(
      `\nCould not retrieve effects for ledger ${ledgerSequence}: ${getErrorMessage(error)}`,
    );
    return;
  }

  const summary = summarizeLedgerEffects(effects);

  console.log(
    '\n' +
      formatLedgerEffectsReport(ledgerSequence, effects, summary, { limit, header, truncated }),
  );

  console.log('\nHow ledger effects differ from transaction and account effects:');
  console.log('  - Ledger effects cover every transaction in one closed ledger. The set is');
  console.log('    complete, bounded, and final: it will never change or grow.');
  console.log('  - Transaction effects cover one submission across its operations, which is');
  console.log('    what you want after submitting (see example 45-horizon-effects).');
  console.log('  - Account effects cover one participant across all of history, so they span');
  console.log('    many ledgers and keep growing as the account stays active.');
  console.log('  The records themselves are identical; only the scope of the query differs.');
  console.log('\nLedger effects example completed successfully.');
}
