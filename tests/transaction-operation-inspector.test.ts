import {
  Account,
  Asset,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import {
  decimalAmountToStroops,
  formatOperationInspectionReport,
  inspectTransactionEnvelope,
} from '../src/examples/264-transaction-operation-inspector';
import { examples } from '../src/runner/catalog';

const SOURCE = Keypair.random().publicKey();
const OP_SOURCE = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();

describe('264-transaction-operation-inspector', () => {
  it('inspects a transaction with a single payment operation and memo', () => {
    const tx = new TransactionBuilder(new Account(SOURCE, '41'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: DEST,
          asset: Asset.native(),
          amount: '12.3456789',
        }),
      )
      .addMemo(Memo.text('invoice-42'))
      .setTimeout(0)
      .build();

    const xdrBefore = tx.toXDR();
    const report = inspectTransactionEnvelope(xdrBefore, { networkPassphrase: Networks.TESTNET });

    expect(report.originalXdr).toBe(xdrBefore);
    expect(report.sourceAccount).toBe(SOURCE);
    expect(report.sequenceNumber).toBe('42');
    expect(report.feeStroops).toBe('100');
    expect(report.memoType).toBe('text');
    expect(report.memoValue).toBe('invoice-42');
    expect(report.operationCount).toBe(1);
    expect(report.operations[0].type).toBe('payment');
    expect(report.operations[0].amount).toBe('12.3456789');
    expect(report.operations[0].asset).toEqual({ code: 'XLM', issuer: null, isNative: true });
    expect(tx.toXDR()).toBe(xdrBefore);
  });

  it('inspects multiple operation types, issued assets, and distinct operation source accounts', () => {
    const usdc = new Asset('USDC', ISSUER);
    const tx = new TransactionBuilder(new Account(SOURCE, '99'), {
      fee: '300',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.changeTrust({
          asset: usdc,
          limit: '5000.0000000',
          source: OP_SOURCE,
        }),
      )
      .addOperation(
        Operation.payment({
          destination: DEST,
          asset: usdc,
          amount: '250.0000000',
        }),
      )
      .addOperation(
        Operation.setOptions({
          medThreshold: 2,
          highThreshold: 3,
        }),
      )
      .setTimeout(0)
      .build();

    const report = inspectTransactionEnvelope(tx.toXDR(), {
      networkPassphrase: Networks.TESTNET,
      largeAmountThreshold: '200.0000000',
      expectedOperationTypes: ['changeTrust', 'payment'],
    });

    expect(report.operationCount).toBe(3);
    expect(report.operations[0].effectiveSourceAccount).toBe(OP_SOURCE);
    expect(report.operations[0].inheritsTransactionSource).toBe(false);
    expect(report.operations[1].asset).toEqual({ code: 'USDC', issuer: ISSUER, isNative: false });
    expect(report.warnings.some((w) => w.rule === 'distinct_operation_source')).toBe(true);
    expect(report.warnings.some((w) => w.rule === 'large_amount_threshold')).toBe(true);
    expect(report.warnings.some((w) => w.rule === 'account_configuration_change')).toBe(true);
    expect(report.warnings.some((w) => w.rule === 'unexpected_operation_type' && w.operationIndex === 2)).toBe(true);

    const formatted = formatOperationInspectionReport(report);
    expect(formatted).toContain('USDC:' + ISSUER);
    expect(formatted).toContain('Disclaimer:');
  });

  it('represents unsupported operation types explicitly without omitting them', () => {
    const tx = new TransactionBuilder(new Account(SOURCE, '5'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.bumpSequence({
          bumpTo: '100',
        }),
      )
      .setTimeout(0)
      .build();

    const report = inspectTransactionEnvelope(tx.toXDR(), { networkPassphrase: Networks.TESTNET });
    expect(report.operationCount).toBe(1);
    expect(report.operations[0].type).toBe('bumpSequence');
    expect(report.operations[0].supportedForDetailedSummary).toBe(false);
    expect(report.operations[0].note).toContain('not supported');
  });

  it('handles large amounts without JavaScript floating-point precision loss', () => {
    const hugeAmount = '90071992547.4099301'; // > Number.MAX_SAFE_INTEGER in stroops
    expect(decimalAmountToStroops(hugeAmount)).toBe(900719925474099301n);

    const tx = new TransactionBuilder(new Account(SOURCE, '10'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: DEST,
          asset: Asset.native(),
          amount: hugeAmount,
        }),
      )
      .setTimeout(0)
      .build();

    const report = inspectTransactionEnvelope(tx.toXDR(), {
      networkPassphrase: Networks.TESTNET,
      largeAmountThreshold: '90071992547.4099300',
    });

    expect(report.operations[0].amount).toBe(hugeAmount);
    expect(report.warnings.some((w) => w.rule === 'large_amount_threshold')).toBe(true);
  });

  it('rejects invalid base64, malformed XDR, missing network context, and fee-bump variants', () => {
    expect(() => inspectTransactionEnvelope('not valid base64!!!', { networkPassphrase: Networks.TESTNET })).toThrow(
      /Invalid base64/,
    );
    expect(() => inspectTransactionEnvelope('AAAA', { networkPassphrase: Networks.TESTNET })).toThrow(
      /Malformed transaction envelope XDR/,
    );
    expect(() => inspectTransactionEnvelope('AAAA', { networkPassphrase: '' })).toThrow(
      /networkPassphrase is required/,
    );

    const innerTx = new TransactionBuilder(new Account(SOURCE, '10'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: DEST,
          asset: Asset.native(),
          amount: '1.0000000',
        }),
      )
      .setTimeout(0)
      .build();

    const feeBump = TransactionBuilder.buildFeeBumpTransaction(SOURCE, '200', innerTx, Networks.TESTNET);
    expect(() => inspectTransactionEnvelope(feeBump.toXDR(), { networkPassphrase: Networks.TESTNET })).toThrow(
      /Unsupported envelope variant/,
    );
  });

  it('is registered in the example catalog', () => {
    expect(examples['264-transaction-operation-inspector']).toBeDefined();
  });
});
