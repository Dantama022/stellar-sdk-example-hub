import { Account, Keypair, Networks } from '@stellar/stellar-sdk';
import {
  buildSponsoredFeeBump,
  describeFeeBumpError,
} from '../src/examples/09-fee-bump';

const K = Keypair;

function horizonError(transaction: string, operations: string[] = []) {
  return {
    message: 'Transaction failed',
    response: { status: 400, data: { extras: { result_codes: { transaction, operations } } } },
  };
}

describe('describeFeeBumpError (#401)', () => {
  it('reports an underfunded fee source as insufficient-fee-balance', () => {
    expect(describeFeeBumpError(horizonError('tx_insufficient_balance')).category).toBe(
      'insufficient-fee-balance',
    );
    expect(describeFeeBumpError(horizonError('tx_failed', ['op_underfunded'])).category).toBe(
      'insufficient-fee-balance',
    );
  });

  it('reports a fee below the minimum', () => {
    const report = describeFeeBumpError(horizonError('tx_insufficient_fee'));
    expect(report.category).toBe('insufficient-fee');
    expect(report.message).toContain('Raise the bump base fee');
  });

  it('reports bad or missing signatures', () => {
    expect(describeFeeBumpError(horizonError('tx_bad_auth')).category).toBe('invalid-signature');
    expect(describeFeeBumpError(horizonError('tx_bad_auth_extra')).category).toBe('invalid-signature');
  });

  it('reports a malformed envelope', () => {
    expect(describeFeeBumpError(horizonError('tx_malformed')).category).toBe('malformed-envelope');
  });

  it('treats a failure with no Horizon response as a network error', () => {
    const err = Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' });
    const report = describeFeeBumpError(err);
    expect(report.category).toBe('network');
    expect(report.message).toContain('ECONNREFUSED');
  });

  it('falls back to unknown and names the Horizon result code', () => {
    const report = describeFeeBumpError(horizonError('tx_too_late'));
    expect(report.category).toBe('unknown');
    expect(report.message).toContain('tx_too_late');
  });

  it('never echoes key material from a caller error message', () => {
    const seed = Keypair.random().secret();
    const report = describeFeeBumpError(new Error(`bad input ${seed}`));
    expect(report.category).toBe('network');
    expect(report.message).not.toContain(seed);
  });
});


describe('buildSponsoredFeeBump (#401)', () => {
  const source = Keypair.random();
  const sponsor = Keypair.random();
  const destination = Keypair.random();
  const sourceAccount = new Account(source.publicKey(), '100');

  it('keeps the inner source and sponsor as distinct accounts', () => {
    const feeBump = buildSponsoredFeeBump({ source, sponsor, destination, sourceAccount });
    expect(feeBump.feeSource).toBe(sponsor.publicKey());
    expect(feeBump.innerTransaction.source).toBe(source.publicKey());
    expect(feeBump.innerTransaction.source).not.toBe(feeBump.feeSource);
  });

  it('preserves the inner operations and their destination', () => {
    const feeBump = buildSponsoredFeeBump({ source, sponsor, destination, sourceAccount });
    const ops = feeBump.innerTransaction.operations;
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe('payment');
    expect((ops[0] as { destination: string }).destination).toBe(destination.publicKey());
  });

  it('signs the inner transaction with the source key and the envelope with the sponsor key', () => {
    const feeBump = buildSponsoredFeeBump({ source, sponsor, destination, sourceAccount });
    const inner = feeBump.innerTransaction;

    expect(inner.signatures).toHaveLength(1);
    expect(K.fromPublicKey(source.publicKey()).verify(inner.hash(), inner.signatures[0].signature())).toBe(true);

    expect(feeBump.signatures).toHaveLength(1);
    expect(K.fromPublicKey(sponsor.publicKey()).verify(feeBump.hash(), feeBump.signatures[0].signature())).toBe(true);
  });

  it('does not let the sponsor signature stand in for the source signature', () => {
    const feeBump = buildSponsoredFeeBump({ source, sponsor, destination, sourceAccount });
    const inner = feeBump.innerTransaction;
    expect(K.fromPublicKey(sponsor.publicKey()).verify(inner.hash(), inner.signatures[0].signature())).toBe(false);
  });

  it('uses the requested network passphrase', () => {
    const feeBump = buildSponsoredFeeBump({ source, sponsor, destination, sourceAccount });
    expect(feeBump.networkPassphrase).toBe(Networks.TESTNET);
  });

  it('rejects malformed input at SDK validation', () => {
    expect(() =>
      buildSponsoredFeeBump({
        source,
        sponsor,
        destination: { publicKey: () => 'not-a-key' } as unknown as Keypair,
        sourceAccount,
      }),
    ).toThrow();
  });
});
