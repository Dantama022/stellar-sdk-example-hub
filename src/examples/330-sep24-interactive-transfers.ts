/** ISSUE-330 / SEP-24: hosted deposit/withdrawal lifecycle; mock-only by default. */
import { StrKey } from '@stellar/stellar-sdk';
import { AnchorHttp, FetchLike, JsonObject, assetCapability, endpointUrl, mockFetch, object,
  requiredString, requireTransaction, statusCategory, useLive, validateLimits } from './anchor-workflow-helpers';

export type TransferKind = 'deposit' | 'withdraw';
const ACCOUNT = 'GACW7NONV43MZIFHCOKCQJAKSJSISSICFVUJ2C6EZIW5773OU3HD64VI';

export function parseInteractive(value: unknown): { id: string; url: string } {
  const response = object(value);
  if (response.type !== 'interactive_customer_info_needed') throw new Error('SEP-24: unexpected interactive response type');
  const id = requiredString(response.id, 'interactive.id');
  const rawUrl = requiredString(response.url, 'interactive.url');
  // An anchor may legitimately host the webview on a different HTTPS hostname.
  let safe: URL;
  try { safe = new URL(rawUrl); } catch { throw new Error('SEP-24 interactive URL is invalid'); }
  if (safe.protocol !== 'https:' || safe.username || safe.password) throw new Error('SEP-24 interactive URL must use HTTPS');
  return { id, url: safe.toString() };
}

export async function discover(client: AnchorHttp): Promise<JsonObject> {
  const info = await client.get('/info');
  object(info.deposit, 'info.deposit');
  object(info.withdraw, 'info.withdraw');
  return info;
}

export async function initiate(client: AnchorHttp, info: JsonObject, kind: TransferKind,
  asset: string, account: string, amount: string): Promise<{ id: string; url: string }> {
  if (!StrKey.isValidEd25519PublicKey(account)) throw new Error('SEP-24 requires a valid G-account for this example');
  validateLimits(assetCapability(info, kind, asset), amount);
  const reply = await client.postForm(`/transactions/${kind}/interactive`, {
    asset_code: asset, account, amount,
  });
  return parseInteractive(reply);
}

export async function track(client: AnchorHttp, id: string): Promise<{ id: string; status: string; category: string }> {
  requiredString(id, 'transaction id');
  const tx = requireTransaction(await client.get('/transaction', { id }));
  if (tx.id !== id) throw new Error('SEP-24: transaction ID mismatch');
  return { ...tx, category: statusCategory(tx.status) };
}

export function demoClient(fetcher?: FetchLike, live = false): AnchorHttp {
  if (live) {
    const endpoint = endpointUrl(requiredString(process.env.SEP24_TRANSFER_SERVER, 'SEP24_TRANSFER_SERVER'));
    const token = requiredString(process.env.SEP24_JWT, 'SEP24_JWT (SEP-10/SEP-45 token)');
    return new AnchorHttp(endpoint, fetcher ?? fetch, token);
  }
  const fixture = mockFetch({
    'GET /info': { deposit: { USD: { enabled: true, min_amount: 1 } }, withdraw: { USD: { enabled: true } } },
    'POST /transactions/deposit/interactive': { type: 'interactive_customer_info_needed', id: 'demo-deposit', url: 'https://mock.anchor.test/flow/deposit?token=REDACTED' },
    'POST /transactions/withdraw/interactive': { type: 'interactive_customer_info_needed', id: 'demo-withdraw', url: 'https://mock.anchor.test/flow/withdraw?token=REDACTED' },
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
  const client = demoClient(undefined, live);
  const info = await discover(client);
  const asset = process.env.SEP24_ASSET ?? 'USD';
  const account = live ? requiredString(process.env.SEP24_ACCOUNT, 'SEP24_ACCOUNT') : ACCOUNT;
  console.log('SEP-24:', live ? 'explicit live mode' : 'offline mocked flow');
  console.log('Available deposit assets:', Object.keys(object(info.deposit)).join(', '));
  console.log('Available withdrawal assets:', Object.keys(object(info.withdraw)).join(', '));
  for (const kind of ['deposit', 'withdraw'] as const) {
    // Never automatically initiate two real transfer workflows during a demo.
    if (live && process.env.SEP24_ACTION !== kind) continue;
    const result = await initiate(client, info, kind, asset, account, '10');
    const url = new URL(result.url);
    console.log(kind, 'transaction created:', result.id, 'UI host:', url.origin,
      '(URL query withheld; open only after user review)');
    const status = await track(client, result.id);
    console.log('Status:', status.status, 'category:', status.category, '(not proof of settlement)');
  }
  console.log('No transaction signed or submitted. Do not open returned URLs automatically.');
}
