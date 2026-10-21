/**
 * Tests for the account merge blocker analysis (ISSUE-378).
 *
 * The tests use synthetic account fixtures so that no network access is
 * required.
 */

import { analyzeMergeBlockers, classifyMergeReadiness, PROTOCOL_RULES } from '../blocker-analysis';
import type { AccountSnapshot, MissingInformation } from '../types';

/** Builds an account snapshot with sensible defaults. */
function snapshot(overrides: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    accountId: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    sequence: '12345',
    subentryCount: 0,
    nativeBalance: '10.0000000',
    trustlines: [{ assetType: 'native', balance: '10.0000000' }],
    offers: [],
    signers: [
      {
        key: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        weight: 1,
        type: 'master_key',
      },
    ],
    dataEntries: [],
    claimableBalances: [],
    numSponsoring: 0,
    numSponsored: 0,
    thresholds: { low: 0, medium: 0, high: 0 },
    flags: {
      authRequired: false,
      authRevocable: false,
      authImmutable: false,
      authClawbackEnabled: false,
    },
    ...overrides,
  };
}

/** Returns the finding with the given id. */
function findingById(findings: ReturnType<typeof analyzeMergeBlockers>, id: string) {
  return findings.find((finding) => finding.id === id);
}

describe('account merge blocker analysis', () => {
  // ─── Accounts without blockers ─────────────────────────────────────────────

  it('reports no blockers for an account without subentries', () => {
    const findings = analyzeMergeBlockers(snapshot());

    expect(findings.filter((finding) => finding.severity === 'blocker')).toHaveLength(0);
  });

  it('classifies a clean account as no_obvious_blockers', () => {
    const findings = analyzeMergeBlockers(snapshot());
    const { readiness, evidence } = classifyMergeReadiness(findings);

    expect(readiness).toBe('no_obvious_blockers');
    expect(evidence.length).toBeGreaterThan(0);
  });

  // ─── Subentries ────────────────────────────────────────────────────────────

  it('detects trustlines as a blocker', () => {
    const findings = analyzeMergeBlockers(
      snapshot({
        subentryCount: 1,
        trustlines: [
          { assetType: 'native', balance: '10.0000000' },
          {
            assetType: 'credit_alphanum4',
            assetCode: 'USD',
            assetIssuer: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
            balance: '5.0000000',
          },
        ],
      }),
    );
    const finding = findingById(findings, 'trustlines');

    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('blocker');
    expect(finding?.status).toBe('confirmed');
    expect(finding?.protocolRule).toBe(PROTOCOL_RULES.noSubEntries);
  });

  it('detects offers as a blocker', () => {
    const findings = analyzeMergeBlockers(
      snapshot({
        subentryCount: 1,
        offers: [
          {
            id: '1',
            seller: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
            selling: { assetType: 'native', amount: '1.0000000' },
            buying: { assetType: 'credit_alphanum4', assetCode: 'USD', amount: '2.0000000' },
          },
        ],
      }),
    );

    expect(findingById(findings, 'offers')?.severity).toBe('blocker');
  });

  it('detects data entries as a blocker', () => {
    const findings = analyzeMergeBlockers(
      snapshot({ subentryCount: 1, dataEntries: [{ name: 'config' }] }),
    );

    expect(findingById(findings, 'data-entries')?.severity).toBe('blocker');
  });

  it('detects additional signers as a blocker', () => {
    const findings = analyzeMergeBlockers(
      snapshot({
        subentryCount: 1,
        signers: [
          {
            key: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
            weight: 1,
            type: 'master_key',
          },
          {
            key: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
            weight: 1,
            type: 'signer',
          },
        ],
      }),
    );

    expect(findingById(findings, 'signers')?.severity).toBe('blocker');
  });

  it('detects the reported subentry count as a blocker', () => {
    const findings = analyzeMergeBlockers(snapshot({ subentryCount: 3 }));
    const finding = findingById(findings, 'subentries');

    expect(finding?.severity).toBe('blocker');
    expect(finding?.evidence).toContain('3');
  });

  it('classifies an account with subentries as potential_blockers', () => {
    const findings = analyzeMergeBlockers(snapshot({ subentryCount: 1 }));
    const { readiness } = classifyMergeReadiness(findings);

    expect(readiness).toBe('potential_blockers');
  });

  // ─── Sponsorship ───────────────────────────────────────────────────────────

  it('detects an account that sponsors other entries', () => {
    const findings = analyzeMergeBlockers(snapshot({ numSponsoring: 2 }));
    const finding = findingById(findings, 'sponsoring');

    expect(finding?.severity).toBe('blocker');
    expect(finding?.protocolRule).toBe(PROTOCOL_RULES.notASponsor);
  });

  it('flags sponsored entries as an item that needs review', () => {
    const findings = analyzeMergeBlockers(snapshot({ numSponsored: 1 }));
    const finding = findingById(findings, 'sponsored-entries');

    expect(finding?.status).toBe('needs-review');
    expect(finding?.severity).toBe('warning');
  });

  it('reports a sponsored account as informational', () => {
    const findings = analyzeMergeBlockers(
      snapshot({ sponsor: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' }),
    );
    const finding = findingById(findings, 'sponsored-account');

    expect(finding?.severity).toBe('info');
    expect(finding?.status).toBe('confirmed');
  });

  // ─── Liabilities and claims ───────────────────────────────────────────────

  it('flags buying liabilities as a potential blocker', () => {
    const findings = analyzeMergeBlockers(
      snapshot({
        trustlines: [
          { assetType: 'native', balance: '10.0000000' },
          {
            assetType: 'credit_alphanum4',
            assetCode: 'USD',
            assetIssuer: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
            balance: '5.0000000',
            buyingLiabilities: '2.0000000',
          },
        ],
      }),
    );

    expect(findingById(findings, 'liabilities')?.status).toBe('potential');
  });

  it('flags claimable balances as an item that needs review', () => {
    const findings = analyzeMergeBlockers(
      snapshot({
        claimableBalances: [
          {
            id: '1',
            asset: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
            amount: '1.0000000',
            claimants: [
              {
                address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
                predicate: 'unconditional',
              },
            ],
          },
        ],
      }),
    );

    expect(findingById(findings, 'claimable-balances')?.status).toBe('needs-review');
  });

  // ─── Signers and flags ─────────────────────────────────────────────────────

  it('reports a missing master key as a blocker', () => {
    const findings = analyzeMergeBlockers(snapshot({ signers: [] }));

    expect(findingById(findings, 'master-key')?.severity).toBe('blocker');
  });

  it('reports the AUTH_IMMUTABLE flag as informational', () => {
    const findings = analyzeMergeBlockers(
      snapshot({
        flags: {
          authRequired: false,
          authRevocable: false,
          authImmutable: true,
          authClawbackEnabled: false,
        },
      }),
    );

    expect(findingById(findings, 'auth-immutable')?.severity).toBe('info');
  });

  // ─── Missing information ───────────────────────────────────────────────────

  it('reports missing information as an item that needs review', () => {
    const missing: MissingInformation[] = [{ field: 'offers', reason: 'timeout' }];
    const findings = analyzeMergeBlockers(snapshot(), missing);

    expect(findingById(findings, 'missing-offers')?.status).toBe('needs-review');
  });

  it('classifies an account with missing information as additional_review_required', () => {
    const missing: MissingInformation[] = [{ field: 'offers', reason: 'timeout' }];
    const findings = analyzeMergeBlockers(snapshot(), missing);
    const { readiness } = classifyMergeReadiness(findings, missing);

    expect(readiness).toBe('additional_review_required');
  });

  it('never reports a guaranteed merge', () => {
    const findings = analyzeMergeBlockers(snapshot());
    const { readiness } = classifyMergeReadiness(findings);

    expect(readiness).not.toBe('guaranteed');
    expect(readiness).not.toBe('merge_will_succeed');
  });

  it('produces deterministic findings', () => {
    const first = analyzeMergeBlockers(snapshot({ subentryCount: 2, numSponsoring: 1 }));
    const second = analyzeMergeBlockers(snapshot({ subentryCount: 2, numSponsoring: 1 }));

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
