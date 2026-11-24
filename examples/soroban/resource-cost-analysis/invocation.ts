/**
 * Step 1 and 2: validate the invocation config and build an UNSIGNED transaction.
 *
 * Nothing here talks to a simulator, signs, or submits. The built transaction has no Soroban data
 * yet (no footprint or resource fee): that is exactly what simulation supplies.
 */
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Networks,
  StrKey,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';
import { ArgSpec, CostAnalysisError, InvocationConfig, NetworkName, ValidatedInvocation } from './types';

const PASSPHRASES: Record<NetworkName, string> = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
  futurenet: Networks.FUTURENET,
};

/** Convenience public endpoints. Mainnet has none baked in: choose a provider deliberately. */
const DEFAULT_RPC: Partial<Record<NetworkName, string>> = {
  testnet: 'https://soroban-testnet.stellar.org',
  futurenet: 'https://rpc-futurenet.stellar.org',
};

export const DEFAULT_WARN_RATIO = 0.8;

// Soroban function names are symbols: up to 32 chars of [A-Za-z0-9_].
const FUNCTION_NAME = /^[A-Za-z0-9_]{1,32}$/;

export function networkPassphrase(network: NetworkName): string {
  const p = PASSPHRASES[network];
  if (!p) throw new CostAnalysisError('INVALID_NETWORK', `Unknown network "${network}". Use testnet, mainnet or futurenet.`);
  return p;
}

function parseInteger(type: string, raw: string | boolean): bigint {
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw.trim())) {
    throw new CostAnalysisError('INVALID_ARGUMENTS', `Argument of type ${type} needs a base-10 integer string, got ${JSON.stringify(raw)}.`);
  }
  const n = BigInt(raw.trim());
  const bits = Number(type.slice(1));
  const signed = type.startsWith('i');
  const min = signed ? -(1n << BigInt(bits - 1)) : 0n;
  const max = signed ? (1n << BigInt(bits - 1)) - 1n : (1n << BigInt(bits)) - 1n;
  if (n < min || n > max) {
    throw new CostAnalysisError('INVALID_ARGUMENTS', `Value ${n} is out of range for ${type} (${min}..${max}).`);
  }
  return n;
}

/** Convert one typed argument to an ScVal. Integers go through bigint, never `number`. */
export function argToScVal(arg: ArgSpec): xdr.ScVal {
  switch (arg.type) {
    case 'bool':
      if (typeof arg.value === 'boolean') return xdr.ScVal.scvBool(arg.value);
      if (arg.value === 'true' || arg.value === 'false') return xdr.ScVal.scvBool(arg.value === 'true');
      throw new CostAnalysisError('INVALID_ARGUMENTS', `bool argument must be true or false, got ${JSON.stringify(arg.value)}.`);
    case 'u32':
    case 'i32':
    case 'u64':
    case 'i64':
    case 'u128':
    case 'i128':
    case 'u256':
    case 'i256':
      return nativeToScVal(parseInteger(arg.type, arg.value), { type: arg.type });
    case 'string':
      return nativeToScVal(String(arg.value), { type: 'string' });
    case 'symbol':
      return nativeToScVal(String(arg.value), { type: 'symbol' });
    case 'address': {
      const v = String(arg.value);
      if (!StrKey.isValidEd25519PublicKey(v) && !StrKey.isValidContract(v)) {
        throw new CostAnalysisError('INVALID_ARGUMENTS', `address argument is not a valid G... or C... address: ${v}`);
      }
      return new Address(v).toScVal();
    }
    case 'bytes': {
      const v = String(arg.value);
      if (!/^([0-9a-fA-F]{2})*$/.test(v)) {
        throw new CostAnalysisError('INVALID_ARGUMENTS', 'bytes argument must be an even-length hex string.');
      }
      return xdr.ScVal.scvBytes(Buffer.from(v, 'hex'));
    }
    default:
      throw new CostAnalysisError('INVALID_ARGUMENTS', `Unsupported argument type "${(arg as ArgSpec).type}".`);
  }
}

/** Validate every required input and convert the arguments. Throws CostAnalysisError. */
export function validateInvocation(config: InvocationConfig): ValidatedInvocation {
  const passphrase = networkPassphrase(config.network);

  const rpcUrl = config.rpcUrl ?? DEFAULT_RPC[config.network];
  if (!rpcUrl) {
    throw new CostAnalysisError('INVALID_RPC_URL', `No default RPC endpoint for ${config.network}; pass rpcUrl explicitly.`);
  }
  try {
    new URL(rpcUrl);
  } catch {
    throw new CostAnalysisError('INVALID_RPC_URL', `rpcUrl is not a valid URL: ${rpcUrl}`);
  }

  if (!config.contractId || !StrKey.isValidContract(config.contractId)) {
    throw new CostAnalysisError('INVALID_CONTRACT_ADDRESS', `Not a valid contract address (expected C..., 56 chars): ${config.contractId}`);
  }
  if (!config.sourceAccount || !StrKey.isValidEd25519PublicKey(config.sourceAccount)) {
    throw new CostAnalysisError('INVALID_SOURCE_ACCOUNT', `Not a valid source account public key (G...): ${config.sourceAccount}`);
  }
  if (!config.functionName || !FUNCTION_NAME.test(config.functionName)) {
    throw new CostAnalysisError('INVALID_FUNCTION_NAME', `Function name must be 1-32 chars of [A-Za-z0-9_]: ${JSON.stringify(config.functionName)}`);
  }

  const inclusionFee = config.inclusionFee ?? BASE_FEE;
  if (!/^\d+$/.test(inclusionFee) || BigInt(inclusionFee) <= 0n) {
    throw new CostAnalysisError('INVALID_ARGUMENTS', `inclusionFee must be a positive integer number of stroops: ${inclusionFee}`);
  }

  const warnRatio = config.warnRatio ?? DEFAULT_WARN_RATIO;
  if (!(warnRatio > 0 && warnRatio <= 1)) {
    throw new CostAnalysisError('INVALID_ARGUMENTS', `warnRatio must be in (0, 1], got ${warnRatio}`);
  }

  return {
    network: config.network,
    networkPassphrase: passphrase,
    rpcUrl,
    contractId: config.contractId,
    functionName: config.functionName,
    args: (config.args ?? []).map(argToScVal),
    sourceAccount: config.sourceAccount,
    inclusionFee,
    warnRatio,
  };
}

/**
 * Build the unsigned invocation transaction. The caller supplies the source account's current
 * sequence number (fetched separately), so this function stays pure and testable.
 */
export function buildInvocationTransaction(inv: ValidatedInvocation, sequence: string): Transaction {
  const account = new Account(inv.sourceAccount, sequence);
  return new TransactionBuilder(account, { fee: inv.inclusionFee, networkPassphrase: inv.networkPassphrase })
    .addOperation(new Contract(inv.contractId).call(inv.functionName, ...inv.args))
    .setTimeout(300)
    .build();
}
