/** Shared types for the token balance / allowance inspection example. */

export type TokenInspectionErrorCode =
  | 'INVALID_CONTRACT_ADDRESS'
  | 'INVALID_ACCOUNT_ADDRESS'
  | 'INVALID_SPENDER_ADDRESS'
  | 'NETWORK_MISMATCH'
  | 'RPC_UNAVAILABLE'
  | 'CONTRACT_NOT_FOUND'
  /** The contract is missing a method required for the requested inspection. */
  | 'UNSUPPORTED_INTERFACE'
  /** A single method does not exist on the contract (used internally per call). */
  | 'METHOD_NOT_FOUND'
  /** The method exists but the simulated call failed (trap, contract error, bad args...). */
  | 'INVOCATION_FAILED'
  | 'UNEXPECTED_RETURN_TYPE'
  | 'INVALID_DECIMALS'
  | 'FORMAT_ERROR';

export class TokenInspectionError extends Error {
  constructor(
    public readonly code: TokenInspectionErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'TokenInspectionError';
  }
}

/** A raw on-chain integer (smallest unit) and its human-readable rendering. */
export interface Amount {
  /** Exact on-chain value. Never passes through a JS `number`. */
  raw: bigint;
  /** Decimal string using the token's decimals. Undefined when decimals are unknown. */
  formatted?: string;
}

/**
 * Outcome of the allowance lookup. The non-ok states are deliberately distinct from
 * `ok` with a raw value of 0n, which is a real answer: "the spender may spend nothing".
 */
export type AllowanceStatus = 'ok' | 'unsupported' | 'failed';

export interface AllowanceResult {
  owner: string;
  spender: string;
  status: AllowanceStatus;
  /** Present only when status is "ok". */
  amount?: Amount;
  /** Present when status is "unsupported" or "failed". */
  error?: { code: TokenInspectionErrorCode; message: string };
}

export interface InterfaceReport {
  /**
   * "contract_spec": read from the Wasm's embedded contract spec.
   * "stellar_asset": Stellar Asset Contract (built into the host; implements the token interface).
   * "unavailable": the spec could not be read, so support is only learned by invoking.
   */
  source: 'contract_spec' | 'stellar_asset' | 'unavailable';
  /** true/false when known from the spec; undefined when unknown. */
  methods: { balance?: boolean; allowance?: boolean; decimals?: boolean };
}

export interface TokenInspectionResult {
  status: 'ok' | 'partial' | 'error';
  network: 'testnet' | 'mainnet';
  networkPassphrase: string;
  tokenContract: string;
  account: string;
  balance?: Amount;
  decimals?: number;
  decimalsSource?: 'explicit' | 'contract';
  allowance?: AllowanceResult;
  interface?: InterfaceReport;
  warnings: string[];
  error?: { code: TokenInspectionErrorCode; message: string };
}
