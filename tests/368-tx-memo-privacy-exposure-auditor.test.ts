import {
  auditTransactionMemoPrivacy,
  formatMemoPrivacyAuditReport,
  run,
} from '../src/examples/368-tx-memo-privacy-exposure-auditor';

const SAMPLE_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

describe('368-tx-memo-privacy-exposure-auditor', () => {
  it('computes low risk when metrics are well below the threshold limit', () => {
    const report = auditTransactionMemoPrivacy({
      targetId: SAMPLE_ID,
      memoType: 100,
      memoByteLength: 0,
      piiPatternCount: 10,
      thresholdLimit: 1000,
    });

    expect(report.targetId).toBe(SAMPLE_ID);
    expect(report.riskLevel).toBe('low');
    expect(report.utilizationRatioBps).toBe(1000);
    expect(report.findings[0]).toContain('Nominal metrics');
  });

  it('flags elevated risk when utilization or secondary metric exceeds threshold', () => {
    const report = auditTransactionMemoPrivacy({
      targetId: SAMPLE_ID,
      memoType: 700,
      memoByteLength: 250,
      piiPatternCount: 1200,
      thresholdLimit: 1000,
    });

    expect(report.riskLevel).toBe('elevated');
    expect(report.utilizationRatioBps).toBe(9500);
    expect(report.findings.join(' ')).toContain('Elevated metric threshold reached');
  });

  it('formats a human-readable report including the safety caveat', () => {
    const report = auditTransactionMemoPrivacy({
      targetId: SAMPLE_ID,
      memoType: 300,
      memoByteLength: 250,
      piiPatternCount: 40,
      thresholdLimit: 1000,
    });

    const formatted = formatMemoPrivacyAuditReport(report);
    expect(formatted).toContain(SAMPLE_ID);
    expect(formatted).toContain(report.caveat);
  });

  it('executes the runnable example entrypoint', async () => {
    const report = await run({ targetId: SAMPLE_ID, json: true });
    expect(report.targetId).toBe(SAMPLE_ID);
  });
});
