/**
 * Shared types for invocation error analysis.
 */

export type Stage =
  | 'input-validation'
  | 'transaction-construction'
  | 'simulation'
  | 'resource-estimation'
  | 'authorization'
  | 'submission'
  | 'execution'
  | 'status-retrieval'
  | 'unknown';

export type Category =
  | 'invalid-input'
  | 'contract-not-found'
  | 'authorization'
  | 'contract-execution'
  | 'resource-limit'
  | 'fee-or-configuration'
  | 'network-connectivity'
  | 'transaction-rejected'
  | 'transaction-pending'
  | 'unknown';

/**
 * How sure the classifier is.
 *  - high:   a structured, documented code (tx result code, RPC status, host error type + code)
 *  - medium: a recognised pattern in free-form text
 *  - low:    a loose heuristic
 *  - none:   unclassified
 */
export type Confidence = 'high' | 'medium' | 'low' | 'none';

/**
 * What is known about whether the transaction reached the network.
 *  - not-applicable: failed before any submission was attempted
 *  - not-submitted:  the network definitely did not accept it
 *  - unknown:        submission may or may not have succeeded (e.g. connection dropped while sending)
 *  - pending:        accepted or duplicate, outcome not final yet
 *  - included:       it was included in a ledger (executed, with success or failure)
 */
export type SubmissionStatus = 'not-applicable' | 'not-submitted' | 'unknown' | 'pending' | 'included';

export interface InvocationContext {
  contractAddress?: string;
  functionName?: string;
  network?: string;
}

/** What the caller captured when an invocation step failed. Everything is optional. */
export interface InvocationFailure {
  /** The stage you were in. Strongly preferred: it is the only reliable signal. */
  stage?: Stage;
  /** A thrown error (SDK error, axios error, plain Error, string...). */
  error?: unknown;
  /** An RPC response: simulation, sendTransaction or getTransaction. */
  response?: unknown;
  transactionHash?: string;
  context?: InvocationContext;
}
