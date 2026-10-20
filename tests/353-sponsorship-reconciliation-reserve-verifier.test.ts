import {
  reconcileSponsorshipReserves,
  formatSponsorshipReconcileReport,
  run,
} from '../src/examples/353-sponsorship-reconciliation-reserve-verifier';

const SAMPLE_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

describe('353-sponsorship-reconciliation-reserve-verifier', () => {
  it('computes low risk when metrics are well below the threshold limit', () => {
    const report = reconcileSponsorshipReserves({
      targetId: SAMPLE_ID,
      expectedReserveStroops: 100,
      actualReserveStroops: 0,
      discrepancyStroops: 10,
      thresholdLimit: 1000,
    });

    expect(report.targetId).toBe(SAMPLE_ID);
    expect(report.riskLevel).toBe('low');
    expect(report.utilizationRatioBps).toBe(1000);
    expect(report.findings[0]).toContain('Nominal metrics');
  });

  it('flags elevated risk when utilization or secondary metric exceeds threshold', () => {
    const report = reconcileSponsorshipReserves({
      targetId: SAMPLE_ID,
      expectedReserveStroops: 700,
      actualReserveStroops: 250,
      discrepancyStroops: 1200,
      thresholdLimit: 1000,
    });

    expect(report.riskLevel).toBe('elevated');
    expect(report.utilizationRatioBps).toBe(9500);
    expect(report.findings.join(' ')).toContain('Elevated metric threshold reached');
  });

  it('formats a human-readable report including the safety caveat', () => {
    const report = reconcileSponsorshipReserves({
      targetId: SAMPLE_ID,
      expectedReserveStroops: 300,
      actualReserveStroops: 250,
      discrepancyStroops: 40,
      thresholdLimit: 1000,
    });

    const formatted = formatSponsorshipReconcileReport(report);
    expect(formatted).toContain(SAMPLE_ID);
    expect(formatted).toContain(report.caveat);
  });

  it('executes the runnable example entrypoint', async () => {
    const report = await run({ targetId: SAMPLE_ID, json: true });
    expect(report.targetId).toBe(SAMPLE_ID);
  });
});
