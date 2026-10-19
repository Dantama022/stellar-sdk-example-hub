/** ISSUE-335: SEP-7 pay/tx URI construction and strict inspection (no signing, no network). */
import { Account, Asset, Keypair, Networks, Operation, StrKey, TransactionBuilder, xdr } from '@stellar/stellar-sdk';

export type PayRequest = { operation: 'pay'; destination: string; amount?: string; memo?: string; memo_type?: 'MEMO_TEXT'; asset_code?: string; asset_issuer?: string; msg?: string; network_passphrase?: string };
export type TxRequest = { operation: 'tx'; xdr: string; network_passphrase?: string; callback?: string; pubkey?: string };
export type Sep7Request = PayRequest | TxRequest;
const PAY_PARAMS = new Set(['destination', 'amount', 'memo', 'memo_type', 'asset_code', 'asset_issuer', 'msg', 'network_passphrase']);
const TX_PARAMS = new Set(['xdr', 'network_passphrase', 'callback', 'pubkey']);

export function validateAmount(amount: string): void {
  if (!/^(?:0|[1-9]\d{0,15})(?:\.\d{1,7})?$/.test(amount) || !/[1-9]/.test(amount)) {
    throw new Error('amount must be positive decimal with at most 7 fractional digits');
  }
}
export function validateRequest(input: Sep7Request): void {
  if (input.operation === 'pay') {
    if (!StrKey.isValidEd25519PublicKey(input.destination)) throw new Error('destination must be a valid Stellar G... address');
    if (input.amount !== undefined) validateAmount(input.amount);
    if ((input.asset_code === undefined) !== (input.asset_issuer === undefined)) throw new Error('asset_code and asset_issuer must appear together');
    if (input.asset_code && !/^[A-Za-z0-9]{1,12}$/.test(input.asset_code)) throw new Error('invalid asset_code');
    if (input.asset_issuer && !StrKey.isValidEd25519PublicKey(input.asset_issuer)) throw new Error('invalid asset_issuer');
    if ((input.memo === undefined) !== (input.memo_type === undefined)) throw new Error('memo and memo_type must appear together');
    if (input.memo_type && input.memo_type !== 'MEMO_TEXT') throw new Error('this example supports MEMO_TEXT only');
    if (input.memo && Buffer.byteLength(input.memo, 'utf8') > 28) throw new Error('MEMO_TEXT cannot exceed 28 UTF-8 bytes');
    if (input.msg && input.msg.length > 300) throw new Error('msg exceeds 300 characters');
  } else {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.xdr) || input.xdr.length > 200000) throw new Error('xdr must be base64 TransactionEnvelope');
    try { xdr.TransactionEnvelope.fromXDR(input.xdr, 'base64'); }
    catch { throw new Error('xdr is not a valid TransactionEnvelope'); }
    if (input.pubkey && !StrKey.isValidEd25519PublicKey(input.pubkey)) throw new Error('invalid pubkey');
    if (input.callback) {
      if (!input.callback.startsWith('url:')) throw new Error('only url: callback is supported');
      let target: URL;
      try { target = new URL(input.callback.slice(4)); } catch { throw new Error('callback URL is invalid'); }
      if (target.protocol !== 'https:') throw new Error('callback must use HTTPS');
    }
  }
  if (input.network_passphrase !== undefined && !input.network_passphrase.trim()) throw new Error('network_passphrase cannot be blank');
}

export function generateUri(request: Sep7Request): string {
  validateRequest(request);
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(request)) {
    if (key !== 'operation' && value !== undefined) qs.set(key, value);
  }
  return `web+stellar:${request.operation}?${qs.toString()}`;
}

export function parseUri(uri: string): Sep7Request {
  if (uri.length > 210000) throw new Error('SEP-7 URI exceeds supported size');
  if (!uri.startsWith('web+stellar:')) throw new Error('URI must begin web+stellar:');
  const match = /^web\+stellar:([a-z]+)\?([^#]+)$/.exec(uri);
  if (!match) throw new Error('malformed SEP-7 URI; expected web+stellar:pay? or web+stellar:tx?');
  const operation = match[1];
  if (operation !== 'pay' && operation !== 'tx') throw new Error(`unsupported SEP-7 operation: ${operation}`);
  // URLSearchParams tolerates malformed percent escapes, so reject them first.
  const query = match[2];
  if (/%(?![0-9A-Fa-f]{2})/.test(query)) throw new Error('malformed percent-encoded parameter');
  const params = new URLSearchParams(query);
  const allowed = operation === 'pay' ? PAY_PARAMS : TX_PARAMS;
  const values: Record<string, string> = {};
  params.forEach((value, key) => {
    if (!allowed.has(key)) throw new Error(`unsupported ${operation} parameter: ${key}`);
    if (Object.prototype.hasOwnProperty.call(values, key)) throw new Error(`duplicate SEP-7 parameter: ${key}`);
    values[key] = value;
  });
  if (operation === 'pay') {
    if (!values.destination) throw new Error('pay requires destination');
    const request: PayRequest = { operation: 'pay', destination: values.destination };
    for (const name of ['amount', 'memo', 'asset_code', 'asset_issuer', 'msg', 'network_passphrase'] as const) {
      if (values[name] !== undefined) request[name] = values[name];
    }
    if (values.memo_type !== undefined) {
      if (values.memo_type !== 'MEMO_TEXT') throw new Error('only MEMO_TEXT is supported');
      request.memo_type = 'MEMO_TEXT';
    }
    validateRequest(request);
    return request;
  }
  if (!values.xdr) throw new Error('tx requires xdr');
  const request: TxRequest = { operation: 'tx', xdr: values.xdr };
  for (const name of ['network_passphrase', 'callback', 'pubkey'] as const) {
    if (values[name] !== undefined) request[name] = values[name];
  }
  validateRequest(request);
  return request;
}

/** Constructs a synthetic UNSIGNED payment envelope entirely offline. */
export function demoUnsignedEnvelope(account: string): string {
  if (!StrKey.isValidEd25519PublicKey(account)) throw new Error('invalid demo account');
  return new TransactionBuilder(new Account(account, '0'), { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({ destination: account, asset: Asset.native(), amount: '1' }))
    .setTimeout(0).build().toXDR();
}

export async function run(): Promise<void> {
  const destination = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey(); // deterministic DEMO only
  const pay = generateUri({ operation: 'pay', destination, amount: '1.25', memo: 'Example order 42', memo_type: 'MEMO_TEXT', network_passphrase: Networks.TESTNET });
  const tx = generateUri({ operation: 'tx', xdr: demoUnsignedEnvelope(destination), network_passphrase: Networks.TESTNET });
  console.log('Pay URI:', pay);
  console.log('Parsed pay request:', JSON.stringify(parseUri(pay)));
  console.log('Unsigned signing-request URI (no submission):', tx);
  console.log('Parsed transaction operation:', parseUri(tx).operation);
  console.log('Before wallet handoff, independently verify destination, amount, network and transaction operations.');
}
if (require.main === module) run().catch(err => { console.error(err instanceof Error ? err.message : 'Invalid SEP-7 request'); process.exitCode = 1; });
