import {
  checkClawback,
  checkFlagTransition,
  formatAssetControlReport,
  getAuthorizationState,
  summarizeHolders,
} from '../src/examples/260-asset-issuance-controls';

const issuer = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const code = 'ISSUED';

const noFlags = { authRequired: false, authRevocable: false, authImmutable: false };

function trustline(overrides: Partial<Parameters<typeof getAuthorizationState>[0][number]> = {}) {
  return {
    asset_type: 'credit_alphanum4',
    asset_code: code,
    asset_issuer: issuer,
    balance: '100',
    ...overrides,
  };
}

describe('ISSUE-307: asset issuance, authorization and clawback controls', () => {
  it('reads the authorization state of a trustline', () => {
    expect(getAuthorizationState([trustline({ is_authorized: true })], code, issuer)).toBe(
      'AUTHORIZED',
    );
    expect(
      getAuthorizationState(
        [trustline({ is_authorized_to_maintain_liabilities: true })],
        code,
        issuer,
      ),
    ).toBe('AUTHORIZED_TO_MAINTAIN_LIABILITIES');
    expect(getAuthorizationState([trustline()], code, issuer)).toBe('UNAUTHORIZED');
    expect(getAuthorizationState([], code, issuer)).toBe('NOT_FOUND');
  });

  it('ignores trustlines for other assets or issuers', () => {
    const balances = [
      trustline({ asset_code: 'OTHER', is_authorized: true }),
      trustline({ asset_issuer: 'GOTHER', is_authorized: true }),
    ];
    expect(getAuthorizationState(balances, code, issuer)).toBe('NOT_FOUND');
  });

  it('allows a legal flag transition', () => {
    const check = checkFlagTransition(noFlags, { ...noFlags, authRevocable: true });
    expect(check.allowed).toBe(true);
    expect(check.problems).toEqual([]);
  });

  it('rejects any change once AUTH_IMMUTABLE is set', () => {
    const check = checkFlagTransition(
      { authRequired: true, authRevocable: true, authImmutable: true },
      { authRequired: true, authRevocable: false, authImmutable: true },
    );
    expect(check.allowed).toBe(false);
    expect(check.problems.join(' ')).toContain('AUTH_IMMUTABLE is already set');
  });

  it('rejects turning AUTH_REQUIRED off', () => {
    const check = checkFlagTransition(
      { authRequired: true, authRevocable: false, authImmutable: false },
      { authRequired: false, authRevocable: false, authImmutable: false },
    );
    expect(check.allowed).toBe(false);
    expect(check.problems.join(' ')).toContain('cannot be turned off');
  });

  it('rejects turning AUTH_REQUIRED on once trustlines exist', () => {
    const check = checkFlagTransition(
      noFlags,
      { ...noFlags, authRequired: true },
      {
        hasExistingTrustlines: true,
      },
    );
    expect(check.allowed).toBe(false);
    expect(check.problems.join(' ')).toContain('after trustlines already exist');
  });

  it('rejects clearing AUTH_IMMUTABLE', () => {
    const check = checkFlagTransition(
      { authRequired: false, authRevocable: false, authImmutable: false },
      { authRequired: false, authRevocable: false, authImmutable: true },
    );
    expect(check.allowed).toBe(false);
    expect(check.problems.join(' ')).toContain('can only be set, never cleared');
  });

  it('blocks every clawback when AUTH_REVOCABLE is not set', () => {
    const check = checkClawback(noFlags, [{ account: 'GONE', amount: '100', state: 'AUTHORIZED' }]);
    expect(check.possible).toBe(false);
    expect(check.problems.join(' ')).toContain('AUTH_REVOCABLE is not set');
  });

  it('reports a permanently unclawbackable asset', () => {
    const check = checkClawback(
      { authRequired: false, authRevocable: false, authImmutable: true },
      [],
    );
    expect(check.possible).toBe(false);
    expect(check.problems.join(' ')).toContain('can never be clawed back');
  });

  it('lists the holders that can be clawed back and the ones that cannot', () => {
    const check = checkClawback({ authRequired: true, authRevocable: true, authImmutable: false }, [
      { account: 'GOK', amount: '50', state: 'AUTHORIZED' },
      { account: 'GMNT', amount: '20', state: 'AUTHORIZED_TO_MAINTAIN_LIABILITIES' },
      { account: 'GUNA', amount: '10', state: 'UNAUTHORIZED' },
      { account: 'GNONE', amount: '0', state: 'NOT_FOUND' },
    ]);

    expect(check.possible).toBe(true);
    expect(check.clawbackable).toEqual([{ account: 'GOK', amount: '50' }]);
    expect(check.blocked).toHaveLength(3);
    expect(check.blocked[0].reason).toContain('maintain liabilities');
    expect(check.blocked[1].reason).toContain('revoke the trustline');
    expect(check.blocked[2].reason).toContain('No trustline');
  });

  it('summarizes holders with their amount and authorization state', () => {
    const holders = summarizeHolders(
      {
        GA: [trustline({ is_authorized: true, balance: '75' })],
        GB: [],
      },
      code,
      issuer,
    );

    expect(holders).toEqual([
      { account: 'GA', amount: '75', state: 'AUTHORIZED' },
      { account: 'GB', amount: '0', state: 'NOT_FOUND' },
    ]);
  });

  it('renders a report with the flags, the transition and the clawback state', () => {
    const text = formatAssetControlReport({
      asset: code,
      issuer,
      flags: { authRequired: true, authRevocable: true, authImmutable: false },
      transition: checkFlagTransition(
        { authRequired: true, authRevocable: true, authImmutable: false },
        { authRequired: true, authRevocable: true, authImmutable: false },
      ),
      clawback: checkClawback({ authRequired: true, authRevocable: true, authImmutable: false }, [
        { account: 'GOK', amount: '50', state: 'AUTHORIZED' },
      ]),
    });

    expect(text).toContain('Asset: ISSUED');
    expect(text).toContain('authRequired:  yes');
    expect(text).toContain('authRevocable: yes');
    expect(text).toContain('allowed: yes');
    expect(text).toContain('possible: yes');
    expect(text).toContain('GOK: 50 clawbackable');
  });
});
