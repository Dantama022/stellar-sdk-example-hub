/** ISSUE-333 / SEP-6: programmatic deposit and withdrawal, no on-chain payments. */
import { StrKey } from '@stellar/stellar-sdk';
import { AnchorHttp, FetchLike, JsonObject, assetCapability, endpointUrl, mockFetch, object,
  requiredString, requireTransaction, statusCategory, useLive, validateLimits } from './anchor-workflow-helpers';

export type TransferKind = 'deposit' | 'withdraw';
const ACCOUNT = 'GACW7NONV43MZIFHCOKCQJAKSJSISSICFVUJ2C6EZIW5773OU3HD64VI';

export class ProgrammaticTransferDemo {
  private readonly attempts = new Set<string>();
  constructor(private readonly client: AnchorHttp) {}

  async info(): Promise<JsonObject> {
    const info = await this.client.get('/info');
    object(info.deposit, 'SEP-6 info.deposit');
    object(info.withdraw, 'SEP-6 info.withdraw');
    if (info.authentication_required === true && !this.client.authenticated) {
      throw new Error('SEP-6: anchor requires SEP-10/SEP-45 authentication (SEP6_JWT)');
    }
    return info;
  }

  async begin(info: JsonObject, kind: TransferKind, asset: string, account: string,
    amount: string, fundingMethod: string, localRequestId: string): Promise<{ id?: string; instructionsAvailable: boolean }> {
    if (!StrKey.isValidEd25519PublicKey(account)) throw new Error('SEP-6: invalid Stellar G-account');
    requiredString(fundingMethod, 'funding_method');
    const cap = assetCapability(info, kind, asset);
    validateLimits(cap, amount);
    const methods = cap.funding_methods;
    if (!Array.isArray(methods) || !methods.includes(fundingMethod)) throw new Error('SEP-6: unsupported funding_method');
    const fields = cap.fields;
    if (fields !== undefined) {
      const missing = Object.entries(object(fields, 'SEP-6 fields')).filter(([, value]) => object(value).optional !== true);
      if (missing.length) throw new Error(`SEP-6: anchor requires extra information via SEP-12 or fields: ${missing.map(([name]) => name).join(', ')}`);
    }
    requiredString(localRequestId, 'local request ID');
    if (this.attempts.has(localRequestId)) throw new Error('Duplicate SEP-6 request blocked; inspect existing transaction');
    this.attempts.add(localRequestId); // reserve before async GET because GET may initiate a transfer
    const reply = await this.client.get(`/${kind}`, { asset_code: asset, account, amount, funding_method: fundingMethod });
    // SEP-6 allows an ID to be absent; track via /transactions or memo when this happens.
    const id = reply.id === undefined ? undefined : requiredString(reply.id, 'SEP-6 transaction.id');
    const type = reply.type;
    if (type !== undefined && type !== 'non_interactive_customer_info_needed' && type !== 'customer_info_status') {
      throw new Error('SEP-6: unsupported response type');
    }
    if (type !== undefined) throw new Error('SEP-6: additional customer information required; use SEP-12');
    return { id, instructionsAvailable: Boolean(reply.how || reply.instructions || reply.account_id) };
  }

  async status(id: string): Promise<{ id: string; status: string; category: string }> {
    requiredString(id, 'transaction ID');
    const tx = requireTransaction(await this.client.get('/transaction', { id }));
    if (tx.id !== id) throw new Error('SEP-6: transaction ID mismatch');
    return { ...tx, category: statusCategory(tx.status) };
  }
}

export function demoClient(fetcher?: FetchLike, live = false): AnchorHttp {
  if (live) {
    return new AnchorHttp(endpointUrl(requiredString(process.env.SEP6_TRANSFER_SERVER, 'SEP6_TRANSFER_SERVER')),
      fetcher ?? fetch, process.env.SEP6_JWT);
  }
  const fixture = mockFetch({
    'GET /info': { deposit: { USD: { enabled: true, funding_methods: ['SWIFT'] } }, withdraw: { USD: { enabled: true, funding_methods: ['SWIFT'] } } },
    'GET /deposit': { id: 'mock-sep6-deposit', how: 'Follow synthetic funding instructions' },
    'GET /withdraw': { id: 'mock-sep6-withdraw', account_id: ACCOUNT },
  });
  const responder: FetchLike = fetcher ?? ((async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/transaction') {
      return new Response(JSON.stringify({ id: parsed.searchParams.get('id'), status: 'pending_user_transfer_start' }), { status: 200 });
    }
    return fixture(url, init);
  }) as FetchLike);
  return new AnchorHttp('https://mock.anchor.test', responder, 'synthetic-mock-token');
}

export async function run(): Promise<void> {
  const live = useLive();
  const demo = new ProgrammaticTransferDemo(demoClient(undefined, live));
  const info = await demo.info();
  console.log('SEP-6 deposit assets:', Object.keys(object(info.deposit)).join(', '));
  console.log('SEP-6 withdrawal assets:', Object.keys(object(info.withdraw)).join(', '));
  if (live && !['deposit', 'withdraw'].includes(process.env.SEP6_ACTION ?? '')) {
    console.log('Live mode discovery only. Set SEP6_ACTION=deposit or withdraw to initiate deliberately.');
    return;
  }
  const account = live ? requiredString(process.env.SEP6_ACCOUNT, 'SEP6_ACCOUNT') : ACCOUNT;
  for (const kind of ['deposit', 'withdraw'] as const) {
    if (live && process.env.SEP6_ACTION !== kind) continue;
    const result = await demo.begin(info, kind, process.env.SEP6_ASSET ?? 'USD', account, '10',
      process.env.SEP6_FUNDING_METHOD ?? 'SWIFT', `demo-${kind}`);
    console.log(kind, 'request accepted. Tracking ID:', result.id ?? '(not provided by anchor)');
    if (!result.id) { console.log('Use authenticated /transactions history for discovery; do not invent an ID.'); continue; }
    const tx = await demo.status(result.id);
    console.log('Status:', tx.status, 'category:', tx.category);
  }
  console.log('No Stellar transaction created or submitted; no settlement guaranteed.');
}
