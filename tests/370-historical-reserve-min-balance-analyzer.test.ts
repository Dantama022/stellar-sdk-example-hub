import {
  analyzeHistoricalReserveRequirement,
  formatHistoricalReserveReport,
  run,
} from '../src/examples/370-historical-reserve-min-balance-analyzer';

const SAMPLE_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

describe('370-historical-reserve-min-balance-analyzer', () => {
  it('computes low risk when metrics are well below the threshold limit', () => {
    const report = analyzeHistoricalReserveRequirement({
      targetId: SAMPLE_ID,
      baseReserveStroops: 100,
      totalSubentries: 0,
      requiredMinBalanceStroops: 10,
      thresholdLimit: 1000,
    });

    expect(report.targetId).toBe(SAMPLE_ID);
    expect(report.riskLevel).toBe('low');
    expect(report.utilizationRatioBps).toBe(1000);
    expect(report.findings[0]).toContain('Nominal metrics');
  });

  it('flags elevated risk when utilization or secondary metric exceeds threshold', () => {
    const report = analyzeHistoricalReserveRequirement({
      targetId: SAMPLE_ID,
      baseReserveStroops: 700,
      totalSubentries: 250,
      requiredMinBalanceStroops: 1200,
      thresholdLimit: 1000,
    });

    expect(report.riskLevel).toBe('elevated');
    expect(report.utilizationRatioBps).toBe(9500);
    expect(report.findings.join(' ')).toContain('Elevated metric threshold reached');
  });

  it('formats a human-readable report including the safety caveat', () => {
    const report = analyzeHistoricalReserveRequirement({
      targetId: SAMPLE_ID,
      baseReserveStroops: 300,
      totalSubentries: 250,
      requiredMinBalanceStroops: 40,
      thresholdLimit: 1000,
    });

    const formatted = formatHistoricalReserveReport(report);
    expect(formatted).toContain(SAMPLE_ID);
    expect(formatted).toContain(report.caveat);
  });

  it('executes the runnable example entrypoint', async () => {
    const report = await run({ targetId: SAMPLE_ID, json: true });
    expect(report.targetId).toBe(SAMPLE_ID);
  });
});
