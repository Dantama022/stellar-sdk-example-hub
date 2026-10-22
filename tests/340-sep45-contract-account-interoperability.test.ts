import {
  inspectSep45ContractAccount,
  formatSep45InteropReport,
  run,
} from '../src/examples/340-sep45-contract-account-interoperability';

const SAMPLE_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

describe('340-sep45-contract-account-interoperability', () => {
  it('computes low risk when metrics are well below the threshold limit', () => {
    const report = inspectSep45ContractAccount({
      targetId: SAMPLE_ID,
      contractAddressValid: 100,
      supportsCheckAuth: 0,
      domainBindingVerified: 10,
      thresholdLimit: 1000,
    });

    expect(report.targetId).toBe(SAMPLE_ID);
    expect(report.riskLevel).toBe('low');
    expect(report.utilizationRatioBps).toBe(1000);
    expect(report.findings[0]).toContain('Nominal metrics');
  });

  it('flags elevated risk when utilization or secondary metric exceeds threshold', () => {
    const report = inspectSep45ContractAccount({
      targetId: SAMPLE_ID,
      contractAddressValid: 700,
      supportsCheckAuth: 250,
      domainBindingVerified: 1200,
      thresholdLimit: 1000,
    });

    expect(report.riskLevel).toBe('elevated');
    expect(report.utilizationRatioBps).toBe(9500);
    expect(report.findings.join(' ')).toContain('Elevated metric threshold reached');
  });

  it('formats a human-readable report including the safety caveat', () => {
    const report = inspectSep45ContractAccount({
      targetId: SAMPLE_ID,
      contractAddressValid: 300,
      supportsCheckAuth: 250,
      domainBindingVerified: 40,
      thresholdLimit: 1000,
    });

    const formatted = formatSep45InteropReport(report);
    expect(formatted).toContain(SAMPLE_ID);
    expect(formatted).toContain(report.caveat);
  });

  it('executes the runnable example entrypoint', async () => {
    const report = await run({ targetId: SAMPLE_ID, json: true });
    expect(report.targetId).toBe(SAMPLE_ID);
  });
});
