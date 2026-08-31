import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Networks,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';

export interface InvocationParams {
  contractId?: string;
  method?: string;
  sourceAccount?: string;
  args?: unknown[];
  sequence?: string;
  fee?: string;
  networkPassphrase?: string;
  jsonOutput?: boolean;
}

export interface PreparedInvocation {
  contractId: string;
  method: string;
  source: string;
  sequence: string;
  fee: string;
  networkPassphrase: string;
  encodedArgs: Array<{ index: number; jsType: string; scValType: string; xdr: string }>;
  operationType: string;
  envelopeXdr: string;
  transactionHash: string;
}

const DEMO_CONTRACT_ID = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';
const DEMO_SOURCE = 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI';

/**
 * Converts a plain JavaScript value into a Soroban `ScVal`.
 *
 * Strings that look like Stellar addresses or contract IDs become address
 * values; everything else is inferred by the SDK's `nativeToScVal`.
 */
export function toScVal(value: unknown): xdr.ScVal {
  if (typeof value === 'string' && (StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value))) {
    return Address.fromString(value).toScVal();
  }
  if (value instanceof Uint8Array) {
    return nativeToScVal(value, { type: 'bytes' });
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    return nativeToScVal(value, { type: 'i32' });
  }
  return nativeToScVal(value);
}

/**
 * Builds a Soroban contract invocation transaction without submitting it.
 */
export function prepareInvocation(params: Required<Omit<InvocationParams, 'jsonOutput'>>): PreparedInvocation {
  const { contractId, method, sourceAccount, args, sequence, fee, networkPassphrase } = params;

  if (!StrKey.isValidContract(contractId)) {
    throw new Error(`Invalid contract ID: ${contractId}`);
  }
  if (!StrKey.isValidEd25519PublicKey(sourceAccount)) {
    throw new Error(`Invalid source account: ${sourceAccount}`);
  }
  if (!method || typeof method !== 'string') {
    throw new Error('A contract method name is required');
  }

  let scValArgs: xdr.ScVal[];
  try {
    scValArgs = args.map(toScVal);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not encode contract arguments: ${message}`);
  }

  const contract = new Contract(contractId);
  const operation = contract.call(method, ...scValArgs);

  const transaction = new TransactionBuilder(new Account(sourceAccount, sequence), {
    fee,
    networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(30)
    .build();

  return {
    contractId,
    method,
    source: sourceAccount,
    sequence: transaction.sequence,
    fee: transaction.fee,
    networkPassphrase,
    encodedArgs: scValArgs.map((scVal, index) => ({
      index,
      jsType: typeof args[index],
      scValType: scVal.switch().name,
      xdr: scVal.toXDR('base64'),
    })),
    operationType: 'invokeHostFunction',
    envelopeXdr: transaction.toXDR(),
    transactionHash: transaction.hash().toString('hex'),
  };
}

export function formatInvocation(prepared: PreparedInvocation): string {
  return [
    `Contract ID:   ${prepared.contractId}`,
    `Method:        ${prepared.method}`,
    `Source:        ${prepared.source}`,
    `Sequence:      ${prepared.sequence}`,
    `Fee:           ${prepared.fee} stroops`,
    `Operation:     ${prepared.operationType}`,
    '',
    'Encoded arguments:',
    ...prepared.encodedArgs.map(
      (arg) => `  [${arg.index}] ${arg.jsType} -> ${arg.scValType} (${arg.xdr})`,
    ),
    '',
    `Transaction hash: ${prepared.transactionHash}`,
    `Envelope XDR:     ${prepared.envelopeXdr}`,
    '',
    'This transaction was prepared only — it was not signed or submitted.',
  ].join('\n');
}

/**
 * Runs the Soroban contract invocation preparation example.
 */
export async function run(params: InvocationParams = {}): Promise<void> {
  const prepared = prepareInvocation({
    contractId: params.contractId || DEMO_CONTRACT_ID,
    method: params.method || 'increment',
    sourceAccount: params.sourceAccount || DEMO_SOURCE,
    args: params.args || ['hello', true, 42],
    sequence: params.sequence || '1',
    fee: params.fee || BASE_FEE,
    networkPassphrase: params.networkPassphrase || Networks.TESTNET,
  });

  if (params.jsonOutput) {
    console.log(JSON.stringify(prepared, null, 2));
    return;
  }

  console.log(formatInvocation(prepared));
}
