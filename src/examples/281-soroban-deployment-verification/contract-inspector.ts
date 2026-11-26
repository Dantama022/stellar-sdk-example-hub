import { Contract, rpc, StrKey, xdr } from '@stellar/stellar-sdk';

import { DeploymentVerificationError, describeError } from './errors';
import { isWasmHash } from './manifest';

/**
 * Minimal read-only subset of `rpc.Server` used by this example.
 *
 * Keeping the dependency narrow makes the audit trivially mockable and makes it
 * obvious that no state-changing RPC method is reachable from this code.
 */
export interface SorobanRpcClient {
  getNetwork(): Promise<{ passphrase: string; protocolVersion?: string }>;
  getLatestLedger(): Promise<{ sequence: number }>;
  getLedgerEntries(
    ...keys: xdr.LedgerKey[]
  ): Promise<{ entries: rpc.Api.LedgerEntryResult[]; latestLedger?: number }>;
}

export type ContractExecutableKind = 'wasm' | 'builtin' | 'unknown';

export interface ContractExecutableInfo {
  kind: ContractExecutableKind;
  /** Hex-encoded Wasm hash for Wasm executables, otherwise null. */
  wasmHash: string | null;
  /** Raw XDR discriminant name, useful for unexpected executable types. */
  typeName: string;
}

export interface ContractInstanceInspection {
  contractId: string;
  status: 'found' | 'not_found' | 'error';
  latestLedger: number | null;
  lastModifiedLedgerSeq: number | null;
  liveUntilLedgerSeq: number | null;
  executable: ContractExecutableInfo | null;
  error: string | null;
}

export interface ContractCodeLookup {
  status: 'found' | 'not_found' | 'error';
  code: Buffer | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Ledger key construction
// ---------------------------------------------------------------------------

/** Builds the LedgerKey for a contract's instance entry. */
export function buildContractInstanceLedgerKey(contractId: string): xdr.LedgerKey {
  if (!StrKey.isValidContract(contractId)) {
    throw new DeploymentVerificationError(
      'INVALID_CONTRACT_ADDRESS',
      `"${contractId}" is not a valid Stellar contract (C...) address`,
    );
  }

  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Contract(contractId).address().toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

/** Builds the LedgerKey for a contract code entry from its hex Wasm hash. */
export function buildContractCodeLedgerKey(wasmHashHex: string): xdr.LedgerKey {
  if (!isWasmHash(wasmHashHex)) {
    throw new DeploymentVerificationError(
      'INCOMPLETE_DATA',
      `"${wasmHashHex}" is not a 64-character hex-encoded Wasm hash`,
    );
  }

  return xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: Buffer.from(wasmHashHex, 'hex') }),
  );
}

// ---------------------------------------------------------------------------
// Executable extraction
// ---------------------------------------------------------------------------

function toLedgerEntryData(value: unknown): xdr.LedgerEntryData | null {
  if (value === null || typeof value !== 'object') return null;
  const candidate = value as {
    switch?: () => unknown;
    data?: () => unknown;
  };

  try {
    if (typeof candidate.switch === 'function') {
      // `LedgerEntryData` is the XDR union returned by `getLedgerEntries` in the
      // pinned SDK; callers verify the concrete entry type after this check.
      candidate.switch();
      return value as xdr.LedgerEntryData;
    }
  } catch {
    // Not a LedgerEntryData; fall through to the wrapped-entry shape below.
  }

  try {
    if (typeof candidate.data === 'function') {
      const wrapped = candidate.data();
      if (wrapped !== null && typeof wrapped === 'object') {
        return wrapped as xdr.LedgerEntryData;
      }
    }
  } catch {
    // Neither shape matched.
  }

  return null;
}

/**
 * Extracts the executable description from a contract instance ledger entry.
 *
 * Returns null when the entry is not a contract instance (for example a
 * persistent storage entry), so callers never confuse storage with code.
 */
export function extractExecutableInfo(
  entry: rpc.Api.LedgerEntryResult,
): ContractExecutableInfo | null {
  const data = toLedgerEntryData(entry.val);
  if (!data) return null;

  try {
    if (data.switch() !== xdr.LedgerEntryType.contractData()) return null;

    const contractData = data.contractData();
    if (contractData.key().switch() !== xdr.ScValType.scvLedgerKeyContractInstance()) return null;

    const val = contractData.val();
    if (val.switch() !== xdr.ScValType.scvContractInstance()) return null;

    const executable = val.instance().executable();
    const executableType = executable.switch();
    const typeName =
      (executableType as unknown as { name?: string }).name ?? String(executableType);

    if (executableType === xdr.ContractExecutableType.contractExecutableWasm()) {
      return {
        kind: 'wasm',
        wasmHash: executable.wasmHash().toString('hex'),
        typeName: 'wasm',
      };
    }

    if (executableType === xdr.ContractExecutableType.contractExecutableStellarAsset()) {
      return { kind: 'builtin', wasmHash: null, typeName: 'stellarAsset' };
    }

    return { kind: 'unknown', wasmHash: null, typeName };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Network inspection
// ---------------------------------------------------------------------------

/**
 * Retrieves the contract instance entry from the selected network.
 *
 * This is the only way the example proves the contract exists: a bootstrap
 * account, a metadata file, or a locally known address is not proof.
 */
export async function inspectContractInstance(
  client: SorobanRpcClient,
  contractId: string,
): Promise<ContractInstanceInspection> {
  const inspection: ContractInstanceInspection = {
    contractId,
    status: 'error',
    latestLedger: null,
    lastModifiedLedgerSeq: null,
    liveUntilLedgerSeq: null,
    executable: null,
    error: null,
  };

  let instanceKey: xdr.LedgerKey;
  try {
    instanceKey = buildContractInstanceLedgerKey(contractId);
  } catch (error) {
    inspection.error = describeError(error);
    return inspection;
  }

  try {
    const latest = await client.getLatestLedger();
    inspection.latestLedger = latest.sequence;
  } catch (error) {
    inspection.error = `RPC failure fetching latest ledger: ${describeError(error)}`;
    return inspection;
  }

  let response: { entries: rpc.Api.LedgerEntryResult[] };
  try {
    response = await client.getLedgerEntries(instanceKey);
  } catch (error) {
    const message = describeError(error);
    inspection.error = /archiv|expir/i.test(message)
      ? `Contract instance appears archived or expired: ${message}`
      : `RPC failure fetching contract instance: ${message}`;
    return inspection;
  }

  const entry = response?.entries?.[0];
  if (!entry) {
    inspection.status = 'not_found';
    inspection.error = `Contract instance not found on the selected network: ${contractId}`;
    return inspection;
  }

  inspection.status = 'found';
  inspection.lastModifiedLedgerSeq = entry.lastModifiedLedgerSeq ?? null;
  inspection.liveUntilLedgerSeq = entry.liveUntilLedgerSeq ?? null;
  inspection.executable = extractExecutableInfo(entry);

  if (!inspection.executable) {
    inspection.error = 'Contract instance entry did not expose an executable';
  }

  return inspection;
}

/** Retrieves the contract code entry that holds the Wasm bytes and spec section. */
export async function fetchContractCode(
  client: SorobanRpcClient,
  wasmHashHex: string,
): Promise<ContractCodeLookup> {
  let codeKey: xdr.LedgerKey;
  try {
    codeKey = buildContractCodeLedgerKey(wasmHashHex);
  } catch (error) {
    return { status: 'error', code: null, error: describeError(error) };
  }

  let response: { entries: rpc.Api.LedgerEntryResult[] };
  try {
    response = await client.getLedgerEntries(codeKey);
  } catch (error) {
    return {
      status: 'error',
      code: null,
      error: `RPC failure fetching contract code entry: ${describeError(error)}`,
    };
  }

  const entry = response?.entries?.[0];
  if (!entry) {
    return {
      status: 'not_found',
      code: null,
      error: `Contract code entry ${wasmHashHex} was not found on the selected network`,
    };
  }

  const data = toLedgerEntryData(entry.val);
  if (!data) {
    return {
      status: 'error',
      code: null,
      error: 'Contract code ledger entry has an unexpected XDR shape',
    };
  }

  try {
    if (data.switch() !== xdr.LedgerEntryType.contractCode()) {
      return {
        status: 'error',
        code: null,
        error: `Expected a contractCode ledger entry, received ${String(data.switch())}`,
      };
    }

    return { status: 'found', code: data.contractCode().code(), error: null };
  } catch (error) {
    return { status: 'error', code: null, error: describeError(error) };
  }
}
