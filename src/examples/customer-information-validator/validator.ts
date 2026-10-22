import { isIP } from 'node:net';

import {
  CustomerInformationValidationReport,
  PreparedSep12CustomerFields,
  Sep9FieldDefinition,
  ValidationOptions,
} from './types';

export const SEP9_FIELD_DEFINITIONS: Readonly<Record<string, Sep9FieldDefinition>> = {
  family_name: { type: 'string', description: 'Family or last name.' },
  last_name: { type: 'string', description: 'Family or last name.' },
  given_name: { type: 'string', description: 'Given or first name.' },
  first_name: { type: 'string', description: 'Given or first name.' },
  additional_name: { type: 'string', description: 'Middle or additional name.' },
  address_country_code: { type: 'string', description: 'Country code for current address.' },
  state_or_province: { type: 'string', description: 'State, province, region, or prefecture.' },
  city: { type: 'string', description: 'City or town.' },
  postal_code: { type: 'string', description: "Postal or other code identifying the user's locale." },
  address: { type: 'string', description: 'Full multi-line address.' },
  mobile_number: { type: 'string', description: 'Mobile number, normally in E.164 format.' },
  mobile_number_format: { type: 'string', description: 'Format used by mobile_number.' },
  email_address: { type: 'string', description: 'Email address.' },
  birth_date: { type: 'date', description: 'Date of birth.' },
  birth_place: { type: 'string', description: 'Place of birth.' },
  birth_country_code: { type: 'string', description: 'ISO country code of birth.' },
  tax_id: { type: 'string', description: 'Tax identifier in the relevant country.' },
  tax_id_name: { type: 'string', description: 'Name of the tax identifier.' },
  occupation: { type: 'number', description: 'Occupation ISCO code.' },
  employer_name: { type: 'string', description: 'Employer name.' },
  employer_address: { type: 'string', description: 'Employer address.' },
  language_code: { type: 'string', description: 'Primary language.' },
  id_type: { type: 'string', description: 'Type of identity document.' },
  id_country_code: {
    type: 'string',
    description: 'Country issuing the passport or photo ID.',
    formats: ['ISO 3166-1 alpha-3'],
  },
  id_issue_date: { type: 'date', description: 'Identity document issue date.' },
  id_expiration_date: { type: 'date', description: 'Identity document expiration date.' },
  id_number: { type: 'string', description: 'Passport or identity document number.' },
  photo_id_front: { type: 'binary', description: 'Image of the front of a photo ID.' },
  photo_id_back: { type: 'binary', description: 'Image of the back of a photo ID.' },
  notary_approval_of_photo_id: { type: 'binary', description: "Notary's approval of photo ID." },
  ip_address: { type: 'string', description: "Customer's IP address." },
  photo_proof_residence: { type: 'binary', description: 'Image proving residence.' },
  sex: { type: 'string', description: 'Sex; SEP-9 lists male, female, or other.' },
  proof_of_income: { type: 'binary', description: 'Image of proof of income.' },
  proof_of_liveness: { type: 'binary', description: 'Video or image for proof of liveness.' },
  referral_id: { type: 'string', description: 'Origin or referral identifier.' },
  bank_name: { type: 'string', description: 'Bank name.' },
  bank_account_type: { type: 'string', description: 'Bank account type; SEP-9 lists checking or savings.' },
  bank_account_number: { type: 'string', description: 'Bank account number.' },
  bank_number: { type: 'string', description: 'Number identifying a bank in a national system.' },
  bank_phone_number: { type: 'string', description: 'Bank phone number.' },
  bank_branch_number: { type: 'string', description: 'Bank branch number.' },
  external_transfer_memo: { type: 'string', description: 'Destination tag or memo.' },
  clabe_number: { type: 'string', description: 'Bank account number for Mexico.' },
  cbu_number: { type: 'string', description: 'CBU or CVU number.' },
  cbu_alias: { type: 'string', description: 'CBU or CVU alias.' },
  mobile_money_number: { type: 'string', description: 'E.164 mobile money account number.' },
  mobile_money_provider: { type: 'string', description: 'Mobile money service provider.' },
  crypto_address: { type: 'string', description: 'Cryptocurrency account address.' },
  crypto_memo: { type: 'string', description: 'Deprecated destination tag or memo.' },
  'organization.name': { type: 'string', description: 'Organization name as incorporated.' },
  'organization.VAT_number': { type: 'string', description: 'Organization VAT number.' },
  'organization.registration_number': { type: 'string', description: 'Organization registration number.' },
  'organization.registration_date': { type: 'string', description: 'Organization registration date.' },
  'organization.registered_address': { type: 'string', description: 'Organization registered address.' },
  'organization.number_of_shareholders': { type: 'number', description: 'Organization shareholder count.' },
  'organization.shareholder_name': { type: 'string', description: 'Shareholder name.' },
  'organization.photo_incorporation_doc': { type: 'binary', description: 'Image of incorporation documents.' },
  'organization.photo_proof_address': { type: 'binary', description: 'Image proving organization address.' },
  'organization.address_country_code': { type: 'string', description: 'Organization address country code.' },
  'organization.state_or_province': { type: 'string', description: 'Organization state, province, or region.' },
  'organization.city': { type: 'string', description: 'Organization city or town.' },
  'organization.postal_code': { type: 'string', description: 'Organization postal code.' },
  'organization.director_name': { type: 'string', description: 'Organization managing director.' },
  'organization.website': { type: 'string', description: 'Organization website.' },
  'organization.email': { type: 'string', description: 'Organization contact email.' },
  'organization.phone': { type: 'string', description: 'Organization contact phone.' },
  'card.number': { type: 'string', description: 'Card number.' },
  'card.expiration_date': { type: 'date', description: 'Card expiration in YY-MM format.' },
  'card.cvc': { type: 'string', description: 'Card CVC.' },
  'card.holder_name': { type: 'string', description: 'Card holder name.' },
  'card.network': { type: 'string', description: 'Card network.' },
  'card.postal_code': { type: 'string', description: 'Card billing postal code.' },
  'card.country_code': {
    type: 'string',
    description: 'Card billing country code.',
    formats: ['ISO 3166-1 alpha-2'],
  },
  'card.state_or_province': { type: 'string', description: 'Card billing state or province.' },
  'card.city': { type: 'string', description: 'Card billing city or town.' },
  'card.address': { type: 'string', description: 'Card billing address.' },
  'card.token': { type: 'string', description: 'External payment system token.' },
};

const VALIDATION_RULES = [
  'Only fields in the current SEP-9 field tables are recognized; other field names are reported as unknown.',
  'SEP-9 defines no universally required fields. Required fields are supplied separately in validation options.',
  'String fields must be non-empty after trimming; values are never included in diagnostics.',
  'Date fields use YYYY-MM-DD, except card.expiration_date which uses YY-MM.',
  'Binary fields in JSON input must be non-empty standard base64 strings; SEP-12 uploads binary fields as multipart data.',
  'Email, IP address, E.164 mobile numbers, and explicitly specified ISO country-code shapes receive basic syntax checks.',
  'Country-specific identity, tax, banking, address, and document-number formats are not inferred.',
];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_PATTERN = /^\+[1-9]\d{1,14}$/;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const CARD_EXPIRATION_PATTERN = /^(\d{2})-(\d{2})$/;

export function validateCustomerPayload(
  payload: unknown,
  options: ValidationOptions = {},
): CustomerInformationValidationReport {
  const report = emptyReport();
  const structureErrors = validatePayloadStructure(payload);
  if (structureErrors.length > 0) {
    report.structureErrors.push(...structureErrors);
    finishReport(report);
    return report;
  }

  const { fields } = payload as { fields: Record<string, unknown> };
  const values = new Map(Object.entries(fields));
  const required = new Set(options.requiredFields ?? []);

  for (const requiredField of required) {
    if (!Object.hasOwn(SEP9_FIELD_DEFINITIONS, requiredField)) {
      report.applicableRules.push(`Configured required field "${requiredField}" is not in the local SEP-9 schema.`);
    }
  }

  for (const [field, value] of values) {
    if (!Object.hasOwn(SEP9_FIELD_DEFINITIONS, field)) {
      report.unknownFields.push(field);
      continue;
    }

    const definition = SEP9_FIELD_DEFINITIONS[field];
    report.recognizedFields.push(field);
    if (isEmptyValue(value)) {
      if (required.has(field)) {
        report.missingRequiredFields.push(field);
      } else {
        report.invalidValues.push({ field, rule: 'must not be empty or whitespace-only' });
      }
      continue;
    }

    const rule = getValueError(field, value, definition.type, values);
    if (rule) report.invalidValues.push({ field, rule });
  }

  for (const field of required) {
    if (!values.has(field)) report.missingRequiredFields.push(field);
  }

  report.missingRequiredFields = [...new Set(report.missingRequiredFields)].sort();
  report.recognizedFields.sort();
  report.unknownFields.sort();
  finishReport(report);
  return report;
}

export function validateCustomerJson(
  json: string,
  options: ValidationOptions = {},
): CustomerInformationValidationReport {
  try {
    return validateCustomerPayload(JSON.parse(json) as unknown, options);
  } catch {
    const report = emptyReport();
    report.structureErrors.push('Input is not valid JSON. Correct the JSON syntax and try again.');
    finishReport(report);
    return report;
  }
}

export function prepareSep12CustomerFields(
  fields: Record<string, unknown>,
): PreparedSep12CustomerFields {
  const values: Array<[string, string | number]> = [];
  const binaryFields: Array<[string, string]> = [];

  for (const [field, value] of Object.entries(fields)) {
    if (!Object.hasOwn(SEP9_FIELD_DEFINITIONS, field)) continue;
    if (SEP9_FIELD_DEFINITIONS[field].type === 'binary' && typeof value === 'string') {
      binaryFields.push([field, value]);
    } else if (typeof value === 'string' || typeof value === 'number') {
      values.push([field, value]);
    }
  }

  return { values: Object.fromEntries(values), binaryFields: Object.fromEntries(binaryFields) };
}

function validatePayloadStructure(payload: unknown): string[] {
  if (!isRecord(payload)) {
    return ['Payload must be a JSON object with a fields object.'];
  }

  if (Object.keys(payload).some((key) => key !== 'fields')) {
    return ['Payload may contain only fields. Keep descriptions and requirements in validation configuration, not customer input.'];
  }

  if (!isRecord(payload.fields)) {
    return ['Payload fields must be a JSON object mapping SEP-9 field names to values.'];
  }

  return [];
}

function getValueError(
  field: string,
  value: unknown,
  type: Sep9FieldDefinition['type'],
  values: Map<string, unknown>,
): string | undefined {
  if (type === 'number') {
    return typeof value === 'number' && Number.isFinite(value)
      ? undefined
      : 'must be a finite JSON number';
  }

  if (typeof value !== 'string') {
    return type === 'binary'
      ? 'must be a base64-encoded JSON string'
      : `must be a ${type === 'date' ? 'date string' : 'string'}`;
  }

  if (type === 'binary') return isBase64(value) ? undefined : 'must be a non-empty standard base64 string';
  if (type === 'date') return isValidDate(field, value) ? undefined : dateRule(field);
  if (field === 'email_address' || field === 'organization.email') {
    return EMAIL_PATTERN.test(value) ? undefined : 'must have a basic email address format';
  }
  if (field === 'ip_address') return isIP(value) ? undefined : 'must be a valid IPv4 or IPv6 address';
  if (field === 'organization.website') return isHttpUrl(value) ? undefined : 'must be an absolute HTTP or HTTPS URL';
  if (field === 'id_country_code' && !/^[A-Za-z]{3}$/.test(value)) {
    return 'must contain three letters (ISO 3166-1 alpha-3 shape)';
  }
  if (field === 'card.country_code' && !/^[A-Za-z]{2}$/.test(value)) {
    return 'must contain two letters (ISO 3166-1 alpha-2 shape)';
  }
  if (field === 'sex' && !['male', 'female', 'other'].includes(value)) {
    return 'must be one of the SEP-9 values: male, female, or other';
  }
  if (field === 'bank_account_type' && !['checking', 'savings'].includes(value)) {
    return 'must be one of the SEP-9 values: checking or savings';
  }
  if (field === 'mobile_number' && requiresE164(values.get('mobile_number_format')) && !E164_PATTERN.test(value)) {
    return 'must use E.164 format when mobile_number_format is absent or E.164';
  }
  if (field === 'mobile_money_number' && !E164_PATTERN.test(value)) {
    return 'must use E.164 format';
  }

  return undefined;
}

function isValidDate(field: string, value: string): boolean {
  if (field === 'card.expiration_date') {
    const match = CARD_EXPIRATION_PATTERN.exec(value);
    return Boolean(match && Number(match[2]) >= 1 && Number(match[2]) <= 12);
  }

  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function dateRule(field: string): string {
  return field === 'card.expiration_date' ? 'must use YY-MM with a month from 01 to 12' : 'must be a valid YYYY-MM-DD calendar date';
}

function requiresE164(format: unknown): boolean {
  if (typeof format !== 'string' || format.trim() === '') return true;
  return format.trim().toLowerCase() === 'e.164';
}

function isBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emptyReport(): CustomerInformationValidationReport {
  return {
    valid: false,
    recognizedFields: [],
    missingRequiredFields: [],
    invalidValues: [],
    unknownFields: [],
    structureErrors: [],
    applicableRules: [...VALIDATION_RULES],
    nextSteps: [],
  };
}

function finishReport(report: CustomerInformationValidationReport): void {
  report.applicableRules = [...new Set(report.applicableRules)];
  report.valid =
    report.structureErrors.length === 0 &&
    report.missingRequiredFields.length === 0 &&
    report.invalidValues.length === 0 &&
    report.unknownFields.length === 0;
  report.nextSteps = report.valid
    ? ['Local syntax checks passed. Confirm the anchor requirements and customer status separately before any SEP-12 submission.']
    : ['Correct the listed field names or values and provide every configured required field. No submitted values are included in this report.'];
}