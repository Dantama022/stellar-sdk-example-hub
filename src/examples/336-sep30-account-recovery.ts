/** ISSUE-336: SEP-30 registration and account lookup, using an injected mock by default. */
import { Account, Asset, Keypair, Networks, Operation, StrKey, TransactionBuilder, xdr } from '@stellar/stellar-sdk';

export type AuthMethod = { type: 'email' | 'phone_number' | 'stellar_address'; value: string };
export type Identity = { role: string; auth_methods: AuthMethod[] };
export type Registration = { identities: Identity[] };
export type RecoveryAccount = { address: string; identities: Array<{role?: string; authenticated?: boolean}>; signers: Array<{key: string}> };
export type Sep30Settings = { baseUrl: string; jwt: string; timeoutMs: number };
export type RecoverySignature = { signature: string; network_passphrase: string };

export function validateSettings(config: Sep30Settings): void {
  let parsed: URL;
  try { parsed = new URL(config.baseUrl); } catch { throw new Error('SEP30_SERVICE_URL must be an absolute HTTPS URL'); }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) {
    throw new Error('SEP30_SERVICE_URL must use HTTPS except for local mocks');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('SEP30_SERVICE_URL must not contain credentials, query or fragment');
  if (!config.jwt.trim()) throw new Error('SEP30_JWT is required (SEP-10 for POST registration; service-issued JWT for lookup)');
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 60000) throw new Error('SEP30_TIMEOUT_MS must be 100..60000');
}
export function validateRegistration(body: Registration): void {
  if (!body || !Array.isArray(body.identities) || body.identities.length === 0) throw new Error('identities must be a nonempty array');
  const roles = new Set<string>();
  for (const item of body.identities) {
    if (!item.role || typeof item.role !== 'string' || roles.has(item.role)) throw new Error('identity roles must be unique nonempty strings');
    roles.add(item.role);
    if (!Array.isArray(item.auth_methods) || item.auth_methods.length === 0) throw new Error('each identity needs auth_methods');
    for (const method of item.auth_methods) {
      if (!['email','phone_number','stellar_address'].includes(method.type) || typeof method.value !== 'string') throw new Error('unsupported auth method');
      if (method.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(method.value)) throw new Error('invalid email auth method');
      if (method.type === 'phone_number' && !/^\+[1-9]\d{6,14}$/.test(method.value)) throw new Error('invalid E.164 phone auth method');
      if (method.type === 'stellar_address' && !StrKey.isValidEd25519PublicKey(method.value)) throw new Error('invalid stellar_address auth method');
    }
  }
}

export function validateAccount(value: unknown, expectedAddress: string): RecoveryAccount {
  if (!value || typeof value !== 'object') throw new Error('SEP-30 response is not an object');
  const obj = value as Record<string, unknown>;
  if (obj.address !== expectedAddress) throw new Error('SEP-30 response address does not match request');
  if (!Array.isArray(obj.identities) || !obj.identities.every(identity => identity && typeof identity === 'object' &&
    (!('role' in identity) || typeof identity.role === 'string') &&
    (!('authenticated' in identity) || typeof identity.authenticated === 'boolean'))) {
    throw new Error('SEP-30 response has malformed identities');
  }
  if (!Array.isArray(obj.signers) || !obj.signers.length ||
      !obj.signers.every(s => s && typeof s === 'object' && 'key' in s && typeof s.key === 'string' && StrKey.isValidEd25519PublicKey(s.key))) {
    throw new Error('SEP-30 response has invalid signers');
  }
  return obj as unknown as RecoveryAccount;
}

/** No automatic retries of POST; never print JWTs, identities or service response bodies. */
export class Sep30Client {
  constructor(private readonly settings: Sep30Settings, private readonly fetchFn: typeof fetch = fetch) {
    validateSettings(settings);
  }
  async register(address: string, body: Registration): Promise<RecoveryAccount> {
    validateRegistration(body);
    return this.requestAccount('POST', address, body);
  }
  async getAccount(address: string): Promise<RecoveryAccount> { return this.requestAccount('GET', address); }

  /** Request a recovery provider's signature, NOT an on-chain recovery. Requires external-identity JWT. */
  async requestRecoverySignature(address: string, signingAddress: string, transaction: string): Promise<RecoverySignature> {
    if (!StrKey.isValidEd25519PublicKey(address) || !StrKey.isValidEd25519PublicKey(signingAddress)) {
      throw new Error('account and signing address must be valid G... public keys');
    }
    try { xdr.TransactionEnvelope.fromXDR(transaction, 'base64'); }
    catch { throw new Error('transaction must be base64 TransactionEnvelope XDR'); }
    const payload = await this.fetchJson('POST', `accounts/${address}/sign/${signingAddress}`, { transaction });
    if (!payload || typeof payload !== 'object') throw new Error('SEP-30 signing response is malformed');
    const result = payload as Record<string, unknown>;
    if (typeof result.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(result.signature) ||
      Buffer.from(result.signature, 'base64').length !== 64 ||
      typeof result.network_passphrase !== 'string' || !result.network_passphrase.trim()) {
      throw new Error('SEP-30 signing response missing valid signature or network_passphrase');
    }
    return { signature: result.signature, network_passphrase: result.network_passphrase };
  }

  private async requestAccount(method: 'POST' | 'GET', address: string, body?: Registration): Promise<RecoveryAccount> {
    if (!StrKey.isValidEd25519PublicKey(address)) throw new Error('account address must be a valid G... public key');
    const payload = await this.fetchJson(method, `accounts/${address}`, body);
    return validateAccount(payload, address);
  }

  private async fetchJson(method: 'POST' | 'GET', resourcePath: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    try {
      const response = await this.fetchFn(`${this.settings.baseUrl.replace(/\/$/, '')}/${resourcePath}`, {
        method,
        headers: { Authorization: `Bearer ${this.settings.jwt}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`SEP-30 service returned HTTP ${response.status}`);
      try { return await response.json(); }
      catch { throw new Error('SEP-30 service returned invalid JSON'); }
    } catch (err) {
      if (controller.signal.aborted) throw new Error('SEP-30 request timed out');
      if (err instanceof Error && err.message.startsWith('SEP-30')) throw err;
      throw new Error('SEP-30 request failed; verify service reachability and authorization');
    } finally { clearTimeout(timer); }
  }
}

/** Validates explicit live-service configuration; the bundled run() never sends live requests. */
export function liveSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): Sep30Settings {
  const settings = {
    baseUrl: env.SEP30_SERVICE_URL || '', jwt: env.SEP30_JWT || '',
    timeoutMs: Number(env.SEP30_TIMEOUT_MS || 5000),
  };
  validateSettings(settings);
  return settings;
}

/** Offline mock only. This is not a recovery provider or a real authorization token. */
export function makeMockFetch(address: string, signer: string): typeof fetch {
  return (async (_url: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    if (options?.method !== 'GET' && options?.method !== 'POST') return new Response('{}', { status: 405 });
    if (String(_url).includes('/sign/')) {
      return new Response(JSON.stringify({signature: Buffer.alloc(64, 1).toString('base64'), network_passphrase: Networks.TESTNET}), {status:200});
    }
    return new Response(JSON.stringify({ address, identities: [{ role: 'owner', authenticated: true }], signers: [{ key: signer }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

export async function run(): Promise<void> {
  // No live network by default, even when environment variables are present.
  const account = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey();
  const signer = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey();
  const settings: Sep30Settings = { baseUrl: 'https://mock.invalid', jwt: 'mock-only-never-sent', timeoutMs: 5000 };
  const client = new Sep30Client(settings, makeMockFetch(account, signer));
  const body: Registration = { identities: [{ role: 'owner', auth_methods: [{ type: 'email', value: 'example@example.invalid' }] }] };
  const result = await client.register(account, body);
  console.log(`SEP-30 account registration acknowledged: ${result.address}; recovery signers: ${result.signers.length}`);
  const unsigned = new TransactionBuilder(new Account(account, '0'), {fee: '100', networkPassphrase: Networks.TESTNET})
    .addOperation(Operation.payment({destination: account, asset: Asset.native(), amount:'1'})).setTimeout(0).build().toXDR();
  const recoveryRequest = await client.requestRecoverySignature(account, signer, unsigned);
  console.log(`Mock recovery-signature response received for network: ${recoveryRequest.network_passphrase}`);
  console.log('Neither registration nor a returned signature completes recovery. Signer setup, authorization and an on-chain transaction are separate.');
}
if (require.main === module) run().catch(err => { console.error(err instanceof Error ? err.message : 'SEP-30 example failed'); process.exitCode = 1; });
