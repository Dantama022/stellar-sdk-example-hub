import {
  checkEndpointCompatibility,
  formatEndpointCompatibilityReport,
  run,
} from '../src/examples/351-network-config-endpoint-compatibility';

const SAMPLE_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

describe('351-network-config-endpoint-compatibility', () => {
  it('computes low risk when metrics are well below the threshold limit', () => {
    const report = checkEndpointCompatibility({
      targetId: SAMPLE_ID,
      horizonProtocolVersion: 100,
      rpcProtocolVersion: 0,
      passphraseMatches: 10,
      thresholdLimit: 1000,
    });

    expect(report.targetId).toBe(SAMPLE_ID);
    expect(report.riskLevel).toBe('low');
    expect(report.utilizationRatioBps).toBe(1000);
    expect(report.findings[0]).toContain('Nominal metrics');
  });

  it('flags elevated risk when utilization or secondary metric exceeds threshold', () => {
    const report = checkEndpointCompatibility({
      targetId: SAMPLE_ID,
      horizonProtocolVersion: 700,
      rpcProtocolVersion: 250,
      passphraseMatches: 1200,
      thresholdLimit: 1000,
    });

    expect(report.riskLevel).toBe('elevated');
    expect(report.utilizationRatioBps).toBe(9500);
    expect(report.findings.join(' ')).toContain('Elevated metric threshold reached');
  });

  it('formats a human-readable report including the safety caveat', () => {
    const report = checkEndpointCompatibility({
      targetId: SAMPLE_ID,
      horizonProtocolVersion: 300,
      rpcProtocolVersion: 250,
      passphraseMatches: 40,
      thresholdLimit: 1000,
    });

    const formatted = formatEndpointCompatibilityReport(report);
    expect(formatted).toContain(SAMPLE_ID);
    expect(formatted).toContain(report.caveat);
  });

  it('executes the runnable example entrypoint', async () => {
    const report = await run({ targetId: SAMPLE_ID, json: true });
    expect(report.targetId).toBe(SAMPLE_ID);
  });
});
