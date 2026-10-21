import { Keypair } from '@stellar/stellar-sdk';
import { buildBatch, classifySubmissionFailure, describeAtomicity, submitTestnetOnly, validateBatch, validateOperationCount } from '../src/examples/325-multi-operation-atomicity';
const receiver = Keypair.fromRawEd25519Seed(Buffer.alloc(32,7)).publicKey();
const issuer = Keypair.fromRawEd25519Seed(Buffer.alloc(32,8)).publicKey();
const input = {receiver,issuer,amount:'1.1234567',assetCode:'USD',sequence:'2'};
test('trustline before issuer payment in one transaction; no network or signatures', () => {
  const tx = buildBatch(input);
  expect(describeAtomicity(tx).operations).toEqual(['changeTrust','payment']);
  expect(tx.signatures).toHaveLength(0);
});
test('rejects invalid amount, address, asset and ordering limits', () => {
  expect(()=>validateBatch({...input,amount:'-1'})).toThrow();
  expect(()=>validateBatch({...input,amount:'1.00000001'})).toThrow();
  expect(()=>validateBatch({...input,receiver:'bad'})).toThrow();
  expect(()=>validateBatch({...input,assetCode:'!'})).toThrow();
  expect(()=>validateBatch({...input,issuer:receiver})).toThrow();
  expect(()=>validateOperationCount(101)).toThrow();
  expect(()=>validateOperationCount(0)).toThrow();
  expect(()=>buildBatch(input,100,99)).toThrow();
});
test('failure categorization never exposes raw server error bodies', () => {
  expect(classifySubmissionFailure({response:{status:400,data:{extras:{result_codes:{transaction:'tx_failed',operations:['op_no_trust']}}}}})).toContain('tx_failed');
  expect(classifySubmissionFailure({response:{status:500,data:{secret:'SHOULD_NOT_APPEAR'}}})).not.toContain('SHOULD_NOT_APPEAR');
});
test('testnet submission is opt-in and never happens in default workflow', async () => {
  await expect(submitTestnetOnly({enabled:false,receiverSecret:'',issuerSecret:'',horizonUrl:'',amount:'1',assetCode:'USD'}))
    .rejects.toThrow('disabled');
});
