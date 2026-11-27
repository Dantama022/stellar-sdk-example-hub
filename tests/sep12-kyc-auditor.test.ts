import {
  auditSep12CustomerRecord,
  fetchSep12Customer,
  formatSep12KycAuditReport,
  redactCustomerIdentifier,
} from '../src/examples/269-sep12-kyc-auditor';
import { examples } from '../src/runner/catalog';

describe('269-sep12-kyc-auditor', () => {
  it('audits an ACCEPTED customer with all required fields approved and redacts customer ID', () => {
    const report = auditSep12CustomerRecord(
      {
        id: 'customer-123456789',
        status: 'ACCEPTED',
        provided_fields: {
          first_name: { type: 'string', status: 'ACCEPTED' },
          last_name: { type: 'string', status: 'ACCEPTED' },
        },
      },
      { anchorService: 'https://anchor.test', customerType: 'sep31-sender' },
    );

    expect(report.overallStatus).toBe('ACCEPTED');
    expect(report.counts.acceptedFields).toBe(2);
    expect(report.inconsistencies).toEqual([]);
    expect(report.redactedCustomerId).toBe('cus***789');
    const rendered = formatSep12KycAuditReport(report);
    expect(rendered).not.toContain('customer-123456789');
    expect(JSON.stringify(report)).not.toContain('customer-123456789');
  });

  it('audits PROCESSING, NEEDS_INFO, and REJECTED field states', () => {
    const processing = auditSep12CustomerRecord({
      id: 'cust-proc-1',
      status: 'PROCESSING',
      provided_fields: {
        id_document: { type: 'binary', status: 'PROCESSING' },
      },
    });
    expect(processing.counts.processingFields).toBe(1);
    expect(processing.processingFieldNames).toEqual(['id_document']);

    const needsInfo = auditSep12CustomerRecord({
      id: 'cust-info-1',
      status: 'NEEDS_INFO',
      fields: {
        email_address: { type: 'string', optional: false },
        referral_code: { type: 'string', optional: true },
      },
      provided_fields: {
        first_name: { type: 'string', status: 'ACCEPTED' },
      },
    });
    expect(needsInfo.counts.requiredFields).toBe(1);
    expect(needsInfo.counts.optionalFields).toBe(1);
    expect(needsInfo.missingRequiredFieldNames).toEqual(['email_address']);

    const rejected = auditSep12CustomerRecord({
      id: 'cust-rej-1',
      status: 'REJECTED',
      provided_fields: {
        id_number: { type: 'string', status: 'REJECTED', error: 'Document expired' },
      },
    });
    expect(rejected.counts.rejectedFields).toBe(1);
    expect(rejected.rejectedFieldNames).toEqual(['id_number']);
    expect(rejected.outstandingRequests[0]).toContain('Document expired');
  });

  it('handles conditional field requirements', () => {
    const report = auditSep12CustomerRecord(
      {
        id: 'cust-cond-1',
        status: 'NEEDS_INFO',
        fields: {
          employer_name: {
            type: 'string',
            optional: true,
          },
        },
        provided_fields: {
          employment_status: { type: 'string', status: 'ACCEPTED' },
        },
      },
      {
        conditionalRequirements: {
          employer_name: (provided) => provided.has('employment_status'),
        },
      },
    );

    expect(report.counts.requiredFields).toBe(1);
    expect(report.missingRequiredFieldNames).toEqual(['employer_name']);
  });

  it('detects inconsistent customer-level and field-level statuses and unrecognized statuses', () => {
    const inconsistent = auditSep12CustomerRecord({
      id: 'cust-inc-1',
      status: 'ACCEPTED',
      provided_fields: {
        id_number: { type: 'string', status: 'REJECTED', error: 'Invalid' },
      },
    });
    expect(inconsistent.inconsistencies.some((i) => i.includes('Customer status is ACCEPTED'))).toBe(true);

    const unrecognized = auditSep12CustomerRecord({
      id: 'cust-unk-1',
      status: 'MYSTERY_STATUS',
      provided_fields: {
        first_name: { type: 'string', status: 'WEIRD_FIELD_STATUS' },
      },
    });
    expect(unrecognized.recognizedOverallStatus).toBe(false);
    expect(unrecognized.inconsistencies.some((i) => i.includes('MYSTERY_STATUS'))).toBe(true);
    expect(unrecognized.inconsistencies.some((i) => i.includes('WEIRD_FIELD_STATUS'))).toBe(true);
  });

  it('handles missing customer record (404) and authentication failure (401)', async () => {
    await expect(
      fetchSep12Customer('https://anchor.test', 'tok', { id: 'missing' }, async () => ({
        ok: false,
        status: 404,
        async json() {
          return {};
        },
      })),
    ).rejects.toThrow(/not found/);

    await expect(
      fetchSep12Customer('https://anchor.test', 'bad-tok', { id: 'x' }, async () => ({
        ok: false,
        status: 401,
        async json() {
          return {};
        },
      })),
    ).rejects.toThrow(/authentication failed/);

    expect(redactCustomerIdentifier('short')).toBe('***');
    expect(redactCustomerIdentifier(undefined)).toBe('unassigned');
  });

  it('is registered in the example catalog', () => {
    expect(examples['269-sep12-kyc-auditor']).toBeDefined();
  });
});
