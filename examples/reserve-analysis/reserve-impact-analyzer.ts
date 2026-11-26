/** #578: hypothetical reserve comparisons; no transactions or secret keys. */
import {
  HorizonAccount, JsonFetcher, Network, loadAccount, pages,
  parseStroops, parseUnits, percent, units, validateAccount,
} from '../_shared/horizon';

export interface ReserveInputs {
  currentBaseReserveStroops: string | bigint;
  proposedBaseReserveStroops: string | bigint;
  currentSource: string;
  proposedSource: string;
}

export function compareReserve(account: HorizonAccount, inputs: ReserveInputs) {
  const current = parseStroops(inputs.currentBaseReserveStroops, 'current base reserve');
  const proposed = parseStroops(inputs.proposedBaseReserveStroops, 'proposed base reserve');
  if (!inputs.currentSource?.trim() || !inputs.proposedSource?.trim()) {
    throw new Error('Describe the source of each reserve parameter');
  }
  const subentries = account.subentry_count;
  if (subentries === undefined || !Number.isSafeInteger(subentries) || subentries < 0) {
    throw new Error('Missing or invalid subentry_count');
  }
  const warnings: string[] = [];
  const sponsoring = account.num_sponsoring;
  const sponsored = account.num_sponsored;
  if (!Number.isSafeInteger(sponsoring) || !Number.isSafeInteger(sponsored) ||
      sponsoring === undefined || sponsored === undefined || sponsoring < 0 || sponsored < 0) {
    throw new Error('Missing or invalid sponsorship counters: reserve cannot be verified');
  }
  const unitsDue = 2n + BigInt(subentries) + BigInt(sponsoring) - BigInt(sponsored);
  if (unitsDue < 0n) throw new Error('Invalid reserve calculation: negative reserve units');
  const native = account.balances.find((entry) => entry.asset_type === 'native');
  if (!native) throw new Error('Missing native XLM balance');
  const balance = parseUnits(native.balance, 'XLM balance');
  const liabilities = parseUnits(native.selling_liabilities ?? '0', 'XLM selling liabilities');
  const oldMinimum = unitsDue * current;
  const newMinimum = unitsDue * proposed;
  const delta = newMinimum - oldMinimum;
  const currentAvailable = balance - oldMinimum;
  const proposedAvailable = balance - newMinimum;
  const currentSpendable = currentAvailable - liabilities;
  const proposedSpendable = proposedAvailable - liabilities;
  if (account.num_sponsoring || account.num_sponsored || account.sponsor) {
    warnings.push('Sponsorship counters include ledger reserve units; individual sponsor-to-entry mappings cannot be fully verified from this account snapshot.');
  }
  if (newMinimum > balance) warnings.push('XLM balance is below the hypothetical proposed minimum.');
  if (proposedSpendable < 0n) warnings.push('Proposed available XLM after selling liabilities is negative.');
  return {
    accountId: account.account_id,
    balanceXlm: units(balance),
    baseReserve: { currentStroops: current.toString(), currentSource: inputs.currentSource,
      proposedStroops: proposed.toString(), proposedSource: inputs.proposedSource,
      proposedIsHypothetical: true },
    reserveUnits: unitsDue.toString(),
    subentryCount: account.subentry_count,
    sponsorship: { sponsoringReserveUnits: sponsoring, sponsoredReserveUnits: sponsored,
      sponsorOfAccount: account.sponsor ?? null,
      sponsoringContributionChangeXlm: units(BigInt(sponsoring) * (proposed - current)),
      sponsoredReliefChangeXlm: units(BigInt(sponsored) * (proposed - current)) },
    minimumBalanceXlm: { current: units(oldMinimum), proposed: units(newMinimum) },
    deltaXlm: units(delta),
    absoluteReserveDifferenceXlm: units(delta < 0n ? -delta : delta),
    changePercent: percent(delta, oldMinimum),
    availableBeforeLiabilitiesXlm: { current: units(currentAvailable), proposed: units(proposedAvailable) },
    sellingLiabilitiesXlm: units(liabilities),
    estimatedSpendableXlm: { current: units(currentSpendable), proposed: units(proposedSpendable) },
    additionalXlmNeeded: units(newMinimum > balance ? newMinimum - balance : 0n),
    warnings,
  };
}

interface HorizonOffer { id: string; sponsor?: string }

/** Inspects trustlines/signers/offers; authoritative reserve counts remain Horizon account counters. */
export async function analyzeReserve(
  accountId: string, network: Network, inputs: ReserveInputs,
  fetcher: JsonFetcher = fetch,
) {
  validateAccount(accountId);
  const account = await loadAccount(accountId, network, fetcher);
  const report = compareReserve(account, inputs);
  const offers = await pages<HorizonOffer>(
    network, `/accounts/${accountId}/offers?limit=200&order=asc`, 5, fetcher,
  );
  const trustlines = account.balances.filter((b) => b.asset_type !== 'native');
  const additionalSigners = (account.signers ?? []).filter((s) => s.key !== accountId);
  const observed = trustlines.length + offers.records.length + additionalSigners.length;
  const warnings = [...report.warnings];
  if (!offers.complete) warnings.push('Offer listing hit its pagination limit; offer count may be incomplete.');
  if (!account.signers) warnings.push('Signer metadata unavailable.');
  if (observed > (account.subentry_count ?? 0)) {
    warnings.push('Observed entry count exceeds account subentry count; inspect ledger metadata.');
  }
  if (observed < (account.subentry_count ?? 0)) {
    warnings.push('Other subentry types may exist (e.g. data entries); do not derive reserve from the listed entries.');
  }
  return {
    network, ...report,
    inspectedEntries: {
      trustlineCount: trustlines.length, offerCount: offers.records.length,
      additionalSignerCount: additionalSigners.length,
      sponsoredTrustlineEntriesReported: trustlines.filter((b) => Boolean(b.sponsor)).length,
      sponsoredOffersReported: offers.records.filter((o) => Boolean(o.sponsor)).length,
      sponsoredSignersReported: additionalSigners.filter((s) => Boolean(s.sponsor)).length,
    },
    warnings,
    note: 'A scenario, not an approved network reserve change. Minimum balance excludes selling liabilities.',
  };
}

if (require.main === module) {
  const [accountId, network = 'testnet', current = '5000000', proposed = '10000000'] = process.argv.slice(2);
  analyzeReserve(accountId ?? '', network as Network, {
    currentBaseReserveStroops: current, proposedBaseReserveStroops: proposed,
    currentSource: 'caller-supplied reference value (verify against network)',
    proposedSource: 'caller-supplied hypothetical scenario',
  }).then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
