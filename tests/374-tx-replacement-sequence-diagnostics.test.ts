import {
  diagnoseSequenceReplacement,
  formatSequenceConflictReport,
  run,
} from '../src/examples/374-tx-replacement-sequence-diagnostics';

const SAMPLE_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

describe('374-tx-replacement-sequence-diagnostics', () => {
  it('computes low risk when metrics are well below the threshold limit', () => {
    const report = diagnoseSequenceReplacement({
      targetId: SAMPLE_ID,
      accountSequence: 100,
      candidateSequence: 0,
      feeBumpMultiplierBps: 10,
      thresholdLimit: 1000,
    });

    expect(report.targetId).toBe(SAMPLE_ID);
    expect(report.riskLevel).toBe('low');
    expect(report.utilizationRatioBps).toBe(1000);
    expect(report.findings[0]).toContain('Nominal metrics');
  });

  it('flags elevated risk when utilization or secondary metric exceeds threshold', () => {
    const report = diagnoseSequenceReplacement({
      targetId: SAMPLE_ID,
      accountSequence: 700,
      candidateSequence: 250,
      feeBumpMultiplierBps: 1200,
      thresholdLimit: 1000,
    });

    expect(report.riskLevel).toBe('elevated');
    expect(report.utilizationRatioBps).toBe(9500);
    expect(report.findings.join(' ')).toContain('Elevated metric threshold reached');
  });

  it('formats a human-readable report including the safety caveat', () => {
    const report = diagnoseSequenceReplacement({
      targetId: SAMPLE_ID,
      accountSequence: 300,
      candidateSequence: 250,
      feeBumpMultiplierBps: 40,
      thresholdLimit: 1000,
    });

    const formatted = formatSequenceConflictReport(report);
    expect(formatted).toContain(SAMPLE_ID);
    expect(formatted).toContain(report.caveat);
  });

  it('executes the runnable example entrypoint', async () => {
    const report = await run({ targetId: SAMPLE_ID, json: true });
    expect(report.targetId).toBe(SAMPLE_ID);
  });
});
