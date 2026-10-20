import {
  coordinateConcurrentSequences,
  formatSequenceCoordinatorReport,
  run,
} from '../src/examples/366-account-sequence-concurrent-coordinator';

const SAMPLE_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

describe('366-account-sequence-concurrent-coordinator', () => {
  it('computes low risk when metrics are well below the threshold limit', () => {
    const report = coordinateConcurrentSequences({
      targetId: SAMPLE_ID,
      baseSequence: 100,
      allocatedCount: 0,
      gapDetectedCount: 10,
      thresholdLimit: 1000,
    });

    expect(report.targetId).toBe(SAMPLE_ID);
    expect(report.riskLevel).toBe('low');
    expect(report.utilizationRatioBps).toBe(1000);
    expect(report.findings[0]).toContain('Nominal metrics');
  });

  it('flags elevated risk when utilization or secondary metric exceeds threshold', () => {
    const report = coordinateConcurrentSequences({
      targetId: SAMPLE_ID,
      baseSequence: 700,
      allocatedCount: 250,
      gapDetectedCount: 1200,
      thresholdLimit: 1000,
    });

    expect(report.riskLevel).toBe('elevated');
    expect(report.utilizationRatioBps).toBe(9500);
    expect(report.findings.join(' ')).toContain('Elevated metric threshold reached');
  });

  it('formats a human-readable report including the safety caveat', () => {
    const report = coordinateConcurrentSequences({
      targetId: SAMPLE_ID,
      baseSequence: 300,
      allocatedCount: 250,
      gapDetectedCount: 40,
      thresholdLimit: 1000,
    });

    const formatted = formatSequenceCoordinatorReport(report);
    expect(formatted).toContain(SAMPLE_ID);
    expect(formatted).toContain(report.caveat);
  });

  it('executes the runnable example entrypoint', async () => {
    const report = await run({ targetId: SAMPLE_ID, json: true });
    expect(report.targetId).toBe(SAMPLE_ID);
  });
});
