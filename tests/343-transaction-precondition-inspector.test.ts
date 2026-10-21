import { Account, Keypair, Networks, Operation, Asset, TransactionBuilder } from '@stellar/stellar-sdk';
import { demoEnvelope, inspectXdr, validatePreconditions } from '../src/examples/343-transaction-precondition-inspector';
const account = Keypair.fromRawEd25519Seed(Buffer.alloc(32,11)).publicKey();
const view = () => inspectXdr(demoEnvelope());
test('inspects time-bound envelope with fixed clock', () => {
  const info = view();
  expect(info.timeBounds).toEqual({minTime:'1000',maxTime:'1200'});
  expect(validatePreconditions(info,{nowSeconds:1200n,requireExpiry:true})).toEqual([]);
  expect(validatePreconditions(info,{nowSeconds:1201n})).toContain('Transaction has expired');
  expect(validatePreconditions(info,{nowSeconds:999n})).toContain('Transaction is too early');
});
test('missing, malformed, reversed and no-expiry time bounds', () => {
  const info = view();
  expect(validatePreconditions({...info,timeBounds:undefined},{nowSeconds:1100n,requireExpiry:true})).toContain('Policy requires explicit expiring time bounds');
  expect(validatePreconditions({...info,timeBounds:{minTime:'20',maxTime:'10'}},{nowSeconds:11n})).toContain('Reversed time bounds');
  expect(validatePreconditions({...info,timeBounds:{minTime:'x',maxTime:'10'}},{nowSeconds:11n})).toContain('Malformed time bounds');
  expect(validatePreconditions({...info,timeBounds:{minTime:'0',maxTime:'0'}},{nowSeconds:11n,requireExpiry:true})).toContain('Policy requires finite maxTime');
  expect(()=>inspectXdr('not-xdr',Networks.TESTNET)).toThrow('Invalid or unsupported');
});
test('ledger upper bound is exclusive and sequence checks require account state', () => {
  const info = {...view(),ledgerBounds:{minLedger:30,maxLedger:50},minAccountSequence:'99',
    minAccountSequenceAge:'10',minAccountSequenceLedgerGap:2};
  expect(validatePreconditions(info,{nowSeconds:1100n,currentLedger:50})).toContain('Ledger bound exceeded');
  expect(validatePreconditions(info,{nowSeconds:1100n,currentLedger:31,accountSequence:99n,
    accountSequenceTime:1099n,accountSequenceLedger:30})).toContain('Minimum sequence age not met');
  expect(validatePreconditions(info,{nowSeconds:1100n,currentLedger:31,accountSequenceLedger:30})).toContain('Minimum sequence ledger gap not met');
});
test('reads generalized ledger bounds from SDK-built transaction', () => {
  const builder = new TransactionBuilder(new Account(account,'100'),{fee:'100',networkPassphrase:Networks.TESTNET});
  const tx = builder.addOperation(Operation.payment({destination:account,amount:'1',asset:Asset.native()}))
    .setLedgerbounds(3,5).setTimeout(60).build();
  expect(inspectXdr(tx.toXDR()).ledgerBounds).toEqual({minLedger:3,maxLedger:5});
});
