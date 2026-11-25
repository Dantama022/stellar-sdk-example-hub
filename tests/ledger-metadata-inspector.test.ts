import {
  analyzeCloseInterval,
  checkProtocolCompatibility,
  compareProtocolVersions,
  extractLedgerMetadata,
  inspectLedger,
  parseLedgerSequence,
  type LedgerLoader,
} from '../examples/ledger/ledger-metadata-inspector';

function ledger(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sequence: 100,
    hash: 'aaaaaaaa',
    prev_hash: 'bbbbbbbb',
    closed_at: '2026-11-25T10:00:05Z',
    tx_count: 12,
    operation_count: 34,
    successful_tx_count: 11,
    protocol_version: 22,
    base_fee_in_stroops: 100,
    ...overrides,
  };
}

function loader(current: unknown, previous?: unknown): LedgerLoader {
  return {
    loadLedger: async (sequence?: number) => {
      if (sequence === undefined) {
        if (current instanceof Error) throw current;
        return current;
      }
      if (sequence === 99) {
        if (previous instanceof Error) throw previous;
        return (
          previous ??
          ledger({ sequence: 99, closed_at: '2026-11-25T10:00:00Z', protocol_version: 22 })
        );
      }
      if (current instanceof Error) throw current;
      return current;
    },
  };
}

describe('ledger metadata inspector (ISSUE-404)', () => {
  describe('sequence input', () => {
    it('accepts a positive integer sequence', () => {
      expect(parseLedgerSequence('12345')).toBe(12345);
      expect(parseLedgerSequence(42)).toBe(42);
    });

    it('rejects invalid ledger identifiers', () => {
      expect(() => parseLedgerSequence('abc')).toThrow(/Invalid ledger sequence/);
      expect(() => parseLedgerSequence('-1')).toThrow(/Invalid ledger sequence/);
      expect(() => parseLedgerSequence('0')).toThrow(/positive safe integer/);
      expect(() => parseLedgerSequence('1.5')).toThrow(/Invalid ledger sequence/);
    });
  });

  describe('metadata extraction', () => {
    it('extracts the advertised ledger fields', () => {
      const metadata = extractLedgerMetadata(ledger());
      expect(metadata.sequence).toBe(100);
      expect(metadata.hash).toBe('aaaaaaaa');
      expect(metadata.previousHash).toBe('bbbbbbbb');
      expect(metadata.transactionCount).toBe(12);
      expect(metadata.operationCount).toBe(34);
      expect(metadata.successfulTransactionCount).toBe(11);
      expect(metadata.baseFeeInStroops).toBe(100);
      expect(metadata.missingFields).toEqual([]);
    });

    it('extracts protocol version metadata from a string', () => {
      expect(extractLedgerMetadata(ledger({ protocol_version: '22' })).protocolVersion).toBe(22);
    });

    it('marks unavailable fields instead of inventing values', () => {
      const metadata = extractLedgerMetadata({ sequence: 100 });
      expect(metadata.hash).toBeNull();
      expect(metadata.protocolVersion).toBeNull();
      expect(metadata.closedAt).toBeNull();
      expect(metadata.missingFields).toContain('protocolVersion');
    });
  });

  describe('protocol comparison and compatibility', () => {
    it('reports matching protocol versions for consecutive ledgers', () => {
      const result = compareProtocolVersions(22, 22);
      expect(result.changed).toBe(false);
      expect(result.direction).toBe('unchanged');
    });

    it('reports a protocol change between consecutive ledgers', () => {
      const upgrade = compareProtocolVersions(21, 22);
      expect(upgrade.changed).toBe(true);
      expect(upgrade.direction).toBe('upgrade');
      const downgrade = compareProtocolVersions(22, 21);
      expect(downgrade.direction).toBe('downgrade');
      expect(compareProtocolVersions(null, 22).direction).toBe('unknown');
    });

    it('checks the minimum supported protocol version', () => {
      const result = checkProtocolCompatibility(19, { minSupportedProtocol: 20 });
      expect(result.compatible).toBe(false);
      expect(result.status).toBe('below-minimum');
    });

    it('checks the maximum supported protocol version', () => {
      const result = checkProtocolCompatibility(23, { maxSupportedProtocol: 22 });
      expect(result.status).toBe('above-maximum');
      expect(result.compatible).toBe(false);
      expect(
        checkProtocolCompatibility(22, { minSupportedProtocol: 20, maxSupportedProtocol: 22 })
          .compatible,
      ).toBe(true);
    });

    it('handles a missing protocol version', () => {
      expect(checkProtocolCompatibility(null).status).toBe('unknown');
    });
  });

  describe('close intervals', () => {
    it('reports normal, short and long intervals', () => {
      expect(analyzeCloseInterval('2026-11-25T10:00:00Z', '2026-11-25T10:00:05Z').status).toBe(
        'normal',
      );
      expect(analyzeCloseInterval('2026-11-25T10:00:00Z', '2026-11-25T10:00:00.200Z').status).toBe(
        'short',
      );
      expect(analyzeCloseInterval('2026-11-25T10:00:00Z', '2026-11-25T10:00:30Z').status).toBe(
        'long',
      );
      const custom = analyzeCloseInterval('2026-11-25T10:00:00Z', '2026-11-25T10:00:30Z', {
        maxMs: 60_000,
      });
      expect(custom.status).toBe('normal');
    });

    it('reports missing close timestamps', () => {
      const result = analyzeCloseInterval(null, '2026-11-25T10:00:05Z');
      expect(result.status).toBe('unavailable');
      expect(result.elapsedMs).toBeNull();
    });
  });

  describe('end-to-end inspection', () => {
    it('retrieves a ledger by sequence and its predecessor', async () => {
      const inspected: number[] = [];
      const mock: LedgerLoader = {
        loadLedger: async (sequence) => {
          inspected.push(sequence ?? -1);
          return sequence === 99
            ? ledger({ sequence: 99, closed_at: '2026-11-25T10:00:00Z', protocol_version: 21 })
            : ledger();
        },
      };
      const report = await inspectLedger(mock, { sequence: 100, minSupportedProtocol: 20 });
      expect(inspected).toEqual([100, 99]);
      expect(report.errors).toEqual([]);
      expect(report.protocolComparison?.direction).toBe('upgrade');
      expect(report.closeInterval.elapsedMs).toBe(5000);
      expect(report.compatibility.compatible).toBe(true);
    });

    it('retrieves the latest ledger when no sequence is given', async () => {
      const requested: Array<number | undefined> = [];
      const mock: LedgerLoader = {
        loadLedger: async (sequence) => {
          requested.push(sequence);
          return sequence === undefined
            ? ledger({ sequence: 5 })
            : ledger({ sequence: 4, closed_at: '2026-11-25T10:00:00Z' });
        },
      };
      const report = await inspectLedger(mock);
      expect(requested[0]).toBeUndefined();
      expect(report.inspected.sequence).toBe(5);
    });

    it('reports an unavailable ledger record', async () => {
      const report = await inspectLedger(loader(new Error('404 Not Found')));
      expect(report.errors.join(' ')).toMatch(/404 Not Found/);
      expect(report.inspected.protocolVersion).toBeNull();
    });

    it('reports a network request failure for the predecessor', async () => {
      const report = await inspectLedger(loader(ledger(), new Error('ECONNRESET')));
      expect(report.errors.join(' ')).toMatch(/ECONNRESET/);
      expect(report.previous).toBeNull();
      expect(report.protocolComparison).toBeNull();
      expect(report.closeInterval.status).toBe('unavailable');
    });
  });
});
