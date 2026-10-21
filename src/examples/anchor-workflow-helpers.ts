/** Shared, mock-first HTTP and validation utilities for SEP-6/12/24/31 demos. */
export type JsonObject = Record<string, unknown>;
export type FetchLike = typeof fetch;

export function object(value: unknown, label = 'response'): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}: expected JSON object`);
  }
  return value as JsonObject;
}

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field}: missing or invalid`);
  return value;
}

export function positiveAmount(value: string): number {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,7})?$/.test(value)) {
    throw new Error('amount must be a positive decimal with at most 7 fractional digits');
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error('amount must be positive and finite');
  return n;
}

export function endpointUrl(input: string): string {
  let parsed: URL;
  try { parsed = new URL(input); } catch { throw new Error('Anchor endpoint must be a valid HTTPS URL'); }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Anchor endpoint must be an HTTPS URL without credentials, query or fragment');
  }
  return parsed.toString().replace(/\/$/, '');
}

export function assetCapability(info: unknown, direction: string, asset: string): JsonObject {
  const catalog = object(object(info, 'info')[direction], `info.${direction}`);
  const entry = object(catalog[asset], `${direction}.${asset}: unsupported asset`);
  if (entry.enabled === false) throw new Error(`${direction}.${asset}: operation disabled`);
  return entry;
}

export function validateLimits(capability: JsonObject, amount: string): void {
  const n = positiveAmount(amount);
  for (const [key, bad] of [['min_amount', (x: number) => n < x], ['max_amount', (x: number) => n > x]] as const) {
    const limit = capability[key];
    if (limit !== undefined && (typeof limit !== 'number' || !Number.isFinite(limit) || bad(limit))) {
      throw new Error(`amount violates ${key} or anchor advertised an invalid limit`);
    }
  }
}

export function requireTransaction(payload: unknown, wrapped = false): { id: string; status: string } {
  const raw = object(payload);
  const tx = wrapped ? object(raw.transaction, 'transaction') : raw;
  const id = requiredString(tx.id, 'transaction.id');
  const status = requiredString(tx.status, 'transaction.status');
  return { id, status };
}

export function statusCategory(status: string): 'complete' | 'failed' | 'pending' | 'unknown' {
  if (status === 'completed') return 'complete';
  if (['error', 'expired', 'refunded', 'no_market', 'too_small', 'too_large'].includes(status)) return 'failed';
  if (['pending_sender', 'pending_receiver', 'pending_external', 'pending_stellar', 'pending_anchor',
    'pending_user_transfer_start', 'pending_user_transfer_complete', 'pending_customer_info_update',
    'pending_transaction_info_update', 'pending_trust', 'incomplete', 'pending'].includes(status)) return 'pending';
  return 'unknown';
}

export class AnchorHttp {
  readonly base: string;
  get authenticated(): boolean { return Boolean(this.token); }
  constructor(base: string, private readonly fetcher: FetchLike, private readonly token?: string, private readonly timeoutMs = 5000) {
    this.base = endpointUrl(base);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('Timeout must be 1–60000 milliseconds');
  }

  async get(path: string, query?: Record<string, string>): Promise<JsonObject> {
    return this.request('GET', path, query);
  }

  async postForm(path: string, form: Record<string, string>): Promise<JsonObject> {
    return this.request('POST', path, undefined, new URLSearchParams(form).toString(), 'application/x-www-form-urlencoded');
  }

  async postJson(path: string, body: JsonObject): Promise<JsonObject> {
    return this.request('POST', path, undefined, JSON.stringify(body), 'application/json');
  }

  async putJson(path: string, body: JsonObject): Promise<JsonObject> {
    return this.request('PUT', path, undefined, JSON.stringify(body), 'application/json');
  }

  private async request(method: string, path: string, query?: Record<string, string>, body?: string, contentType?: string): Promise<JsonObject> {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Only relative API paths are supported');
    const url = new URL(`${this.base}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      if (contentType) headers['Content-Type'] = contentType;
      const response = await this.fetcher(url.toString(), { method, headers, body, signal: controller.signal, redirect: 'error' });
      if (!response.ok) throw new Error(`Anchor API rejected ${method} ${path} (HTTP ${response.status})`);
      let payload: unknown;
      try { payload = await response.json(); } catch { throw new Error(`Anchor API ${path}: malformed JSON`); }
      return object(payload, `Anchor API ${path}`);
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`Anchor API ${path}: request timed out`);
      if (error instanceof Error && error.message.startsWith('Anchor API')) throw error;
      throw new Error(`Anchor API ${path}: network request failed`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** No real network activity unless both explicit flags are set. */
export function useLive(env: NodeJS.ProcessEnv = process.env): boolean {
  const enabled = env.ANCHOR_MODE === 'live';
  if (enabled && env.ANCHOR_ALLOW_REQUESTS !== 'true') {
    throw new Error('Live anchor access requires ANCHOR_ALLOW_REQUESTS=true');
  }
  return enabled;
}

export function mockFetch(routes: Record<string, JsonObject | { statusCode: number; payload: JsonObject }>): FetchLike {
  return (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const address = new URL(String(url));
    const method = init?.method ?? 'GET';
    const route = `${method} ${address.pathname}`;
    const reply = routes[route];
    if (!reply) return new Response(JSON.stringify({ error: 'Fixture not found' }), { status: 404 });
    if ('statusCode' in reply && 'payload' in reply) {
      const r = reply as { statusCode: number; payload: JsonObject };
      return new Response(JSON.stringify(r.payload), { status: r.statusCode, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as FetchLike;
}
