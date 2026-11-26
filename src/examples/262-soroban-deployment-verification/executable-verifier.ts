import type { ContractExecutableInfo, ContractInstanceInspection } from './contract-inspector';
import type { ManifestExecutable } from './manifest';

export type ExecutableVerificationStatus = 'match' | 'mismatch' | 'inconclusive';

export interface ExecutableVerification {
  status: ExecutableVerificationStatus;
  expectedType: ManifestExecutable['type'];
  actualType: ContractExecutableInfo['kind'] | null;
  expectedWasmHash: string | null;
  retrievedWasmHash: string | null;
  /** Set when the comparison found a concrete inconsistency. */
  reason: string | null;
  notes: string[];
}

/**
 * Compares the executable recorded on-chain with the manifest expectation.
 *
 * The executable hash is a property of the uploaded Wasm module, not of the
 * contract address: two addresses can share a hash, and one address can point at
 * a different hash after an upgrade. Unavailable information is reported as
 * inconclusive, never as a pass.
 */
export function verifyExecutable(
  inspection: ContractInstanceInspection,
  expected: ManifestExecutable,
): ExecutableVerification {
  const notes: string[] = [];
  const actual = inspection.executable;
  const expectedWasmHash = expected.type === 'wasm' ? expected.wasmHash.toLowerCase() : null;

  const result: ExecutableVerification = {
    status: 'inconclusive',
    expectedType: expected.type,
    actualType: actual ? actual.kind : null,
    expectedWasmHash,
    retrievedWasmHash: actual?.wasmHash ?? null,
    reason: null,
    notes,
  };

  if (inspection.status === 'not_found') {
    notes.push('Contract instance was not found, so no executable could be inspected');
    return result;
  }

  if (inspection.status === 'error' || !actual) {
    notes.push(
      inspection.error
        ? `Executable information is unavailable: ${inspection.error}`
        : 'Executable information is unavailable for this contract instance',
    );
    return result;
  }

  if (expected.type === 'wasm') {
    if (actual.kind !== 'wasm') {
      return {
        ...result,
        status: 'mismatch',
        reason:
          `Expected a Wasm executable but the contract reports the "${actual.typeName}" ` +
          'executable type',
      };
    }

    if (!actual.wasmHash) {
      notes.push('The Wasm executable did not expose a hash; the expectation cannot be verified');
      return result;
    }

    if (!expectedWasmHash) {
      notes.push('The manifest does not declare an expected Wasm hash');
      return result;
    }

    if (expectedWasmHash === actual.wasmHash.toLowerCase()) {
      return { ...result, status: 'match' };
    }

    return {
      ...result,
      status: 'mismatch',
      reason: `Wasm hash mismatch: expected ${expectedWasmHash}, retrieved ${actual.wasmHash}`,
    };
  }

  // Expected a protocol built-in executable (for example the Stellar Asset Contract).
  if (actual.kind === 'builtin') {
    notes.push('Built-in executables have no Wasm hash to compare; only the type is checked');
    return { ...result, status: 'match' };
  }

  if (actual.kind === 'unknown') {
    notes.push(
      `The contract reports an unrecognised executable type "${actual.typeName}"; ` +
        'it cannot be classified as built-in or Wasm',
    );
    return result;
  }

  return {
    ...result,
    status: 'mismatch',
    reason: `Expected a built-in executable but the contract uses Wasm (${actual.wasmHash})`,
  };
}
