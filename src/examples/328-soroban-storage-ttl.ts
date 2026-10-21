import {
  Account, BASE_FEE, Contract, Keypair, Networks, Operation, rpc,
  SorobanDataBuilder, StrKey, Transaction, TransactionBuilder, xdr,
} from '@stellar/stellar-sdk';

export type StorageState = 'healthy' | 'expiring-soon' | 'not-found-or-archived' | 'ttl-unavailable';
export interface TtlAssessment { state: StorageState; liveUntilLedger?: number; ledgersRemaining?: number; }
export interface TtlConfig { contractId: string; rpcUrl: string; passphrase: string; threshold: number; }

export function validateTtlConfig(config: TtlConfig): TtlConfig {
  if (!StrKey.isValidContract(config.contractId)) throw new Error('Invalid Soroban contract ID');
  if (!config.passphrase?.trim()) throw new Error('Missing network passphrase');
  if (!Number.isSafeInteger(config.threshold) || config.threshold < 1) throw new Error('TTL threshold must be a positive integer');
  let url: URL;
  try { url = new URL(config.rpcUrl); } catch { throw new Error('Invalid Soroban RPC URL'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Soroban RPC must use HTTPS');
  if (url.username || url.password) throw new Error('Do not embed credentials in RPC URLs');
  return config;
}

export function assessTtl(currentLedger: number, liveUntilLedger: number | undefined, threshold: number, entryFound = true): TtlAssessment {
  if (!Number.isSafeInteger(currentLedger) || currentLedger < 0) throw new Error('Invalid current ledger');
  if (!Number.isSafeInteger(threshold) || threshold < 1) throw new Error('Invalid TTL threshold');
  if (!entryFound) return { state: 'not-found-or-archived' }; // absence alone does not prove archive status
  if (liveUntilLedger === undefined) return { state: 'ttl-unavailable' };
  if (!Number.isSafeInteger(liveUntilLedger) || liveUntilLedger < currentLedger) return { state: 'not-found-or-archived' };
  const ledgersRemaining = liveUntilLedger - currentLedger;
  return { state: ledgersRemaining <= threshold ? 'expiring-soon' : 'healthy', liveUntilLedger, ledgersRemaining };
}

export function instanceKey(contractId: string): xdr.LedgerKey {
  if (!StrKey.isValidContract(contractId)) throw new Error('Invalid Soroban contract ID');
  return new Contract(contractId).getFootprint();
}

export type LedgerLookup = {
  getLatestLedger(): Promise<{ sequence: number }>;
  getLedgerEntries(...keys: xdr.LedgerKey[]): Promise<{ entries?: Array<{ liveUntilLedgerSeq?: number }> }>;
};

/** Only known ledger keys can be inspected; RPC does not enumerate all keys for a contract. */
export async function inspectEntries(service: LedgerLookup, keys: xdr.LedgerKey[], threshold: number): Promise<TtlAssessment[]> {
  if (keys.length === 0) throw new Error('At least one ledger key is required');
  let latest: number;
  let response: Awaited<ReturnType<LedgerLookup['getLedgerEntries']>>;
  try {
    latest = (await service.getLatestLedger()).sequence;
    response = await service.getLedgerEntries(...keys);
  } catch { throw new Error('Soroban RPC inspection failed; check network, endpoint and availability'); }
  if (!Array.isArray(response.entries)) throw new Error('Malformed RPC ledger entries response');
  // In production, correlate entries by returned XDR key; batch results can omit missing keys.
  // For a single key, this never incorrectly assigns another entry's TTL.
  if (keys.length !== 1) throw new Error('Inspect each key separately to safely correlate missing entries');
  if (response.entries.length > 1) throw new Error('Unexpected number of ledger entries');
  return [assessTtl(latest, response.entries[0]?.liveUntilLedgerSeq, threshold, response.entries.length !== 0)];
}

export type TtlOperation = 'extend' | 'restore';
export function buildTtlTransaction(account: Account, passphrase: string, keys: xdr.LedgerKey[],
  mode: TtlOperation, extendTo = 100000): Transaction {
  if (!passphrase) throw new Error('Missing network passphrase');
  if (!keys.length) throw new Error('At least one ledger key required');
  if (mode === 'extend' && (!Number.isSafeInteger(extendTo) || extendTo < 1)) throw new Error('Invalid extendTo ledger count');
  const footprint = new SorobanDataBuilder();
  if (mode === 'extend') footprint.setReadOnly(keys);
  else footprint.setReadWrite(keys);
  return new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase })
    .setSorobanData(footprint.build())
    .addOperation(mode === 'extend' ? Operation.extendFootprintTtl({ extendTo }) : Operation.restoreFootprint({}))
    .setTimeout(60).build();
}

export async function prepareTtlTransaction(server: Pick<rpc.Server, 'prepareTransaction'>, tx: Transaction): Promise<Transaction> {
  try { return await server.prepareTransaction(tx); }
  catch { throw new Error('TTL transaction simulation/preparation failed; check footprint, network and fees'); }
}

/** Explicit state-changing action: callers must supply a funded keypair and opt in. */
export async function submitTtlTransaction(server: Pick<rpc.Server, 'sendTransaction'>,
  prepared: Transaction, feePayer: Keypair, optIn: boolean): Promise<string> {
  if (!optIn) throw new Error('Submission blocked: explicit opt-in required');
  if (prepared.source !== feePayer.publicKey()) throw new Error('Signing key does not match transaction source');
  prepared.sign(feePayer);
  try {
    const sent = await server.sendTransaction(prepared);
    if (sent.status === 'ERROR') throw new Error('Rejected');
    return sent.hash; // only a submission hash, NOT confirmation of successful execution
  } catch { throw new Error('TTL submission failed or status is uncertain; query final result before retrying'); }
}

export async function run(): Promise<void> {
  const contractId = process.env.CONTRACT_ID;
  if (!contractId) {
    console.log('Set CONTRACT_ID and SOROBAN_RPC_URL for read-only live TTL inspection. No requests made.');
    return;
  }
  const config = validateTtlConfig({
    contractId,
    rpcUrl: process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org',
    passphrase: process.env.STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET,
    threshold: Number(process.env.TTL_THRESHOLD || '10000'),
  });
  const endpoint = new URL(config.rpcUrl);
  console.log(`Soroban TTL read-only inspection: ${endpoint.origin}, contract ${config.contractId}`);
  const result = await inspectEntries(new rpc.Server(config.rpcUrl), [instanceKey(config.contractId)], config.threshold);
  console.log(`Instance storage: ${JSON.stringify(result[0])}`);
  console.log('Extending/restoring needs known keys, simulation, a funded signer, and explicit opt-in. No submission performed.');
}
