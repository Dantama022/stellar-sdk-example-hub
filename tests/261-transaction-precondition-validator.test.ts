import {
  evaluateLedgerBounds,
  evaluateSequencePreconditions,
  evaluateTimeBounds,
  inspectPreconditions,
  overallStatus,
  parseReferenceTime,
  type PreconditionCheck,
  type ValidationContext,
} from '../src/examples/261-transaction-precondition-validator';

type TransactionLikeInput = {
  timeBounds: { minTime: string; maxTime: string } | undefined;
  ledgerBounds: { minLedger: number; maxLedger: number } | undefined;
  minAccountSequence: string | undefined;
  minAccountSequenceAge: { toString(): string } | undefined;
  minAccountSequenceLedgerGap: number | undefined;
  extraSigners: unknown[];
};

const emptyTx: TransactionLikeInput = {
  timeBounds: undefined,
  ledgerBounds: undefined,
  minAccountSequence: undefined,
  minAccountSequenceAge: undefined,
  minAccountSequenceLedgerGap: undefined,
  extraSigners: [],
};

describe('ISSUE-383: Transaction precondition inspection', () => {
  it('reports a transaction with no explicit preconditions as type none', () => {
    const snapshot = inspectPreconditions(emptyTx);
    expect(snapshot.preconditionType).toBe('none');
    expect(snapshot.timeBounds).toBeNull();
    expect(snapshot.ledgerBounds).toBeNull();
    expect(snapshot.minAccountSequence).toBeNull();
    expect(snapshot.minAccountSequenceAgeSeconds).toBeNull();
    expect(snapshot.minAccountSequenceLedgerGap).toBeNull();
  });

  it('detects time bounds only', () => {
    const snapshot = inspectPreconditions({
      ...emptyTx,
      timeBounds: { minTime: '1000', maxTime: '2000' },
    });
    expect(snapshot.preconditionType).toBe('time');
    expect(snapshot.timeBounds).toEqual({ minTime: 1000, maxTime: 2000 });
  });

  it('detects ledger bounds only', () => {
    const snapshot = inspectPreconditions({
      ...emptyTx,
      ledgerBounds: { minLedger: 10, maxLedger: 20 },
    });
    expect(snapshot.preconditionType).toBe('ledger');
    expect(snapshot.ledgerBounds).toEqual({ minLedger: 10, maxLedger: 20 });
  });

  it('detects sequence preconditions only', () => {
    const snapshot = inspectPreconditions({ ...emptyTx, minAccountSequence: '5' });
    expect(snapshot.preconditionType).toBe('sequence');
    expect(snapshot.minAccountSequence).toBe('5');
  });

  it('detects sequence age and ledger gap as part of v2-combined preconditions', () => {
    const snapshot = inspectPreconditions({
      ...emptyTx,
      minAccountSequenceAge: { toString: () => '300' },
      minAccountSequenceLedgerGap: 3,
    });
    expect(snapshot.preconditionType).toBe('v2-combined');
    expect(snapshot.minAccountSequenceAgeSeconds).toBe(300);
    expect(snapshot.minAccountSequenceLedgerGap).toBe(3);
  });

  it('reports combined preconditions as v2-combined', () => {
    const snapshot = inspectPreconditions({
      ...emptyTx,
      timeBounds: { minTime: '1', maxTime: '2' },
      ledgerBounds: { minLedger: 1, maxLedger: 2 },
    });
    expect(snapshot.preconditionType).toBe('v2-combined');
  });
});

describe('ISSUE-383: Time-bound validation', () => {
  const now = Math.floor(Date.now() / 1000);

  it('passes when the reference time is within the bounds', () => {
    const check = evaluateTimeBounds({ minTime: now - 100, maxTime: now + 100 }, now);
    expect(check.status).toBe('PASS');
    expect(check.reason).toContain('within');
  });

  it('fails when the maximum time bound has passed', () => {
    const check = evaluateTimeBounds({ minTime: 0, maxTime: now - 60 }, now);
    expect(check.status).toBe('FAIL');
    expect(check.reason).toContain('maxTime');
  });

  it('fails when the reference time is before minTime', () => {
    const check = evaluateTimeBounds({ minTime: now + 3600, maxTime: now + 7200 }, now);
    expect(check.status).toBe('FAIL');
    expect(check.reason).toContain('not yet valid');
  });

  it('fails on inconsistent bounds where minTime exceeds maxTime', () => {
    const check = evaluateTimeBounds({ minTime: now + 100, maxTime: now + 50 }, now);
    expect(check.status).toBe('FAIL');
    expect(check.reason).toContain('Inconsistent');
  });

  it('passes with no time bounds configured', () => {
    const check = evaluateTimeBounds(null, now);
    expect(check.status).toBe('PASS');
    expect(check.reason).toContain('no minTime/maxTime');
  });

  it('reports UNKNOWN when no reference time is supplied', () => {
    const check = evaluateTimeBounds({ minTime: 0, maxTime: now + 100 }, null);
    expect(check.status).toBe('UNKNOWN');
    expect(check.reason).toContain('cannot be evaluated');
  });

  it('treats maxTime of 0 as never expiring', () => {
    const check = evaluateTimeBounds({ minTime: 0, maxTime: 0 }, now - 100000);
    expect(check.status).toBe('PASS');
  });

  it('parses Unix seconds, ISO strings, and falls back to now', () => {
    expect(parseReferenceTime(String(now)).value).toBe(now);
    expect(parseReferenceTime('2026-01-01T00:00:00Z').value).toBe(
      Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000),
    );
    const fallback = parseReferenceTime('not-a-time');
    expect(fallback.value).toBeNull();
    expect(fallback.source).toContain('current system time');
  });
});

describe('ISSUE-383: Ledger-bound validation', () => {
  it('passes when the reference ledger is within the bounds', () => {
    const check = evaluateLedgerBounds({ minLedger: 100, maxLedger: 200 }, 150);
    expect(check.status).toBe('PASS');
  });

  it('fails below the minimum ledger bound', () => {
    const check = evaluateLedgerBounds({ minLedger: 100, maxLedger: 200 }, 50);
    expect(check.status).toBe('FAIL');
    expect(check.reason).toContain('below');
  });

  it('fails above the maximum ledger bound', () => {
    const check = evaluateLedgerBounds({ minLedger: 100, maxLedger: 200 }, 250);
    expect(check.status).toBe('FAIL');
    expect(check.reason).toContain('expired');
  });

  it('treats maxLedger 0 as unbounded', () => {
    const check = evaluateLedgerBounds({ minLedger: 100, maxLedger: 0 }, 9999);
    expect(check.status).toBe('PASS');
  });

  it('passes when no ledger bounds are configured', () => {
    const check = evaluateLedgerBounds(null, 150);
    expect(check.status).toBe('PASS');
  });

  it('reports UNKNOWN without a reference ledger', () => {
    const check = evaluateLedgerBounds({ minLedger: 100, maxLedger: 200 }, null);
    expect(check.status).toBe('UNKNOWN');
  });
});

describe('ISSUE-383: Sequence-related precondition validation', () => {
  const context: ValidationContext = {
    // 2026-01-02T00:00:00Z, one day after the mocked account sequence time
    referenceTimeSeconds: 1767331200,
    referenceLedger: 50000,
    accountSequence: '10',
    accountSequenceTime: '2026-01-01T00:00:00Z',
    accountSequenceLedger: 49990,
  };

  const seqTx = (overrides: Partial<TransactionLikeInput>) =>
    inspectPreconditions({ ...emptyTx, ...overrides });

  it('passes minimum sequence number when the account sequence satisfies it', () => {
    const snapshot = seqTx({ minAccountSequence: '5' });
    const checks = evaluateSequencePreconditions(snapshot, context, context.referenceTimeSeconds!);
    const seqCheck = checks.find((c) => c.constraint === 'minimum sequence number');
    expect(seqCheck?.status).toBe('PASS');
  });

  it('fails minimum sequence number when the account sequence is too low', () => {
    const snapshot = seqTx({ minAccountSequence: '20' });
    const checks = evaluateSequencePreconditions(snapshot, context, context.referenceTimeSeconds!);
    const seqCheck = checks.find((c) => c.constraint === 'minimum sequence number');
    expect(seqCheck?.status).toBe('FAIL');
    expect(seqCheck?.reason).toContain('below');
  });

  it('reports UNKNOWN for minimum sequence number without account data', () => {
    const snapshot = seqTx({ minAccountSequence: '5' });
    const checks = evaluateSequencePreconditions(
      snapshot,
      { ...context, accountSequence: null },
      context.referenceTimeSeconds!,
    );
    const seqCheck = checks.find((c) => c.constraint === 'minimum sequence number');
    expect(seqCheck?.status).toBe('UNKNOWN');
  });

  it('passes sequence age when enough time has elapsed', () => {
    const snapshot = seqTx({ minAccountSequenceAge: { toString: () => '100' } });
    const checks = evaluateSequencePreconditions(snapshot, context, context.referenceTimeSeconds!);
    const ageCheck = checks.find((c) => c.constraint === 'minimum sequence age');
    expect(ageCheck?.status).toBe('PASS');
  });

  it('fails sequence age when not enough time has elapsed', () => {
    const snapshot = seqTx({ minAccountSequenceAge: { toString: () => '1000000000' } });
    const checks = evaluateSequencePreconditions(snapshot, context, context.referenceTimeSeconds!);
    const ageCheck = checks.find((c) => c.constraint === 'minimum sequence age');
    expect(ageCheck?.status).toBe('FAIL');
  });

  it('reports UNKNOWN for sequence age without sequence time', () => {
    const snapshot = seqTx({ minAccountSequenceAge: { toString: () => '100' } });
    const checks = evaluateSequencePreconditions(
      snapshot,
      { ...context, accountSequenceTime: null },
      context.referenceTimeSeconds!,
    );
    const ageCheck = checks.find((c) => c.constraint === 'minimum sequence age');
    expect(ageCheck?.status).toBe('UNKNOWN');
  });

  it('passes sequence ledger gap when the gap is sufficient', () => {
    const snapshot = seqTx({ minAccountSequenceLedgerGap: 5 });
    const checks = evaluateSequencePreconditions(snapshot, context, context.referenceTimeSeconds!);
    const gapCheck = checks.find((c) => c.constraint === 'minimum sequence ledger gap');
    expect(gapCheck?.status).toBe('PASS');
  });

  it('fails sequence ledger gap when the gap is insufficient', () => {
    const snapshot = seqTx({ minAccountSequenceLedgerGap: 1000 });
    const checks = evaluateSequencePreconditions(snapshot, context, context.referenceTimeSeconds!);
    const gapCheck = checks.find((c) => c.constraint === 'minimum sequence ledger gap');
    expect(gapCheck?.status).toBe('FAIL');
  });

  it('reports UNKNOWN for ledger gap without reference ledgers', () => {
    const snapshot = seqTx({ minAccountSequenceLedgerGap: 5 });
    const checks = evaluateSequencePreconditions(
      snapshot,
      { ...context, referenceLedger: null, accountSequenceLedger: null },
      context.referenceTimeSeconds!,
    );
    const gapCheck = checks.find((c) => c.constraint === 'minimum sequence ledger gap');
    expect(gapCheck?.status).toBe('UNKNOWN');
  });
});

describe('ISSUE-383: Report assembly', () => {
  it('combines checks into an overall status', () => {
    expect(
      overallStatus([
        { status: 'PASS' } as PreconditionCheck,
        { status: 'PASS' } as PreconditionCheck,
      ]),
    ).toBe('PASS');
    expect(
      overallStatus([
        { status: 'PASS' } as PreconditionCheck,
        { status: 'FAIL' } as PreconditionCheck,
      ]),
    ).toBe('FAIL');
    expect(
      overallStatus([
        { status: 'PASS' } as PreconditionCheck,
        { status: 'UNKNOWN' } as PreconditionCheck,
      ]),
    ).toBe('UNKNOWN');
  });
});
