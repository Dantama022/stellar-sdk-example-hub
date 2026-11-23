/** #577: Stellar reserve planning; calculations use integer stroops. */
import {
  Account, Fetcher, Network, account, collect, nativeBalance,
  stroops, unitsToAmount, validAccount,
} from '../_shared/horizon-readonly';
import { applyChanges, Change, ReserveCounts, validateCounts } from './sponsorship-impact';

export interface PlanningOptions {
  baseReserveStroops: string | bigint;
  reserveSource: string;
  changes: Change[];
}
export function reserveMinimum(counts: ReserveCounts, baseReserve: bigint): bigint {
  validateCounts(counts);
  if (baseReserve <= 0n) throw new Error('Invalid base reserve');
  const units = 2n + BigInt(counts.subentries) + BigInt(counts.sponsoring) - BigInt(counts.sponsored);
  if (units < 0n) throw new Error('Invalid reserve units');
  return units * baseReserve;
}
export function planReserves(acc: Account, options: PlanningOptions, sponsorAccounts: Record<string, Account> = {}) {
  const base = stroops(options.baseReserveStroops);
  if (!options.reserveSource?.trim()) throw new Error('Document the source of the base reserve');
  const counts: ReserveCounts = {
    subentries: acc.subentry_count as number,
    sponsoring: acc.num_sponsoring as number,
    sponsored: acc.num_sponsored as number,
  };
  validateCounts(counts);
  const native = nativeBalance(acc);
  const model = applyChanges(counts, options.changes, acc.account_id);
  const before = reserveMinimum(counts, base);
  const after = reserveMinimum(model.result, base);
  const warnings: string[] = [];
  if (!acc.signers || !acc.data) warnings.push('Signer or account-data detail missing; reserve counters remain authoritative.');
  if (acc.sponsor || counts.sponsored || counts.sponsoring) warnings.push('Sponsorship counts describe reserve units, not fully verified entry-to-sponsor ownership.');
  const sponsorImpacts = Object.entries(model.sponsorUnitChanges).map(([sponsorId, deltaUnits]) => {
    const sponsor = sponsorAccounts[sponsorId];
    if (!sponsor) warnings.push(`Sponsor ${sponsorId}: account state not supplied; reserve eligibility unverified.`);
    let availableAfterStroops: string | null = null;
    if (sponsor) {
      const sponsorBalance = nativeBalance(sponsor);
      const sponsorCounts: ReserveCounts = {
        subentries: sponsor.subentry_count as number,
        sponsoring: sponsor.num_sponsoring as number,
        sponsored: sponsor.num_sponsored as number,
      };
      validateCounts(sponsorCounts);
      const next = { ...sponsorCounts, sponsoring: sponsorCounts.sponsoring + deltaUnits };
      validateCounts(next);
      const avail = sponsorBalance.balance - sponsorBalance.sellingLiabilities - reserveMinimum(next, base);
      availableAfterStroops = avail.toString();
      if (avail < 0n) warnings.push(`Sponsor ${sponsorId} may lack XLM after proposed sponsorship.`);
    }
    return { sponsorId, reserveDeltaXlm: unitsToAmount(BigInt(deltaUnits) * base), availableAfterStroops };
  });
  const availableBefore = native.balance - native.sellingLiabilities - before;
  const availableAfter = native.balance - native.sellingLiabilities - after;
  if (availableAfter < 0n) warnings.push('Proposed state may leave insufficient available XLM.');
  return {
    accountId: acc.account_id, baseReserveStroops: base.toString(), reserveSource: options.reserveSource,
    baseReserveIsCallerSupplied: true, existingCounts: counts, proposedCounts: model.result,
    currentXlm: unitsToAmount(native.balance),
    minimumXlm: { current: unitsToAmount(before), proposed: unitsToAmount(after) },
    reserveDifferenceXlm: unitsToAmount(after - before),
    availableAboveMinimumXlm: { current: unitsToAmount(native.balance - before), proposed: unitsToAmount(native.balance - after) },
    nativeSellingLiabilitiesXlm: unitsToAmount(native.sellingLiabilities),
    estimatedSpendableXlm: { current: unitsToAmount(availableBefore), proposed: unitsToAmount(availableAfter) },
    proposedOperations: options.changes, sponsorImpacts, warnings,
    assumptions: [...model.notes, 'Reserve planning is not transaction authorization; fees, ledger changes and liabilities can prevent success.'],
  };
}
interface Offer { id: string; sponsor?: string }
export async function analyzeReservePlan(
  accountId: string, network: Network, options: PlanningOptions, fetcher: Fetcher = fetch,
) {
  validAccount(accountId);
  const acc = await account(accountId, network, fetcher);
  const offers = await collect<Offer>(network, `/accounts/${accountId}/offers?limit=200&order=asc`, 5, fetcher);
  const sponsorIds = Array.from(new Set(options.changes.map((x) => x.sponsorId).filter((x): x is string => !!x)));
  const sponsors: Record<string, Account> = {};
  const extraWarnings: string[] = [];
  for (const id of sponsorIds) {
    validAccount(id);
    try { sponsors[id] = await account(id, network, fetcher); }
    catch (error) { extraWarnings.push(`Unable to inspect sponsor ${id}: ${String(error)}`); }
  }
  const report = planReserves(acc, options, sponsors);
  const trustlines = acc.balances.filter((b) => b.asset_type !== 'native');
  const signers = acc.signers?.filter((s) => s.key !== accountId) ?? [];
  if (!offers.complete) extraWarnings.push('Offer inspection reached pagination cap.');
  return {
    network, ...report,
    inspectedEntries: { trustlines: trustlines.length, offers: offers.records.length, additionalSigners: signers.length,
      sponsoredTrustlinesReported: trustlines.filter((b) => !!b.sponsor).length,
      sponsoredOffersReported: offers.records.filter((o) => !!o.sponsor).length,
      sponsoredSignersReported: signers.filter((s) => !!s.sponsor).length },
    warnings: [...report.warnings, ...extraWarnings],
  };
}
if (require.main === module) {
  const [id, network = 'testnet', base = '5000000'] = process.argv.slice(2);
  analyzeReservePlan(id ?? '', network as Network, {
    baseReserveStroops: base, reserveSource: 'Caller-provided reference; verify with network before use',
    changes: [{ action: 'add', kind: 'trustline' }],
  }).then((r) => console.log(JSON.stringify(r, null, 2))).catch((e: unknown) => { console.error(e); process.exitCode = 1; });
}
