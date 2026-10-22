import {
  inspectLedgerProtocolTrack,
  formatLedgerProtocolReport,
  run,
} from '../src/examples/380-ledger-header-protocol-tracker';

const SAMPLE_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

describe('380-ledger-header-protocol-tracker', () => {
  it('computes low risk when metrics are well below the threshold limit', () => {
    const report = inspectLedgerProtocolTrack({
      targetId: SAMPLE_ID,
      protocolVersion: 100,
      baseFeeStroops: 0,
      maxTxSetSize: 10,
      thresholdLimit: 1000,
    });

    expect(report.targetId).toBe(SAMPLE_ID);
    expect(report.riskLevel).toBe('low');
    expect(report.utilizationRatioBps).toBe(1000);
    expect(report.findings[0]).toContain('Nominal metrics');
  });

  it('flags elevated risk when utilization or secondary metric exceeds threshold', () => {
    const report = inspectLedgerProtocolTrack({
      targetId: SAMPLE_ID,
      protocolVersion: 700,
      baseFeeStroops: 250,
      maxTxSetSize: 1200,
      thresholdLimit: 1000,
    });

    expect(report.riskLevel).toBe('elevated');
    expect(report.utilizationRatioBps).toBe(9500);
    expect(report.findings.join(' ')).toContain('Elevated metric threshold reached');
  });

  it('formats a human-readable report including the safety caveat', () => {
    const report = inspectLedgerProtocolTrack({
      targetId: SAMPLE_ID,
      protocolVersion: 300,
      baseFeeStroops: 250,
      maxTxSetSize: 40,
      thresholdLimit: 1000,
    });

    const formatted = formatLedgerProtocolReport(report);
    expect(formatted).toContain(SAMPLE_ID);
    expect(formatted).toContain(report.caveat);
  });

  it('executes the runnable example entrypoint', async () => {
    const report = await run({ targetId: SAMPLE_ID, json: true });
    expect(report.targetId).toBe(SAMPLE_ID);
  });
});
