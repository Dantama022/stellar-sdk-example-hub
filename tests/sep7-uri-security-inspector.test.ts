import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

import {
  formatReport,
  inspectSep7Uri,
  parseSep7Uri,
  redactUri,
  Sep7ParseError,
} from '../src/examples/262-sep7-uri-security-inspector';

// Deterministic synthetic accounts; nothing here touches a network.
const source = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x11));
const destination = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x22));
const issuer = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x33));
const DEST = destination.publicKey();

function txXdr(
  build: (b: TransactionBuilder) => TransactionBuilder,
  passphrase = Networks.TESTNET,
): string {
  const builder = new TransactionBuilder(new Account(source.publicKey(), '41'), {
    fee: '100',
    networkPassphrase: passphrase,
  });
  return build(builder).setTimeout(300).build().toXDR();
}

const paymentXdr = txXdr((b) =>
  b.addOperation(Operation.payment({ destination: DEST, asset: Asset.native(), amount: '5' })),
);
const testnet = encodeURIComponent(Networks.TESTNET);
const codes = (uri: string, opts = {}) => inspectSep7Uri(uri, opts).findings.map((f) => f.code);

describe('SEP-7 URI security inspector (#594)', () => {
  it('1. accepts a valid payment URI and decodes its parameters once', () => {
    const uri =
      `web+stellar:pay?destination=${DEST}&amount=12.5&asset_code=USDC&asset_issuer=${issuer.publicKey()}` +
      `&memo=order%2042&memo_type=MEMO_TEXT&msg=thanks%20%25%20more`;
    const report = inspectSep7Uri(uri);
    expect(report.status).toBe('valid');
    expect(report).toMatchObject({
      operation: 'pay',
      destination: DEST,
      amount: '12.5',
      memo: { type: 'MEMO_TEXT', value: 'order 42' },
    });
    expect(report.asset).toBe(`USDC:${issuer.publicKey()}`);
    expect(parseSep7Uri(uri).params.get('msg')).toBe('thanks % more'); // decoded exactly once
  });

  it('2. accepts a valid transaction request and inspects the XDR', () => {
    const uri = `web+stellar:tx?xdr=${encodeURIComponent(paymentXdr)}&network_passphrase=${testnet}&pubkey=${source.publicKey()}`;
    const report = inspectSep7Uri(uri, { expectedNetworkPassphrase: Networks.TESTNET });
    expect(report.status).toBe('valid');
    expect(report.transaction).toMatchObject({
      decoded: true,
      source: source.publicKey(),
      feeStroops: '100',
      operations: ['payment'],
    });
    expect(report.network.matches).toBe(true);
  });

  it('3. rejects an unsupported operation type', () => {
    expect(codes('web+stellar:sign?xdr=AAAA')).toContain('unsupported-operation');
    expect(codes('https://example.com/pay?destination=x')).toContain('parse-error');
  });

  it('4. rejects malformed percent-encoding and duplicate keys', () => {
    expect(() => parseSep7Uri(`web+stellar:pay?destination=${DEST}&msg=%E0%A4%A`)).toThrow(
      Sep7ParseError,
    );
    expect(() => parseSep7Uri(`web+stellar:pay?destination=${DEST}&destination=${DEST}`)).toThrow(
      /Duplicate/,
    );
    expect(inspectSep7Uri(`web+stellar:pay?msg=%ZZ`).status).toBe('invalid');
  });

  it('5. rejects an invalid destination public key', () => {
    expect(codes('web+stellar:pay?destination=GNOTAKEY')).toContain('invalid-destination');
  });

  it('6. rejects malformed asset identifiers', () => {
    expect(
      codes(
        `web+stellar:pay?destination=${DEST}&asset_code=TOO_LONG_CODE_X&asset_issuer=${issuer.publicKey()}`,
      ),
    ).toContain('invalid-asset');
    expect(codes(`web+stellar:pay?destination=${DEST}&asset_code=USDC`)).toContain('invalid-asset');
    expect(
      codes(`web+stellar:pay?destination=${DEST}&asset_code=USDC&asset_issuer=GBAD`),
    ).toContain('invalid-asset');
  });

  it.each(['-1', '0', '1.12345678', '1e5', 'abc', '922337203686.4775808'])(
    '7. rejects invalid amount %p',
    (amount) => {
      expect(codes(`web+stellar:pay?destination=${DEST}&amount=${amount}`)).toContain(
        'invalid-amount',
      );
    },
  );

  it('8. reports missing required parameters', () => {
    expect(codes('web+stellar:pay?amount=1')).toContain('missing-parameter');
    expect(codes('web+stellar:tx?msg=hi')).toContain('missing-parameter');
  });

  it('9. validates memo type and value', () => {
    expect(codes(`web+stellar:pay?destination=${DEST}&memo=1&memo_type=MEMO_FOO`)).toContain(
      'invalid-memo-type',
    );
    expect(codes(`web+stellar:pay?destination=${DEST}&memo=abc&memo_type=MEMO_ID`)).toContain(
      'invalid-memo',
    );
    expect(codes(`web+stellar:pay?destination=${DEST}&memo=${'a'.repeat(29)}`)).toContain(
      'invalid-memo',
    );
    const hash = encodeURIComponent(Buffer.alloc(32, 7).toString('base64'));
    expect(
      inspectSep7Uri(`web+stellar:pay?destination=${DEST}&memo=${hash}&memo_type=MEMO_HASH`).status,
    ).toBe('valid');
  });

  it('10. rejects malformed transaction XDR', () => {
    const report = inspectSep7Uri('web+stellar:tx?xdr=bm90LXhkcg%3D%3D');
    expect(report.transaction).toEqual({ decoded: false });
    expect(report.findings.map((f) => f.code)).toContain('malformed-xdr');
  });

  it('11. flags an unexpected network passphrase', () => {
    const uri = `web+stellar:tx?xdr=${encodeURIComponent(paymentXdr)}&network_passphrase=${testnet}`;
    const report = inspectSep7Uri(uri); // wallet expects the Public network (SEP-7 default)
    expect(report.network).toMatchObject({
      passphrase: Networks.TESTNET,
      expected: Networks.PUBLIC,
      matches: false,
    });
    expect(report.status).toBe('invalid');
  });

  it('12. inspects callbacks without contacting them', () => {
    const base = `web+stellar:pay?destination=${DEST}`;
    expect(codes(`${base}&callback=https%3A%2F%2Fexample.com`)).toContain('invalid-callback'); // missing url: prefix
    expect(codes(`${base}&callback=url%3Anot%20a%20url`)).toContain('invalid-callback');
    expect(codes(`${base}&callback=url%3Ahttp%3A%2F%2Fexample.com%2Fcb`)).toContain(
      'insecure-callback',
    );
    const ok = inspectSep7Uri(`${base}&callback=url%3Ahttps%3A%2F%2Fpay.example.com%2Fcb`);
    expect(ok.callback).toEqual({ url: 'https://pay.example.com/cb', scheme: 'https' });
    expect(ok.findings.map((f) => f.code)).toContain('external-callback');
  });

  it('13. flags unexpected and high-risk transaction operations', () => {
    const takeover = txXdr((b) =>
      b.addOperation(Operation.setOptions({ signer: { ed25519PublicKey: DEST, weight: 255 } })),
    );
    const report = inspectSep7Uri(
      `web+stellar:tx?xdr=${encodeURIComponent(takeover)}&network_passphrase=${testnet}`,
      {
        expectedNetworkPassphrase: Networks.TESTNET,
      },
    );
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: 'unexpected-operation', severity: 'high' }),
    );
    const data = txXdr((b) => b.addOperation(Operation.manageData({ name: 'k', value: 'v' })));
    expect(
      codes(`web+stellar:tx?xdr=${encodeURIComponent(data)}&network_passphrase=${testnet}`, {
        expectedNetworkPassphrase: Networks.TESTNET,
      }),
    ).toContain('unexpected-operation');
  });

  it('14. redacts sensitive parameters in the report', () => {
    const uri =
      `web+stellar:tx?xdr=${encodeURIComponent(paymentXdr)}&network_passphrase=${testnet}` +
      `&callback=url%3Ahttps%3A%2F%2Fuser%3Apass%40cb.example.com%2Fhook%3Ftoken%3Dsecret` +
      `&origin_domain=example.com&signature=c2lnbmF0dXJlLWJ5dGVz`;
    const report = inspectSep7Uri(uri, { expectedNetworkPassphrase: Networks.TESTNET });
    const text = formatReport(report) + JSON.stringify(report);
    expect(text).not.toMatch(/secret|pass@|c2lnbmF0dXJlLWJ5dGVz/);
    expect(text).not.toContain(paymentXdr);
    expect(report.signature).toBe('present-unverified');
    expect(redactUri(uri)).toContain('signature=REDACTED');
  });

  it('warns that a literal + in a value was decoded as a space', () => {
    expect(codes(`web+stellar:pay?destination=${DEST}&msg=a+b`)).toContain('plus-in-value');
  });

  it('requires a signature whenever origin_domain is set', () => {
    expect(codes(`web+stellar:pay?destination=${DEST}&origin_domain=example.com`)).toContain(
      'unsigned-origin',
    );
  });
});
