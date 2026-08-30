import { Address, Contract, xdr, Keypair } from '@stellar/stellar-sdk';

export interface AuthorizationPreparationParams {
  contractId?: string;
  sourceAccount?: string;
  functionName?: string;
  args?: any[];
  jsonOutput?: boolean;
}

export interface PreparedAuthorizationDetail {
  authorizedAddress: string;
  credentialType: 'address' | 'none';
  contractId: string;
  functionName: string;
  argsCount: number;
  subInvocationsCount: number;
  xdrBase64: string;
  isSigned: boolean;
}

/**
 * Validates a Stellar public key (G...) or contract ID (C...).
 */
export function isValidStellarId(id: string): boolean {
  if (!id || typeof id !== 'string') return false;
  const trimmed = id.trim();
  return (trimmed.startsWith('G') || trimmed.startsWith('C')) && trimmed.length === 56;
}

/**
 * Creates a valid xdr.SorobanAuthorizationEntry for demonstration/testing.
 */
export function createMockAuthorizationEntry(
  contractId: string,
  address: string,
  fnName: string,
  args: xdr.ScVal[] = [],
  subInvocations: xdr.SorobanAuthorizedInvocation[] = [],
): xdr.SorobanAuthorizationEntry {
  const contractAddr = new Contract(contractId).address().toScVal();

  const rootInvocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.SorobanAuthorizedContractFunction({
        contractAddress: Address.fromString(contractId).toScVal().address(),
        functionName: fnName,
        args,
      }),
    ),
    subInvocations,
  });

  const addressCredentials = new xdr.SorobanAddressCredentials({
    address: Address.fromString(address).toScVal().address(),
    nonce: xdr.Int64.fromString('0'),
    signatureExpirationLedger: 100000,
    signature: xdr.ScVal.scvVoid(),
  });

  const credentials = xdr.SorobanCredentials.sorobanCredentialsAddress(addressCredentials);

  return new xdr.SorobanAuthorizationEntry({
    credentials,
    rootInvocation,
  });
}

/**
 * Decodes a base64 XDR string back into an xdr.SorobanAuthorizationEntry object.
 */
export function decodeAuthorizationEntryXDR(xdrString: string): xdr.SorobanAuthorizationEntry {
  if (!xdrString || typeof xdrString !== 'string') {
    throw new Error('Invalid XDR string provided.');
  }

  const buffer = Buffer.from(xdrString, 'base64');
  return xdr.SorobanAuthorizationEntry.fromXDR(buffer);
}

/**
 * Verifies round-trip encoding and decoding consistency for a SorobanAuthorizationEntry.
 */
export function verifyRoundTripConsistency(entry: xdr.SorobanAuthorizationEntry): boolean {
  try {
    const encoded = entry.toXDR('base64');
    const decoded = decodeAuthorizationEntryXDR(encoded);
    const reEncoded = decoded.toXDR('base64');
    return encoded === reEncoded;
  } catch {
    return false;
  }
}

/**
 * Formats a list of authorization entries into a readable tree hierarchy.
 */
export function formatAuthorizationTree(entriesDetails: PreparedAuthorizationDetail[]): string {
  const lines: string[] = [];

  lines.push('=== Prepared Soroban Authorization Tree ===');
  lines.push(`Total Authorization Entries Prepared: ${entriesDetails.length}`);

  entriesDetails.forEach((detail, idx) => {
    lines.push(`\nAuthorization Entry #${idx + 1}:`);
    lines.push(`  - Authorized Address:  ${detail.authorizedAddress}`);
    lines.push(`  - Credential Type:     ${detail.credentialType}`);
    lines.push(`  - Target Contract:     ${detail.contractId}`);
    lines.push(`  - Root Function:       ${detail.functionName}`);
    lines.push(`  - Arguments Count:     ${detail.argsCount}`);
    lines.push(`  - Sub-invocations:     ${detail.subInvocationsCount}`);
    lines.push(`  - Authorization State: ${detail.isSigned ? 'SIGNED' : 'UNSIGNED (Ready for signing)'}`);
    lines.push(`  - Raw XDR (base64):    ${detail.xdrBase64.slice(0, 32)}...`);
  });

  lines.push('\nSecurity & Protocol Guidance:');
  lines.push('  - Prepared entries represent unsigned authorization definitions.');
  lines.push('  - Authorization data should be reviewed by the authorizing account before signing.');
  lines.push('  - No private keys or secret seeds were used or requested in this flow.');

  return lines.join('\n');
}

/**
 * Runs the Soroban authorization entry preparation example.
 */
export async function run(params: AuthorizationPreparationParams = {}): Promise<void> {
  const contractId =
    params.contractId?.trim() ||
    process.env.CONTRACT_ID?.trim() ||
    'CDW6BR4A6MGGCW23SCAVBBBZ3HW4V5C3TJ35OC3D4RQ4A6MGGCW23SCA';

  const sourceAccount =
    params.sourceAccount?.trim() ||
    process.env.SOURCE_ACCOUNT?.trim() ||
    Keypair.random().publicKey();

  const functionName = params.functionName?.trim() || 'transfer';

  console.log('Starting Soroban Authorization Entry Preparation Example...');
  console.log(`Target Contract ID: ${contractId}`);
  console.log(`Authorizing Source: ${sourceAccount}`);
  console.log(`Target Function:    ${functionName}`);

  if (!isValidStellarId(contractId)) {
    console.log(`Warning: Contract ID '${contractId}' is not a standard 56-char address. Proceeding with mock demonstration.`);
  }

  const sampleArgs = [
    Address.fromString(sourceAccount).toScVal(),
    xdr.ScVal.scvU32(100),
  ];

  // Prepare primary authorization entry
  const entry = createMockAuthorizationEntry(contractId, sourceAccount, functionName, sampleArgs);
  const xdrBase64 = entry.toXDR('base64');

  // Verify round trip consistency
  const isConsistent = verifyRoundTripConsistency(entry);
  console.log(`Round-trip XDR Encoding/Decoding Verification: ${isConsistent ? 'SUCCESS' : 'FAILED'}`);

  const details: PreparedAuthorizationDetail[] = [
    {
      authorizedAddress: sourceAccount,
      credentialType: 'address',
      contractId,
      functionName,
      argsCount: sampleArgs.length,
      subInvocationsCount: 0,
      xdrBase64,
      isSigned: false,
    },
  ];

  if (params.jsonOutput || process.env.JSON_OUTPUT === 'true') {
    console.log(JSON.stringify({ isConsistent, entries: details }, null, 2));
  } else {
    console.log('\n' + formatAuthorizationTree(details));
  }

  console.log('\nAuthorization entry preparation completed successfully.');
}
