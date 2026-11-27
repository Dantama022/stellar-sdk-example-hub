/**
 * Error taxonomy for the deployment verification example.
 *
 * Every failure mode listed in the issue maps to one code so callers can
 * distinguish a broken manifest from a contract that is simply not deployed.
 */
export type DeploymentVerificationErrorCode =
  | 'INVALID_MANIFEST'
  | 'INVALID_CONTRACT_ADDRESS'
  | 'NETWORK_PASSPHRASE_MISMATCH'
  | 'CONTRACT_NOT_FOUND'
  | 'EXECUTABLE_UNAVAILABLE'
  | 'WASM_HASH_MISMATCH'
  | 'SPEC_UNAVAILABLE'
  | 'INTERFACE_MISMATCH'
  | 'RPC_FAILURE'
  | 'INCOMPLETE_DATA';

export class DeploymentVerificationError extends Error {
  constructor(
    public readonly code: DeploymentVerificationErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DeploymentVerificationError';
  }
}

/** Normalizes an unknown thrown value into a readable message. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
