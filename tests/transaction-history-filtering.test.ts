import {
  validateAccountId,
  validateLedgerRange,
  validateTimeWindow,
  parseTransactionTimestamp,
  getLedgerSequence,
  filterTransactions,
} from '../src/examples/258-transaction-history-filtering';

describe('258-transaction-history-filtering', () => {
  describe('validateAccountId', () => {
    it('accepts a valid G... public key', () => {
      const valid = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
      expect(validateAccountId(valid)).toBe(valid);
    });

    it('rejects an invalid key', () => {
      expect(() => validateAccountId('invalid')).toThrow('valid Stellar G');
    });

    it('rejects an empty string', () => {
      expect(() => validateAccountId('')).toThrow('valid Stellar G');
    });

    it('trims whitespace', () => {
      const valid = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
      expect(validateAccountId(`  ${valid}  `)).toBe(valid);
    });
  });

  describe('validateLedgerRange', () => {
    it('accepts undefined min and max', () => {
      expect(validateLedgerRange(undefined, undefined)).toEqual({
        minLedger: undefined,
        maxLedger: undefined,
      });
    });

    it('accepts valid minLedger only', () => {
      expect(validateLedgerRange(100, undefined)).toEqual({ minLedger: 100, maxLedger: undefined });
    });

    it('accepts valid maxLedger only', () => {
      expect(validateLedgerRange(undefined, 200)).toEqual({ minLedger: undefined, maxLedger: 200 });
    });

    it('accepts valid range', () => {
      expect(validateLedgerRange(100, 200)).toEqual({ minLedger: 100, maxLedger: 200 });
    });

    it('rejects negative minLedger', () => {
      expect(() => validateLedgerRange(-1, undefined)).toThrow('Invalid minLedger');
    });

    it('rejects negative maxLedger', () => {
      expect(() => validateLedgerRange(undefined, -1)).toThrow('Invalid maxLedger');
    });

    it('rejects non-integer minLedger', () => {
      expect(() => validateLedgerRange(100.5, undefined)).toThrow('Invalid minLedger');
    });

    it('rejects minLedger > maxLedger', () => {
      expect(() => validateLedgerRange(200, 100)).toThrow('Contradictory ledger range');
    });

    it('accepts string numbers', () => {
      expect(validateLedgerRange('100', '200')).toEqual({ minLedger: 100, maxLedger: 200 });
    });

    it('accepts zero values', () => {
      expect(validateLedgerRange(0, 100)).toEqual({ minLedger: 0, maxLedger: 100 });
    });
  });

  describe('validateTimeWindow', () => {
    it('accepts undefined from and to', () => {
      expect(validateTimeWindow(undefined, undefined)).toEqual({
        fromTime: undefined,
        toTime: undefined,
      });
    });

    it('accepts valid ISO string fromTime only', () => {
      const result = validateTimeWindow('2024-01-01T00:00:00Z', undefined);
      expect(result.fromTime).toBeInstanceOf(Date);
      expect(result.fromTime!.toISOString()).toBe('2024-01-01T00:00:00.000Z');
      expect(result.toTime).toBeUndefined();
    });

    it('accepts valid ISO string toTime only', () => {
      const result = validateTimeWindow(undefined, '2024-12-31T23:59:59Z');
      expect(result.toTime).toBeInstanceOf(Date);
      expect(result.toTime!.toISOString()).toBe('2024-12-31T23:59:59.000Z');
      expect(result.fromTime).toBeUndefined();
    });

    it('accepts valid time window', () => {
      const result = validateTimeWindow('2024-01-01T00:00:00Z', '2024-12-31T23:59:59Z');
      expect(result.fromTime!.toISOString()).toBe('2024-01-01T00:00:00.000Z');
      expect(result.toTime!.toISOString()).toBe('2024-12-31T23:59:59.000Z');
    });

    it('rejects invalid fromTime', () => {
      expect(() => validateTimeWindow('not-a-date', undefined)).toThrow('Invalid fromTime');
    });

    it('rejects invalid toTime', () => {
      expect(() => validateTimeWindow(undefined, 'not-a-date')).toThrow('Invalid toTime');
    });

    it('rejects fromTime > toTime', () => {
      expect(() =>
        validateTimeWindow('2024-12-31T23:59:59Z', '2024-01-01T00:00:00Z'),
      ).toThrow('Contradictory time window');
    });

    it('accepts Date objects', () => {
      const from = new Date('2024-01-01T00:00:00Z');
      const to = new Date('2024-12-31T23:59:59Z');
      const result = validateTimeWindow(from, to);
      expect(result.fromTime).toBe(from);
      expect(result.toTime).toBe(to);
    });

    it('accepts empty strings as undefined', () => {
      expect(validateTimeWindow('', '')).toEqual({ fromTime: undefined, toTime: undefined });
    });
  });

  describe('parseTransactionTimestamp', () => {
    it('parses valid ISO timestamp', () => {
      const result = parseTransactionTimestamp('2024-01-01T12:30:45Z');
      expect(result).toBeInstanceOf(Date);
      expect(result!.toISOString()).toBe('2024-01-01T12:30:45.000Z');
    });

    it('returns null for undefined', () => {
      expect(parseTransactionTimestamp(undefined)).toBeNull();
    });

    it('returns null for null', () => {
      expect(parseTransactionTimestamp(null as any)).toBeNull();
    });

    it('returns null for invalid string', () => {
      expect(parseTransactionTimestamp('not-a-date')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(parseTransactionTimestamp('')).toBeNull();
    });
  });

  describe('getLedgerSequence', () => {
    it('extracts numeric ledger from ledger_attr', () => {
      const record = { ledger_attr: 12345 };
      expect(getLedgerSequence(record)).toBe(12345);
    });

    it('extracts numeric ledger from ledger', () => {
      const record = { ledger: 67890 };
      expect(getLedgerSequence(record)).toBe(67890);
    });

    it('extracts string ledger from ledger_attr', () => {
      const record = { ledger_attr: '12345' };
      expect(getLedgerSequence(record)).toBe(12345);
    });

    it('returns null for missing ledger', () => {
      expect(getLedgerSequence({})).toBeNull();
    });

    it('returns null for invalid ledger', () => {
      expect(getLedgerSequence({ ledger: 'abc' })).toBeNull();
    });

    it('prefers ledger_attr over ledger', () => {
      const record = { ledger_attr: 100, ledger: 200 };
      expect(getLedgerSequence(record)).toBe(100);
    });
  });

  describe('filterTransactions', () => {
    const baseTx = (overrides: Record<string, any> = {}) => ({
      hash: 'a'.repeat(64),
      ledger_attr: 100,
      created_at: '2024-01-15T12:00:00Z',
      successful: true,
      operation_count: 1,
      fee_charged: 100,
      memo_type: 'none',
      ...overrides,
    });

    it('returns all transactions when no filters', () => {
      const txs = [baseTx(), baseTx({ hash: 'b'.repeat(64) })];
      const { filtered, dropped } = filterTransactions(txs, {});
      expect(filtered).toHaveLength(2);
      expect(dropped).toHaveLength(0);
    });

    it('filters by minLedger', () => {
      const txs = [
        baseTx({ hash: 'a'.repeat(64), ledger_attr: 90 }),
        baseTx({ hash: 'b'.repeat(64), ledger_attr: 100 }),
        baseTx({ hash: 'c'.repeat(64), ledger_attr: 110 }),
      ];
      const { filtered, dropped } = filterTransactions(txs, { minLedger: 100 });
      expect(filtered).toHaveLength(2);
      expect(dropped).toHaveLength(1);
      expect(dropped[0].reason).toContain('below minLedger');
    });

    it('filters by maxLedger', () => {
      const txs = [
        baseTx({ hash: 'a'.repeat(64), ledger_attr: 90 }),
        baseTx({ hash: 'b'.repeat(64), ledger_attr: 100 }),
        baseTx({ hash: 'c'.repeat(64), ledger_attr: 110 }),
      ];
      const { filtered, dropped } = filterTransactions(txs, { maxLedger: 100 });
      expect(filtered).toHaveLength(2);
      expect(dropped).toHaveLength(1);
      expect(dropped[0].reason).toContain('above maxLedger');
    });

    it('filters by ledger range', () => {
      const txs = [
        baseTx({ hash: 'a'.repeat(64), ledger_attr: 90 }),
        baseTx({ hash: 'b'.repeat(64), ledger_attr: 100 }),
        baseTx({ hash: 'c'.repeat(64), ledger_attr: 110 }),
      ];
      const { filtered, dropped } = filterTransactions(txs, { minLedger: 100, maxLedger: 100 });
      expect(filtered).toHaveLength(1);
      expect(dropped).toHaveLength(2);
    });

    it('filters by fromTime', () => {
      const txs = [
        baseTx({ hash: 'a'.repeat(64), created_at: '2024-01-14T12:00:00Z' }),
        baseTx({ hash: 'b'.repeat(64), created_at: '2024-01-15T12:00:00Z' }),
        baseTx({ hash: 'c'.repeat(64), created_at: '2024-01-16T12:00:00Z' }),
      ];
      const { filtered, dropped } = filterTransactions(txs, {
        fromTime: new Date('2024-01-15T12:00:00Z'),
      });
      expect(filtered).toHaveLength(2);
      expect(dropped).toHaveLength(1);
      expect(dropped[0].reason).toContain('before fromTime');
    });

    it('filters by toTime', () => {
      const txs = [
        baseTx({ hash: 'a'.repeat(64), created_at: '2024-01-14T12:00:00Z' }),
        baseTx({ hash: 'b'.repeat(64), created_at: '2024-01-15T12:00:00Z' }),
        baseTx({ hash: 'c'.repeat(64), created_at: '2024-01-16T12:00:00Z' }),
      ];
      const { filtered, dropped } = filterTransactions(txs, {
        toTime: new Date('2024-01-15T12:00:00Z'),
      });
      expect(filtered).toHaveLength(2);
      expect(dropped).toHaveLength(1);
      expect(dropped[0].reason).toContain('after toTime');
    });

    it('filters by time window', () => {
      const txs = [
        baseTx({ hash: 'a'.repeat(64), created_at: '2024-01-14T12:00:00Z' }),
        baseTx({ hash: 'b'.repeat(64), created_at: '2024-01-15T12:00:00Z' }),
        baseTx({ hash: 'c'.repeat(64), created_at: '2024-01-16T12:00:00Z' }),
      ];
      const { filtered, dropped } = filterTransactions(txs, {
        fromTime: new Date('2024-01-15T00:00:00Z'),
        toTime: new Date('2024-01-15T23:59:59Z'),
      });
      expect(filtered).toHaveLength(1);
      expect(dropped).toHaveLength(2);
    });

    it('drops transaction with missing ledger when minLedger filter is active', () => {
      const txs = [baseTx({ hash: 'a'.repeat(64), ledger_attr: undefined })];
      const { filtered, dropped } = filterTransactions(txs, { minLedger: 100 });
      expect(filtered).toHaveLength(0);
      expect(dropped).toHaveLength(1);
      expect(dropped[0].reason).toContain('Missing ledger sequence');
    });

    it('drops transaction with missing ledger when maxLedger filter is active', () => {
      const txs = [baseTx({ hash: 'a'.repeat(64), ledger_attr: undefined })];
      const { filtered, dropped } = filterTransactions(txs, { maxLedger: 100 });
      expect(filtered).toHaveLength(0);
      expect(dropped).toHaveLength(1);
      expect(dropped[0].reason).toContain('Missing ledger sequence');
    });

    it('drops transaction with missing timestamp when fromTime filter is active', () => {
      const txs = [baseTx({ hash: 'a'.repeat(64), created_at: undefined })];
      const { filtered, dropped } = filterTransactions(txs, { fromTime: new Date() });
      expect(filtered).toHaveLength(0);
      expect(dropped).toHaveLength(1);
      expect(dropped[0].reason).toContain('Missing or invalid created_at');
    });

    it('drops transaction with missing timestamp when toTime filter is active', () => {
      const txs = [baseTx({ hash: 'a'.repeat(64), created_at: undefined })];
      const { filtered, dropped } = filterTransactions(txs, { toTime: new Date() });
      expect(filtered).toHaveLength(0);
      expect(dropped).toHaveLength(1);
      expect(dropped[0].reason).toContain('Missing or invalid created_at');
    });

    it('combines ledger and time filters', () => {
      const txs = [
        baseTx({ hash: 'a'.repeat(64), ledger_attr: 90, created_at: '2024-01-15T12:00:00Z' }),
        baseTx({ hash: 'b'.repeat(64), ledger_attr: 100, created_at: '2024-01-14T12:00:00Z' }),
        baseTx({ hash: 'c'.repeat(64), ledger_attr: 100, created_at: '2024-01-15T12:00:00Z' }),
      ];
      const { filtered, dropped } = filterTransactions(txs, {
        minLedger: 100,
        fromTime: new Date('2024-01-15T00:00:00Z'),
      });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].hash).toBe('c'.repeat(64));
      expect(dropped).toHaveLength(2);
    });

    it('preserves dropped transaction metadata', () => {
      const txs = [baseTx({ hash: 'a'.repeat(64), ledger_attr: 90 })];
      const { dropped } = filterTransactions(txs, { minLedger: 100 });
      expect(dropped[0]).toMatchObject({
        hash: 'a'.repeat(64),
        ledger: 90,
        createdAt: '2024-01-15T12:00:00Z',
      });
    });

    it('handles boundary inclusive correctly for minLedger', () => {
      const txs = [baseTx({ hash: 'a'.repeat(64), ledger_attr: 100 })];
      const { filtered } = filterTransactions(txs, { minLedger: 100 });
      expect(filtered).toHaveLength(1);
    });

    it('handles boundary inclusive correctly for maxLedger', () => {
      const txs = [baseTx({ hash: 'a'.repeat(64), ledger_attr: 100 })];
      const { filtered } = filterTransactions(txs, { maxLedger: 100 });
      expect(filtered).toHaveLength(1);
    });

    it('handles boundary inclusive correctly for fromTime', () => {
      const txs = [baseTx({ hash: 'a'.repeat(64), created_at: '2024-01-15T12:00:00Z' })];
      const { filtered } = filterTransactions(txs, {
        fromTime: new Date('2024-01-15T12:00:00Z'),
      });
      expect(filtered).toHaveLength(1);
    });

    it('handles boundary inclusive correctly for toTime', () => {
      const txs = [baseTx({ hash: 'a'.repeat(64), created_at: '2024-01-15T12:00:00Z' })];
      const { filtered } = filterTransactions(txs, {
        toTime: new Date('2024-01-15T12:00:00Z'),
      });
      expect(filtered).toHaveLength(1);
    });
  });
});