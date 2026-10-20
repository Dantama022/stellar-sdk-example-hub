import { Keypair, Networks } from '@stellar/stellar-sdk';
import { demoUnsignedEnvelope, generateUri, parseUri } from '../src/examples/335-sep7-uri';
const publicKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey();

test('pay URI round-trips encoded memo and testnet', () => {
  const uri = generateUri({ operation: 'pay', destination: publicKey, amount: '1.2345678', memo: 'Order #42 & tea', memo_type: 'MEMO_TEXT', network_passphrase: Networks.TESTNET });
  expect(parseUri(uri)).toMatchObject({ operation: 'pay', amount: '1.2345678', memo: 'Order #42 & tea' });
  expect(uri).toContain('memo=Order+%2342+%26+tea');
});

test('transaction URI contains parseable unsigned XDR', () => {
  const parsed = parseUri(generateUri({ operation: 'tx', xdr: demoUnsignedEnvelope(publicKey), network_passphrase: Networks.TESTNET }));
  expect(parsed.operation).toBe('tx');
});

test.each([
  'web+stellar:pay?amount=4',
  `web+stellar:pay?destination=${publicKey}&amount=-1`,
  `web+stellar:pay?destination=${publicKey}&destination=${publicKey}`,
  `web+stellar:pay?destination=GINVALID`,
  'web+stellar:stake?destination=X',
  'not-a-uri',
  'web+stellar:tx?xdr=AAABBA',
  `web+stellar:pay?destination=${publicKey}&memo=%GG`,
  `web+stellar:pay?destination=${publicKey}&asset_code=USD`,
  `web+stellar:pay?destination=${publicKey}&unsafe=1`,
])('invalid URI rejected: %s', uri => expect(() => parseUri(uri)).toThrow());
