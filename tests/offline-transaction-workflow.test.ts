import { readFileSync } from 'fs';
import path from 'path';

import {
  Account,
  Asset,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

import * as ex80 from '../src/examples/80-offline-transaction-workflow';
import { examples } from '../src/runner/catalog';

describe('ISSUE-080: Offline Transaction Preparation Workflow', () => {
  const networkPassphrase = Networks.TESTNET;

  /**
   * Builds a real, unsigned payment transaction from two fresh keypairs.
   * `Account` only requires a public key and sequence string, so this needs
   * no network access at all.
   */
  const buildUnsignedTx = () => {
    const sourceKeypair = Keypair.random();
    const destinationKeypair = Keypair.random();
    const account = new Account(sourceKeypair.publicKey(), '100');

    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination: destinationKeypair.publicKey(),
          asset: Asset.native(),
          amount: '10',
        }),
      )
      .setTimeout(30)
      .build();

    return { tx, sourceKeypair, destinationKeypair };
  };

  describe('reconstructTransactionFromXDR', () => {
    it('round-trips a valid unsigned transaction from its XDR', () => {
      const { tx, sourceKeypair } = buildUnsignedTx();
      const xdr = tx.toXDR();

      const reconstructed = ex80.reconstructTransactionFromXDR(xdr, networkPassphrase);

      expect(reconstructed).toBeInstanceOf(Transaction);
      expect(reconstructed.source).toBe(sourceKeypair.publicKey());
      expect(reconstructed.sequence).toBe(tx.sequence);
      expect(reconstructed.operations.length).toBe(1);
    });

    it('throws a clear, descriptive error for a corrupted/truncated XDR string', () => {
      const { tx } = buildUnsignedTx();
      const xdr = tx.toXDR();
      const corrupted = xdr.slice(0, -10);

      expect(() => ex80.reconstructTransactionFromXDR(corrupted, networkPassphrase)).toThrow(
        /Invalid or corrupted transaction XDR/,
      );
    });

    it('throws a clear, descriptive error for a completely garbage string', () => {
      expect(() =>
        ex80.reconstructTransactionFromXDR('not-valid-xdr-at-all!!!', networkPassphrase),
      ).toThrow(/Invalid or corrupted transaction XDR/);
    });

    it('rejects a fee-bump transaction envelope with a clear error', () => {
      const { tx, sourceKeypair } = buildUnsignedTx();
      tx.sign(sourceKeypair);

      const feeBumpAccount = Keypair.random();
      const feeBumpAccountEntity = new Account(feeBumpAccount.publicKey(), '0');
      const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
        feeBumpAccount,
        '1000',
        tx,
        networkPassphrase,
      );
      void feeBumpAccountEntity;

      const feeBumpXdr = feeBumpTx.toXDR();
      expect(feeBumpTx).toBeInstanceOf(FeeBumpTransaction);

      expect(() => ex80.reconstructTransactionFromXDR(feeBumpXdr, networkPassphrase)).toThrow(
        /Invalid or corrupted transaction XDR/,
      );
    });
  });

  describe('signOffline', () => {
    it('signs an unsigned XDR and produces a reconstructable signed transaction', () => {
      const { tx, sourceKeypair } = buildUnsignedTx();
      const unsignedXdr = tx.toXDR();

      const signedXdr = ex80.signOffline(unsignedXdr, networkPassphrase, sourceKeypair);
      const signedTx = ex80.reconstructTransactionFromXDR(signedXdr, networkPassphrase);

      expect(signedTx.signatures.length).toBe(1);

      const hash = signedTx.hash();
      const signature = signedTx.signatures[0].signature();
      expect(sourceKeypair.verify(hash, signature)).toBe(true);
      expect(signedTx.signatures[0].hint().equals(sourceKeypair.signatureHint())).toBe(true);
    });
  });

  describe('describeTransaction', () => {
    it('summarizes source, sequence, signature count, and operation count', () => {
      const { tx, sourceKeypair } = buildUnsignedTx();

      const summary = ex80.describeTransaction(tx);

      expect(summary).toEqual({
        source: sourceKeypair.publicKey(),
        sequence: tx.sequence,
        signatureCount: 0,
        operationCount: 1,
      });
    });

    it('reflects signature count after signing', () => {
      const { tx, sourceKeypair } = buildUnsignedTx();
      tx.sign(sourceKeypair);

      expect(ex80.describeTransaction(tx).signatureCount).toBe(1);
    });
  });

  describe('isLikelyCorruptedXDR', () => {
    it('returns false for a valid transaction XDR', () => {
      const { tx } = buildUnsignedTx();
      expect(ex80.isLikelyCorruptedXDR(tx.toXDR())).toBe(false);
    });

    it('returns true for a truncated XDR, a garbage string, and an empty string', () => {
      const { tx } = buildUnsignedTx();
      const xdr = tx.toXDR();

      expect(ex80.isLikelyCorruptedXDR(xdr.slice(0, -10))).toBe(true);
      expect(ex80.isLikelyCorruptedXDR('not-base64-at-all!!!')).toBe(true);
      expect(ex80.isLikelyCorruptedXDR('')).toBe(true);
    });
  });

  describe('runner and documentation registration', () => {
    it('registers the example in the catalog with a run function', () => {
      const entry = examples['80-offline-transaction-workflow'];

      expect(entry).toBeDefined();
      expect(typeof entry.run).toBe('function');
    });

    it('documents the example in the README', () => {
      const readme = readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

      expect(readme).toContain('`80-offline-transaction-workflow`');
      expect(readme).toContain('npm run run-example 80-offline-transaction-workflow');
    });
  });
});
