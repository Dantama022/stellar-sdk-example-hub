import { Address, rpc, scValToNative, StrKey, xdr } from '@stellar/stellar-sdk';

export type LifecycleStatus = 'Active' | 'Near expiration' | 'Expired/unavailable' | 'Unknown';

export interface StateEntryObservation {
  contractId: string;
  entryType: 'contract-instance' | 'persistent-data' | 'temporary-data' | 'other';
  ledgerKey: string;
  currentLedger: number;
  liveUntilLedgerSeq?: number;
  remainingLedgers?: number;
  status: LifecycleStatus;
  rawEntry?: string;
  decodedKey?: unknown;
  decodedValue?: unknown;
  error?: string;
}

export interface LedgerKeyInspection {
  rawXdr: string;
  ledgerKeyType: string;
  supported: boolean;
  contractId?: string;
  durability?: 'Persistent' | 'Temporary';
  decodedKey?: unknown;
  decodedValue?: unknown;
  error?: string;
}

export interface ContractStateProvider {
  getLatestLedger(): Promise<{ sequence: number }>;
  getContractData(
    contractId: string,
    key: xdr.ScVal,
    durability: rpc.Durability,
  ): Promise<rpc.Api.LedgerEntryResult>;
}

export function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array)
    return `0x${Buffer.from(value).toString('hex')}`;
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value instanceof Map)
    return Array.from(value.entries()).map(([key, child]) => ({
      key: jsonSafe(key),
      value: jsonSafe(child),
    }));
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort())
      output[key] = jsonSafe((value as Record<string, unknown>)[key]);
    return output;
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(jsonSafe(value), null, 2);
}
export function decodeScVal(value: xdr.ScVal): unknown {
  try {
    return jsonSafe(scValToNative(value));
  } catch {
    return { type: value.switch().name, rawXdr: value.toXDR('base64') };
  }
}
export function scAddressToString(address: xdr.ScAddress): string {
  try {
    return String(scValToNative(xdr.ScVal.scvAddress(address)));
  } catch {
    return `(unsupported:${address.switch().name})`;
  }
}
function isCanonicalBase64(value: string): boolean {
  if (!value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return false;
  try {
    return Buffer.from(value, 'base64').toString('base64') === value;
  } catch {
    return false;
  }
}
export function decodeLedgerKeyXdr(rawInput: string): LedgerKeyInspection {
  const rawXdr = rawInput.trim();
  if (!isCanonicalBase64(rawXdr))
    return {
      rawXdr,
      ledgerKeyType: 'invalid',
      supported: false,
      error: 'Input is not canonical base64.',
    };
  let key: xdr.LedgerKey;
  try {
    key = xdr.LedgerKey.fromXDR(rawXdr, 'base64');
  } catch (error: unknown) {
    return {
      rawXdr,
      ledgerKeyType: 'malformed',
      supported: false,
      error: `Malformed ledger-key XDR: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const type = key.switch().name;
  if (type === 'contractData') {
    const data = key.contractData();
    const durabilityName = data.durability().name.toLowerCase();
    return {
      rawXdr,
      ledgerKeyType: type,
      supported: true,
      contractId: scAddressToString(data.contract()),
      durability: durabilityName.includes('persistent') ? 'Persistent' : 'Temporary',
      decodedKey: decodeScVal(data.key()),
    };
  }
  if (type === 'contractCode')
    return {
      rawXdr,
      ledgerKeyType: type,
      supported: true,
      decodedKey: { wasmHash: Buffer.from(key.contractCode().hash()).toString('hex') },
    };
  if (type === 'ttl')
    return {
      rawXdr,
      ledgerKeyType: type,
      supported: true,
      decodedKey: { keyHash: Buffer.from(key.ttl().keyHash()).toString('hex') },
    };
  return {
    rawXdr,
    ledgerKeyType: type,
    supported: false,
    error: `Ledger-key type "${type}" is valid XDR but outside supported Soroban state types.`,
  };
}

export function validateContractId(contractId: string): string {
  const value = contractId.trim();
  if (!StrKey.isValidContract(value)) throw new Error(`Invalid contract ID "${value}".`);
  return value;
}
export function parseStorageKey(input: string): xdr.ScVal {
  const value = input.trim();
  if (!value) throw new Error('Storage key cannot be empty.');
  if (value === '<instance>' || value === 'instance')
    return xdr.ScVal.scvLedgerKeyContractInstance();
  if (value.startsWith('symbol:')) return xdr.ScVal.scvSymbol(value.slice(7));
  if (value.startsWith('string:')) return xdr.ScVal.scvString(value.slice(7));
  if (value.startsWith('u32:')) return xdr.ScVal.scvU32(Number(value.slice(4)));
  if (value.startsWith('i32:')) return xdr.ScVal.scvI32(Number(value.slice(4)));
  if (value.startsWith('address:')) return Address.fromString(value.slice(8).trim()).toScVal();
  if (value.startsWith('xdr:')) return xdr.ScVal.fromXDR(value.slice(4).trim(), 'base64');
  return xdr.ScVal.scvSymbol(value);
}
export function classifyExpiration(
  currentLedger: number,
  liveUntilLedgerSeq: number | undefined,
  warningLedgers: number,
): { remainingLedgers?: number; status: LifecycleStatus } {
  if (liveUntilLedgerSeq === undefined) return { status: 'Unknown' };
  const remainingLedgers = liveUntilLedgerSeq - currentLedger;
  if (remainingLedgers < 0) return { remainingLedgers, status: 'Expired/unavailable' };
  if (remainingLedgers <= warningLedgers) return { remainingLedgers, status: 'Near expiration' };
  return { remainingLedgers, status: 'Active' };
}
function rawLedgerEntry(entry: rpc.Api.LedgerEntryResult): string | undefined {
  try {
    return entry.val?.toXDR('base64');
  } catch {
    return undefined;
  }
}
function decodedLedgerValue(entry: rpc.Api.LedgerEntryResult): unknown {
  try {
    return entry.val ? decodeScVal(entry.val.contractData().val()) : undefined;
  } catch {
    return undefined;
  }
}

export async function inspectContractState(
  provider: ContractStateProvider,
  contractIdInput: string,
  storageKeys: string[] = [],
  warningLedgers = 1000,
): Promise<StateEntryObservation[]> {
  const contractId = validateContractId(contractIdInput);
  const latest = await provider.getLatestLedger();
  if (!Number.isInteger(latest.sequence) || latest.sequence < 0)
    throw new Error('RPC returned an invalid current ledger sequence.');
  const requests: Array<{
    entryType: StateEntryObservation['entryType'];
    key: xdr.ScVal;
    durability: rpc.Durability;
  }> = [
    {
      entryType: 'contract-instance',
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: rpc.Durability.Persistent,
    },
  ];
  for (const storageKey of storageKeys) {
    const key = parseStorageKey(storageKey);
    requests.push(
      { entryType: 'persistent-data', key, durability: rpc.Durability.Persistent },
      { entryType: 'temporary-data', key, durability: rpc.Durability.Temporary },
    );
  }
  const output: StateEntryObservation[] = [];
  for (const request of requests) {
    const ledgerKey = stableStringify(decodeScVal(request.key));
    try {
      const entry = await provider.getContractData(contractId, request.key, request.durability);
      const ttl = classifyExpiration(latest.sequence, entry.liveUntilLedgerSeq, warningLedgers);
      output.push({
        contractId,
        entryType: request.entryType,
        ledgerKey,
        currentLedger: latest.sequence,
        liveUntilLedgerSeq: entry.liveUntilLedgerSeq,
        remainingLedgers: ttl.remainingLedgers,
        status: ttl.status,
        rawEntry: rawLedgerEntry(entry),
        decodedKey: decodeScVal(request.key),
        decodedValue: decodedLedgerValue(entry),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      output.push({
        contractId,
        entryType: request.entryType,
        ledgerKey,
        currentLedger: latest.sequence,
        status: /not found|missing|archiv|expired/i.test(message)
          ? 'Expired/unavailable'
          : 'Unknown',
        decodedKey: decodeScVal(request.key),
        error: message,
      });
    }
  }
  return output;
}

export function parseCommonFlags(args: string[]): {
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
} {
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith('-')) {
      positional.push(token);
      continue;
    }
    const key = token.replace(/^-+/, '');
    const next = args[i + 1];
    if (key === 'key' && next && !next.startsWith('-')) {
      const existing = flags[key];
      flags[key] = Array.isArray(existing) ? [...existing, next] : [next];
      i += 1;
      continue;
    }
    if (!next || next.startsWith('-')) flags[key] = true;
    else {
      flags[key] = next;
      i += 1;
    }
  }
  return { positional, flags };
}
export function stringFlag(
  flags: Record<string, string | boolean | string[]>,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = flags[name];
    if (typeof value === 'string') return value;
  }
  return undefined;
}
export function numberFlag(
  flags: Record<string, string | boolean | string[]>,
  name: string,
  fallback: number,
): number {
  const raw = stringFlag(flags, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`--${name} must be a non-negative integer.`);
  return value;
}
export function booleanFlag(
  flags: Record<string, string | boolean | string[]>,
  ...names: string[]
): boolean {
  return names.some((name) => flags[name] === true || typeof flags[name] === 'string');
}
export function keyFlags(flags: Record<string, string | boolean | string[]>): string[] {
  const raw = flags.key;
  return Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
}
