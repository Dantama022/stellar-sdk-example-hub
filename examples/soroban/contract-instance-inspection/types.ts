/** Shared types for the contract-instance inspection example. */

export type InspectionErrorCode =
  | 'INVALID_ADDRESS'
  | 'NETWORK_MISMATCH'
  | 'RPC_UNAVAILABLE'
  | 'INSTANCE_NOT_FOUND'
  | 'INVALID_LEDGER_ENTRY'
  | 'XDR_DECODE_FAILED';

export class InspectionError extends Error {
  constructor(
    public readonly code: InspectionErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'InspectionError';
  }
}

/** A JSON-safe representation of a decoded ScVal. */
export interface DecodedValue {
  /** ScVal arm name, e.g. "scvU64", "scvSymbol". */
  type: string;
  /** True when `value` is a faithful readable form; false when only `xdr` is trustworthy. */
  supported: boolean;
  /** Readable value. 64-bit and larger integers are decimal strings; bytes are hex. */
  value?: unknown;
  /** Base64 XDR of the original ScVal. Always set when unsupported; optional otherwise. */
  xdr?: string;
  warning?: string;
}

export interface DecodeOptions {
  /** Attach base64 XDR to every decoded value, not only unsupported ones. */
  retainXdr?: boolean;
  /** Maximum nesting depth for vectors/maps. */
  maxDepth?: number;
}

export interface DecodedMapEntry {
  key: DecodedValue;
  value: DecodedValue;
}

export type ExecutableInfo =
  | { type: 'wasm'; wasmHash: string }
  | { type: 'stellar_asset' }
  | { type: 'unknown'; xdr: string };

export interface InstanceStorageEntry {
  /** Index in the storage map. Keys are NOT interpreted as application field names. */
  index: number;
  key: DecodedValue;
  value: DecodedValue;
}

export interface InspectionResult {
  status: 'ok' | 'not_found' | 'error';
  contractAddress: string;
  network: 'testnet' | 'mainnet';
  networkPassphrase: string;
  instance?: {
    executable: ExecutableInfo;
    /** null when the instance has no storage map at all. */
    storageEntryCount: number | null;
    lastModifiedLedgerSeq?: number;
    liveUntilLedgerSeq?: number;
    latestLedger?: number;
    /** Base64 XDR of the whole LedgerEntryData. */
    entryXdr?: string;
  };
  storage: InstanceStorageEntry[];
  warnings: string[];
  error?: { code: InspectionErrorCode; message: string };
}
