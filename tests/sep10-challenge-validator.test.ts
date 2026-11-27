import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import {
  formatSep10ValidationReport,
  validateSep10Challenge,
} from '../src/examples/266-sep10-challenge-validator';
import { examples } from '../src/runner/catalog';

const SERVER_KP = Keypair.fromSecret(
  'SCZANGBA5YHTNYVVV4C3U252E2B6P6F5T3U6MM63WBSBZATAQI3EBTQ4',
);
const CLIENT_KP = Keypair.fromSecret(
  'SDHOAMBN4BVU6KQH7L4Q2G2K5X4T4W5M2B6L7R8N9P0Q1R2S3T4U5V6W'.slice(0, 56),
);
const OTHER_KP = Keypair.random();
const NOW = 1_700_000_000;

function buildChallenge(opts: {
  sourceKp?: Keypair;
  seq?: string;
  minTime?: number;
  maxTime?: number;
  signWith?: Keypair[];
  passphrase?: string;
  extraOp?: ReturnType<typeof Operation.payment> | ReturnType<typeof Operation.manageData>;
  firstOpSource?: string | null;
}) {
  const sourceKp = opts.sourceKp ?? SERVER_KP;
  const builder = new TransactionBuilder(new Account(sourceKp.publicKey(), opts.seq ?? '-1'), {
    fee: '100',
    networkPassphrase: opts.passphrase ?? Networks.TESTNET,
    timebounds: {
      minTime: opts.minTime ?? NOW - 60,
      maxTime: opts.maxTime ?? NOW + 300,
    },
  }).addOperation(
    Operation.manageData({
      name: 'example.com auth',
      value: Buffer.from('deterministic-nonce'),
      ...(opts.firstOpSource === null ? {} : { source: opts.firstOpSource ?? CLIENT_KP.publicKey() }),
    }),
  );

  if (opts.extraOp) {
    builder.addOperation(opts.extraOp);
  }

  const tx = builder.build();
  for (const kp of opts.signWith ?? [SERVER_KP]) {
    tx.sign(kp);
  }
  return tx.toXDR();
}

describe('266-sep10-challenge-validator', () => {
  it('accepts a valid SEP-10 challenge transaction', () => {
    const xdr = buildChallenge({});
    const report = validateSep10Challenge(xdr, {
      expectedServerSigningKey: SERVER_KP.publicKey(),
      networkPassphrase: Networks.TESTNET,
      expectedHomeDomain: 'example.com',
      nowEpochSeconds: NOW,
    });

    expect(report.valid).toBe(true);
    expect(report.failedChecks).toEqual([]);
    expect(report.signatureCheck.serverSignatureValid).toBe(true);
    expect(formatSep10ValidationReport(report)).toContain('Valid: true');
  });

  it('rejects malformed XDR', () => {
    expect(() =>
      validateSep10Challenge('not-valid-xdr', {
        expectedServerSigningKey: SERVER_KP.publicKey(),
        networkPassphrase: Networks.TESTNET,
      }),
    ).toThrow(/Malformed SEP-10 challenge XDR/);
  });

  it('fails signature verification when network passphrase is incorrect', () => {
    const xdr = buildChallenge({ passphrase: Networks.TESTNET });
    const report = validateSep10Challenge(xdr, {
      expectedServerSigningKey: SERVER_KP.publicKey(),
      networkPassphrase: Networks.PUBLIC,
      nowEpochSeconds: NOW,
    });

    expect(report.valid).toBe(false);
    expect(report.signatureCheck.serverSignatureValid).toBe(false);
  });

  it('rejects missing server signature and invalid server signature', () => {
    const unsignedXdr = buildChallenge({ signWith: [] });
    const unsignedReport = validateSep10Challenge(unsignedXdr, {
      expectedServerSigningKey: SERVER_KP.publicKey(),
      nowEpochSeconds: NOW,
    });
    expect(unsignedReport.valid).toBe(false);
    expect(unsignedReport.signatureCheck.serverSignaturePresent).toBe(false);

    const wrongSignerXdr = buildChallenge({ signWith: [OTHER_KP] });
    const wrongSignerReport = validateSep10Challenge(wrongSignerXdr, {
      expectedServerSigningKey: SERVER_KP.publicKey(),
      nowEpochSeconds: NOW,
    });
    expect(wrongSignerReport.valid).toBe(false);
    expect(wrongSignerReport.signatureCheck.serverSignatureValid).toBe(false);
  });

  it('rejects unexpected transaction source account and unexpected operation types', () => {
    const wrongSourceXdr = buildChallenge({ sourceKp: OTHER_KP, signWith: [SERVER_KP] });
    const sourceReport = validateSep10Challenge(wrongSourceXdr, {
      expectedServerSigningKey: SERVER_KP.publicKey(),
      nowEpochSeconds: NOW,
    });
    expect(sourceReport.valid).toBe(false);
    expect(sourceReport.failedChecks.some((c) => c.includes('Transaction source account'))).toBe(true);

    const badOpXdr = buildChallenge({
      extraOp: Operation.payment({
        destination: OTHER_KP.publicKey(),
        asset: Asset.native(),
        amount: '10.0000000',
      }),
    });
    const opReport = validateSep10Challenge(badOpXdr, {
      expectedServerSigningKey: SERVER_KP.publicKey(),
      nowEpochSeconds: NOW,
    });
    expect(opReport.valid).toBe(false);
    expect(opReport.failedChecks.some((c) => c.includes('Unexpected operation type "payment"'))).toBe(true);
  });

  it('rejects expired, not-yet-valid, and invalid timeBounds', () => {
    const expiredXdr = buildChallenge({ minTime: NOW - 600, maxTime: NOW - 10 });
    const expiredReport = validateSep10Challenge(expiredXdr, {
      expectedServerSigningKey: SERVER_KP.publicKey(),
      nowEpochSeconds: NOW,
    });
    expect(expiredReport.valid).toBe(false);
    expect(expiredReport.timeBounds.isExpired).toBe(true);

    const futureXdr = buildChallenge({ minTime: NOW + 60, maxTime: NOW + 360 });
    const futureReport = validateSep10Challenge(futureXdr, {
      expectedServerSigningKey: SERVER_KP.publicKey(),
      nowEpochSeconds: NOW,
    });
    expect(futureReport.valid).toBe(false);
    expect(futureReport.timeBounds.isNotYetValid).toBe(true);

    const zeroBoundsXdr = buildChallenge({ minTime: 0, maxTime: 0 });
    const zeroReport = validateSep10Challenge(zeroBoundsXdr, {
      expectedServerSigningKey: SERVER_KP.publicKey(),
      nowEpochSeconds: NOW,
    });
    expect(zeroReport.valid).toBe(false);
    expect(zeroReport.timeBounds.isValidWindow).toBe(false);
  });

  it('rejects unexpected additional signatures', () => {
    const extraSigXdr = buildChallenge({ signWith: [SERVER_KP, OTHER_KP] });
    const report = validateSep10Challenge(extraSigXdr, {
      expectedServerSigningKey: SERVER_KP.publicKey(),
      nowEpochSeconds: NOW,
    });

    expect(report.valid).toBe(false);
    expect(report.signatureCheck.unexpectedSignatureCount).toBe(1);
    expect(report.failedChecks.some((c) => c.includes('unexpected additional signature'))).toBe(true);
  });

  it('is registered in the example catalog', () => {
    expect(examples['266-sep10-challenge-validator']).toBeDefined();
  });
});
