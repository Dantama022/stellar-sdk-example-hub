/** ISSUE-331 / SEP-12: discover, submit synthetic customer fields, inspect status. */
import { AnchorHttp, FetchLike, JsonObject, endpointUrl, mockFetch, object,
  requiredString, useLive } from './anchor-workflow-helpers';

export const CUSTOMER_STATUSES = ['NEEDS_INFO', 'PROCESSING', 'ACCEPTED', 'REJECTED'] as const;
export type CustomerStatus = typeof CUSTOMER_STATUSES[number];
export interface CustomerInfo { id?: string; status: CustomerStatus; fields: JsonObject; }
export const SYNTHETIC_CUSTOMER: Record<string, string> = {
  first_name: 'Demo', last_name: 'Example', email_address: 'demo@example.invalid',
};

export function parseCustomer(value: unknown): CustomerInfo {
  const data = object(value, 'SEP-12 customer');
  if (!CUSTOMER_STATUSES.includes(data.status as CustomerStatus)) throw new Error('SEP-12: unsupported customer status');
  const status = data.status as CustomerStatus;
  const fields = data.fields === undefined ? {} : object(data.fields, 'customer.fields');
  if (status === 'NEEDS_INFO' && data.fields === undefined) throw new Error('SEP-12: NEEDS_INFO without fields');
  return { id: data.id === undefined ? undefined : requiredString(data.id, 'customer.id'), status, fields };
}

export function validateSyntheticFields(requirements: CustomerInfo, submitted: Record<string, string>): void {
  if (requirements.status !== 'NEEDS_INFO') return;
  for (const [field, definition] of Object.entries(requirements.fields)) {
    if (object(definition, `field ${field}`).optional === true) continue;
    if (!submitted[field]?.trim()) throw new Error(`SEP-12: missing required field ${field}`);
  }
}

export async function getCustomer(client: AnchorHttp, params: { id?: string; type?: string }): Promise<CustomerInfo> {
  return parseCustomer(await client.get('/customer', params as Record<string, string>));
}

export async function putCustomer(client: AnchorHttp, requirements: CustomerInfo,
  values: Record<string, string>, customerType: string): Promise<string> {
  validateSyntheticFields(requirements, values);
  requiredString(customerType, 'customer type');
  const body: JsonObject = { type: customerType, ...values };
  if (requirements.id) body.id = requirements.id;
  const response = await client.putJson('/customer', body);
  return requiredString(response.id, 'SEP-12 returned customer ID');
}

export function demoClient(fetcher?: FetchLike, live = false): AnchorHttp {
  if (live) {
    return new AnchorHttp(endpointUrl(requiredString(process.env.SEP12_KYC_SERVER, 'SEP12_KYC_SERVER')),
      fetcher ?? fetch, requiredString(process.env.SEP12_JWT, 'SEP12_JWT (SEP-10/SEP-45 token)'));
  }
  const fixture = mockFetch({
    'GET /customer': { status: 'NEEDS_INFO', fields: { first_name: { type: 'string' }, last_name: { type: 'string' }, email_address: { type: 'string', optional: true } } },
    'PUT /customer': { statusCode: 202, payload: { id: 'synthetic-customer-001' } },
  });
  const responder: FetchLike = fetcher ?? ((async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/customer' && parsed.searchParams.has('id')) {
      return new Response(JSON.stringify({ id: parsed.searchParams.get('id'), status: 'PROCESSING' }), { status: 200 });
    }
    return fixture(url, init);
  }) as FetchLike);
  return new AnchorHttp('https://mock.anchor.test', responder, 'synthetic-mock-token');
}

export async function run(): Promise<void> {
  const live = useLive();
  const client = demoClient(undefined, live);
  const type = process.env.SEP12_CUSTOMER_TYPE ?? 'individual';
  const requirements = await getCustomer(client, { type });
  console.log('SEP-12 status:', requirements.status, 'required field names:', Object.keys(requirements.fields));
  if (live) {
    console.log('Live mode: discovery only. Do not upload the synthetic fixture to a real KYC service.');
    return;
  }
  const id = await putCustomer(client, requirements, SYNTHETIC_CUSTOMER, type);
  console.log('Synthetic record ID:', id, '(submission does not imply verification approval)');
  const status = await getCustomer(client, { id, type });
  console.log('Verification status:', status.status);
}
