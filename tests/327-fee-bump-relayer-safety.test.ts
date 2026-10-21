import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { createSponsoredEnvelope, inspectInner, parseInner, RelayerPolicy, signOuter, SponsorshipTracker, submitSponsored } from '../src/examples/327-fee-bump-relayer-safety';

const sender = Keypair.random();
const recipient = Keypair.random().publicKey();
const feePayer = Keypair.random();
const policy: RelayerPolicy = { networkPassphrase: Networks.TESTNET, allowedOperationTypes: ['payment'], allowedDestinations: [recipient], maxFeeStroops: '5000', baseFeeStroops: '200' };
function fixture(sign = true) {
  const tx = new TransactionBuilder(new Account(sender.publicKey(), '0'), { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({ destination: recipient, asset: Asset.native(), amount: '1' })).setTimeout(60).build();
  if (sign) tx.sign(sender);
  return tx;
}
test('valid signed inner transaction, stable operations and unsigned outer fee-bump', () => {
  const tx = fixture();
  const parsed = parseInner(tx.toXDR(), Networks.TESTNET, Networks.TESTNET);
  const wrapped = createSponsoredEnvelope(parsed, feePayer.publicKey(), policy);
  expect(wrapped.innerTransaction.operations.length).toBe(tx.operations.length);
  expect(wrapped.signatures).toHaveLength(0);
});
test('rejects wrong network, malformed XDR and unsigned inner transaction', () => {
  expect(() => parseInner(fixture().toXDR(), Networks.PUBLIC_NETWORK, Networks.TESTNET)).toThrow('cross-network');
  expect(() => parseInner('not-xdr', Networks.TESTNET, Networks.TESTNET)).toThrow('Invalid');
  expect(() => inspectInner(fixture(false), policy)).toThrow('no signatures');
});
test('rejects disallowed operations, destinations and excessive fees', () => {
  expect(() => createSponsoredEnvelope(fixture(), feePayer.publicKey(), { ...policy, allowedOperationTypes: ['manageData'] })).toThrow('Operation blocked');
  expect(() => createSponsoredEnvelope(fixture(), feePayer.publicKey(), { ...policy, allowedDestinations: [] })).toThrow('Destination blocked');
  expect(() => createSponsoredEnvelope(fixture(), feePayer.publicKey(), { ...policy, maxFeeStroops: '100' })).toThrow('budget');
  expect(() => createSponsoredEnvelope(fixture(), feePayer.publicKey(), { ...policy, baseFeeStroops: 'oops' })).toThrow('fee bid');
});
test('requires matching fee-payer signer; guards submission and repeat sponsorship', async () => {
  const tx = createSponsoredEnvelope(fixture(), feePayer.publicKey(), policy);
  const sender = jest.fn();
  await expect(submitSponsored(tx, sender)).rejects.toThrow('Unsigned');
  expect(sender).not.toHaveBeenCalled();
  expect(() => signOuter(tx, Keypair.random(), feePayer.publicKey())).toThrow('does not match');
  signOuter(tx, feePayer, feePayer.publicKey());
  await expect(submitSponsored(tx, async () => { throw new Error('secret'); })).rejects.toThrow('status is uncertain');
  const tracker = new SponsorshipTracker();
  tracker.reserve('hash');
  expect(() => tracker.reserve('hash')).toThrow('already reserved');
  tracker.release('hash');
  expect(() => tracker.reserve('hash')).not.toThrow();
});
