import {
  auditLedgerSequenceContinuity,
  formatLedgerContinuityReport,
  run,
} from '../src/examples/364-ledger-sequence-gap-continuity-audit';

const SAMPLE_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

describe('364-ledger-sequence-gap-continuity-audit', () => {
  it('computes low risk when metrics are well below the threshold limit', () => {
    const report = auditLedgerSequenceContinuity({
      targetId: SAMPLE_ID,
      scannedLedgers: 100,
      gapCount: 0,
      maxCloseDeltaSecs: 10,
      thresholdLimit: 1000,
    });

    expect(report.targetId).toBe(SAMPLE_ID);
    expect(report.riskLevel).toBe('low');
    expect(report.utilizationRatioBps).toBe(1000);
    expect(report.findings[0]).toContain('Nominal metrics');
  });

  it('flags elevated risk when utilization or secondary metric exceeds threshold', () => {
    const report = auditLedgerSequenceContinuity({
      targetId: SAMPLE_ID,
      scannedLedgers: 700,
      gapCount: 250,
      maxCloseDeltaSecs: 1200,
      thresholdLimit: 1000,
    });

    expect(report.riskLevel).toBe('elevated');
    expect(report.utilizationRatioBps).toBe(9500);
    expect(report.findings.join(' ')).toContain('Elevated metric threshold reached');
  });

  it('formats a human-readable report including the safety caveat', () => {
    const report = auditLedgerSequenceContinuity({
      targetId: SAMPLE_ID,
      scannedLedgers: 300,
      gapCount: 250,
      maxCloseDeltaSecs: 40,
      thresholdLimit: 1000,
    });

    const formatted = formatLedgerContinuityReport(report);
    expect(formatted).toContain(SAMPLE_ID);
    expect(formatted).toContain(report.caveat);
  });

  it('executes the runnable example entrypoint', async () => {
    const report = await run({ targetId: SAMPLE_ID, json: true });
    expect(report.targetId).toBe(SAMPLE_ID);
  });
});
