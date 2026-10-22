import {
  buildSignerAuditReport,
  formatSignerAuditReport,
} from '../src/examples/260-signer-recovery-readiness-audit';
import { examples } from '../src/runner/catalog';

const ACCOUNT_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

describe('260-signer-recovery-readiness-audit', () => {
  it('checks configured signer weight against low, medium, and high thresholds', () => {
    const report = buildSignerAuditReport({
      account_id: ACCOUNT_ID,
      signers: [
        { key: ACCOUNT_ID, type: 'ed25519_public_key', weight: 1 },
        { key: 'GOTHERONE', type: 'ed25519_public_key', weight: 2 },
        { key: 'GOTHERTWO', type: 'ed25519_public_key', weight: 2 },
      ],
      thresholds: { low_threshold: 1, med_threshold: 3, high_threshold: 5 },
    });

    expect(report.maximumConfiguredWeight).toBe(5);
    expect(report.thresholds.map((threshold) => threshold.configurationCanMeetThreshold)).toEqual([
      true,
      true,
      true,
    ]);
    expect(report.masterKeyWeight).toBe(1);
    expect(report.additionalSignerCount).toBe(2);
  });

  it('identifies a threshold that available configured weights cannot meet', () => {
    const report = buildSignerAuditReport({
      account_id: ACCOUNT_ID,
      signers: [{ key: ACCOUNT_ID, type: 'ed25519_public_key', weight: 1 }],
      thresholds: { low_threshold: 1, med_threshold: 2, high_threshold: 3 },
    });

    expect(report.thresholds.map((threshold) => threshold.configurationCanMeetThreshold)).toEqual([
      true,
      false,
      false,
    ]);
    expect(report.thresholds[2].missingWeight).toBe(2);
    expect(report.findings.join(' ')).toContain('cannot meet the high threshold');
  });

  it('does not claim recoverability and warns when signer redundancy is thin', () => {
    const report = buildSignerAuditReport({
      account_id: ACCOUNT_ID,
      signers: [{ key: ACCOUNT_ID, type: 'ed25519_public_key', weight: 1 }],
      thresholds: { low_threshold: 1, med_threshold: 1, high_threshold: 1 },
    });

    expect(report.recoveryCaveat).toContain('does not confirm that the account can be recovered');
    expect(report.findings.join(' ')).toContain('independent backup signer coverage is not apparent');
    expect(formatSignerAuditReport(report)).toContain('configuration-only assessment');
  });

  it('is registered as a runnable example', () => {
    expect(examples['260-signer-recovery-readiness-audit']).toBeDefined();
    expect(typeof examples['260-signer-recovery-readiness-audit'].run).toBe('function');
  });
});