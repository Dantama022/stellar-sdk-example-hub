/**
 * Read-only retrieval of a Soroban contract instance ledger entry.
 *
 * Only getNetwork and getLedgerEntries are called; nothing is signed or submitted.
 */
import { Address, Networks, StrKey, rpc, xdr } from '@stellar/stellar-sdk';
import { decodeScVal, describeExecutable, ledgerEntryDataFromBase64 } from './decoder';
import { DecodeOptions, DecodedValue, InspectionError, InspectionResult, InstanceStorageEntry } from './types';

export type NetworkName = 'testnet' | 'mainnet';

export interface NetworkConfig {
  name: NetworkName;
  passphrase: string;
  defaultRpcUrl: string;
}

export const NETWORKS: Record<NetworkName, NetworkConfig> = {
  testnet: {
    name: 'testnet',
    passphrase: Networks.TESTNET,
    defaultRpcUrl: 'https://soroban-testnet.stellar.org',
  },
  // There is no SDF-run public mainnet RPC; this is a community endpoint.
  // Use --rpc-url / SOROBAN_RPC_URL with your own provider for real work.
  mainnet: {
    name: 'mainnet',
    passphrase: Networks.PUBLIC,
    defaultRpcUrl: 'https://mainnet.sorobanrpc.com',
  },
};

/** The slice of the RPC server this example needs; easy to mock in tests. */
export interface InstanceRpcClient {
  getNetwork(): Promise<{ passphrase: string }>;
  getRawLedgerEntries(keyXdrBase64: string): Promise<rpc.Api.RawGetLedgerEntriesResponse>;
}

export function createRpcClient(rpcUrl: string): InstanceRpcClient {
  const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
  return {
    getNetwork: () => server.getNetwork(),
    // _getLedgerEntries returns the raw base64 XDR, so decoding stays in our hands.
    getRawLedgerEntries: (keyXdr) =>
      server._getLedgerEntries(xdr.LedgerKey.fromXDR(keyXdr, 'base64')),
  };
}

export function validateContractAddress(address: string): string {
  if (typeof address !== 'string' || !StrKey.isValidContract(address)) {
    throw new InspectionError(
      'INVALID_ADDRESS',
      'Expected a Soroban contract address (56 characters, starting with "C").'
    );
  }
  return address;
}

/**
 * The instance of a contract is stored as a ContractData entry whose key is the
 * special ScVal "ledgerKeyContractInstance", always with persistent durability.
 */
export function buildInstanceLedgerKey(contractAddress: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractAddress).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    })
  );
}

export interface InspectOptions extends DecodeOptions {
  network?: NetworkName;
  rpcUrl?: string;
  /** Inject a client (used by tests). */
  client?: InstanceRpcClient;
}

/**
 * Inspect a contract's instance entry. Expected failures are reported in the
 * result (`status` + `error`) instead of being thrown.
 */
export async function inspectContractInstance(
  address: string,
  options: InspectOptions = {}
): Promise<InspectionResult> {
  const network = NETWORKS[options.network ?? 'testnet'];
  const result: InspectionResult = {
    status: 'error',
    contractAddress: address,
    network: network.name,
    networkPassphrase: network.passphrase,
    storage: [],
    warnings: [],
  };

  try {
    validateContractAddress(address);
    const client = options.client ?? createRpcClient(options.rpcUrl ?? network.defaultRpcUrl);

    const actual = await rpcCall(() => client.getNetwork());
    if (actual.passphrase !== network.passphrase) {
      throw new InspectionError(
        'NETWORK_MISMATCH',
        `Requested ${network.name} but the RPC endpoint reports a different network ("${actual.passphrase}").`
      );
    }

    const keyXdr = buildInstanceLedgerKey(address).toXDR('base64');
    const response = await rpcCall(() => client.getRawLedgerEntries(keyXdr));
    const entry = response.entries?.[0];
    if (!entry) {
      result.status = 'not_found';
      result.error = {
        code: 'INSTANCE_NOT_FOUND',
        message:
          'No instance entry found. The contract may not exist on this network, or its instance entry may have expired (archived) and need restoring.',
      };
      return result;
    }

    parseEntry(entry, response.latestLedger, options, result);
    result.status = 'ok';
  } catch (e) {
    if (e instanceof InspectionError) {
      result.error = { code: e.code, message: e.message };
    } else {
      result.error = { code: 'INVALID_LEDGER_ENTRY', message: (e as Error).message };
    }
  }
  return result;
}

/** Wrap RPC calls so transport failures become RPC_UNAVAILABLE. */
async function rpcCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new InspectionError('RPC_UNAVAILABLE', `RPC request failed: ${(e as Error).message}`);
  }
}

function parseEntry(
  entry: rpc.Api.RawLedgerEntryResult,
  latestLedger: number | undefined,
  options: DecodeOptions,
  result: InspectionResult
): void {
  const data = ledgerEntryDataFromBase64(entry.xdr);
  if (data.switch().name !== 'contractData') {
    throw new InspectionError(
      'INVALID_LEDGER_ENTRY',
      `Expected a contractData entry but got "${data.switch().name}".`
    );
  }
  const contractData = data.contractData();
  if (contractData.key().switch().name !== 'scvLedgerKeyContractInstance') {
    throw new InspectionError(
      'INVALID_LEDGER_ENTRY',
      'Returned contract data entry is not the contract instance entry.'
    );
  }
  const val = contractData.val();
  if (val.switch().name !== 'scvContractInstance') {
    throw new InspectionError(
      'INVALID_LEDGER_ENTRY',
      `Instance entry value should be scvContractInstance but was "${val.switch().name}".`
    );
  }

  const instance = val.instance();
  const executable = describeExecutable(instance.executable());
  // The SDK types this as `null`, but an absent optional can come back as `undefined`.
  const storage = instance.storage() ?? null;

  result.instance = {
    executable,
    storageEntryCount: storage === null ? null : storage.length,
    lastModifiedLedgerSeq: entry.lastModifiedLedgerSeq,
    liveUntilLedgerSeq: entry.liveUntilLedgerSeq,
    latestLedger,
    entryXdr: entry.xdr,
  };

  if (executable.type === 'wasm') {
    result.warnings.push(
      'Only the Wasm hash is part of the instance entry. The Wasm bytecode lives in a separate contractCode entry and was not fetched.'
    );
  } else if (executable.type === 'stellar_asset') {
    result.warnings.push(
      'This is a Stellar Asset Contract: it has no Wasm; its code is built in to the host.'
    );
  } else {
    result.warnings.push('Unrecognised executable type; original XDR retained.');
  }
  if (storage === null) {
    result.warnings.push('Instance has no storage map.');
  }

  const decoded: InstanceStorageEntry[] = (storage ?? []).map((e, index) => ({
    index,
    key: decodeScVal(e.key(), options),
    value: decodeScVal(e.val(), options),
  }));
  result.storage = decoded;

  const unsupportedCount = countUnsupported(decoded);
  if (unsupportedCount > 0) {
    result.warnings.push(
      `${unsupportedCount} value(s) could not be fully decoded; their original XDR is retained.`
    );
  }
  result.warnings.push(
    'Instance storage keys are contract-defined and are shown as-is; without the contract spec they should not be read as field names. Temporary/persistent data entries are separate ledger entries and are not included.'
  );
}

function countUnsupported(entries: InstanceStorageEntry[]): number {
  let n = 0;
  const walk = (v: DecodedValue): void => {
    if (!v.supported) n++;
    if (v.type === 'scvVec' && Array.isArray(v.value)) {
      (v.value as DecodedValue[]).forEach(walk);
    } else if (v.type === 'scvMap' && Array.isArray(v.value)) {
      (v.value as { key: DecodedValue; value: DecodedValue }[]).forEach((m) => {
        walk(m.key);
        walk(m.value);
      });
    }
  };
  entries.forEach((e) => {
    walk(e.key);
    walk(e.value);
  });
  return n;
}
