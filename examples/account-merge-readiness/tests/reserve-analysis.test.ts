/**
 * Tests for the reserve and residual balance analysis (ISSUE-378).
 */

import {
  analyzeReserves,
  BASE_RESERVE_XLM,
  calculateAvailableBalance,
  calculateDestinationIncrease,
  calculateMinimumBalance,
  DEFAULT_MERGE_FEE_XLM,
} from '../reserve-analysis';
import type { AccountSnapshot } from '../types';

/** Builds an account snapshot with sensible defaults. */
function snapshot(overrides: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    accountId: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    sequence: '1',
    subentryCount: 0,
    nativeBalance: '10.0000000',
    trustlines: [{ assetType: 'native', balance: '10.0000000' }],
    offers: [],
    signers: [],
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

describe('account merge reserve analysis', () => {
  // ─── Minimum balance ───────────────────────────────────────────────────────

  it('reserves one base reserve for the account itself', () => {
    expect(calculateMinimumBalance(0)).toBe(BASE_RESERVE_XLM);
  });

  it('adds a base reserve for every subentry', () => {
    expect(calculateMinimumBalance(1)).toBe(1);
    expect(calculateMinimumBalance(4)).toBe(2.5);
  });

  it('excludes sponsored entries from the reserve requirement', () => {
    expect(calculateMinimumBalance(3, BASE_RESERVE_XLM, 2)).toBe(1);
  });

  it('never returns a negative owned entry count', () => {
    expect(calculateMinimumBalance(1, BASE_RESERVE_XLM, 5)).toBe(BASE_RESERVE_XLM);
  });

  it('supports a custom base reserve', () => {
    expect(calculateMinimumBalance(2, 1)).toBe(3);
  });

  // ─── Available balance ─────────────────────────────────────────────────────

  it('calculates the balance above the minimum balance', () => {
    expect(calculateAvailableBalance(10, 0.5)).toBe(9.5);
  });

  it('reports a negative available balance when the account is underfunded', () => {
    expect(calculateAvailableBalance(0.25, 0.5)).toBe(-0.25);
  });

  // ─── Destination increase ──────────────────────────────────────────────────

  it('transfers the remaining balance and releases the base reserve', () => {
    expect(calculateDestinationIncrease(10, 0.00001, 0.5)).toBe(10.49999);
  });

  it('never reports a negative destination increase', () => {
    expect(calculateDestinationIncrease(0.000001, 0.00001, 0.5)).toBe(0.5);
  });

  // ─── Report ────────────────────────────────────────────────────────────────

  it('builds the reserve section of the report', () => {
    const analysis = analyzeReserves(snapshot({ subentryCount: 1, nativeBalance: '10.0000000' }));

    expect(analysis.baseReserve).toBe('0.5');
    expect(analysis.subentryCount).toBe(1);
    expect(analysis.minimumBalance).toBe('1');
    expect(analysis.balance).toBe('10');
    expect(analysis.availableBalance).toBe('9');
    expect(analysis.releasedBaseReserve).toBe('0.5');
    expect(analysis.estimatedFee).toBe(String(DEFAULT_MERGE_FEE_XLM));
  });

  it('states its assumptions', () => {
    const analysis = analyzeReserves(snapshot());

    expect(analysis.assumptions.length).toBeGreaterThan(3);
    expect(analysis.assumptions.join(' ')).toContain('base reserve');
  });

  it('mentions sponsored entries in the assumptions', () => {
    const analysis = analyzeReserves(snapshot({ numSponsored: 2 }), { sponsoredEntryCount: 2 });

    expect(analysis.sponsoredEntryCount).toBe(2);
    expect(analysis.assumptions.join(' ')).toContain('sponsored');
  });
});
