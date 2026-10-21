/** ISSUE-332 / SEP-31: receiving-anchor discovery, request, status (mock-first). */
import { AnchorHttp, FetchLike, JsonObject, assetCapability, endpointUrl, mockFetch, object,
  positiveAmount, requiredString, requireTransaction, statusCategory, useLive, validateLimits } from './anchor-workflow-helpers';

export interface PaymentRequest {
  asset_code: string;
  amount: number;
  funding_method: string;
  sender_id?: string;
  receiver_id?: string;
  asset_issuer?: string;
}

export class CrossBorderDemo {
  private readonly submissions = new Set<string>();
  constructor(private readonly client: AnchorHttp) {}

  async info(): Promise<JsonObject> {
    const response = await this.client.get('/info');
    object(response.receive, 'SEP-31 info.receive');
    return response;
  }

  validate(info: JsonObject, payload: PaymentRequest): void {
    const capability = assetCapability(info, 'receive', payload.asset_code);
    validateLimits(capability, String(payload.amount));
    positiveAmount(String(payload.amount));
    const methods = capability.funding_methods;
    if (!Array.isArray(methods) || !methods.includes(payload.funding_method)) {
      throw new Error('SEP-31: unsupported or missing funding_method');
    }
    if (capability.quotes_required === true) throw new Error('SEP-31: quotes_required; obtain a SEP-38 quote first');
    const sep12 = capability.sep12;
    if (sep12 !== undefined) {
      const roles = object(sep12, 'SEP-31 sep12');
      for (const role of ['sender', 'receiver'] as const) {
        const config = roles[role];
        if (config && Object.keys(object(object(config, role).types ?? {}, `${role}.types`)).length && !payload[`${role}_id`]) {
          throw new Error(`SEP-31: ${role}_id required after SEP-12 verification`);
        }
      }
    }
  }

  async create(info: JsonObject, payload: PaymentRequest, localRequestId: string): Promise<string> {
    this.validate(info, payload);
    requiredString(localRequestId, 'local request ID');
    if (this.submissions.has(localRequestId)) throw new Error('Duplicate SEP-31 creation blocked: check existing transaction status');
    // Reserve before async HTTP; do not automatically retry ambiguous POST outcomes.
    this.submissions.add(localRequestId);
    const response = await this.client.postJson('/transactions', payload as unknown as JsonObject);
    return requiredString(response.id, 'SEP-31 created transaction ID');
  }

  async getStatus(id: string): Promise<{ id: string; status: string; category: string }> {
    requiredString(id, 'transaction ID');
    const response = await this.client.get(`/transactions/${encodeURIComponent(id)}`);
    const tx = requireTransaction(response, true);
    if (tx.id !== id) throw new Error('SEP-31: transaction ID mismatch');
    return { ...tx, category: statusCategory(tx.status) };
  }
}

export function demoClient(fetcher?: FetchLike, live = false): AnchorHttp {
  if (live) {
    return new AnchorHttp(endpointUrl(requiredString(process.env.SEP31_DIRECT_PAYMENT_SERVER, 'SEP31_DIRECT_PAYMENT_SERVER')),
      fetcher ?? fetch, requiredString(process.env.SEP31_JWT, 'SEP31_JWT (anchor-issued auth token)'));
  }
  return new AnchorHttp('https://mock.anchor.test', fetcher ?? mockFetch({
    'GET /info': { receive: { USDC: { funding_methods: ['SWIFT'], min_amount: 1, max_amount: 1000 } } },
    'POST /transactions': { statusCode: 201, payload: { id: 'mock-payment-001' } },
    'GET /transactions/mock-payment-001': { transaction: { id: 'mock-payment-001', status: 'pending_sender' } },
  }), 'synthetic-mock-token');
}

export async function run(): Promise<void> {
  const live = useLive();
  const demo = new CrossBorderDemo(demoClient(undefined, live));
  const info = await demo.info();
  console.log('SEP-31 receiving assets:', Object.keys(object(info.receive)).join(', '));
  const request: PaymentRequest = { asset_code: process.env.SEP31_ASSET ?? 'USDC',
    amount: 10, funding_method: process.env.SEP31_FUNDING_METHOD ?? 'SWIFT' };
  if (live && process.env.SEP31_ACTION !== 'create') {
    console.log('Live mode discovery only. To create a transaction, complete SEP-12 as needed and explicitly set SEP31_ACTION=create.');
    return;
  }
  const id = await demo.create(info, request, 'synthetic-one-time-request');
  const status = await demo.getStatus(id);
  console.log('Transaction ID:', id, 'status:', status.status, 'category:', status.category);
  console.log('This does not send an on-chain payment or prove off-chain settlement.');
}
