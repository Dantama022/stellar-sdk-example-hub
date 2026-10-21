/**
 * Merge blocker analysis (ISSUE-378).
 *
 * The analysis turns the inspected account state into a list of findings that
 * explain whether the account can be merged away.
 *
 * The rules follow the Stellar account merge semantics:
 *
 * - The source account must not own any subentry. Subentries are trustlines
 *   other than the native one, offers, data entries and signers other than
 *   the master key. The ledger reports the authoritative number in
 *   `subentry_count`.
 * - The source account must not sponsor other entries. An account that
 *   sponsors entries has to revoke the sponsorship first.
 * - A claimable balance the account can claim is not a subentry, but merging
 *   the account away would forfeit the claim.
 * - Buying liabilities mean that the account has committed to pay for
 *   assets it does not hold yet.
 *
 * Every finding states whether it is a confirmed fact of the inspected
 * ledger state, a potential blocker or an item that needs a manual check.
 * A finding never claims that a merge is guaranteed to succeed.
 */

import type {
  AccountSnapshot,
  BlockerFinding,
  FindingSeverity,
  MissingInformation,
  MergeReadiness,
} from './types';

/** Protocol rule references used by the findings. */
export const PROTOCOL_RULES = {
  noSubEntries:
    'The source account of an AccountMerge operation must not own any subentry ' +
    '(trustlines other than the native balance line, offers, data entries and signers ' +
    'other than the master key).',
  notASponsor:
    'The source account of an AccountMerge operation must not sponsor other entries. ' +
    'The sponsorship has to be revoked before the account can be merged.',
  liabilities:
    'An account that has committed buying liabilities cannot give away its balance, ' +
    'because the liabilities have to be settled first.',
  claimableBalances:
    'A claimable balance is not a subentry of the claimant, but the claim is lost ' +
    'when the claimant account is merged away.',
  destinationCapacity:
    'The destination account has to be able to hold the merged balance and the ' +
    'subentries of the source account.',
  masterKey:
    'The source account has to sign the AccountMerge operation, so it needs an ' +
    'active master key with a weight above zero.',
};

/**
 * Analyzes the inspected account state for merge blockers.
 *
 * @param snapshot the normalized account state.
 * @param missingInformation information that could not be retrieved.
 */
export function analyzeMergeBlockers(
  snapshot: AccountSnapshot,
  missingInformation: MissingInformation[] = [],
): BlockerFinding[] {
  const findings: BlockerFinding[] = [];

  const nonNativeTrustlines = snapshot.trustlines.filter((line) => line.assetType !== 'native');
  const extraSigners = snapshot.signers.filter(
    (signer) => signer.type !== 'master_key' && signer.weight > 0,
  );
  const masterSigners = snapshot.signers.filter(
    (signer) => signer.type === 'master_key' && signer.weight > 0,
  );

  // ─── Subentries ────────────────────────────────────────────────────────────

  if (snapshot.subentryCount > 0) {
    findings.push({
      id: 'subentries',
      title: 'The account owns subentries',
      severity: 'blocker',
      status: 'confirmed',
      evidence: `The ledger reports ${snapshot.subentryCount} subentry/subentries for this account.`,
      protocolRule: PROTOCOL_RULES.noSubEntries,
      remediation:
        'Remove the subentries (withdraw the trustlines, delete the offers and data ' +
        'entries and remove the extra signers) before merging the account.',
    });
  }

  if (nonNativeTrustlines.length > 0) {
    findings.push({
      id: 'trustlines',
      title: 'The account holds trustlines',
      severity: 'blocker',
      status: 'confirmed',
      evidence: nonNativeTrustlines
        .map((line) => `${line.assetCode ?? 'unknown'} (${line.assetIssuer ?? 'unknown issuer'})`)
        .join(', '),
      protocolRule: PROTOCOL_RULES.noSubEntries,
      remediation: 'Withdraw the trustlines and release the associated reserves.',
    });
  }

  if (snapshot.offers.length > 0) {
    findings.push({
      id: 'offers',
      title: 'The account has open SDEX offers',
      severity: 'blocker',
      status: 'confirmed',
      evidence: `${snapshot.offers.length} offer(s) are open for this account.`,
      protocolRule: PROTOCOL_RULES.noSubEntries,
      remediation: 'Delete the offers before merging the account.',
    });
  }

  if (snapshot.dataEntries.length > 0) {
    findings.push({
      id: 'data-entries',
      title: 'The account has data entries',
      severity: 'blocker',
      status: 'confirmed',
      evidence: snapshot.dataEntries.map((entry) => entry.name).join(', '),
      protocolRule: PROTOCOL_RULES.noSubEntries,
      remediation: 'Delete the data entries before merging the account.',
    });
  }

  if (extraSigners.length > 0) {
    findings.push({
      id: 'signers',
      title: 'The account has additional signers',
      severity: 'blocker',
      status: 'confirmed',
      evidence: extraSigners.map((signer) => `${signer.key} (weight ${signer.weight})`).join(', '),
      protocolRule: PROTOCOL_RULES.noSubEntries,
      remediation: 'Remove the additional signers before merging the account.',
    });
  }

  // ─── Sponsorship ───────────────────────────────────────────────────────────

  if (snapshot.numSponsoring > 0) {
    findings.push({
      id: 'sponsoring',
      title: 'The account sponsors other entries',
      severity: 'blocker',
      status: 'confirmed',
      evidence: `The account sponsors ${snapshot.numSponsoring} entr(y|ies).`,
      protocolRule: PROTOCOL_RULES.notASponsor,
      remediation: 'Revoke the sponsorship of every sponsored entry before merging.',
    });
  }

  if (snapshot.numSponsored > 0) {
    findings.push({
      id: 'sponsored-entries',
      title: 'The account has sponsored entries',
      severity: 'warning',
      status: 'needs-review',
      evidence: `The account has ${snapshot.numSponsored} sponsored entr(y|ies).`,
      protocolRule:
        'Sponsored entries change both the subentry accounting and the reserve ' +
        'responsibility of the account. The exact treatment depends on the entry type.',
      remediation:
        'Check the sponsored entries in the ledger and revoke the sponsorship before merging.',
    });
  }

  if (snapshot.sponsor) {
    findings.push({
      id: 'sponsored-account',
      title: 'The account is sponsored by another account',
      severity: 'info',
      status: 'confirmed',
      evidence: `The sponsoring account is ${snapshot.sponsor}.`,
      protocolRule:
        'A sponsored account can be merged; the sponsorship ends with the account and the ' +
        'reserve responsibility returns to the sponsor.',
      remediation: 'Inform the sponsoring account before merging.',
    });
  }

  // ─── Liabilities and claims ────────────────────────────────────────────────

  const liabilities = snapshot.trustlines.filter(
    (line) => Number(line.buyingLiabilities ?? '0') > 0,
  );
  if (liabilities.length > 0) {
    findings.push({
      id: 'liabilities',
      title: 'The account has buying liabilities',
      severity: 'warning',
      status: 'potential',
      evidence: liabilities
        .map((line) => `${line.assetCode ?? 'unknown'}: ${line.buyingLiabilities}`)
        .join(', '),
      protocolRule: PROTOCOL_RULES.liabilities,
      remediation: 'Sell the assets or wait for the liabilities to settle before merging.',
    });
  }

  if (snapshot.claimableBalances.length > 0) {
    findings.push({
      id: 'claimable-balances',
      title: 'The account can claim balances that would be lost',
      severity: 'warning',
      status: 'needs-review',
      evidence: `${snapshot.claimableBalances.length} claimable balance(s) list this account as a claimant.`,
      protocolRule: PROTOCOL_RULES.claimableBalances,
      remediation: 'Claim the balances before merging the account.',
    });
  }

  // ─── Signers and flags ─────────────────────────────────────────────────────

  if (masterSigners.length === 0) {
    findings.push({
      id: 'master-key',
      title: 'No usable master key was found',
      severity: 'blocker',
      status: 'confirmed',
      evidence: 'The account has no master key with a weight above zero.',
      protocolRule: PROTOCOL_RULES.masterKey,
      remediation: 'The account cannot sign a merge transaction without an active master key.',
    });
  }

  if (snapshot.flags.authImmutable) {
    findings.push({
      id: 'auth-immutable',
      title: 'The account has the AUTH_IMMUTABLE flag',
      severity: 'info',
      status: 'confirmed',
      evidence: 'The account flags contain auth_immutable.',
      protocolRule:
        'AUTH_IMMUTABLE prevents further changes of the account flags. It does not prevent ' +
        'a merge, but the flags of the source account are removed with the account.',
      remediation: 'No action required for the merge itself.',
    });
  }

  // ─── Missing information ───────────────────────────────────────────────────

  for (const missing of missingInformation) {
    findings.push({
      id: `missing-${missing.field}`,
      title: `The ${missing.field} could not be retrieved`,
      severity: 'warning',
      status: 'needs-review',
      evidence: missing.reason,
      protocolRule:
        'A blocker that cannot be observed cannot be ruled out, so the audit cannot ' +
        'guarantee that the merge succeeds.',
      remediation: 'Retry the audit against an endpoint that exposes the missing data.',
    });
  }

  return sortFindings(findings);
}

/** Sorts findings by severity and identifier so the report is deterministic. */
function sortFindings(findings: BlockerFinding[]): BlockerFinding[] {
  const weight: Record<FindingSeverity, number> = { blocker: 0, warning: 1, info: 2 };
  return [...findings].sort((left, right) => {
    if (weight[left.severity] !== weight[right.severity]) {
      return weight[left.severity] - weight[right.severity];
    }
    return left.id.localeCompare(right.id);
  });
}

/**
 * Classifies the merge readiness of the account.
 *
 * The classification is deliberately cautious: it is never a guarantee that a
 * merge transaction will succeed.
 */
export function classifyMergeReadiness(
  findings: BlockerFinding[],
  missingInformation: MissingInformation[] = [],
): { readiness: MergeReadiness; evidence: string[] } {
  const evidence: string[] = [];

  if (!findings.length && !missingInformation.length) {
    evidence.push('No subentries, signers, offers or sponsorship were found on the account.');
    return { readiness: 'no_obvious_blockers', evidence };
  }

  const confirmedBlockers = findings.filter(
    (finding) => finding.severity === 'blocker' && finding.status === 'confirmed',
  );
  const potentialBlockers = findings.filter(
    (finding) => finding.severity === 'blocker' && finding.status !== 'confirmed',
  );
  const needsReview = findings.filter((finding) => finding.status === 'needs-review');

  if (confirmedBlockers.length > 0) {
    for (const finding of confirmedBlockers) {
      evidence.push(`${finding.title}: ${finding.evidence}`);
    }
    evidence.push('A confirmed blocker has to be removed before the account can be merged.');
    return { readiness: 'potential_blockers', evidence };
  }

  if (potentialBlockers.length > 0) {
    for (const finding of potentialBlockers) {
      evidence.push(`${finding.title}: ${finding.evidence}`);
    }
    return { readiness: 'potential_blockers', evidence };
  }

  if (needsReview.length > 0 || missingInformation.length > 0) {
    for (const finding of needsReview) {
      evidence.push(`${finding.title}: ${finding.evidence}`);
    }
    for (const missing of missingInformation) {
      evidence.push(`Missing information: ${missing.field} (${missing.reason})`);
    }
    evidence.push(
      'The remaining questions have to be answered manually before the merge is submitted.',
    );
    return { readiness: 'additional_review_required', evidence };
  }

  for (const finding of findings) {
    evidence.push(`${finding.title}: ${finding.evidence}`);
  }
  return { readiness: 'no_obvious_blockers', evidence };
}
