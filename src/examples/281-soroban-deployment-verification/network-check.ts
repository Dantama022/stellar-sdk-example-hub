import type { SorobanRpcClient } from './contract-inspector';
import { describeError } from './errors';

export type NetworkCheckStatus = 'match' | 'mismatch' | 'unavailable';

export interface NetworkCheckResult {
  status: NetworkCheckStatus;
  rpcUrl: string;
  expectedPassphrase: string;
  /** Passphrase reported by the RPC endpoint, when it answered. */
  reportedPassphrase: string | null;
  protocolVersion: string | null;
  error: string | null;
}

/**
 * Validates an RPC endpoint URL locally, before any request is attempted.
 * Returns an error message, or null when the URL is usable.
 */
export function validateRpcEndpoint(rpcUrl: string): string | null {
  if (typeof rpcUrl !== 'string' || rpcUrl.trim() === '') {
    return 'network.rpcUrl must be a non-empty string';
  }

  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    return `network.rpcUrl "${rpcUrl}" is not a valid URL`;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `network.rpcUrl must use http or https, received "${parsed.protocol}"`;
  }

  return null;
}

/**
 * Compares the passphrase reported by the RPC endpoint with the manifest.
 *
 * A contract ID is derived from network-specific data, so an address that looks
 * correct can still point at a different deployment on another network. The
 * passphrase check is what keeps the audit honest.
 */
export async function checkNetwork(
  client: SorobanRpcClient,
  expected: { passphrase: string; rpcUrl: string },
): Promise<NetworkCheckResult> {
  const result: NetworkCheckResult = {
    status: 'unavailable',
    rpcUrl: expected.rpcUrl,
    expectedPassphrase: expected.passphrase,
    reportedPassphrase: null,
    protocolVersion: null,
    error: null,
  };

  try {
    const network = await client.getNetwork();
    result.reportedPassphrase = network.passphrase;
    result.protocolVersion = network.protocolVersion ?? null;
    result.status = network.passphrase === expected.passphrase ? 'match' : 'mismatch';
    return result;
  } catch (error) {
    result.status = 'unavailable';
    result.error = `RPC network check failed: ${describeError(error)}`;
    return result;
  }
}
