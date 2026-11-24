/** Network configuration and address validation. */
import { Networks, StrKey } from '@stellar/stellar-sdk';
import { TokenInspectionError } from './types';

export type NetworkName = 'testnet' | 'mainnet';

export interface NetworkConfig {
  name: NetworkName;
  passphrase: string;
  defaultRpcUrl: string;
}

export const NETWORKS: Record<NetworkName, NetworkConfig> = {
  testnet: {
    name: 'testnet',
    passphrase: Networks.TESTNET,
    defaultRpcUrl: 'https://soroban-testnet.stellar.org',
  },
  // There is no SDF-run public mainnet RPC; this is a community endpoint.
  // Use --rpc-url / SOROBAN_RPC_URL with your own provider for real work.
  mainnet: {
    name: 'mainnet',
    passphrase: Networks.PUBLIC,
    defaultRpcUrl: 'https://mainnet.sorobanrpc.com',
  },
};

export function validateContractAddress(address: string): string {
  if (typeof address !== 'string' || !StrKey.isValidContract(address)) {
    throw new TokenInspectionError(
      'INVALID_CONTRACT_ADDRESS',
      'Expected a Soroban token contract address (56 characters, starting with "C").'
    );
  }
  return address;
}

/**
 * Token balances can be held by classic accounts (G...) and by contracts (C...).
 * Muxed (M...) addresses are not accepted: the token interface takes plain Address values.
 */
function isAccountOrContract(address: unknown): address is string {
  return (
    typeof address === 'string' &&
    (StrKey.isValidEd25519PublicKey(address) || StrKey.isValidContract(address))
  );
}

export function validateAccountAddress(address: string): string {
  if (!isAccountOrContract(address)) {
    throw new TokenInspectionError(
      'INVALID_ACCOUNT_ADDRESS',
      'Expected an account (G...) or contract (C...) address for the balance holder.'
    );
  }
  return address;
}

export function validateSpenderAddress(address: string): string {
  if (!isAccountOrContract(address)) {
    throw new TokenInspectionError(
      'INVALID_SPENDER_ADDRESS',
      'Expected an account (G...) or contract (C...) address for the spender.'
    );
  }
  return address;
}
