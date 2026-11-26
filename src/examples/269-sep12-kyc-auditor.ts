export type Sep12CustomerStatus = 'NEEDS_INFO' | 'PROCESSING' | 'ACCEPTED' | 'REJECTED';
export type Sep12FieldStatus = 'ACCEPTED' | 'PROCESSING' | 'REJECTED' | 'VERIFICATION_REQUIRED';

export interface Sep12FieldRequirement {
  type: string;
  description?: string;
  optional?: boolean;
  choices?: string[];
  /** Optional predicate for conditional field requirements */
  requiredWhen?: (providedFieldNames: ReadonlySet<string>) => boolean;
}

export interface Sep12ProvidedField {
  type?: string;
  description?: string;
  optional?: boolean;
  status?: Sep12FieldStatus | string;
  error?: string;
}

export interface Sep12CustomerResponse {
  id?: string;
  status: Sep12CustomerStatus | string;
  message?: string;
  fields?: Record<string, Sep12FieldRequirement>;
  provided_fields?: Record<string, Sep12ProvidedField>;
}

export interface Sep12AuditOptions {
  anchorService?: string;
  customerId?: string;
  customerType?: string;
  conditionalRequirements?: Record<string, (providedFieldNames: ReadonlySet<string>) => boolean>;
}

export interface Sep12KycAuditReport {
  anchorService: string;
  redactedCustomerId: string;
  customerType: string;
  overallStatus: string;
  recognizedOverallStatus: boolean;
  counts: {
    requiredFields: number;
    optionalFields: number;
    submittedFields: number;
    missingRequiredFields: number;
    acceptedFields: number;
    processingFields: number;
    rejectedFields: number;
    verificationRequiredFields: number;
  };
  missingRequiredFieldNames: string[];
  rejectedFieldNames: string[];
  processingFieldNames: string[];
  outstandingRequests: string[];
  inconsistencies: string[];
  recommendedActions: string[];
  disclaimer: string;
}

export interface Sep12HttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type Sep12Fetcher = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<Sep12HttpResponse>;

const VALID_CUSTOMER_STATUSES = new Set<string>(['NEEDS_INFO', 'PROCESSING', 'ACCEPTED', 'REJECTED']);
const VALID_FIELD_STATUSES = new Set<string>([
  'ACCEPTED',
  'PROCESSING',
  'REJECTED',
  'VERIFICATION_REQUIRED',
]);

export function redactCustomerIdentifier(rawId: string | undefined): string {
  if (!rawId || rawId.trim() === '') return 'unassigned';
  const trimmed = rawId.trim();
  if (trimmed.length <= 6) return '***';
  return `${trimmed.slice(0, 3)}***${trimmed.slice(-3)}`;
}

export async function fetchSep12Customer(
  anchorBaseUrl: string,
  authToken: string,
  query: { id?: string; account?: string; type?: string; transactionId?: string },
  fetcher: Sep12Fetcher = (url, init) => fetch(url, init) as Promise<Sep12HttpResponse>,
): Promise<Sep12CustomerResponse> {
  const cleanBase = anchorBaseUrl.replace(/\/+$/, '');
  const params = new URLSearchParams();
  if (query.id) params.set('id', query.id);
  if (query.account) params.set('account', query.account);
  if (query.type) params.set('type', query.type);
  if (query.transactionId) params.set('transaction_id', query.transactionId);

  const qs = params.toString();
  const url = `${cleanBase}/customer${qs ? `?${qs}` : ''}`;

  const res = await fetcher(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${authToken}`,
    },
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error(`SEP-12 authentication failed (HTTP ${res.status}).`);
  }
  if (res.status === 404) {
    throw new Error('SEP-12 customer record not found (HTTP 404).');
  }
  if (!res.ok) {
    throw new Error(`SEP-12 anchor returned HTTP ${res.status}.`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error('SEP-12 anchor returned malformed JSON.');
  }

  if (!body || typeof body !== 'object' || typeof (body as Sep12CustomerResponse).status !== 'string') {
    throw new Error('Malformed SEP-12 customer response: missing status.');
  }

  return body as Sep12CustomerResponse;
}

export function auditSep12CustomerRecord(
  record: Sep12CustomerResponse,
  options: Sep12AuditOptions = {},
): Sep12KycAuditReport {
  const anchorService = options.anchorService ?? 'unspecified-anchor';
  const redactedCustomerId = redactCustomerIdentifier(record.id ?? options.customerId);
  const customerType = options.customerType ?? 'default';
  const overallStatus = record.status;
  const recognizedOverallStatus = VALID_CUSTOMER_STATUSES.has(overallStatus);

  const fields = record.fields ?? {};
  const providedFields = record.provided_fields ?? {};
  const providedNames = new Set(Object.keys(providedFields));

  const missingRequiredFieldNames: string[] = [];
  const rejectedFieldNames: string[] = [];
  const processingFieldNames: string[] = [];
  const outstandingRequests: string[] = [];
  const inconsistencies: string[] = [];
  const recommendedActions: string[] = [];

  let requiredFields = 0;
  let optionalFields = 0;
  let acceptedFields = 0;
  let verificationRequiredFields = 0;

  if (!recognizedOverallStatus) {
    inconsistencies.push(`Unrecognized SEP-12 customer status: "${overallStatus}".`);
  }

  // Evaluate requested/missing fields
  for (const [fieldName, req] of Object.entries(fields)) {
    const conditionalRule = req.requiredWhen ?? options.conditionalRequirements?.[fieldName];
    const isConditionallyRequired = conditionalRule ? conditionalRule(providedNames) : false;
    const isRequired = !req.optional || isConditionallyRequired;

    if (isRequired) {
      requiredFields += 1;
      if (!providedNames.has(fieldName)) {
        missingRequiredFieldNames.push(fieldName);
        outstandingRequests.push(
          `Required field "${fieldName}" (${req.type}) has not been submitted.`,
        );
      }
    } else {
      optionalFields += 1;
    }
  }

  // Evaluate submitted/provided fields (never include raw values or PII)
  for (const [fieldName, info] of Object.entries(providedFields)) {
    const status = info.status;
    if (status && !VALID_FIELD_STATUSES.has(status)) {
      inconsistencies.push(`Field "${fieldName}" has unrecognized status "${status}".`);
      continue;
    }

    if (status === 'ACCEPTED') {
      acceptedFields += 1;
    } else if (status === 'PROCESSING') {
      processingFieldNames.push(fieldName);
    } else if (status === 'REJECTED') {
      rejectedFieldNames.push(fieldName);
      outstandingRequests.push(
        `Field "${fieldName}" was rejected${info.error ? `: ${info.error}` : '.'}`,
      );
    } else if (status === 'VERIFICATION_REQUIRED') {
      verificationRequiredFields += 1;
      outstandingRequests.push(`Field "${fieldName}" requires additional verification.`);
    }
  }

  // Detect customer-level vs field-level inconsistencies
  if (overallStatus === 'ACCEPTED') {
    if (rejectedFieldNames.length > 0 || processingFieldNames.length > 0 || missingRequiredFieldNames.length > 0) {
      inconsistencies.push(
        `Customer status is ACCEPTED, but field-level checks show missing=${missingRequiredFieldNames.length}, processing=${processingFieldNames.length}, rejected=${rejectedFieldNames.length}.`,
      );
    }
  }

  if (overallStatus === 'PROCESSING' && missingRequiredFieldNames.length > 0) {
    inconsistencies.push(
      `Customer status is PROCESSING, yet ${missingRequiredFieldNames.length} required field(s) remain unsubmitted.`,
    );
  }

  if (overallStatus === 'REJECTED' && rejectedFieldNames.length === 0 && !record.message) {
    inconsistencies.push(
      'Customer status is REJECTED, but no rejected fields or anchor rejection message were provided.',
    );
  }

  if (missingRequiredFieldNames.length > 0) {
    recommendedActions.push(`Submit missing required fields: ${missingRequiredFieldNames.join(', ')}.`);
  }
  if (rejectedFieldNames.length > 0) {
    recommendedActions.push(`Correct and resubmit rejected fields: ${rejectedFieldNames.join(', ')}.`);
  }
  if (processingFieldNames.length > 0) {
    recommendedActions.push(`Wait for anchor review of processing fields: ${processingFieldNames.join(', ')}.`);
  }
  if (overallStatus === 'ACCEPTED' && inconsistencies.length === 0) {
    recommendedActions.push('No further KYC action required for the current state.');
  }

  return {
    anchorService,
    redactedCustomerId,
    customerType,
    overallStatus,
    recognizedOverallStatus,
    counts: {
      requiredFields,
      optionalFields,
      submittedFields: Object.keys(providedFields).length,
      missingRequiredFields: missingRequiredFieldNames.length,
      acceptedFields,
      processingFields: processingFieldNames.length,
      rejectedFields: rejectedFieldNames.length,
      verificationRequiredFields,
    },
    missingRequiredFieldNames,
    rejectedFieldNames,
    processingFieldNames,
    outstandingRequests,
    inconsistencies,
    recommendedActions,
    disclaimer:
      'Audit only: reflects the current SEP-12 state exposed by the anchor without storing PII or claiming historical transition logs.',
  };
}

export function formatSep12KycAuditReport(report: Sep12KycAuditReport): string {
  const lines = [
    '=== Stellar SEP-12 KYC Status Audit Report ===',
    `Anchor: ${report.anchorService}`,
    `Customer (redacted): ${report.redactedCustomerId} (type=${report.customerType})`,
    `Overall Status: ${report.overallStatus} (recognized=${report.recognizedOverallStatus})`,
    `Fields: required=${report.counts.requiredFields}, optional=${report.counts.optionalFields}, submitted=${report.counts.submittedFields}, missing=${report.counts.missingRequiredFields}, accepted=${report.counts.acceptedFields}, processing=${report.counts.processingFields}, rejected=${report.counts.rejectedFields}`,
  ];
  if (report.outstandingRequests.length > 0) {
    lines.push('Outstanding Requests:', ...report.outstandingRequests.map((r) => `  - ${r}`));
  }
  if (report.inconsistencies.length > 0) {
    lines.push('Inconsistencies:', ...report.inconsistencies.map((i) => `  - ${i}`));
  }
  if (report.recommendedActions.length > 0) {
    lines.push('Recommended Actions:', ...report.recommendedActions.map((a) => `  - ${a}`));
  }
  lines.push('', `Disclaimer: ${report.disclaimer}`);
  return lines.join('\n');
}

export async function run(params: { json?: boolean | string } = {}): Promise<void> {
  const report = auditSep12CustomerRecord(
    {
      id: 'cust-987654321',
      status: 'NEEDS_INFO',
      fields: {
        email_address: { type: 'string', description: 'Email address', optional: false },
        phone_number: { type: 'string', description: 'Phone number', optional: true },
      },
      provided_fields: {
        first_name: { type: 'string', status: 'ACCEPTED' },
      },
    },
    { anchorService: 'https://anchor.example.com', customerType: 'sep31-sender' },
  );
  const json = params.json === true || params.json === 'true';
  console.log(json ? JSON.stringify(report, null, 2) : formatSep12KycAuditReport(report));
}
