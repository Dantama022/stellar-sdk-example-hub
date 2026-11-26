import { contract, cereal, xdr } from '@stellar/stellar-sdk';

import { parseContractSpec, resolveTypeName } from '../../utils/spec-parser';
import type { ParsedContractSpec } from '../../utils/spec-parser';
import type { ContractInstanceInspection, SorobanRpcClient } from './contract-inspector';
import { fetchContractCode } from './contract-inspector';
import type { ManifestFunction, ManifestInterface } from './manifest';

export type InterfaceVerificationStatus = 'match' | 'mismatch' | 'unavailable' | 'not_applicable';

export interface SignatureMismatch {
  name: string;
  expected: string;
  actual: string;
}

export interface InterfaceVerification {
  status: InterfaceVerificationStatus;
  specificationAvailable: boolean;
  expectedFunctions: string[];
  actualFunctions: string[];
  missingFunctions: string[];
  unexpectedFunctions: string[];
  signatureMismatches: SignatureMismatch[];
  notes: string[];
}

export type SpecReadStatus = 'ok' | 'no_spec_section' | 'unreadable_wasm';

export interface SpecReadResult {
  status: SpecReadStatus;
  spec: contract.Spec | null;
}

// ---------------------------------------------------------------------------
// Specification retrieval
// ---------------------------------------------------------------------------

/**
 * Reads the `contractspecv0` custom section from deployed Wasm bytes.
 *
 * The specification is embedded in the Wasm module itself, so it is only
 * retrievable for Wasm executables. A module without the section is not an
 * incompatible interface; it simply publishes no specification.
 */
export function readContractSpecFromWasm(wasm: Buffer): SpecReadResult {
  let sections: ArrayBuffer[];
  try {
    const module = new WebAssembly.Module(Uint8Array.from(wasm));
    sections = WebAssembly.Module.customSections(module, 'contractspecv0');
  } catch {
    return { status: 'unreadable_wasm', spec: null };
  }

  if (sections.length === 0) {
    return { status: 'no_spec_section', spec: null };
  }

  try {
    const reader = new cereal.XdrReader(Buffer.from(sections[0]));
    const entries: xdr.ScSpecEntry[] = [];
    const scSpecEntry = xdr.ScSpecEntry as unknown as {
      read(io: unknown): xdr.ScSpecEntry;
    };

    while (!reader.eof) {
      entries.push(scSpecEntry.read(reader));
    }

    if (entries.length === 0) return { status: 'no_spec_section', spec: null };
    return { status: 'ok', spec: new contract.Spec(entries) };
  } catch {
    return { status: 'no_spec_section', spec: null };
  }
}

// ---------------------------------------------------------------------------
// Interface comparison
// ---------------------------------------------------------------------------

function normalizeType(typeName: string): string {
  return typeName.replace(/\s+/g, '').toLowerCase();
}

function typeList(types: string[]): string {
  return types.map(normalizeType).join(',');
}

function expectedSignature(fn: ManifestFunction): string {
  const inputs = (fn.inputs ?? []).map((input) => input.type).join(', ');
  const outputs = (fn.outputs ?? []).join(', ') || 'void';
  return `${fn.name}(${inputs}) -> ${outputs}`;
}

function actualSignature(fn: ParsedContractSpec['functions'][number]): string {
  const inputs = fn.inputs.map((input) => input.type).join(', ');
  const outputs = fn.outputs.join(', ') || 'void';
  return `${fn.name}(${inputs}) -> ${outputs}`;
}

function notApplicable(note: string): InterfaceVerification {
  return {
    status: 'not_applicable',
    specificationAvailable: false,
    expectedFunctions: [],
    actualFunctions: [],
    missingFunctions: [],
    unexpectedFunctions: [],
    signatureMismatches: [],
    notes: [note],
  };
}

function unavailable(note: string, actualFunctions: string[] = []): InterfaceVerification {
  return {
    status: 'unavailable',
    specificationAvailable: false,
    expectedFunctions: [],
    actualFunctions,
    missingFunctions: [],
    unexpectedFunctions: [],
    signatureMismatches: [],
    notes: [note],
  };
}

/**
 * Compares a parsed on-chain specification with the manifest expectation.
 *
 * Missing functions, extra functions and signature differences are reported
 * separately so an added helper is not confused with a removed entry point.
 */
export function verifyInterface(
  spec: contract.Spec,
  expected: ManifestInterface,
): InterfaceVerification {
  const parsed = parseContractSpec(spec);
  const internalFunctions = parsed.functions.filter((fn) => fn.name.startsWith('__'));
  const exportedFunctions = parsed.functions.filter((fn) => !fn.name.startsWith('__'));

  const actualByName = new Map(exportedFunctions.map((fn) => [fn.name, fn]));
  const expectedNames = expected.functions.map((fn) => fn.name);
  const actualNames = exportedFunctions.map((fn) => fn.name);

  const missingFunctions = expectedNames.filter((name) => !actualByName.has(name));
  const unexpectedFunctions = actualNames.filter((name) => !expectedNames.includes(name));
  const signatureMismatches: SignatureMismatch[] = [];
  const notes: string[] = [];

  for (const expectedFunction of expected.functions) {
    const actualFunction = actualByName.get(expectedFunction.name);
    if (!actualFunction) continue;

    const inputsMatch =
      expectedFunction.inputs === undefined ||
      typeList(expectedFunction.inputs.map((input) => input.type)) ===
        typeList(actualFunction.inputs.map((input) => input.type));

    const expectedOutputs =
      expectedFunction.outputs === undefined
        ? undefined
        : expectedFunction.outputs.filter((output) => normalizeType(output) !== 'void');
    const outputsMatch =
      expectedOutputs === undefined ||
      typeList(expectedOutputs) === typeList(actualFunction.outputs);

    if (!inputsMatch || !outputsMatch) {
      signatureMismatches.push({
        name: expectedFunction.name,
        expected: expectedSignature(expectedFunction),
        actual: actualSignature(actualFunction),
      });
    }
  }

  if (internalFunctions.length > 0) {
    notes.push(
      `Ignored ${internalFunctions.length} internal spec function(s) prefixed with "__": ` +
        internalFunctions.map((fn) => fn.name).join(', '),
    );
  }
  if (expected.allowAdditionalFunctions) {
    notes.push('Additional exported functions are allowed by the manifest');
  }

  const hasMismatch =
    missingFunctions.length > 0 ||
    signatureMismatches.length > 0 ||
    (!expected.allowAdditionalFunctions && unexpectedFunctions.length > 0);

  return {
    status: hasMismatch ? 'mismatch' : 'match',
    specificationAvailable: true,
    expectedFunctions: expectedNames,
    actualFunctions: actualNames,
    missingFunctions,
    unexpectedFunctions,
    signatureMismatches,
    notes,
  };
}

/**
 * Retrieves the deployed specification and compares it with the manifest.
 *
 * Every path that cannot obtain a specification is reported as unavailable,
 * which is distinct from an interface that was retrieved and disagrees.
 */
export async function verifyInterfaceAgainstNetwork(
  client: SorobanRpcClient,
  inspection: ContractInstanceInspection,
  expected: ManifestInterface | undefined,
): Promise<InterfaceVerification> {
  if (!expected) {
    return notApplicable(
      'The manifest declares no expected interface; address and executable checks alone do not ' +
        'prove that two deployments expose the same entry points',
    );
  }

  if (inspection.status !== 'found') {
    return unavailable(
      'Contract instance is unavailable, so its specification cannot be compared with the manifest',
    );
  }

  const executable = inspection.executable;
  if (executable?.kind !== 'wasm' || !executable.wasmHash) {
    return unavailable(
      `Contract does not expose a Wasm executable (${executable ? executable.typeName : 'unknown'}), ` +
        'so no on-chain specification is retrievable',
    );
  }

  const code = await fetchContractCode(client, executable.wasmHash);
  if (code.status === 'error') {
    return unavailable(`Specification retrieval failed: ${code.error}`);
  }
  if (code.status === 'not_found' || !code.code) {
    return unavailable(
      `Contract code entry ${executable.wasmHash} is missing; the specification cannot be retrieved`,
    );
  }

  const read = readContractSpecFromWasm(code.code);
  if (read.status === 'unreadable_wasm') {
    return unavailable('Contract code entry is not a readable WebAssembly module');
  }
  if (!read.spec) {
    return unavailable(
      'Deployed Wasm does not contain a contractspecv0 section; no specification is published',
    );
  }

  return verifyInterface(read.spec, expected);
}

/** Re-exported so callers can render spec type names consistently. */
export { resolveTypeName };
