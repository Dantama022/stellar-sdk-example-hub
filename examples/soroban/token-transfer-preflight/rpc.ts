/** The slice of the Soroban RPC server this example uses; trivial to mock in tests. */
import { Transaction, rpc } from '@stellar/stellar-sdk';
import { TransferError } from './types';

export interface TransferRpcClient {
  getNetwork(): Promise<{ passphrase: string }>;
  getLatestLedger(): Promise<{ sequence: number }>;
  /** Returns the account's current sequence number as a string. */
  getSequence(accountId: string): Promise<string>;
  simulateTransaction(tx: Transaction): Promise<rpc.Api.SimulateTransactionResponse>;
  sendTransaction(tx: Transaction): Promise<rpc.Api.SendTransactionResponse>;
  getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse>;
}

export function createRpcClient(rpcUrl: string): TransferRpcClient {
  const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
  return {
    getNetwork: () => server.getNetwork(),
    getLatestLedger: () => server.getLatestLedger(),
    getSequence: async (id) => (await server.getAccount(id)).sequenceNumber(),
    simulateTransaction: (tx) => server.simulateTransaction(tx),
    sendTransaction: (tx) => server.sendTransaction(tx),
    getTransaction: (hash) => server.getTransaction(hash),
  };
}

/** Wrap transport failures so callers can tell them from contract / transaction failures. */
export async function rpcCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new TransferError('RPC_UNAVAILABLE', `RPC request failed: ${(e as Error).message}`);
  }
}
