import { Account, Keypair, Networks, Operation, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';

/** A network is defined by its passphrase, not the hostname used to reach it. */
export interface NetworkConfig {
  label: 'testnet' | 'public' | 'custom';
  passphrase: string;
  horizonUrl: string;
}

export function validateNetwork(config: NetworkConfig): NetworkConfig {
  if (!config || !config.passphrase?.trim()) throw new Error('Missing network passphrase');
  if (!config.horizonUrl) throw new Error('Missing Horizon endpoint');
  let endpoint: URL;
  try { endpoint = new URL(config.horizonUrl); } catch { throw new Error('Invalid Horizon endpoint URL'); }
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(endpoint.hostname))) {
    throw new Error('Horizon endpoint must use HTTPS (HTTP permitted only for localhost)');
  }
  if (endpoint.username || endpoint.password) throw new Error('Do not embed credentials in Horizon URLs');
  if (config.label === 'testnet' && config.passphrase !== Networks.TESTNET) throw new Error('Testnet passphrase mismatch');
  if (config.label === 'public' && config.passphrase !== Networks.PUBLIC_NETWORK) throw new Error('Public network passphrase mismatch');
  if (config.label === 'custom' && [Networks.TESTNET, Networks.PUBLIC_NETWORK].includes(config.passphrase)) {
    throw new Error('Use the correct public/testnet label for a known public-network passphrase');
  }
  return config;
}

export function safeEndpoint(url: string): string {
  try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch { return '[invalid endpoint]'; }
}

export function assertSameNetwork(expected: string, actual: string): void {
  if (!expected || !actual || expected !== actual) throw new Error('Network passphrase mismatch: signing/submission blocked');
}

/** Fetch Horizon root's explicit network_passphrase; HTTP success by itself proves nothing. */
export async function probeHorizon(config: NetworkConfig, fetcher: typeof fetch = fetch): Promise<void> {
  validateNetwork(config);
  let response: Response;
  try {
    response = await fetcher(config.horizonUrl, { signal: AbortSignal.timeout(5000) });
  } catch { throw new Error('Horizon network probe failed (connection or timeout)'); }
  if (!response.ok) throw new Error(`Horizon network probe failed: HTTP ${response.status}`);
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new Error('Horizon returned invalid JSON'); }
  const network = payload && typeof payload === 'object' && 'network_passphrase' in payload
    ? (payload as { network_passphrase?: unknown }).network_passphrase : undefined;
  if (typeof network !== 'string') throw new Error('Horizon response is missing network_passphrase');
  assertSameNetwork(config.passphrase, network);
  // This compares provider-supplied metadata; it does not authenticate an untrusted Horizon provider.
}

export function buildUnsignedDemo(config: NetworkConfig): Transaction {
  validateNetwork(config);
  const sender = Keypair.random().publicKey(); // local public-only fixture, no account funding
  return new TransactionBuilder(new Account(sender, '0'), {
    fee: '100', networkPassphrase: config.passphrase,
  }).addOperation(Operation.bumpSequence({ bumpTo: '1' })).setTimeout(60).build();
}

/** A caller must provide both the transaction's intended passphrase and an explicit signer. */
export function guardedSign(tx: Transaction, config: NetworkConfig, intendedPassphrase: string,
  signer: (transaction: Transaction) => void): void {
  validateNetwork(config);
  assertSameNetwork(config.passphrase, intendedPassphrase);
  assertSameNetwork(config.passphrase, tx.networkPassphrase);
  signer(tx);
}

/** Submission is deliberately caller-driven and never chooses a fallback network. */
export async function guardedSubmit(tx: Transaction, config: NetworkConfig, intendedPassphrase: string,
  send: (transaction: Transaction) => Promise<unknown>): Promise<unknown> {
  validateNetwork(config);
  assertSameNetwork(config.passphrase, intendedPassphrase);
  assertSameNetwork(config.passphrase, tx.networkPassphrase);
  return send(tx);
}

export async function run(): Promise<void> {
  const label = (process.env.STELLAR_NETWORK ?? 'testnet') as NetworkConfig['label'];
  if (!['testnet', 'public', 'custom'].includes(label)) throw new Error('STELLAR_NETWORK must be testnet, public, or custom');
  const passphrase = process.env.STELLAR_NETWORK_PASSPHRASE || (label === 'testnet' ? Networks.TESTNET : label === 'public' ? Networks.PUBLIC_NETWORK : '');
  const horizonUrl = process.env.HORIZON_URL || (label === 'testnet' ? 'https://horizon-testnet.stellar.org' : label === 'public' ? 'https://horizon.stellar.org' : '');
  const config = validateNetwork({ label, passphrase, horizonUrl });
  const tx = buildUnsignedDemo(config);
  console.log(`Network: ${label}; Horizon: ${safeEndpoint(horizonUrl)}`);
  console.log(`Unsigned transaction prepared; hash: ${tx.hash().toString('hex')}`);
  console.log('No signing or transaction submission performed.');
  // Optional read-only query: requires an actual Horizon connection and explicitly set flag.
  if (process.env.PROBE_HORIZON === 'true') {
    await probeHorizon(config);
    console.log('Horizon advertised the configured network passphrase (provider is not independently authenticated).');
  }
}
