/** Shared types for the token transfer preflight example. */

export type TransferErrorCode =
  | 'NETWORK_REQUIRED'
  | 'INVALID_NETWORK'
  | 'INVALID_SENDER'
  | 'INVALID_RECIPIENT'
  | 'INVALID_TOKEN_CONTRACT'
  | 'INVALID_AMOUNT'
  | 'INVALID_SOURCE'
  | 'RPC_UNAVAILABLE'
  | 'SIMULATION_FAILED'
  | 'INSUFFICIENT_BALANCE'
  | 'INSUFFICIENT_RESOURCES'
  | 'RESTORE_REQUIRED'
  | 'MISSING_AUTHORIZATION'
  | 'UNSUPPORTED_AUTHORIZATION'
  | 'AUTH_SIGNING_FAILED'
  | 'INVALID_SIGNATURE'
  | 'PREFLIGHT_FAILED';

export class TransferError extends Error {
  constructor(
    public readonly code: TransferErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'TransferError';
  }
}

export interface PreflightCheck {
  id: string;
  description: string;
  passed: boolean;
  /** Why the check passed or failed. */
  detail: string;
}

export interface PreflightReport {
  /** true only when every check passed. Submission must be refused otherwise. */
  ok: boolean;
  checks: PreflightCheck[];
}

export type SubmissionOutcome =
  /** Included in a ledger and executed successfully. */
  | 'success'
  /** Included in a ledger but execution failed (fees were charged). */
  | 'failed'
  /** Rejected at submission; it did not enter the transaction queue. */
  | 'rejected'
  /** Accepted, but not yet seen in a ledger when we stopped polling. Status is unresolved. */
  | 'pending'
  /** The network asked us to try later; the transaction was not accepted. */
  | 'not_accepted'
  /** The submit request itself failed; we cannot know whether the network received it. */
  | 'unknown';

export interface SubmissionResult {
  outcome: SubmissionOutcome;
  /** Hex transaction hash. Always known, because it is computed locally before submission. */
  hash: string;
  message: string;
  ledger?: number;
  /** Decoded transaction result code, e.g. "txFailed" or "txBadSeq". */
  resultCode?: string;
  /** Names of diagnostic events or error details returned by the RPC, for debugging. */
  diagnostics?: string[];
}
