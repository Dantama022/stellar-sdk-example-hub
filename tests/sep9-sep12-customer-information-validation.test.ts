import {
  prepareSep12CustomerFields,
  validateCustomerJson,
  validateCustomerPayload,
} from '../src/examples/customer-information-validator/validator';

describe('SEP-9 customer information validation', () => {
  it('accepts supported values and separately configured required fields', () => {
    const report = validateCustomerPayload(
      {
        fields: {
          first_name: 'Jordan',
          email_address: 'jordan@example.test',
          birth_date: '1990-04-12',
          occupation: 2511,
        },
      },
      { requiredFields: ['first_name', 'email_address'] },
    );

    expect(report.valid).toBe(true);
    expect(report.recognizedFields).toEqual(['birth_date', 'email_address', 'first_name', 'occupation']);
  });

  it('reports absent required fields without inventing SEP-9 required fields', () => {
    const report = validateCustomerPayload({ fields: { city: 'Lumen' } }, { requiredFields: ['first_name'] });

    expect(report.valid).toBe(false);
    expect(report.missingRequiredFields).toEqual(['first_name']);
    expect(report.invalidValues).toEqual([]);
  });

  it('reports invalid types and supported basic formats without echoing values', () => {
    const secret = 'private-tax-id-92814';
    const report = validateCustomerPayload({
      fields: {
        tax_id: secret,
        occupation: 'doctor',
        birth_date: '1990-02-31',
        email_address: 'not-an-email',
        mobile_number: '555-0100',
      },
    });

    expect(report.invalidValues.map(({ field }) => field)).toEqual([
      'occupation',
      'birth_date',
      'email_address',
      'mobile_number',
    ]);
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it('supports optional fields and reports unknown names separately', () => {
    const report = validateCustomerPayload({ fields: { city: 'Lumen', passport_number: 'fictional' } });

    expect(report.missingRequiredFields).toEqual([]);
    expect(report.invalidValues).toEqual([]);
    expect(report.recognizedFields).toEqual(['city']);
    expect(report.unknownFields).toEqual(['passport_number']);
  });

  it('treats empty and whitespace values as missing when required and invalid otherwise', () => {
    const report = validateCustomerPayload(
      { fields: { first_name: '  ', city: '' } },
      { requiredFields: ['first_name'] },
    );

    expect(report.missingRequiredFields).toEqual(['first_name']);
    expect(report.invalidValues).toEqual([{ field: 'city', rule: 'must not be empty or whitespace-only' }]);
  });

  it('rejects malformed structures and malformed JSON with actionable value-free errors', () => {
    expect(validateCustomerPayload({ fields: [] }).structureErrors).toContain(
      'Payload fields must be a JSON object mapping SEP-9 field names to values.',
    );
    const report = validateCustomerJson('{"fields":');
    expect(report.valid).toBe(false);
    expect(report.structureErrors[0]).toContain('valid JSON');
    expect(JSON.stringify(report)).not.toContain('{"fields":');
  });

  it('reports out-of-range dates and prototype-named keys without throwing', () => {
    const payload: unknown = JSON.parse(
      '{"fields":{"birth_date":"2024-99-99","__proto__":"unknown"}}',
    );
    const report = validateCustomerPayload(payload);

    expect(report.invalidValues.map(({ field }) => field)).toEqual(['birth_date']);
    expect(report.unknownFields).toEqual(['__proto__']);
  });

  it('rejects embedded field metadata so customer values and validation policy stay separate', () => {
    const report = validateCustomerPayload({ fields: {}, fieldMetadata: { first_name: { required: true } } });
    expect(report.structureErrors[0]).toContain('Keep descriptions and requirements in validation configuration');
  });

  it('validates base64 and explicit SEP-9 enum rules', () => {
    const report = validateCustomerPayload({
      fields: { photo_id_front: 'not base64', sex: 'unspecified', bank_account_type: 'corporate' },
    });
    expect(report.invalidValues.map(({ field }) => field)).toEqual([
      'photo_id_front',
      'sex',
      'bank_account_type',
    ]);
  });

  it('serializes valid and invalid reports as machine-readable JSON', () => {
    const validJson = JSON.stringify(validateCustomerJson('{"fields":{"city":"Lumen"}}'));
    const invalidJson = JSON.stringify(validateCustomerJson('{"fields":{"email_address":"bad"}}'));

    expect(JSON.parse(validJson).valid).toBe(true);
    expect(JSON.parse(invalidJson).invalidValues[0].field).toBe('email_address');
  });

  it('prepares SEP-12 field values independently without submitting them', () => {
    const prepared = prepareSep12CustomerFields({
      first_name: 'Jordan',
      photo_id_front: 'aGVsbG8=',
    });

    expect(prepared).toEqual({
      values: { first_name: 'Jordan' },
      binaryFields: { photo_id_front: 'aGVsbG8=' },
    });
  });
});