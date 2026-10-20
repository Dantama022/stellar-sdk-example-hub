import {
  Account,
  TransactionBuilder,
  Keypair,
  Networks,
  Operation,
  Asset,
  type Transaction,
} from '@stellar/stellar-sdk';

import {
  analyzeThreshold,
  buildReport,
  formatReport,
  parseOfflineSignerConfig,
  verifySignatureWithKey,
  verifySignatures,
  type SignerConfig,
  type ThresholdAnalysis,
  type VerifiedSignature,
} from '../src/examples/263-transaction-signature-threshold-analyzer';

const SIGNER = Keypair.random();
const OTHER_KEY = Keypair.random().publicKey();
const ACCOUNT_ID = SIGNER.publicKey();

function buildSignedEnvelope(signWith: Keypair): string {
  const account = new Account(ACCOUNT_ID, '1');
  const tx = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({ destination: ACCOUNT_ID, asset: Asset.native(), amount: '1' }),
    )
    .setTimeout(1000)
    .build();
  tx.sign(signWith);
  return tx.toEnvelope().toXDR('base64');
}

describe('ISSUE-385: Cryptographic signature verification', () => {
  const xdr = buildSignedEnvelope(SIGNER);
  const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as Transaction;
  const hash = tx.hash();
  const signatureInputs = tx.signatures.map((sig) => ({
    hint: sig.hint(),
    signature: sig.signature(),
  }));

  it('verifies a signature produced by the matching public key', () => {
    const sig = signatureInputs[0];
    const result = verifySignatureWithKey(hash, sig.signature, SIGNER.publicKey());
    expect(result.verified).toBe(true);
    expect(result.error).toBeNull();
  });

  it('rejects a signature produced by a different key', () => {
    const sig = signatureInputs[0];
    const result = verifySignatureWithKey(hash, sig.signature, OTHER_KEY);
    expect(result.verified).toBe(false);
    expect(result.error).toBeNull();
  });

  it('handles an invalid candidate public key safely', () => {
    const sig = signatureInputs[0];
    const result = verifySignatureWithKey(hash, sig.signature, 'not-a-valid-key');
    expect(result.verified).toBe(false);
    expect(result.error).not.toBeNull();
  });

  it('verifies against candidate keys and reports matches', () => {
    const sigs = verifySignatures(hash, signatureInputs, [SIGNER.publicKey(), OTHER_KEY]);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].verified).toBe(true);
    expect(sigs[0].matchedKey).toBe(SIGNER.publicKey());
    expect(sigs[0].result).toBe('verified');
  });

  it('reports unmatched signatures when no candidate verifies', () => {
    const sigs = verifySignatures(hash, signatureInputs, [OTHER_KEY]);
    expect(sigs[0].verified).toBe(false);
    expect(sigs[0].matchedKey).toBeNull();
    expect(sigs[0].result).toBe('unmatched');
  });
});

describe('ISSUE-385: Offline signer configuration parsing', () => {
  it('parses keys, weights, and thresholds', () => {
    const { config, error } = parseOfflineSignerConfig(
      `${ACCOUNT_ID},${OTHER_KEY}`,
      '2,1',
      '{"low":1,"medium":2,"high":3}',
    );
    expect(error).toBeNull();
    expect(config!.signers).toHaveLength(2);
    expect(config!.signers[0].weight).toBe(2);
    expect(config!.thresholds).toEqual({ low: 1, medium: 2, high: 3 });
  });

  it('defaults missing weights to 1 and thresholds to key count', () => {
    const { config, error } = parseOfflineSignerConfig(ACCOUNT_ID, undefined, undefined);
    expect(error).toBeNull();
    expect(config!.signers[0].weight).toBe(1);
    expect(config!.thresholds.high).toBe(1);
  });

  it('rejects negative weights', () => {
    const { config, error } = parseOfflineSignerConfig(ACCOUNT_ID, '-1', undefined);
    expect(config).toBeNull();
    expect(error).not.toBeNull();
  });

  it('rejects missing offline keys', () => {
    const { config, error } = parseOfflineSignerConfig('', undefined, undefined);
    expect(config).toBeNull();
    expect(error).not.toBeNull();
  });
});

describe('ISSUE-385: Threshold analysis', () => {
  const baseConfig: SignerConfig = {
    accountId: ACCOUNT_ID,
    signers: [
      { key: ACCOUNT_ID, weight: 2, type: 'ed25519_public_key' },
      { key: OTHER_KEY, weight: 1, type: 'ed25519_public_key' },
    ],
    thresholds: { low: 1, medium: 2, high: 3 },
    source: 'offline-input',
    note: 'test',
  };

  const verified = (matchedKey: string): VerifiedSignature => ({
    hint: '00',
    signature: 'deadbeef',
    result: 'verified',
    matchedKey,
    verified: true,
    note: 'ok',
  });

  it('reports MEETS when collected weight reaches the threshold', () => {
    const analysis = analyzeThreshold(
      ACCOUNT_ID,
      [verified(ACCOUNT_ID), verified(OTHER_KEY)],
      baseConfig,
      [],
    ) as ThresholdAnalysis;
    expect(analysis.result).toBe('MEETS');
    expect(analysis.collectedWeight).toBe(3);
    expect(analysis.requiredWeight).toBe(3);
  });

  it('reports BELOW when collected weight is short', () => {
    const analysis = analyzeThreshold(
      ACCOUNT_ID,
      [verified(ACCOUNT_ID)],
      baseConfig,
      [],
    ) as ThresholdAnalysis;
    expect(analysis.result).toBe('BELOW');
    expect(analysis.collectedWeight).toBe(2);
    expect(analysis.detail).toContain('below');
  });

  it('counts each distinct signer only once', () => {
    const analysis = analyzeThreshold(
      ACCOUNT_ID,
      [verified(ACCOUNT_ID), verified(ACCOUNT_ID)],
      baseConfig,
      [],
    ) as ThresholdAnalysis;
    expect(analysis.collectedWeight).toBe(2);
    expect(analysis.matchedSigners).toHaveLength(1);
  });

  it('ignores signers with zero weight', () => {
    const lockedConfig = {
      ...baseConfig,
      signers: [{ key: ACCOUNT_ID, weight: 0, type: 'ed25519_public_key' }],
    };
    const analysis = analyzeThreshold(
      ACCOUNT_ID,
      [verified(ACCOUNT_ID)],
      lockedConfig,
      [],
    ) as ThresholdAnalysis;
    expect(analysis.collectedWeight).toBe(0);
    expect(analysis.result).toBe('BELOW');
  });

  it('is indeterminate when signer configuration is missing', () => {
    const missing: SignerConfig = {
      accountId: ACCOUNT_ID,
      signers: [],
      thresholds: { low: 0, medium: 0, high: 0 },
      source: 'missing',
      note: 'unavailable',
    };
    const analysis = analyzeThreshold(
      ACCOUNT_ID,
      [verified(ACCOUNT_ID)],
      missing,
      [],
    ) as ThresholdAnalysis;
    expect(analysis.result).toBe('INDETERMINATE');
    expect(analysis.status).toBe('UNKNOWN');
  });

  it('is indeterminate when the source account is unknown', () => {
    const analysis = analyzeThreshold(
      null,
      [verified(ACCOUNT_ID)],
      baseConfig,
      [],
    ) as ThresholdAnalysis;
    expect(analysis.result).toBe('INDETERMINATE');
  });
});

describe('ISSUE-385: Report generation', () => {
  it('builds a report with separated cryptographic and authorization conclusions', () => {
    const sigs: VerifiedSignature[] = [
      {
        hint: 'aa',
        signature: '01',
        result: 'verified',
        matchedKey: ACCOUNT_ID,
        verified: true,
        note: 'ok',
      },
      {
        hint: 'bb',
        signature: '02',
        result: 'unmatched',
        matchedKey: null,
        verified: false,
        note: 'no match',
      },
    ];
    const config: SignerConfig = {
      accountId: ACCOUNT_ID,
      signers: [{ key: ACCOUNT_ID, weight: 2, type: 'ed25519_public_key' }],
      thresholds: { low: 1, medium: 2, high: 2 },
      source: 'offline-input',
      note: 'test',
    };
    const analysis = analyzeThreshold(ACCOUNT_ID, sigs, config, []) as ThresholdAnalysis;
    const report = buildReport('xdr', false, ACCOUNT_ID, '5', 'hash', sigs, config, analysis);
    expect(report.signatureCount).toBe(2);
    expect(report.verifiedCount).toBe(1);
    expect(report.unmatchedCount).toBe(1);
    expect(report.thresholdAnalysis!.result).toBe('MEETS');
    expect(report.notes.some((n) => n.toLowerCase().includes('cryptographic'))).toBe(true);
    expect(report.notes.some((n) => n.toLowerCase().includes('authorization'))).toBe(true);
  });

  it('formats a readable report', () => {
    const config: SignerConfig = {
      accountId: ACCOUNT_ID,
      signers: [],
      thresholds: { low: 0, medium: 0, high: 0 },
      source: 'missing',
      note: 'unavailable',
    };
    const report = buildReport('xdr', false, null, '0', null, [], config, null);
    const formatted = formatReport(report);
    expect(formatted).toContain('unavailable');
    expect(formatted).toMatch(/Source account:\s+\(unavailable\)/);
  });
});
