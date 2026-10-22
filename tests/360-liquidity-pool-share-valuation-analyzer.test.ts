import {
  analyzeLiquidityPoolValuation,
  formatLiquidityPoolValuationReport,
  run,
} from '../src/examples/360-liquidity-pool-share-valuation-analyzer';

const SAMPLE_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

describe('360-liquidity-pool-share-valuation-analyzer', () => {
  it('computes low risk when metrics are well below the threshold limit', () => {
    const report = analyzeLiquidityPoolValuation({
      targetId: SAMPLE_ID,
      reserveAStroops: 100,
      reserveBStroops: 0,
      userShareValueAStroops: 10,
      thresholdLimit: 1000,
    });

    expect(report.targetId).toBe(SAMPLE_ID);
    expect(report.riskLevel).toBe('low');
    expect(report.utilizationRatioBps).toBe(1000);
    expect(report.findings[0]).toContain('Nominal metrics');
  });

  it('flags elevated risk when utilization or secondary metric exceeds threshold', () => {
    const report = analyzeLiquidityPoolValuation({
      targetId: SAMPLE_ID,
      reserveAStroops: 700,
      reserveBStroops: 250,
      userShareValueAStroops: 1200,
      thresholdLimit: 1000,
    });

    expect(report.riskLevel).toBe('elevated');
    expect(report.utilizationRatioBps).toBe(9500);
    expect(report.findings.join(' ')).toContain('Elevated metric threshold reached');
  });

  it('formats a human-readable report including the safety caveat', () => {
    const report = analyzeLiquidityPoolValuation({
      targetId: SAMPLE_ID,
      reserveAStroops: 300,
      reserveBStroops: 250,
      userShareValueAStroops: 40,
      thresholdLimit: 1000,
    });

    const formatted = formatLiquidityPoolValuationReport(report);
    expect(formatted).toContain(SAMPLE_ID);
    expect(formatted).toContain(report.caveat);
  });

  it('executes the runnable example entrypoint', async () => {
    const report = await run({ targetId: SAMPLE_ID, json: true });
    expect(report.targetId).toBe(SAMPLE_ID);
  });
});
