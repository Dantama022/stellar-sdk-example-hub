import { scValToNative, xdr } from '@stellar/stellar-sdk';
import {
  booleanFlag,
  jsonSafe,
  parseCommonFlags,
  stableStringify,
} from '../utils/soroban-state-inspection';
export type SignatureState =
  | 'present'
  | 'absent'
  | 'structurally-invalid'
  | 'unable-to-verify'
  | 'not-applicable';
export interface AuthInspectionOptions {
  entries?: string[] | string;
  json?: boolean;
}
interface InvocationReport {
  path: string;
  depth: number;
  functionType: string;
  contractAddress?: string;
  functionName?: string;
  arguments: unknown[];
}
export interface AuthorizationReport {
  rawXdr: string;
  roundTripValid: boolean;
  credentialType: string;
  authorizedAddress?: string;
  nonce?: string;
  signatureExpirationLedger?: number;
  signatureState: SignatureState;
  signatureType?: string;
  signatureRawXdr?: string;
  signatureNote: string;
  invocations: InvocationReport[];
  error?: string;
}
function formatAddress(address: xdr.ScAddress): string {
  try {
    return String(scValToNative(xdr.ScVal.scvAddress(address)));
  } catch {
    return `(unsupported:${address.switch().name})`;
  }
}
function safeScVal(value: xdr.ScVal): unknown {
  try {
    return jsonSafe(scValToNative(value));
  } catch {
    return { type: value.switch().name, rawXdr: value.toXDR('base64') };
  }
}
function flatten(root: xdr.SorobanAuthorizedInvocation): InvocationReport[] {
  const output: InvocationReport[] = [];
  const stack = [{ invocation: root, depth: 0, path: '0' }];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    const fn = current.invocation.function();
    const report: InvocationReport = {
      path: current.path,
      depth: current.depth,
      functionType: fn.switch().name,
      arguments: [],
    };
    if (fn.switch().name === 'sorobanAuthorizedFunctionTypeContractFn') {
      const contractFn = fn.contractFn();
      report.contractAddress = formatAddress(contractFn.contractAddress());
      report.functionName = contractFn.functionName().toString();
      report.arguments = contractFn.args().map(safeScVal);
    }
    output.push(report);
    const children = current.invocation.subInvocations();
    for (let i = children.length - 1; i >= 0; i -= 1)
      stack.push({
        invocation: children[i],
        depth: current.depth + 1,
        path: `${current.path}.${i}`,
      });
  }
  return output;
}
function inspectSignature(signature: xdr.ScVal): {
  state: SignatureState;
  type: string;
  rawXdr: string;
  note: string;
} {
  const type = signature.switch().name;
  const rawXdr = signature.toXDR('base64');
  if (type === 'scvVoid')
    return { state: 'absent', type, rawXdr, note: 'No address-credential signature is present.' };
  try {
    const decoded = scValToNative(signature);
    if (decoded === null || decoded === undefined)
      return {
        state: 'structurally-invalid',
        type,
        rawXdr,
        note: 'Signature ScVal decoded to an empty value.',
      };
    return {
      state: 'unable-to-verify',
      type,
      rawXdr,
      note: 'Signature data is structurally decodable. Cryptographic verification requires signer-specific rules and is not attempted.',
    };
  } catch {
    return {
      state: 'structurally-invalid',
      type,
      rawXdr,
      note: 'Signature ScVal could not be decoded structurally.',
    };
  }
}
export function inspectAuthorizationEntry(rawInput: string): AuthorizationReport {
  const rawXdr = rawInput.trim();
  let entry: xdr.SorobanAuthorizationEntry;
  try {
    entry = xdr.SorobanAuthorizationEntry.fromXDR(rawXdr, 'base64');
  } catch (error: unknown) {
    return {
      rawXdr,
      roundTripValid: false,
      credentialType: 'malformed',
      signatureState: 'structurally-invalid',
      signatureNote: 'Authorization-entry XDR could not be decoded.',
      invocations: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const credentialType = entry.credentials().switch().name;
  const base: AuthorizationReport = {
    rawXdr,
    roundTripValid: entry.toXDR('base64') === rawXdr,
    credentialType,
    signatureState: 'not-applicable',
    signatureNote: 'No separate authorization-entry signature applies to this credential type.',
    invocations: flatten(entry.rootInvocation()),
  };
  if (credentialType === 'sorobanCredentialsSourceAccount') return base;
  if (credentialType === 'sorobanCredentialsAddress') {
    const credentials = entry.credentials().address();
    const signature = inspectSignature(credentials.signature());
    return {
      ...base,
      authorizedAddress: formatAddress(credentials.address()),
      nonce: credentials.nonce().toString(),
      signatureExpirationLedger: credentials.signatureExpirationLedger(),
      signatureState: signature.state,
      signatureType: signature.type,
      signatureRawXdr: signature.rawXdr,
      signatureNote: signature.note,
    };
  }
  return {
    ...base,
    signatureState: 'unable-to-verify',
    signatureNote: `Credential type "${credentialType}" is not specifically supported.`,
  };
}
export function inspectAuthorizationEntries(inputs: string[]): AuthorizationReport[] {
  return inputs.map(inspectAuthorizationEntry);
}
export function parseAuthorizationArgs(args: string[]): AuthInspectionOptions {
  const { positional, flags } = parseCommonFlags(args);
  return { entries: positional, json: booleanFlag(flags, 'json') };
}
function normalizeEntries(entries: string[] | string | undefined): string[] {
  if (Array.isArray(entries)) return entries;
  if (typeof entries === 'string') return entries.split(/\s+/).filter(Boolean);
  return [];
}
export async function run(options: AuthInspectionOptions = {}): Promise<void> {
  const entries = normalizeEntries(options.entries);
  if (!entries.length) throw new Error('Provide at least one SorobanAuthorizationEntry XDR value.');
  const report = inspectAuthorizationEntries(entries);
  if (options.json) {
    console.log(stableStringify(report));
    return;
  }
  console.log('=== Soroban Authorization Signature Inspection ===');
  report.forEach((entry, index) => {
    console.log(`\nEntry #${index + 1}`);
    console.log(`Credential type: ${entry.credentialType}`);
    if (entry.authorizedAddress) console.log(`Authorized address: ${entry.authorizedAddress}`);
    console.log(`Signature status: ${entry.signatureState}`);
    console.log(`Signature note: ${entry.signatureNote}`);
    console.log(`XDR round-trip: ${entry.roundTripValid ? 'valid' : 'mismatch'}`);
    console.log(`Raw XDR: ${entry.rawXdr}`);
    entry.invocations.forEach((invocation) =>
      console.log(
        `${'  '.repeat(invocation.depth)}${invocation.path} ${invocation.functionType}${invocation.contractAddress ? ` contract=${invocation.contractAddress}` : ''}${invocation.functionName ? ` function=${invocation.functionName}` : ''}`,
      ),
    );
    if (entry.error) console.log(`Error: ${entry.error}`);
  });
}
if (require.main === module)
  run(parseAuthorizationArgs(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
