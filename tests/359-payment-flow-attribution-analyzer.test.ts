import {
  analyzePaymentFlowAttribution,
  formatPaymentAttributionReport,
  run,
} from '../src/examples/359-payment-flow-attribution-analyzer';

const SAMPLE_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

describe('359-payment-flow-attribution-analyzer', () => {
  it('computes low risk when metrics are well below the threshold limit', () => {
    const report = analyzePaymentFlowAttribution({
      targetId: SAMPLE_ID,
      inboundStroops: 100,
      outboundStroops: 0,
      uniqueCounterparties: 10,
      thresholdLimit: 1000,
    });

    expect(report.targetId).toBe(SAMPLE_ID);
    expect(report.riskLevel).toBe('low');
    expect(report.utilizationRatioBps).toBe(1000);
    expect(report.findings[0]).toContain('Nominal metrics');
  });

  it('flags elevated risk when utilization or secondary metric exceeds threshold', () => {
    const report = analyzePaymentFlowAttribution({
      targetId: SAMPLE_ID,
      inboundStroops: 700,
      outboundStroops: 250,
      uniqueCounterparties: 1200,
      thresholdLimit: 1000,
    });

    expect(report.riskLevel).toBe('elevated');
    expect(report.utilizationRatioBps).toBe(9500);
    expect(report.findings.join(' ')).toContain('Elevated metric threshold reached');
  });

  it('formats a human-readable report including the safety caveat', () => {
    const report = analyzePaymentFlowAttribution({
      targetId: SAMPLE_ID,
      inboundStroops: 300,
      outboundStroops: 250,
      uniqueCounterparties: 40,
      thresholdLimit: 1000,
    });

    const formatted = formatPaymentAttributionReport(report);
    expect(formatted).toContain(SAMPLE_ID);
    expect(formatted).toContain(report.caveat);
  });

  it('executes the runnable example entrypoint', async () => {
    const report = await run({ targetId: SAMPLE_ID, json: true });
    expect(report.targetId).toBe(SAMPLE_ID);
  });
});
