import fs from 'fs';
import path from 'path';

import { Networks, StrKey } from '@stellar/stellar-sdk';

import { DeploymentVerificationError, describeError } from './errors';
import { validateRpcEndpoint } from './network-check';

// ---------------------------------------------------------------------------
// Manifest types
// ---------------------------------------------------------------------------

/** Network the deployment is expected to live on. */
export interface ManifestNetworkConfig {
  /** Human-readable environment name, e.g. "testnet". */
  name: string;
  /** Stellar network passphrase bound to the deployment. */
  passphrase: string;
  /** Soroban RPC endpoint used for the read-only audit. */
  rpcUrl: string;
}

/** A contract whose code is a Wasm module identified by a code-entry hash. */
export interface ManifestExecutableWasm {
  type: 'wasm';
  /** Hex-encoded SHA-256 hash of the uploaded Wasm (64 hex characters). */
  wasmHash: string;
}

/** A protocol built-in executable such as the Stellar Asset Contract. */
export interface ManifestExecutableBuiltin {
  type: 'builtin';
}

export type ManifestExecutable = ManifestExecutableWasm | ManifestExecutableBuiltin;

export interface ManifestFunctionArgument {
  name?: string;
  /** Soroban type name as reported by the contract spec, e.g. "address" or "Vec<u32>". */
  type: string;
}

export interface ManifestFunction {
  name: string;
  /** When provided, argument types are compared in order. */
  inputs?: ManifestFunctionArgument[];
  /** When provided, return types are compared in order (empty array means "void"). */
  outputs?: string[];
}

export interface ManifestInterface {
  functions: ManifestFunction[];
  /** When false (default) any extra exported function is reported as unexpected. */
  allowAdditionalFunctions?: boolean;
}

/**
 * Declarative description of one contract deployment.
 *
 * A manifest is a durable expectation, not a discovery result: it is validated
 * before any network call so a broken expectation can never be mistaken for a
 * broken deployment.
 */
export interface DeploymentManifest {
  environment: string;
  contractId: string;
  network: ManifestNetworkConfig;
  executable: ManifestExecutable;
  interface?: ManifestInterface;
  /** Free-form, non-authoritative deployment notes (commit, deployer, release). */
  metadata?: Record<string, string>;
}

export interface ManifestValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  /** Present only when the manifest is valid. */
  manifest?: DeploymentManifest;
}

// ---------------------------------------------------------------------------
// Known network configurations
// ---------------------------------------------------------------------------

/** Passphrases the example can cross-check without a custom network. */
export const KNOWN_PASSPHRASES: string[] = Object.values(Networks);

/** Endpoints taken from the documented public Soroban RPC services. */
export const KNOWN_NETWORKS: Record<string, ManifestNetworkConfig> = {
  testnet: {
    name: 'testnet',
    passphrase: Networks.TESTNET,
    rpcUrl: 'https://soroban-testnet.stellar.org',
  },
  futurenet: {
    name: 'futurenet',
    passphrase: Networks.FUTURENET,
    rpcUrl: 'https://rpc-futurenet.stellar.org',
  },
};

/**
 * Sample manifest used when no manifest file is supplied.
 *
 * It points at the Stellar Asset Contract built-in deployment on Testnet so the
 * default run exercises the "non-Wasm executable" path without inventing a Wasm
 * hash. Supply your own manifest to audit a Wasm contract.
 */
export const SAMPLE_MANIFESTS: Record<string, DeploymentManifest> = {
  testnet: {
    environment: 'testnet',
    contractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    network: { ...KNOWN_NETWORKS.testnet },
    executable: { type: 'builtin' },
    metadata: {
      label: 'Built-in Stellar Asset Contract sample target',
      note: 'Replace with your own deployment manifest to audit a Wasm contract.',
    },
  },
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when the value is a 32-byte hash encoded as 64 hex characters. */
export function isWasmHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value);
}

/**
 * Validates an untrusted manifest object.
 *
 * Validation never touches the network: it only proves that the expectation is
 * well formed and internally consistent.
 */
export function validateManifest(manifest: unknown): ManifestValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isRecord(manifest)) {
    return { valid: false, errors: ['Manifest must be a JSON object'], warnings };
  }

  if (typeof manifest.environment !== 'string' || manifest.environment.trim() === '') {
    errors.push('environment must be a non-empty string');
  }

  if (typeof manifest.contractId !== 'string' || manifest.contractId.trim() === '') {
    errors.push('contractId must be a non-empty string');
  } else if (!StrKey.isValidContract(manifest.contractId.trim())) {
    errors.push(
      `contractId "${manifest.contractId}" is not a valid Stellar contract (C...) address; ` +
        'a contract ID is not the same thing as an executable hash',
    );
  }

  const network = manifest.network;
  if (!isRecord(network)) {
    errors.push('network must be an object with name, passphrase and rpcUrl');
  } else {
    if (typeof network.name !== 'string' || network.name.trim() === '') {
      errors.push('network.name must be a non-empty string');
    }
    if (typeof network.passphrase !== 'string' || network.passphrase.trim() === '') {
      errors.push('network.passphrase must be a non-empty network passphrase');
    } else if (!KNOWN_PASSPHRASES.includes(network.passphrase)) {
      warnings.push(
        `network.passphrase "${network.passphrase}" is not a known Stellar network passphrase; ` +
          'custom networks are allowed but cannot be cross-checked against a well-known name',
      );
    }
    if (typeof network.rpcUrl !== 'string') {
      errors.push('network.rpcUrl must be a non-empty string');
    } else {
      const rpcError = validateRpcEndpoint(network.rpcUrl);
      if (rpcError) errors.push(rpcError);
    }
  }

  const executable = manifest.executable;
  if (!isRecord(executable)) {
    errors.push("executable must be an object with a type of 'wasm' or 'builtin'");
  } else {
    const type = executable.type;
    if (type !== 'wasm' && type !== 'builtin') {
      errors.push("executable.type must be 'wasm' or 'builtin'");
    }
    if (executable.wasmHash !== undefined && !isWasmHash(executable.wasmHash)) {
      errors.push('executable.wasmHash must be a 64-character hex-encoded SHA-256 hash');
    }
    if (type === 'wasm' && executable.wasmHash === undefined) {
      errors.push("executable.wasmHash is required when executable.type is 'wasm'");
    }
    if (type === 'builtin' && executable.wasmHash !== undefined) {
      warnings.push("executable.wasmHash is ignored when executable.type is 'builtin'");
    }
  }

  const expectedInterface = manifest.interface;
  if (expectedInterface !== undefined) {
    if (!isRecord(expectedInterface)) {
      errors.push('interface must be an object');
    } else if (
      !Array.isArray(expectedInterface.functions) ||
      expectedInterface.functions.length === 0
    ) {
      errors.push('interface.functions must be a non-empty array');
    } else {
      const seen = new Set<string>();
      expectedInterface.functions.forEach((fn, index) => {
        if (!isRecord(fn) || typeof fn.name !== 'string' || fn.name.trim() === '') {
          errors.push(`interface.functions[${index}].name must be a non-empty string`);
          return;
        }
        if (seen.has(fn.name)) {
          errors.push(`interface.functions contains the duplicate name "${fn.name}"`);
        }
        seen.add(fn.name);

        if (fn.inputs !== undefined) {
          if (!Array.isArray(fn.inputs)) {
            errors.push(`interface.functions[${index}].inputs must be an array`);
          } else {
            fn.inputs.forEach((arg, argIndex) => {
              if (!isRecord(arg) || typeof arg.type !== 'string' || arg.type.trim() === '') {
                errors.push(
                  `interface.functions[${index}].inputs[${argIndex}].type must be a non-empty string`,
                );
              }
            });
          }
        }

        if (fn.outputs !== undefined) {
          if (
            !Array.isArray(fn.outputs) ||
            fn.outputs.some((output) => typeof output !== 'string')
          ) {
            errors.push(`interface.functions[${index}].outputs must be an array of type names`);
          }
        }
      });

      if (typeof expectedInterface.allowAdditionalFunctions !== 'boolean') {
        warnings.push('interface.allowAdditionalFunctions is not a boolean; defaulting to false');
      }
    }
  }

  const metadata = manifest.metadata;
  if (metadata !== undefined) {
    if (!isRecord(metadata)) {
      errors.push('metadata must be an object of string values');
    } else {
      for (const [key, value] of Object.entries(metadata)) {
        if (typeof value !== 'string') errors.push(`metadata.${key} must be a string`);
      }
    }
  }

  if (errors.length > 0) return { valid: false, errors, warnings };

  const executableRecord = manifest.executable as Record<string, unknown>;
  const networkRecord = manifest.network as Record<string, unknown>;
  const normalized: DeploymentManifest = {
    environment: String(manifest.environment).trim(),
    contractId: String(manifest.contractId).trim(),
    network: {
      name: String(networkRecord.name).trim(),
      passphrase: String(networkRecord.passphrase),
      rpcUrl: String(networkRecord.rpcUrl).trim(),
    },
    executable:
      executableRecord.type === 'wasm'
        ? { type: 'wasm', wasmHash: String(executableRecord.wasmHash).toLowerCase() }
        : { type: 'builtin' },
  };

  if (expectedInterface !== undefined) {
    const interfaceRecord = expectedInterface as Record<string, unknown>;
    const functions = (interfaceRecord.functions as unknown[]).map((fn) => {
      const fnRecord = fn as Record<string, unknown>;
      const normalizedFunction: ManifestFunction = { name: String(fnRecord.name).trim() };
      if (fnRecord.inputs !== undefined) {
        normalizedFunction.inputs = (fnRecord.inputs as unknown[]).map((arg) => {
          const argRecord = arg as Record<string, unknown>;
          const normalizedArgument: ManifestFunctionArgument = {
            type: String(argRecord.type).trim(),
          };
          if (typeof argRecord.name === 'string' && argRecord.name.trim() !== '') {
            normalizedArgument.name = argRecord.name.trim();
          }
          return normalizedArgument;
        });
      }
      if (fnRecord.outputs !== undefined) {
        normalizedFunction.outputs = (fnRecord.outputs as string[]).map((output) =>
          String(output).trim(),
        );
      }
      return normalizedFunction;
    });

    normalized.interface = { functions };
    if (typeof interfaceRecord.allowAdditionalFunctions === 'boolean') {
      normalized.interface.allowAdditionalFunctions = interfaceRecord.allowAdditionalFunctions;
    }
  }

  if (metadata !== undefined) {
    normalized.metadata = Object.fromEntries(
      Object.entries(metadata as Record<string, string>).map(([key, value]) => [
        key,
        String(value),
      ]),
    );
  }

  return { valid: true, errors, warnings, manifest: normalized };
}

/**
 * Validates a manifest and throws a coded error when it is unusable.
 *
 * Use this when an invalid manifest should abort the audit before any RPC call.
 */
export function assertValidManifest(manifest: unknown): DeploymentManifest {
  const result = validateManifest(manifest);
  if (!result.valid || !result.manifest) {
    throw new DeploymentVerificationError(
      'INVALID_MANIFEST',
      `Invalid deployment manifest: ${result.errors.join('; ')}`,
      { errors: result.errors, warnings: result.warnings },
    );
  }
  return result.manifest;
}

// ---------------------------------------------------------------------------
// Loading and environment selection
// ---------------------------------------------------------------------------

/** Reads a manifest JSON document from disk without validating it. */
export function loadManifestFile(filePath: string): unknown {
  const resolved = path.resolve(filePath);
  let raw: string;
  try {
    raw = fs.readFileSync(resolved, 'utf8');
  } catch (error) {
    throw new DeploymentVerificationError(
      'INVALID_MANIFEST',
      `Unable to read manifest file ${resolved}: ${describeError(error)}`,
    );
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new DeploymentVerificationError(
      'INVALID_MANIFEST',
      `Manifest file ${resolved} is not valid JSON: ${describeError(error)}`,
    );
  }
}

/**
 * Selects one manifest for an environment from a set of per-environment
 * manifests (for example testnet and production files kept side by side).
 */
export function selectManifest(manifests: Record<string, unknown>, environment: string): unknown {
  const selected = manifests[environment];
  if (selected === undefined) {
    throw new DeploymentVerificationError(
      'INVALID_MANIFEST',
      `No manifest for environment "${environment}". Available: ${Object.keys(manifests).join(', ')}`,
    );
  }
  return selected;
}
