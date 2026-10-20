import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { readFileSync } from 'fs';
import path from 'path';

import {
  transactionFromTxrep,
  transactionToTxrep,
} from '../src/examples/261-sep11-txrep-transaction-representation';

function buildUnsignedPayment() {
  const source = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x11));
  const destination = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x22));
  const transaction = new TransactionBuilder(new Account(source.publicKey(), '7'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: destination.publicKey(),
        asset: Asset.native(),
        amount: '1.25',
      }),
    )
    .setTimeout(0)
    .build();
  return { transaction, source };
}

describe('261-sep11-txrep-transaction-representation', () => {
  it('encodes normalized Txrep and reconstructs the same XDR without a network', () => {
    const { transaction } = buildUnsignedPayment();
    const txrep = transactionToTxrep(transaction);
    const reconstructed = transactionFromTxrep(txrep);

    expect(txrep).toContain('type: ENVELOPE_TYPE_TX');
    expect(txrep).toContain('tx.operations[0].body.paymentOp.asset: TestXLM');
    expect(txrep).toContain('tx.operations[0].body.paymentOp.amount: 12500000');
    expect(reconstructed.toXDR()).toBe(transaction.toXDR());
  });

  it('follows Txrep duplicate-field behavior with the last value winning', () => {
    const { transaction } = buildUnsignedPayment();
    const txrep = transactionToTxrep(transaction).replace('tx.fee: 100', 'tx.fee: 101');
    const reconstructed = transactionFromTxrep(`${txrep}\ntx.fee: 100`);

    expect(reconstructed.toXDR()).toBe(transaction.toXDR());
  });

  it('ignores blank lines and full-line comments', () => {
    const { transaction } = buildUnsignedPayment();
    const txrep = transactionToTxrep(transaction);

    expect(transactionFromTxrep(`: test vector\n\n${txrep}`).toXDR()).toBe(transaction.toXDR());
  });

  it.each([
    ['', /non-empty string/],
    ['not a field', /missing a field separator/],
    ['unknown.field: value', /outside this example profile/],
  ])('rejects malformed or unsupported Txrep input: %s', (input, message) => {
    expect(() => transactionFromTxrep(input)).toThrow(message);
  });

  it('rejects missing fields and invalid numeric values', () => {
    const { transaction } = buildUnsignedPayment();
    const txrep = transactionToTxrep(transaction);

    expect(() => transactionFromTxrep(txrep.replace('type: ENVELOPE_TYPE_TX\n', ''))).toThrow(
      /required field "type" is missing/,
    );
    expect(() => transactionFromTxrep(txrep.replace('tx.fee: 100', 'tx.fee: 1.5'))).toThrow(
      /tx.fee must be an unsigned decimal integer/,
    );
    expect(() => transactionFromTxrep(txrep.replace('amount: 12500000', 'amount: 0'))).toThrow(
      /payment amount must be positive/,
    );
  });

  it('rejects invalid account IDs and unsupported envelope contents', () => {
    const { transaction, source } = buildUnsignedPayment();
    const txrep = transactionToTxrep(transaction);

    expect(() =>
      transactionFromTxrep(txrep.replace(/tx.sourceAccount: .+/, 'tx.sourceAccount: invalid')),
    ).toThrow(/valid Ed25519 account IDs/);
    expect(() =>
      transactionFromTxrep(txrep.replace('tx.memo.type: MEMO_NONE', 'tx.memo.type: MEMO_TEXT')),
    ).toThrow(/expected MEMO_NONE/);

    transaction.sign(source);
    expect(() => transactionToTxrep(transaction)).toThrow(/unsigned envelopes only/);
  });

  it('round-trips through the SDK XDR parser as a Testnet transaction', () => {
    const { transaction } = buildUnsignedPayment();
    const restored = transactionFromTxrep(transactionToTxrep(transaction));
    const parsed = TransactionBuilder.fromXDR(restored.toXDR(), Networks.TESTNET);

    expect(parsed.toXDR()).toBe(transaction.toXDR());
    expect(parsed.networkPassphrase).toBe(Networks.TESTNET);
  });

  it('registers the example and documents how to run it', () => {
    const readme = readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    const catalog = readFileSync(path.join(__dirname, '..', 'src', 'runner', 'catalog.ts'), 'utf8');

    expect(catalog).toContain("'261-sep11-txrep-transaction-representation': {");
    expect(catalog).toContain(
      "run: loadExample('../examples/261-sep11-txrep-transaction-representation')",
    );
    expect(readme).toContain('261-sep11-txrep-transaction-representation');
    expect(readme).toContain('npm run run-example 261-sep11-txrep-transaction-representation');
  });
});
