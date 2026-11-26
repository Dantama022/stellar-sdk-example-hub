import { Keypair } from '@stellar/stellar-sdk';
import {
  createHttpSep24Client,
  formatSep24ReconciliationReport,
  OnChainPaymentRecord,
  reconcileSep24Transactions,
  StellarTransactionLookup,
} from '../src/examples/268-sep24-transaction-reconciliation';
import { examples } from '../src/runner/catalog';

const USER_ACCOUNT = Keypair.random().publicKey();
const ANCHOR_ACCOUNT = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const HASH_1 = '1'.repeat(64);
const HASH_2 = '2'.repeat(64);
const HASH_3 = '3'.repeat(64);
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');

describe('268-sep24-transaction-reconciliation', () => {
  it('reconciles a completed deposit and withdrawal with matching on-chain transactions', async () => {
    const payments = new Map<string, OnChainPaymentRecord>([
      [
        HASH_1,
        {
          transactionHash: HASH_1,
          successful: true,
          sourceAccount: ANCHOR_ACCOUNT,
          destinationAccount: USER_ACCOUNT,
          assetCode: 'USDC',
          assetIssuer: ISSUER,
          amount: '50.0000000',
        },
      ],
      [
        HASH_2,
        {
          transactionHash: HASH_2,
          successful: true,
          sourceAccount: USER_ACCOUNT,
          destinationAccount: ANCHOR_ACCOUNT,
          assetCode: 'USDC',
          assetIssuer: ISSUER,
          amount: '25.0000000',
        },
      ],
    ]);

    const lookup: StellarTransactionLookup = {
      async findPaymentByTxHash(hash) {
        return payments.get(hash) ?? null;
      },
    };

    const report = await reconcileSep24Transactions(
      [
        {
          id: 'dep-1',
          kind: 'deposit',
          status: 'completed',
          stellar_transaction_id: HASH_1,
          amount_out: '50.0000000',
          amount_out_asset: `stellar:USDC:${ISSUER}`,
          to: USER_ACCOUNT,
        },
        {
          id: 'wd-1',
          kind: 'withdrawal',
          status: 'completed',
          stellar_transaction_id: HASH_2,
          amount_in: '25.0000000',
          amount_in_asset: `stellar:USDC:${ISSUER}`,
          to: ANCHOR_ACCOUNT,
        },
      ],
      lookup,
      { anchorService: 'https://anchor.test', nowMs: NOW_MS },
    );

    expect(report.reconciledCount).toBe(2);
    expect(report.unresolvedOrMismatchedCount).toBe(0);
    expect(report.items.every((i) => i.onChainVerificationStatus === 'verified')).toBe(true);
    expect(formatSep24ReconciliationReport(report)).toContain('Reconciled: 2');
  });

  it('detects missing tx hash, missing on-chain tx, asset/amount/destination mismatches, and duplicates', async () => {
    const lookup: StellarTransactionLookup = {
      async findPaymentByTxHash(hash) {
        if (hash === HASH_1) {
          return {
            transactionHash: HASH_1,
            successful: true,
            sourceAccount: ANCHOR_ACCOUNT,
            destinationAccount: Keypair.random().publicKey(), // destination mismatch
            assetCode: 'EURC', // asset mismatch
            assetIssuer: ISSUER,
            amount: '99.0000000', // amount mismatch
          };
        }
        return null;
      },
    };

    const report = await reconcileSep24Transactions(
      [
        { id: 'no-hash', kind: 'deposit', status: 'completed' },
        { id: 'not-found', kind: 'deposit', status: 'completed', stellar_transaction_id: HASH_3 },
        {
          id: 'mismatch-1',
          kind: 'deposit',
          status: 'completed',
          stellar_transaction_id: HASH_1,
          amount_out: '100.0000000',
          amount_out_asset: `stellar:USDC:${ISSUER}`,
          to: USER_ACCOUNT,
        },
        {
          id: 'dup-hash',
          kind: 'deposit',
          status: 'completed',
          stellar_transaction_id: HASH_1,
          amount_out: '100.0000000',
          amount_out_asset: `stellar:USDC:${ISSUER}`,
          to: USER_ACCOUNT,
        },
      ],
      lookup,
      { nowMs: NOW_MS },
    );

    expect(report.items[0].onChainVerificationStatus).toBe('missing_tx_hash');
    expect(report.items[1].onChainVerificationStatus).toBe('not_found');
    expect(report.items[2].onChainVerificationStatus).toBe('mismatch');
    expect(report.items[2].anomalies.some((a) => a.includes('Asset mismatch'))).toBe(true);
    expect(report.items[2].anomalies.some((a) => a.includes('Amount discrepancy'))).toBe(true);
    expect(report.items[2].anomalies.some((a) => a.includes('Destination mismatch'))).toBe(true);
    expect(report.duplicateTxHashes).toEqual([HASH_1]);
  });

  it('flags pending transactions exceeding threshold and refunded/expired statuses', async () => {
    const report = await reconcileSep24Transactions(
      [
        {
          id: 'stuck-pending',
          kind: 'deposit',
          status: 'pending_anchor',
          started_at: new Date(NOW_MS - 7_200_000).toISOString(),
        },
        { id: 'refunded-1', kind: 'withdrawal', status: 'refunded' },
        { id: 'expired-1', kind: 'deposit', status: 'expired' },
      ],
      {
        async findPaymentByTxHash() {
          return null;
        },
      },
      { nowMs: NOW_MS, pendingWarningThresholdMs: 3_600_000 },
    );

    expect(report.items[0].anomalies.some((a) => a.includes('pending_anchor'))).toBe(true);
    expect(report.items[1].anomalies.some((a) => a.includes('refunded'))).toBe(true);
    expect(report.items[2].anomalies.some((a) => a.includes('expired'))).toBe(true);
  });

  it('handles unavailable anchor API, malformed anchor responses, and unavailable Stellar data source', async () => {
    const badHttpClient = createHttpSep24Client('https://anchor.test', 'secret-token', async () => ({
      ok: false,
      status: 503,
      async json() {
        return {};
      },
    }));
    await expect(badHttpClient.fetchTransactions()).rejects.toThrow(/HTTP 503/);

    const malformedClient = createHttpSep24Client('https://anchor.test', 'secret-token', async () => ({
      ok: true,
      status: 200,
      async json() {
        return { unexpected: true };
      },
    }));
    await expect(malformedClient.fetchTransactions()).rejects.toThrow(/missing transactions array/);

    const report = await reconcileSep24Transactions(
      [{ id: 'lookup-err', kind: 'deposit', status: 'completed', stellar_transaction_id: HASH_1 }],
      {
        async findPaymentByTxHash() {
          throw new Error('Horizon connection refused');
        },
      },
    );
    expect(report.items[0].onChainVerificationStatus).toBe('lookup_error');
    expect(report.items[0].anomalies[0]).toContain('Horizon connection refused');
  });

  it('is registered in the example catalog', () => {
    expect(examples['268-sep24-transaction-reconciliation']).toBeDefined();
  });
});
