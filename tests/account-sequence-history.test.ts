import { auditSequences, HistoricalTransaction } from '../examples/sequence-audit/account-sequence-history';

const tx = (n: number, seq: string, source = 'ACCOUNT'): HistoricalTransaction => ({
  hash: n.toString(16).padStart(64, '0'), source_account: source,
  source_account_sequence: seq, ledger: n, paging_token: String(n * 1000), successful: true,
});

describe('sequence history audit (#581)', () => {
  it('reports apparent gaps and repeated sequences, separately by source account', () => {
    const result = auditSequences('ACCOUNT', '12', [
      tx(1, '8'), tx(2, '9'), tx(3, '11'), tx(4, '11'), tx(5, '2', 'OTHER'), tx(6, '3', 'OTHER'),
    ]);
    expect(result.apparentGaps).toEqual([{ source: 'ACCOUNT', from: '9', to: '11', missing: '1' }]);
    expect(result.repeatedSequenceValues).toHaveLength(1);
    expect(result.highestConfirmedSequence).toBe('11');
    expect(result.currentMinusHighest).toBe('1');
    expect(result.otherSourceTransactions).toBe(2);
  });
  it('removes duplicate hashes and tracks unexpected retrieval order', () => {
    const result = auditSequences('ACCOUNT', '9', [tx(2, '9'), tx(1, '8'), tx(1, '8')]);
    expect(result.duplicateRecords).toBe(1);
    expect(result.retrievalOutOfOrder).toBe(1);
    expect(result.repeatedSequenceValues).toHaveLength(0);
  });
  it('handles empty and incomplete ranges without inventing failures', () => {
    const result = auditSequences('ACCOUNT', '100', [], { startLedger: 10, endLedger: 20 }, false);
    expect(result.highestConfirmedSequence).toBeNull();
    expect(result.confidence).toBe('limited');
    expect(result.apparentGaps).toHaveLength(0);
  });
  it('rejects invalid ranges and missing sequence data', () => {
    expect(() => auditSequences('ACCOUNT', '10', [], { startLedger: 20, endLedger: 10 })).toThrow();
    const result = auditSequences('ACCOUNT', '10', [{ ...tx(1, '8'), source_account_sequence: undefined }]);
    expect(result.confidence).toBe('limited');
  });
});
