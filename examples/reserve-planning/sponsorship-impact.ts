/** Reserve unit changes for proposed entries or sponsorship transfers. */
export type EntryKind = 'trustline' | 'signer' | 'offer' | 'data';
export interface Change {
  action: 'add' | 'remove' | 'start-sponsorship' | 'end-sponsorship';
  kind: EntryKind;
  sponsorId?: string;
  /** Required when moving sponsorship on an existing ledger entry. */
  entryIsCurrentlySponsored?: boolean;
}
export interface ReserveCounts { subentries: number; sponsoring: number; sponsored: number }
export function validateCounts(value: ReserveCounts): void {
  for (const [name, n] of Object.entries(value)) {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`Invalid ${name} reserve count`);
  }
  if (value.sponsored > value.subentries + 2) throw new Error('Sponsored reserve units exceed owned entries');
}
export function applyChanges(counts: ReserveCounts, changes: Change[], ownerId: string): {
  result: ReserveCounts; sponsorUnitChanges: Record<string, number>; notes: string[];
} {
  validateCounts(counts);
  const result = { ...counts };
  const sponsorUnitChanges: Record<string, number> = {};
  const notes: string[] = [];
  for (const change of changes) {
    if (!['trustline', 'signer', 'offer', 'data'].includes(change.kind)) throw new Error('Unsupported entry kind');
    if (change.sponsorId === ownerId) throw new Error('An account cannot sponsor its own entry');
    if ((change.action === 'start-sponsorship' || change.action === 'end-sponsorship') && !change.sponsorId) {
      throw new Error('Sponsor account ID is required for sponsorship transfer');
    }
    const id = change.sponsorId;
    if (id && !/^G[A-Z2-7]{55}$/.test(id)) throw new Error('Invalid sponsor account ID format');
    const changeSponsor = (units: number) => { if (id) sponsorUnitChanges[id] = (sponsorUnitChanges[id] ?? 0) + units; };
    switch (change.action) {
      case 'add':
        result.subentries++;
        if (id) { result.sponsored++; changeSponsor(1); }
        break;
      case 'remove':
        result.subentries--;
        if (id) { result.sponsored--; changeSponsor(-1); }
        else if (change.entryIsCurrentlySponsored) throw new Error('Specify sponsorId for sponsored removal');
        break;
      case 'start-sponsorship':
        if (change.entryIsCurrentlySponsored) throw new Error('Entry already sponsored');
        result.sponsored++;
        changeSponsor(1);
        break;
      case 'end-sponsorship':
        if (!change.entryIsCurrentlySponsored) throw new Error('End sponsorship requires an existing sponsored entry');
        result.sponsored--;
        changeSponsor(-1);
        break;
      default: throw new Error('Unsupported reserve change action');
    }
    validateCounts(result);
    notes.push(`${change.action} ${change.kind}${id ? ` (sponsor ${id})` : ''}; verify entry ownership and ledger eligibility before submission`);
  }
  return { result, sponsorUnitChanges, notes };
}
