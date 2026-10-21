/** ISSUE-342: SEP-30 service diagnostics. No protocol-defined /health endpoint exists. */
export type DiagnosticCategory = 'ok' | 'invalid_config' | 'timeout' | 'network' | 'http_error' | 'invalid_json' | 'invalid_response' | 'unsupported';
export interface Diagnostics {
  reachable: boolean | null;
  providerHealth: boolean | null;
  sep30Compatible: null; // No authenticated SEP-30 operation is exercised.
  recoveryCompleted: false;
  category: DiagnosticCategory;
  durationMs: number;
  detail: string;
}
export interface RecoveryConfig {
  baseUrl: string;
  timeoutMs: number;
  providerProbePath?: string;
  allowLocalHttp?: boolean;
}

export function validateRecoveryConfig(config: RecoveryConfig): URL {
  if (!config.baseUrl || typeof config.baseUrl !== 'string') throw new Error('Set SEP30_BASE_URL');
  let url: URL;
  try { url = new URL(config.baseUrl); } catch { throw new Error('SEP30_BASE_URL must be a valid absolute URL'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(config.allowLocalHttp && local && url.protocol === 'http:')) {
    throw new Error('SEP30_BASE_URL must use HTTPS (explicit local HTTP allowed for testing)');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('Base URL must not contain credentials, query or fragment');
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 60000) {
    throw new Error('SEP30 timeout must be 1..60000 ms');
  }
  if (config.providerProbePath !== undefined && (!/^\/[a-zA-Z0-9/_-]*$/.test(config.providerProbePath) ||
    config.providerProbePath.startsWith('//'))) throw new Error('Provider probe must be a relative path such as /health');
  return url;
}

export async function diagnoseSep30(
  config: RecoveryConfig, fetcher: typeof fetch = fetch, now: () => number = Date.now,
): Promise<Diagnostics> {
  let url: URL;
  try { url = validateRecoveryConfig(config); }
  catch { return { reachable: null, providerHealth: null, sep30Compatible: null, recoveryCompleted: false,
    category: 'invalid_config', durationMs: 0, detail: 'Invalid SEP30_BASE_URL, timeout, or provider probe configuration' }; }
  if (!config.providerProbePath) {
    // SEP-30 specifies authenticated account operations, not a public readiness endpoint.
    return { reachable: null, providerHealth: null, sep30Compatible: null, recoveryCompleted: false,
      category: 'unsupported', durationMs: 0, detail: 'No standard SEP-30 health endpoint; configure an explicit provider-specific probe' };
  }
  const probe = new URL(config.providerProbePath, `${url.toString().replace(/\/$/, '')}/`);
  if (probe.origin !== url.origin) throw new Error('Cross-origin probe rejected');
  const started = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetcher(probe.toString(), { method: 'GET', signal: controller.signal,
      headers: { Accept: 'application/json' }, redirect: 'error' });
    const durationMs = Math.max(0, now() - started);
    if (!response.ok) return { reachable: true, providerHealth: false, sep30Compatible: null,
      recoveryCompleted: false, category: 'http_error', durationMs,
      detail: `Provider-specific probe returned HTTP ${response.status}` };
    let body: unknown;
    try { body = await response.json(); } catch {
      return { reachable: true, providerHealth: false, sep30Compatible: null, recoveryCompleted: false,
        category: 'invalid_json', durationMs, detail: 'Provider health response was not valid JSON' };
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof (body as { ok?: unknown }).ok !== 'boolean') {
      return { reachable: true, providerHealth: null, sep30Compatible: null, recoveryCompleted: false,
        category: 'invalid_response', durationMs, detail: 'Provider probe expected JSON {"ok": boolean}; verify provider documentation' };
    }
    const ready = (body as {ok: boolean}).ok;
    return { reachable: true, providerHealth: ready, sep30Compatible: null, recoveryCompleted: false,
      category: ready ? 'ok' : 'invalid_response', durationMs,
      detail: ready ? 'Provider-specific readiness probe passed; SEP-30 compatibility unverified' : 'Provider reachable but not ready' };
  } catch (err) {
    const timeout = controller.signal.aborted || (err instanceof Error && err.name === 'AbortError');
    return { reachable: false, providerHealth: null, sep30Compatible: null, recoveryCompleted: false,
      category: timeout ? 'timeout' : 'network', durationMs: Math.max(0, now() - started),
      detail: timeout ? 'Provider probe timed out' : 'Provider probe connection failed' };
  } finally { clearTimeout(timer); }
}

export async function run(): Promise<void> {
  // Default is entirely mocked; no token, account or recovery operation is sent.
  const mock = process.env.SEP30_LIVE_PROBE !== 'true';
  const config: RecoveryConfig = mock ? { baseUrl: 'https://recovery.example.test', timeoutMs: 2000,
    providerProbePath: '/health' } : {
      baseUrl: process.env.SEP30_BASE_URL || '', timeoutMs: 2000,
      providerProbePath: process.env.SEP30_PROVIDER_PROBE_PATH,
  };
  const mockFetch = (async () => ({ ok: true, status: 200, json: async () => ({ok: true}) })) as unknown as typeof fetch;
  console.log(JSON.stringify(await diagnoseSep30(config, mock ? mockFetch : fetch), null, 2));
}
