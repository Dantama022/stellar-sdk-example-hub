/**
 * Read-only contract invocation via transaction simulation.
 *
 * A transaction is built but NEVER signed or submitted. `simulateTransaction` executes the
 * call against current ledger state and returns the result without changing anything.
 */
import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import { TokenInspectionError } from './types';

export type ContractExecutable = { type: 'wasm'; wasmHash: Buffer } | { type: 'stellar_asset' };

/** The slice of the RPC server this example uses; easy to mock in tests. */
export interface TokenRpcClient {
  getNetwork(): Promise<{ passphrase: string }>;
  simulateTransaction(tx: Transaction): Promise<rpc.Api.SimulateTransactionResponse>;
  /** Resolve the contract's executable, or null if the instance entry does not exist. */
  getContractExecutable(contractId: string): Promise<ContractExecutable | null>;
  getWasm(wasmHash: Buffer): Promise<Buffer>;
}

export function createRpcClient(rpcUrl: string): TokenRpcClient {
  const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
  return {
    getNetwork: () => server.getNetwork(),
    simulateTransaction: (tx) => server.simulateTransaction(tx),
    async getContractExecutable(contractId) {
      // Contract#getFootprint() is the key of the contract instance ledger entry.
      const { entries } = await server.getLedgerEntries(new Contract(contractId).getFootprint());
      if (!entries || entries.length === 0) return null;
      const executable = entries[0].val.contractData().val().instance().executable();
      return executable.switch().name === 'contractExecutableWasm'
        ? { type: 'wasm', wasmHash: Buffer.from(executable.wasmHash()) }
        : { type: 'stellar_asset' };
    },
    getWasm: (hash) => server.getContractWasmByHash(hash),
  };
}

export interface InvokeContext {
  client: TokenRpcClient;
  networkPassphrase: string;
  contractId: string;
}

/** Host message when a function name is not exported by the contract. */
const MISSING_FUNCTION = /non-existent contract function/i;

/** Wrap RPC transport failures so callers can tell them from contract failures. */
export async function rpcCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new TokenInspectionError('RPC_UNAVAILABLE', `RPC request failed: ${(e as Error).message}`);
  }
}

/** Invoke `method` read-only and return the raw ScVal result. */
export async function invokeReadOnly(
  ctx: InvokeContext,
  method: string,
  args: xdr.ScVal[]
): Promise<xdr.ScVal> {
  // Simulation does not require the source account to exist, so a throwaway public key is
  // enough. No secret key is ever generated or kept.
  const source = new Account(Keypair.random().publicKey(), '0');
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: ctx.networkPassphrase,
  })
    .addOperation(new Contract(ctx.contractId).call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await rpcCall(() => ctx.client.simulateTransaction(tx));

  if (rpc.Api.isSimulationError(sim)) {
    if (MISSING_FUNCTION.test(sim.error)) {
      throw new TokenInspectionError(
        'METHOD_NOT_FOUND',
        `The contract does not export a "${method}" function.`
      );
    }
    throw new TokenInspectionError(
      'INVOCATION_FAILED',
      `Simulating "${method}" failed: ${sim.error}`
    );
  }
  if (rpc.Api.isSimulationRestore(sim)) {
    throw new TokenInspectionError(
      'INVOCATION_FAILED',
      `Simulating "${method}" needs archived ledger entries restored first; this read-only example does not restore state.`
    );
  }
  const retval = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  if (!retval) {
    throw new TokenInspectionError('UNEXPECTED_RETURN_TYPE', `"${method}" returned no value.`);
  }
  return retval;
}
