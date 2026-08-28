import { Asset } from '@stellar/stellar-sdk';
import {
  assertIsAssetIssuer,
  getIssuerFlagSummary,
  getTrustlineAuthorizationState,
  isAuthorizationLocked,
  type IssuerFlagsLike,
  type TrustlineBalanceLike,
} from '../src/examples/128-account-authorization-flags';
import { examples } from '../src/runner/catalog';

const ISSUER = 'GBH3KZIVHI3TKR2XRIJES5LUQMQFC22Y3MUFYPAFHUJVOS55O2MQFUYQ';
const OTHER = 'GC4ZWNILJFLN22KU7UQIEB5TIVMHEUXYEIKO5J2AJAGQWI4FYJPGGXYV';

describe('128-account-authorization-flags', () => {
  describe('getIssuerFlagSummary', () => {
    it('maps Horizon flag fields to a summary object', () => {
      const flags: IssuerFlagsLike = {
        auth_required: true,
        auth_revocable: false,
        auth_immutable: false,
        auth_clawback_enabled: true,
      };
      expect(getIssuerFlagSummary(flags)).toEqual({
        authRequired: true,
        authRevocable: false,
        authImmutable: false,
        authClawbackEnabled: true,
      });
    });

    it('defaults clawback to false when absent', () => {
      const flags: IssuerFlagsLike = {
        auth_required: false,
        auth_revocable: false,
        auth_immutable: false,
      };
      expect(getIssuerFlagSummary(flags).authClawbackEnabled).toBe(false);
    });
  });

  describe('isAuthorizationLocked', () => {
    it('is true only when auth_immutable is set', () => {
      expect(
        isAuthorizationLocked({ auth_required: false, auth_revocable: false, auth_immutable: true }),
      ).toBe(true);
      expect(
        isAuthorizationLocked({ auth_required: true, auth_revocable: true, auth_immutable: false }),
      ).toBe(false);
    });
  });

  describe('assertIsAssetIssuer', () => {
    it('does not throw when the signer is the issuer', () => {
      const asset = new Asset('COIN', ISSUER);
      expect(() => assertIsAssetIssuer(asset, ISSUER)).not.toThrow();
    });

    it('throws when the signer is not the issuer', () => {
      const asset = new Asset('COIN', ISSUER);
      expect(() => assertIsAssetIssuer(asset, OTHER)).toThrow(/Unauthorized issuer operation/);
    });

    it('throws for the native asset', () => {
      expect(() => assertIsAssetIssuer(Asset.native(), ISSUER)).toThrow(/no issuer/);
    });
  });

  describe('getTrustlineAuthorizationState', () => {
    const balances: TrustlineBalanceLike[] = [
      {
        asset_type: 'credit_alphanum4',
        asset_code: 'COIN',
        asset_issuer: ISSUER,
        balance: '0',
        is_authorized: true,
      },
    ];

    it('reports AUTHORIZED when is_authorized is true', () => {
      expect(getTrustlineAuthorizationState(balances, 'COIN', ISSUER)).toBe('AUTHORIZED');
    });

    it('reports NOT_FOUND when no matching trustline exists', () => {
      expect(getTrustlineAuthorizationState(balances, 'OTHER', ISSUER)).toBe('NOT_FOUND');
    });

    it('reports UNAUTHORIZED when neither authorization flag is set', () => {
      const unauthorized: TrustlineBalanceLike[] = [
        { asset_type: 'credit_alphanum4', asset_code: 'COIN', asset_issuer: ISSUER, balance: '0' },
      ];
      expect(getTrustlineAuthorizationState(unauthorized, 'COIN', ISSUER)).toBe('UNAUTHORIZED');
    });

    it('reports AUTHORIZED_TO_MAINTAIN_LIABILITIES when that flag is set', () => {
      const partial: TrustlineBalanceLike[] = [
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'COIN',
          asset_issuer: ISSUER,
          balance: '0',
          is_authorized_to_maintain_liabilities: true,
        },
      ];
      expect(getTrustlineAuthorizationState(partial, 'COIN', ISSUER)).toBe(
        'AUTHORIZED_TO_MAINTAIN_LIABILITIES',
      );
    });
  });

  describe('runner registration', () => {
    it('registers 128-account-authorization-flags in the catalog', () => {
      expect(examples['128-account-authorization-flags']).toBeDefined();
      expect(typeof examples['128-account-authorization-flags'].run).toBe('function');
    });
  });
});
