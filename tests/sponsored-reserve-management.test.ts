import {
  SUPPORTED_SPONSORSHIP_TARGETS,
  assertSponsorHasSufficientReserve,
  calculateReserveImpact,
  isSupportedSponsorshipTarget,
  stroopsToXlm,
  type SponsorshipSummary,
} from '../src/examples/130-sponsored-reserve-management';
import { examples } from '../src/runner/catalog';

describe('130-sponsored-reserve-management', () => {
  describe('stroopsToXlm', () => {
    it('converts stroops to a 7-decimal XLM string', () => {
      expect(stroopsToXlm(10_000_000)).toBe('1.0000000');
      expect(stroopsToXlm(5_000_000)).toBe('0.5000000');
    });
  });

  describe('isSupportedSponsorshipTarget', () => {
    it.each(SUPPORTED_SPONSORSHIP_TARGETS)('accepts supported target "%s"', (target) => {
      expect(isSupportedSponsorshipTarget(target)).toBe(true);
    });

    it('rejects an unsupported target', () => {
      expect(isSupportedSponsorshipTarget('liquidity_pool_participation')).toBe(false);
    });
  });

  describe('assertSponsorHasSufficientReserve', () => {
    it('does not throw when the sponsor has enough balance', () => {
      // 3 reserve units * 0.5 XLM base reserve + 1 XLM buffer = 2.5 XLM required
      expect(() => assertSponsorHasSufficientReserve(10, 3, 5_000_000)).not.toThrow();
    });

    it('throws a descriptive error when the sponsor balance is too low', () => {
      expect(() => assertSponsorHasSufficientReserve(1, 3, 5_000_000)).toThrow(
        /Insufficient sponsor balance/,
      );
    });
  });

  describe('calculateReserveImpact', () => {
    const summary: SponsorshipSummary = {
      accountId: 'GACCOUNT',
      accountEntrySponsor: null,
      sponsoringReserveUnits: 2,
      sponsoredReserveUnits: 1,
      subentryCount: 0,
    };

    it('computes outgoing and incoming reserve responsibility in XLM', () => {
      const impact = calculateReserveImpact(summary, 5_000_000);
      expect(impact.baseReserveXlm).toBe('0.5000000');
      expect(impact.outgoingReserveResponsibilityXlm).toBe('1.0000000');
      expect(impact.incomingReserveReliefXlm).toBe('0.5000000');
    });
  });

  describe('runner registration', () => {
    it('registers 130-sponsored-reserve-management in the catalog', () => {
      expect(examples['130-sponsored-reserve-management']).toBeDefined();
      expect(typeof examples['130-sponsored-reserve-management'].run).toBe('function');
    });
  });
});
