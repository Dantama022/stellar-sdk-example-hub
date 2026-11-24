/** Shared types for the Soroban resource & cost analysis example. */
import { xdr } from '@stellar/stellar-sdk';

export type NetworkName = 'testnet' | 'mainnet' | 'futurenet';

export type ErrorCode =
  | 'INVALID_NETWORK'
  | 'INVALID_RPC_URL'
  | 'INVALID_CONTRACT_ADDRESS'
  | 'INVALID_SOURCE_ACCOUNT'
  | 'INVALID_FUNCTION_NAME'
  | 'INVALID_ARGUMENTS'
  | 'NETWORK_MISMATCH'
  | 'RPC_UNAVAILABLE';

/** Thrown for bad input and transport failures. Simulation outcomes are reported, not thrown. */
export class CostAnalysisError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'CostAnalysisError';
  }
}

/** A typed invocation argument, e.g. `{ type: 'i128', value: '1000000' }`. */
export interface ArgSpec {
  type:
    | 'bool'
    | 'u32'
    | 'i32'
    | 'u64'
    | 'i64'
    | 'u128'
    | 'i128'
    | 'u256'
    | 'i256'
    | 'string'
    | 'symbol'
    | 'address'
    | 'bytes';
  /** Integers are strings so values beyond 2^53 never pass through a JS number. */
  value: string | boolean;
}

export interface InvocationConfig {
  network: NetworkName;
  /** Required for mainnet; defaults exist for testnet and futurenet. */
  rpcUrl?: string;
  contractId: string;
  functionName: string;
  args: ArgSpec[];
  /** Public key (G...) used only as the transaction source. Nothing is signed. */
  sourceAccount: string;
  /** Inclusion-fee bid in stroops. Defaults to the SDK's BASE_FEE. */
  inclusionFee?: string;
  /** Fraction of a limit (0-1) at which a warning is raised. Default 0.8. */
  warnRatio?: number;
}

/** A validated invocation: everything needed to build the transaction. */
export interface ValidatedInvocation {
  network: NetworkName;
  networkPassphrase: string;
  rpcUrl: string;
  contractId: string;
  functionName: string;
  args: xdr.ScVal[];
  sourceAccount: string;
  inclusionFee: string;
  warnRatio: number;
}

/** Resources the simulation says the transaction needs. Integers stay bigint. */
export interface SimulatedResources {
  instructions: bigint;
  readBytes: bigint;
  writeBytes: bigint;
  /** Footprint: ledger keys the transaction reads / writes. */
  readOnlyEntries: number;
  readWriteEntries: number;
  /** Total ledger entries read (read-only + read-write) and written (read-write). */
  readEntries: number;
  writeEntries: number;
  /** Resource fee embedded in the simulated transaction data, in stroops. */
  dataResourceFee: bigint;
}

export interface DiagnosticsSummary {
  eventCount: number;
  /** Counts keyed by event type name ("diagnostic", "contract", "system"). */
  eventTypes: Record<string, number>;
  /** Number of diagnostic events that were emitted as failed contract calls. */
  failedCallEvents: number;
  stateChangeCount?: number;
}

export type SimulationStatus = 'success' | 'failed' | 'restore_required' | 'unexpected_response' | 'missing_resource_info';

export type FailureKind = 'missing_function' | 'invalid_arguments' | 'out_of_resources' | 'other';

export interface SimulationOutcome {
  status: SimulationStatus;
  latestLedger?: number;
  /** Present only when status === 'success'. */
  resources?: SimulatedResources;
  minResourceFee?: bigint;
  diagnostics?: DiagnosticsSummary;
  /** Present when status is 'failed'. `kind` is a heuristic classification of `message`. */
  failure?: { kind: FailureKind; message: string };
  /** Human-readable detail for non-success statuses. */
  detail?: string;
  /** The raw success response, kept for fee assembly. Never serialized into the report. */
  raw?: unknown;
}

/** Network limits read from ledger ConfigSetting entries. Any field may be missing. */
export interface NetworkLimits {
  txMaxInstructions?: bigint;
  txMaxReadBytes?: bigint;
  txMaxWriteBytes?: bigint;
  txMaxReadLedgerEntries?: bigint;
  txMaxWriteLedgerEntries?: bigint;
  txMaxSizeBytes?: bigint;
  ledgerSeq?: number;
}

export type ResourceStatus = 'ok' | 'warning' | 'exceeded' | 'unknown';

export interface ResourceLine {
  name: string;
  used: bigint;
  limit?: bigint;
  /** used / limit as a percentage with two decimals; undefined when the limit is unknown. */
  percent?: number;
  status: ResourceStatus;
}

export interface ResourceAnalysis {
  lines: ResourceLine[];
  warnings: string[];
  limitsAvailable: boolean;
}

export type FeeStatus = 'estimated' | 'failed' | 'not_available';

export interface FeeEstimate {
  status: FeeStatus;
  /** Inclusion-fee bid placed on the transaction, stroops. */
  inclusionFee?: bigint;
  /** Resource fee returned by simulation (`minResourceFee`), stroops. */
  resourceFee?: bigint;
  /** inclusionFee + resourceFee: the fee on the assembled transaction. An upper bound on what is charged. */
  maxFee?: bigint;
  /** Optional context from getFeeStats; absent when the call failed. */
  marketInclusionFee?: { p50: string; p99: string; ledgerCount: number };
  error?: string;
  warnings: string[];
}

export type Assessment = 'ok' | 'caution' | 'do_not_submit' | 'inconclusive';

export interface CostReport {
  /** Always true: this example never signs or submits. */
  readOnly: true;
  network: { name: NetworkName; passphrase: string; rpcUrl: string };
  contractId: string;
  functionName: string;
  simulation: { status: SimulationStatus; latestLedger?: number; detail?: string; failureKind?: FailureKind };
  resources?: SimulatedResources;
  limits?: NetworkLimits;
  analysis?: ResourceAnalysis;
  fee: FeeEstimate;
  diagnostics?: DiagnosticsSummary;
  warnings: string[];
  assessment: Assessment;
  notes: string[];
}
