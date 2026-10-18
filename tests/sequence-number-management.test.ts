console.log("Loading module..."); import \{ Account } from '@stellar/stellar-sdk';
console.log("Loading module..."); import \{
  nextSequence,
  sequencesEqual,
  LocalSequenceManager,
  buildSequencedTransaction,
} from '../src/examples/141-sequence-number-management';

describe('sequence number management (#404)', () => {
  describe('nextSequence', () => {
    it('increments a sequence number by 1', () => {
      expect(nextSequence('100')).toBe('101');
      expect(nextSequence('0')).toBe('1');
      expect(nextSequence('9007199254740991')).toBe('9007199254740992');
    });

    it('handles large sequence numbers without precision loss', () => {
      const largeSeq = '999999999999999999999999999999';
      const next = nextSequence(largeSeq);
      expect(BigInt(next)).toBe(BigInt(largeSeq) + 1n);
    });

    it('throws on invalid input', () => {
      expect(() => nextSequence('not-a-number')).toThrow('Invalid sequence number');
      expect(() => nextSequence('')).toThrow('Invalid sequence number');
      expect(() => nextSequence('-1')).toThrow('Invalid sequence number');
      expect(() => nextSequence('1.5')).toThrow('Invalid sequence number');
    });
  });

  describe('sequencesEqual', () => {
    it('returns true for equal sequences', () => {
      expect(sequencesEqual('100', '100')).toBe(true);
      expect(sequencesEqual('999999999999', '999999999999')).toBe(true);
    });

    it('returns false for different sequences', () => {
      expect(sequencesEqual('100', '101')).toBe(false);
      expect(sequencesEqual('100', '1000')).toBe(false);
    });

    it('handles leading zeros correctly', () => {
      expect(sequencesEqual('001', '1')).toBe(true);
      expect(sequencesEqual('000100', '100')).toBe(true);
    });
  });

  describe('LocalSequenceManager', () => {
    it('initializes with the given sequence and returns next available on allocate', () => {
      const manager = new LocalSequenceManager('GTEST', { loadAccount: jest.fn() } as any, '100');
      expect(manager.allocate()).toBe('101');
      expect(manager.allocate()).toBe('102');
    });

    it('tracks allocated sequences', () => {
      const manager = new LocalSequenceManager('GTEST', { loadAccount: jest.fn() } as any, '100');
      manager.allocate(); // 101
      manager.allocate(); // 102
      manager.allocate(); // 103

      const status = manager.status();
      expect(status.allocatedSequences).toHaveLength(3);
      expect(status.allocatedSequences.map((a) => a.sequence)).toEqual(['101', '102', '103']);
      expect(status.pendingCount).toBe(3);
    });

    it('returns the next available sequence based on cursor', () => {
      const manager = new LocalSequenceManager('GTEST', { loadAccount: jest.fn() } as any, '100');
      manager.allocate(); // 101
      manager.allocate(); // 102
      const status = manager.status();
      expect(status.nextAvailableSequence).toBe('103');
    });

    it('reports stale when Horizon sequence advances', async () => {
      const mockServer = {
        loadAccount: jest.fn().mockResolvedValue({
          sequenceNumber: () => '105',
          balances: [{ asset_type: 'native', balance: '100000000' }],
        }),
      };

      const manager = new LocalSequenceManager('GTEST', mockServer as any, '100');
      manager.allocate(); // 101

      const initialStatus = manager.status();
      expect(initialStatus.isStale).toBe(false);

      const wasStale = await manager.refresh();
      expect(wasStale).toBe(true);
      expect(manager.status().onChainSequence).toBe('105');
      expect(manager.status().isStale).toBe(false);
    });

    it('does not report stale when sequence unchanged', async () => {
      const mockServer = {
        loadAccount: jest.fn().mockResolvedValue({
          sequenceNumber: () => '100',
          balances: [{ asset_type: 'native', balance: '100000000' }],
        }),
      };

      const manager = new LocalSequenceManager('GTEST', mockServer as any, '100');

      const wasStale = await manager.refresh();
      expect(wasStale).toBe(false);
    });

    it('allocates unique sequences', () => {
      const manager = new LocalSequenceManager('GTEST', { loadAccount: jest.fn() } as any, '100');
      const seqs = new Set<string>();
      for (let i = 0; i < 10; i++) {
        const seq = manager.allocate();
        expect(seqs.has(seq)).toBe(false);
        seqs.add(seq);
      }
      expect(seqs.size).toBe(10);
    });

    it('clears allocated sequences on refresh when stale', async () => {
      const mockServer = {
        loadAccount: jest.fn().mockResolvedValue({
          sequenceNumber: () => '105',
          balances: [{ asset_type: 'native', balance: '100000000' }],
        }),
      };

      const manager = new LocalSequenceManager('GTEST', mockServer as any, '100');
      manager.allocate(); // 101
      manager.allocate(); // 102

      expect(manager.status().allocatedSequences).toHaveLength(2);

      await manager.refresh();

      expect(manager.status().allocatedSequences).toHaveLength(0);
      expect(manager.status().pendingCount).toBe(0);
    });
  });

  describe('nextSequence', () => {
    it('handles boundary values', () => {
      expect(nextSequence('1')).toBe('2');
      expect(nextSequence('9223372036854775807')).toBe('9223372036854775808');
    });

    it('throws on invalid input', () => {
      expect(() => nextSequence('abc')).toThrow('Invalid sequence number');
      expect(() => nextSequence('')).toThrow('Invalid sequence number');
      expect(() => nextSequence('-1')).toThrow('Invalid sequence number');
      expect(() => nextSequence('1.5')).toThrow('Invalid sequence number');
    });
  });

  describe('sequencesEqual', () => {
    it('handles edge cases', () => {
      expect(sequencesEqual('0', '0')).toBe(true);
      expect(sequencesEqual('1', '01')).toBe(true);
      expect(sequencesEqual('0001', '1')).toBe(true);
      expect(sequencesEqual('1', '2')).toBe(false);
    });
  });

  describe('buildSequencedTransaction', () => {
    it('builds a manageData transaction with correct sequence', () => {
      const account = new Account('GA3J34TPXKKY4HGYSG4YZB5XQDTCA4TY5XL4L3JMJBNGYBXDARY3TL3Y', '100');
      const signer = require('@stellar/stellar-sdk').Keypair.random();

      const tx = buildSequencedTransaction(
        account,
        signer,
        'seq-test',
        'test-value',
      );

      expect(tx.sequence).toBe('101');
      expect(tx.operations).toHaveLength(1);
      expect(tx.signatures).toHaveLength(1);
    });
  });
}
)
