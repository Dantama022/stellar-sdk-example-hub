/**
 * Deployed contract executable lookup.
 *
 * Three different identifiers are involved and they are NOT interchangeable:
 *   - contract address: `C...`, the identity of a deployed contract instance
 *   - executable hash:  SHA-256 of the WASM the instance runs (stored in the
 *                       contract's instance ledger entry)
 *   - local checksum:   SHA-256 of a file on your disk
 * A match means "the deployed instance runs byte-identical WASM to this file".
 * The address alone says nothing about which code runs.
 *
 * Lookup: build the contract-instance ledger key (`Contract#getFootprint()`),
 * read it with `getLedgerEntries`, and read `executable()` from the instance.
 */

import { Contract, StrKey, xdr } from '@stellar/stellar-sdk';

/** The slice of rpc.Server this module needs. */
export interface LedgerEntryReader {
  getLedgerEntries(...keys: xdr.LedgerKey[]): Promise<{ entries: Array<{ val: xdr.LedgerEntryData }> }>;
}

export type DeployedExecutable =
  | { kind: 'wasm'; wasmHash: string }
  /** Stellar Asset Contracts are built into the network; there is no WASM to compare. */
  | { kind: 'stellar-asset' }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string };

export async function fetchDeployedExecutable(server: LedgerEntryReader, contractId: string): Promise<DeployedExecutable> {
  if (!StrKey.isValidContract(contractId)) {
    return { kind: 'error', message: `"${contractId}" is not a valid contract address (expected C...)` };
  }
  try {
    const response = await server.getLedgerEntries(new Contract(contractId).getFootprint());
    const entry = response.entries[0];
    if (!entry) return { kind: 'not-found' };
    const executable = entry.val.contractData().val().instance().executable();
    switch (executable.switch().name) {
      case 'contractExecutableWasm':
        return { kind: 'wasm', wasmHash: executable.wasmHash().toString('hex') };
      case 'contractExecutableStellarAsset':
        return { kind: 'stellar-asset' };
      default:
        return { kind: 'error', message: `unrecognised contract executable type ${executable.switch().name}` };
    }
  } catch (err) {
    return { kind: 'error', message: `could not read the contract instance: ${(err as Error).message}` };
  }
}

export type DeployedComparison =
  | { status: 'match'; contractId: string; deployedWasmHash: string }
  | { status: 'mismatch'; contractId: string; deployedWasmHash: string }
  | { status: 'skipped'; reason: string }
  | { status: 'not-comparable' | 'not-found' | 'unavailable'; contractId: string; reason: string };

export function compareWithDeployed(localSha256: string, contractId: string, deployed: DeployedExecutable): DeployedComparison {
  switch (deployed.kind) {
    case 'wasm':
      return localSha256 === deployed.wasmHash
        ? { status: 'match', contractId, deployedWasmHash: deployed.wasmHash }
        : { status: 'mismatch', contractId, deployedWasmHash: deployed.wasmHash };
    case 'stellar-asset':
      return { status: 'not-comparable', contractId, reason: 'this is a Stellar Asset Contract; it runs built-in code, not uploaded WASM' };
    case 'not-found':
      return { status: 'not-found', contractId, reason: 'no contract instance entry exists (wrong network, never deployed, or archived)' };
    case 'error':
      return { status: 'unavailable', contractId, reason: deployed.message };
  }
}
