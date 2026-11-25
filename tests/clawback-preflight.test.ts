import { Networks, TransactionBuilder } from '@stellar/stellar-sdk';

import {
  assessClawbackEligibility,
  buildClawbackPreflightTransaction,
  describeTrustlineState,
  findTrustline,
  formatStroops,
  loadAccountSnapshot,
  parseAmountToStroops,
  type AccountLoader,
  type AccountSnapshot,
  type ClawbackInput,
  type TrustlineInfo,
} from '../examples/assets/clawback-preflight';

const ISSUER = 'GB6ZS324HT6VEEDZ6MG6CESWE7YZSY7WAJDRQSP2GZCRZ5GBND377A2F';
const HOLDER = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

function flags(clawback: boolean, revocable = false, immutable = false) {
  return {
    authRequired: true,
    authRevocable: revocable,
    authClawbackEnabled: clawback,
    authImmutable: immutable,
  };
}

function trustline(overrides: Partial<TrustlineInfo> = {}): TrustlineInfo {
  return {
    assetCode: 'USD',
    issuer: ISSUER,
    balanceStroops: 25n * 10_000_000n,
    authorized: true,
    authorizedToMaintainLiabilities: false,
    ...overrides,
  };
}

function snapshot(overrides: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    accountId: HOLDER,
    sequence: '123',
    flags: flags(true),
    trustlines: [trustline()],
    ...overrides,
  };
}

function input(overrides: Partial<ClawbackInput> = {}): ClawbackInput {
  return {
    assetCode: 'USD',
    issuer: ISSUER,
    holder: HOLDER,
    amount: '10.5',
    issuerAccount: snapshot({ accountId: ISSUER }),
    holderAccount: snapshot(),
    protocolVersion: 22,
    ...overrides,
  };
}

function codes(report: ReturnType<typeof assessClawbackEligibility>): string[] {
  return report.failedPreconditions.map((precondition) => precondition.code);
}

describe('clawback preflight (ISSUE-403)', () => {
  describe('amount arithmetic', () => {
    it('converts decimal amounts to exact stroops', () => {
      expect(parseAmountToStroops('10.5')).toBe(105_000_000n);
      expect(parseAmountToStroops('0.0000001')).toBe(1n);
      expect(parseAmountToStroops('12')).toBe(120_000_000n);
    });

    it('rejects malformed amounts and excess precision', () => {
      expect(() => parseAmountToStroops('1.12345678')).toThrow(/Invalid amount/);
      expect(() => parseAmountToStroops('-1')).toThrow(/Invalid amount/);
    });

    it('formats stroops with seven decimals', () => {
      expect(formatStroops(10_000_000n)).toBe('1.0000000');
      expect(formatStroops(5_000_000n)).toBe('0.5000000');
    });
  });

  describe('preconditions', () => {
    it('accepts an issuer with clawback enabled and a valid amount', () => {
      const report = assessClawbackEligibility(input());
      expect(report.eligible).toBe(true);
      expect(report.remainingBalance).toBe('14.5000000');
      expect(report.trustlineState).toBe('authorized');
    });

    it('rejects an issuer without clawback enabled', () => {
      const report = assessClawbackEligibility(
        input({ issuerAccount: snapshot({ accountId: ISSUER, flags: flags(false) }) }),
      );
      expect(codes(report)).toContain('clawback-disabled');
      expect(report.clawbackEnabled).toBe(false);
      expect(report.recommendations.join(' ')).toMatch(/AUTH_CLAWBACK_ENABLED/);
    });

    it('rejects a holder with a missing trustline', () => {
      const report = assessClawbackEligibility(
        input({ holderAccount: snapshot({ trustlines: [] }) }),
      );
      expect(codes(report)).toContain('trustline-missing');
      expect(report.trustlineState).toBe('missing');
      expect(report.remainingBalance).toBeNull();
    });

    it('reports an unauthorized holder trustline', () => {
      const unauthorized = snapshot({ trustlines: [trustline({ authorized: false })] });
      const report = assessClawbackEligibility(input({ holderAccount: unauthorized }));
      expect(report.trustlineState).toBe('unauthorized');
      expect(codes(report)).toContain('trustline-unauthorized');
      expect(describeTrustlineState(findTrustline(unauthorized, 'USD', ISSUER))).toBe(
        'unauthorized',
      );
    });

    it('warns for a revocable unauthorized trustline', () => {
      const account = snapshot({
        flags: flags(true, true),
        trustlines: [trustline({ authorized: false })],
      });
      const report = assessClawbackEligibility(
        input({
          holderAccount: account,
          issuerAccount: snapshot({ accountId: ISSUER, flags: flags(true, true) }),
        }),
      );
      expect(codes(report)).not.toContain('trustline-unauthorized');
      expect(report.warnings.join(' ')).toMatch(/unauthorized/);
    });

    it('rejects zero and negative amounts', () => {
      expect(codes(assessClawbackEligibility(input({ amount: '0' })))).toContain(
        'amount-nonpositive',
      );
      expect(codes(assessClawbackEligibility(input({ amount: '-1' })))).toContain('amount-invalid');
    });

    it('rejects an amount exceeding the holder balance', () => {
      const report = assessClawbackEligibility(input({ amount: '26' }));
      expect(codes(report)).toContain('amount-exceeds-balance');
      expect(report.remainingBalance).toBeNull();
    });

    it('handles a full-balance clawback', () => {
      const report = assessClawbackEligibility(input({ amount: '25.0000000' }));
      expect(report.remainingBalance).toBe('0.0000000');
      expect(report.warnings.join(' ')).toMatch(/entire asset balance/);
      expect(report.eligible).toBe(true);
    });

    it('rejects an invalid asset configuration', () => {
      const report = assessClawbackEligibility(
        input({ assetCode: 'XLM', issuer: 'BAD', holder: 'BAD', protocolVersion: 16 }),
      );
      expect(codes(report)).toEqual(
        expect.arrayContaining([
          'asset-code-invalid',
          'issuer-invalid',
          'holder-invalid',
          'protocol-unsupported',
        ]),
      );
    });
  });

  describe('account retrieval', () => {
    const record = {
      account_id: ISSUER,
      sequence: '123',
      flags: { auth_clawback_enabled: true, auth_revocable: true },
      balances: [
        { asset_type: 'native', balance: '10.0000000' },
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'USD',
          asset_issuer: ISSUER,
          balance: '25.0000000',
          authorized: true,
        },
      ],
    };
    const okLoader: AccountLoader = { loadAccount: async () => record };

    it('extracts clawback flags and trustlines from a Horizon response', async () => {
      const account = await loadAccountSnapshot(okLoader, ISSUER);
      expect(account.flags.authClawbackEnabled).toBe(true);
      expect(account.trustlines).toHaveLength(1);
      expect(account.trustlines[0].balanceStroops).toBe(250_000_000n);
    });

    it('distinguishes a missing account from ineligibility', async () => {
      const loader: AccountLoader = {
        loadAccount: async () => {
          throw new Error('404 Not Found');
        },
      };
      await expect(loadAccountSnapshot(loader, ISSUER)).rejects.toThrow(
        /Unable to load account .*404 Not Found/,
      );
    });

    it('distinguishes a network lookup failure from ineligibility', async () => {
      const loader: AccountLoader = {
        loadAccount: async () => {
          throw new Error('ECONNRESET');
        },
      };
      await expect(loadAccountSnapshot(loader, HOLDER)).rejects.toThrow(
        /Unable to load account .*ECONNRESET/,
      );
    });
  });

  describe('transaction construction', () => {
    it('builds an unsigned clawback transaction with an XDR preview', () => {
      const result = buildClawbackPreflightTransaction({
        assetCode: 'USD',
        issuer: ISSUER,
        holder: HOLDER,
        amount: '10.5',
        sequence: '123',
        networkPassphrase: Networks.TESTNET,
      });
      expect(result.operationCount).toBe(1);
      expect(result.xdr.length).toBeGreaterThan(20);
      const restored = TransactionBuilder.fromXDR(result.xdr, Networks.TESTNET);
      expect(restored.signatures).toHaveLength(0);
    });

    it('refuses to build for an invalid asset', () => {
      expect(() =>
        buildClawbackPreflightTransaction({
          assetCode: 'XLM',
          issuer: ISSUER,
          holder: HOLDER,
          amount: '1',
          sequence: '1',
        }),
      ).toThrow(/Invalid clawback asset code/);
    });
  });
});
