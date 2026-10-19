import {
  dedupeTransactions,
  explainOperationResult,
  explainTransactionResult,
  formatCsvReport,
  formatJsonReport,
  normalizeTransaction,
  summarize,
} from '../src/examples/258-transaction-history-export';

const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);

describe('ISSUE-309: transaction history export and reconciliation', () => {
  it('normalizes a Horizon transaction record into a canonical form', () => {
    const normalized = normalizeTransaction({
      hash: hashA,
      ledger: 42,
      created_at: '2024-01-01T00:00:00Z',
      successful: true,
      _links: { account: { href: 'https://horizon.test/accounts/GSOURCE' } },
      result_codes: { transaction: 'tx_success', operations: ['op_success', 'op_underfunded'] },
      operations: [{ type: 'payment' }, { type: 'manage_sell_offer' }],
    });

    expect(normalized).toMatchObject({
      hash: hashA,
      ledger: 42,
      successful: true,
      source: 'GSOURCE',
      transactionResultCode: 'tx_success',
    });
    expect(normalized.operations).toHaveLength(2);
    expect(normalized.operations[0]).toMatchObject({
      index: 1,
      type: 'payment',
      resultCode: 'op_success',
      succeeded: true,
    });
    expect(normalized.operations[1]).toMatchObject({
      index: 2,
      type: 'manage_sell_offer',
      resultCode: 'op_underfunded',
      succeeded: false,
    });
  });

  it('tolerates a record without result codes or operations', () => {
    const normalized = normalizeTransaction({ hash: hashA, ledger: 1 });
    expect(normalized.operations).toEqual([]);
    expect(normalized.transactionResultCode).toBeUndefined();
    expect(normalized.source).toBe('');
  });

  it('deduplicates records by the transaction hash', () => {
    const first = normalizeTransaction({ hash: hashA, ledger: 1, successful: true });
    const second = normalizeTransaction({ hash: hashB, ledger: 2, successful: true });
    const duplicate = normalizeTransaction({ hash: hashA, ledger: 1, successful: true });

    const { unique, duplicatesDropped } = dedupeTransactions([first, second, duplicate]);

    expect(unique).toHaveLength(2);
    expect(unique.map((t) => t.hash)).toEqual([hashA, hashB]);
    expect(duplicatesDropped).toBe(1);
  });

  it('drops records without a hash because they cannot be identified', () => {
    const { unique, duplicatesDropped } = dedupeTransactions([
      normalizeTransaction({ hash: '', ledger: 1 }),
    ]);
    expect(unique).toHaveLength(0);
    expect(duplicatesDropped).toBe(0);
  });

  it('summarizes successful, failed and duplicate counts', () => {
    const transactions = [
      normalizeTransaction({
        hash: hashA,
        ledger: 10,
        successful: true,
        result_codes: { transaction: 'tx_success', operations: [] },
      }),
      normalizeTransaction({
        hash: hashB,
        ledger: 20,
        successful: false,
        result_codes: { transaction: 'tx_failed', operations: ['op_underfunded'] },
      }),
    ];

    const summary = summarize(transactions, 3);
    expect(summary).toMatchObject({
      totalTransactions: 2,
      successful: 1,
      failed: 1,
      duplicatesDropped: 3,
      firstLedger: 10,
      lastLedger: 20,
    });
    expect(summary.resultCodeCounts).toEqual({ tx_success: 1, tx_failed: 1 });
  });

  it('explains known result codes and flags unknown ones', () => {
    expect(explainOperationResult('op_success')).toContain('successfully');
    expect(explainOperationResult('op_underfunded')).toContain('enough balance');
    expect(explainOperationResult('op_mystery')).toContain('Unknown');
    expect(explainTransactionResult('tx_bad_seq')).toContain('sequence number');
    expect(explainTransactionResult('tx_mystery')).toContain('Unknown');
  });

  it('renders a CSV report with a header, rows and a summary', () => {
    const transactions = [
      normalizeTransaction({
        hash: hashA,
        ledger: 10,
        successful: true,
        result_codes: { transaction: 'tx_success', operations: ['op_success'] },
        operations: [{ type: 'payment' }],
      }),
    ];
    const csv = formatCsvReport(transactions, summarize(transactions));
    const lines = csv.split('\n');

    expect(lines[0]).toContain('hash,ledger,successful');
    expect(lines[1]).toContain(hashA);
    expect(lines[1]).toContain('op_success');
    expect(lines[lines.length - 1]).toContain('SUMMARY');
  });

  it('escapes CSV cells that contain a comma or a quote', () => {
    const transactions = [
      normalizeTransaction({
        hash: hashA,
        ledger: 10,
        created_at: '2024,01,01',
        successful: true,
      }),
    ];
    const csv = formatCsvReport(transactions, summarize(transactions));
    expect(csv).toContain('"2024,01,01"');
  });

  it('renders a JSON report with the summary and the transactions', () => {
    const transactions = [normalizeTransaction({ hash: hashA, ledger: 10, successful: true })];
    const parsed = JSON.parse(formatJsonReport(transactions, summarize(transactions)));
    expect(parsed.summary.totalTransactions).toBe(1);
    expect(parsed.transactions).toHaveLength(1);
    expect(parsed.transactions[0].hash).toBe(hashA);
  });
});
