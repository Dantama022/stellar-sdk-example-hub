/** SEP-38 indicative prices and firm quotes: requests alone never execute exchange or payment. */
export interface Sep38Config { baseUrl: string; token?: string; timeoutMs?: number; }
export interface PriceRequest { sell_asset: string; buy_asset: string; sell_amount?: string; buy_amount?: string; context: 'sep6' | 'sep24' | 'sep31'; }
export interface ValidatedPrice { sell_asset: string; buy_asset: string; price: string; sell_amount: string; buy_amount: string; }
export interface ValidatedQuote extends ValidatedPrice { id: string; expires_at: string; }
export type Fetcher = typeof fetch;

const decimal = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const positive = (value: unknown): value is string => typeof value === 'string' && decimal.test(value) && /[1-9]/.test(value);

export function checkAsset(value: string): void {
  if (!value || !/^(?:iso4217:[A-Z]{3}|stellar:native|stellar:[A-Za-z0-9]{1,12}:G[A-Z2-7]{55})$/.test(value)) {
    throw new Error('Unsupported SEP-38 asset identifier');
  }
}
export function validatePriceRequest(request: PriceRequest): PriceRequest {
  checkAsset(request.sell_asset); checkAsset(request.buy_asset);
  if (request.sell_asset === request.buy_asset) throw new Error('Asset pair must be different');
  if (!['sep6', 'sep24', 'sep31'].includes(request.context)) throw new Error('Invalid SEP-38 context');
  if ((request.sell_amount === undefined) === (request.buy_amount === undefined)) throw new Error('Specify exactly one of sell_amount or buy_amount');
  if (request.sell_amount !== undefined && !positive(request.sell_amount)) throw new Error('Invalid sell_amount decimal');
  if (request.buy_amount !== undefined && !positive(request.buy_amount)) throw new Error('Invalid buy_amount decimal');
  return request;
}

export function validateSep38Url(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid SEP-38 service URL'); }
  if (url.username || url.password) throw new Error('Do not embed credentials in SEP-38 URLs');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('SEP-38 requires HTTPS outside localhost');
  }
  if (url.search || url.hash) throw new Error('SEP-38 base URL must not contain query parameters or fragment');
  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

export function parsePrice(value: unknown, expected: Pick<PriceRequest, 'sell_asset' | 'buy_asset'>): ValidatedPrice {
  if (!value || typeof value !== 'object') throw new Error('Malformed SEP-38 price response');
  const result = value as Record<string, unknown>;
  if (!positive(result.price) || !positive(result.sell_amount) || !positive(result.buy_amount)) throw new Error('Missing or invalid SEP-38 price/amount');
  if (result.sell_asset !== expected.sell_asset || result.buy_asset !== expected.buy_asset) {
    // Some price endpoints omit asset fields; expected assets come from the caller's request.
    if (result.sell_asset !== undefined || result.buy_asset !== undefined) throw new Error('SEP-38 response asset pair mismatch');
  }
  return { sell_asset: expected.sell_asset, buy_asset: expected.buy_asset,
    price: result.price, sell_amount: result.sell_amount, buy_amount: result.buy_amount };
}
export function parseQuote(value: unknown, expected: Pick<PriceRequest, 'sell_asset' | 'buy_asset'>, now = Date.now()): ValidatedQuote {
  const price = parsePrice(value, expected);
  const result = value as Record<string, unknown>;
  if (typeof result.id !== 'string' || result.id.length === 0 || result.id.length > 200) throw new Error('Missing quote identifier');
  if (typeof result.expires_at !== 'string' || !/Z$|[+-]\d\d:\d\d$/.test(result.expires_at)) throw new Error('Invalid quote expiry timestamp');
  const until = Date.parse(result.expires_at);
  if (!Number.isFinite(until)) throw new Error('Invalid quote expiry timestamp');
  if (until <= now) throw new Error('Quote has expired');
  return { ...price, id: result.id, expires_at: result.expires_at };
}

export class Sep38Client {
  private readonly base: string;
  constructor(private readonly config: Sep38Config, private readonly transport: Fetcher = fetch) {
    this.base = validateSep38Url(config.baseUrl);
    if (config.timeoutMs !== undefined && (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 100)) throw new Error('Invalid request timeout');
  }
  private async request(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.transport(new URL(path, this.base).toString(), {
        method,
        headers: { ...(this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 5000),
      });
    } catch { throw new Error('SEP-38 connection failed or timed out'); }
    if (!response.ok) throw new Error(`SEP-38 request failed: HTTP ${response.status}`);
    try { return await response.json(); } catch { throw new Error('SEP-38 returned invalid JSON'); }
  }
  async info(): Promise<unknown> {
    const data = await this.request('info');
    if (!data || typeof data !== 'object' || !Array.isArray((data as {assets?: unknown}).assets)) throw new Error('Malformed SEP-38 asset info');
    return data;
  }
  async indicative(request: PriceRequest): Promise<ValidatedPrice> {
    validatePriceRequest(request);
    const query = new URLSearchParams(request as unknown as Record<string, string>);
    return parsePrice(await this.request(`price?${query.toString()}`), request);
  }
  async firm(request: PriceRequest, now = Date.now()): Promise<ValidatedQuote> {
    validatePriceRequest(request);
    return parseQuote(await this.request('quote', 'POST', request), request, now);
  }
  async quote(id: string, expected: PriceRequest, now = Date.now()): Promise<ValidatedQuote> {
    if (!id || id.includes('/') || id.length > 200) throw new Error('Invalid quote identifier');
    validatePriceRequest(expected);
    return parseQuote(await this.request(`quote/${encodeURIComponent(id)}`), expected, now);
  }
}

/** Mock-first: provide SEP38_LIVE=true and SEP38_URL to enable real requests. */
export async function run(): Promise<void> {
  const request: PriceRequest = { sell_asset: 'iso4217:USD', buy_asset: 'stellar:native', sell_amount: '10.00', context: 'sep24' };
  const now = Date.now();
  const fake = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const result = init?.method === 'POST' ? { id: 'synthetic-quote-1', expires_at: new Date(now + 60000).toISOString(),
      sell_asset: request.sell_asset, buy_asset: request.buy_asset, price: '0.5', sell_amount: '10.00', buy_amount: '20.00' }
      : String(_input).includes('/info') ? { assets: [{ asset: 'iso4217:USD' }, { asset: 'stellar:native' }] }
        : { sell_asset: request.sell_asset, buy_asset: request.buy_asset, price: '0.5', sell_amount: '10.00', buy_amount: '20.00' };
    return { ok: true, json: async () => result } as Response;
  };
  const live = process.env.SEP38_LIVE === 'true';
  if (live && !process.env.SEP38_URL) throw new Error('SEP38_URL required for live requests');
  const client = new Sep38Client({ baseUrl: live ? process.env.SEP38_URL! : 'http://localhost:8080', token: live ? process.env.SEP38_TOKEN : undefined }, live ? fetch : fake);
  const assets = await client.info();
  const indicative = await client.indicative(request);
  const quote = await client.firm(request, now);
  console.log(`Asset info loaded: ${Array.isArray((assets as { assets: unknown[] }).assets)}`);
  console.log(`Indicative price: ${indicative.price}; firm quote ID: ${quote.id}; expiry: ${quote.expires_at}`);
  console.log('No exchange, transaction signing, or payment was executed.');
}
