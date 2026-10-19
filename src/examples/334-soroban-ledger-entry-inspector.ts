/** ISSUE-334: Soroban ledger-entry inspector. Read-only, no funded account required. */
import { Address, Asset, Contract, Networks, rpc, scValToNative, StrKey, xdr } from '@stellar/stellar-sdk';

export interface InspectionConfig {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  symbols: string[];
  timeoutMs: number;
}

export function getConfig(env: NodeJS.ProcessEnv = process.env): InspectionConfig {
  const network = env.STELLAR_NETWORK || 'testnet';
  if (!['testnet', 'mainnet'].includes(network)) throw new Error('STELLAR_NETWORK must be testnet or mainnet');
  const passphrase = network === 'testnet' ? Networks.TESTNET : Networks.PUBLIC;
  if (env.NETWORK_PASSPHRASE && env.NETWORK_PASSPHRASE !== passphrase) {
    throw new Error('NETWORK_PASSPHRASE does not match STELLAR_NETWORK');
  }
  const rpcUrl = env.SOROBAN_RPC_URL || (network === 'testnet' ? 'https://soroban-testnet.stellar.org' : '');
  if (!rpcUrl) throw new Error('SOROBAN_RPC_URL is required for mainnet');
  let url: URL;
  try { url = new URL(rpcUrl); } catch { throw new Error('SOROBAN_RPC_URL must be an absolute HTTPS URL'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('SOROBAN_RPC_URL must use HTTPS (HTTP only allowed for localhost)');
  }
  const contractId = env.CONTRACT_ID || Asset.native().contractId(passphrase);
  if (!StrKey.isValidContract(contractId)) throw new Error('CONTRACT_ID must be a valid C... Stellar contract address');
  const symbols = (env.STORAGE_KEYS || 'COUNTER').split(',').map(s => s.trim());
  if (symbols.some(s => !/^[A-Za-z0-9_]{1,32}$/.test(s)) || symbols.length > 15) {
    throw new Error('STORAGE_KEYS must contain up to 15 comma-separated alphanumeric symbols (max 32 chars each)');
  }
  const timeoutMs = Number(env.RPC_TIMEOUT_MS || 8000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) {
    throw new Error('RPC_TIMEOUT_MS must be an integer between 100 and 60000');
  }
  return { contractId, rpcUrl, networkPassphrase: passphrase, symbols, timeoutMs };
}

export function makeKeys(contractId: string, symbols: string[]): xdr.LedgerKey[] {
  if (!StrKey.isValidContract(contractId)) throw new Error('Invalid contract ID');
  const keys: xdr.LedgerKey[] = [new Contract(contractId).getFootprint()];
  for (const name of symbols) {
    if (!/^[A-Za-z0-9_]{1,32}$/.test(name)) throw new Error('Invalid storage symbol');
    for (const durability of [xdr.ContractDataDurability.persistent, xdr.ContractDataDurability.temporary]) {
      keys.push(xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
        contract: new Address(contractId).toScAddress(),
        key: xdr.ScVal.scvSymbol(name), durability,
      })));
    }
  }
  return keys;
}

export function decodeLedgerEntryXdr(base64: string): xdr.LedgerEntryData {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64) || !base64) {
    throw new Error('Ledger entry is not valid base64 XDR');
  }
  try { return xdr.LedgerEntryData.fromXDR(base64, 'base64'); }
  catch { throw new Error('Ledger entry contains malformed XDR'); }
}

export function describeData(entry: xdr.LedgerEntryData): string {
  try {
    const data = entry.contractData();
    const value = data.val();
    if (value.switch().name === 'scvContractInstance') {
      const instance = value.instance();
      const storage = instance.storage();
      return `contract instance; executable=${instance.executable().switch().name}; storage pairs=${storage?.length || 0} (schema-dependent)`;
    }
    // Do not pretend complex SCVals have an application-independent schema.
    const kind = value.switch().name;
    if (!['scvU32', 'scvI32', 'scvU64', 'scvI64', 'scvBool', 'scvSymbol', 'scvString'].includes(kind)) {
      return `${kind}: XDR decoded, application interpretation requires contract schema`;
    }
    const nativeValue: unknown = scValToNative(value);
    return `${kind}: ${String(nativeValue).slice(0, 120)}`;
  } catch { return `unsupported ledger entry type: ${entry.switch().name}`; }
}

export type InspectionRow = { key: string; status: 'found' | 'missing'; details: string; lastModifiedLedgerSeq?: number; liveUntilLedgerSeq?: number };
export async function inspect(
  server: Pick<rpc.Server, 'getLedgerEntries'>,
  contractId: string,
  symbols: string[],
  timeoutMs = 8000,
): Promise<InspectionRow[]> {
  const keys = makeKeys(contractId, symbols);
  let timer: NodeJS.Timeout | undefined;
  try {
    const response = await Promise.race([
      server.getLedgerEntries(...keys),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('RPC timed out; try another Soroban RPC endpoint')), timeoutMs); }),
    ]);
    if (!response || !Array.isArray(response.entries)) throw new Error('Soroban RPC returned malformed ledger entries');
    // RPC omits missing entries; associate returned values by their actual XDR key, not array position.
    const found = new Map(response.entries.map(entry => [entry.key.toXDR('base64'), entry]));
    return keys.map((key, index) => {
      const label = index === 0 ? 'contract instance' : `${symbols[Math.floor((index - 1) / 2)]} (${index % 2 ? 'persistent' : 'temporary'})`;
      const matched = found.get(key.toXDR('base64'));
      if (!matched) return { key: label, status: 'missing', details: 'not present, expired, archived or inaccessible' };
      if (!matched.val) return { key: label, status: 'found', details: 'malformed: missing LedgerEntryData' };
      return {
        key: label, status: 'found', details: describeData(matched.val),
        lastModifiedLedgerSeq: matched.lastModifiedLedgerSeq,
        liveUntilLedgerSeq: matched.liveUntilLedgerSeq,
      };
    });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('RPC timed out')) throw err;
    if (err instanceof Error && err.message.includes('malformed ledger')) throw err;
    throw new Error('Soroban RPC lookup failed; verify URL, network and endpoint availability');
  } finally { if (timer) clearTimeout(timer); }
}

export async function run(): Promise<void> {
  const config = getConfig();
  const server = new rpc.Server(config.rpcUrl);
  const results = await inspect(server, config.contractId, config.symbols, config.timeoutMs);
  console.log(JSON.stringify({ network: config.networkPassphrase, contract: config.contractId, entries: results }, null, 2));
  console.log('Read-only snapshot: arbitrary contract state cannot be reconstructed without its storage schema.');
}

if (require.main === module) run().catch(err => { console.error(err instanceof Error ? err.message : 'Inspection failed'); process.exitCode = 1; });
