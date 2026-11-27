/**
 * Step 1 + 2: validate the transfer request and construct the (unsigned) invocation.
 *
 * Nothing in this file signs or submits anything.
 */
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Networks,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';
import { TransferError } from './types';

export type NetworkName = 'testnet' | 'mainnet';

export const NETWORKS: Record<NetworkName, { passphrase: string; defaultRpcUrl?: string }> = {
  testnet: { passphrase: Networks.TESTNET, defaultRpcUrl: 'https://soroban-testnet.stellar.org' },
  // No SDF-run public mainnet RPC exists: you must supply your own provider URL.
  mainnet: { passphrase: Networks.PUBLIC },
};

/** The token interface encodes amounts as signed 128-bit integers. */
export const I128_MAX = (1n << 127n) - 1n;

export interface TransferRequest {
  /** Explicit; there is deliberately no default so a transfer is never sent to the wrong network. */
  network?: string;
  rpcUrl?: string;
  token: string;
  sender: string;
  recipient: string;
  /** Amount in the token's smallest unit. Strings and bigints only: `number` loses precision. */
  amount: string | bigint;
  /** Account that pays fees and provides the sequence number. Defaults to the sender. */
  source?: string;
}

export interface TransferConfig {
  network: NetworkName;
  networkPassphrase: string;
  rpcUrl: string;
  token: string;
  sender: string;
  recipient: string;
  amount: bigint;
  source: string;
}

/** Balances can be held by accounts (G...) and contracts (C...). Muxed (M...) is not accepted. */
const isAddress = (a: unknown): a is string =>
  typeof a === 'string' && (StrKey.isValidEd25519PublicKey(a) || StrKey.isValidContract(a));

export function parseAmount(amount: unknown): bigint {
  if (typeof amount === 'number') {
    throw new TransferError(
      'INVALID_AMOUNT',
      'Amount must be a string or bigint: JavaScript numbers lose precision above 2^53.'
    );
  }
  let value: bigint;
  if (typeof amount === 'bigint') {
    value = amount;
  } else if (typeof amount === 'string' && /^-?\d+$/.test(amount.trim())) {
    value = BigInt(amount.trim());
  } else {
    throw new TransferError(
      'INVALID_AMOUNT',
      "Amount must be an integer in the token's smallest unit."
    );
  }
  if (value <= 0n) {
    throw new TransferError('INVALID_AMOUNT', 'Amount must be greater than zero.');
  }
  if (value > I128_MAX) {
    throw new TransferError('INVALID_AMOUNT', 'Amount exceeds the maximum i128 value.');
  }
  return value;
}

export function validateTransferRequest(req: TransferRequest): TransferConfig {
  if (!req.network) {
    throw new TransferError(
      'NETWORK_REQUIRED',
      'A network ("testnet" or "mainnet") must be chosen explicitly.'
    );
  }
  if (req.network !== 'testnet' && req.network !== 'mainnet') {
    throw new TransferError(
      'INVALID_NETWORK',
      `Unknown network "${req.network}". Use "testnet" or "mainnet".`
    );
  }
  const net = NETWORKS[req.network];
  const rpcUrl = req.rpcUrl ?? net.defaultRpcUrl;
  if (!rpcUrl) {
    throw new TransferError(
      'INVALID_NETWORK',
      `No default RPC endpoint for ${req.network}: provide rpcUrl.`
    );
  }

  if (typeof req.token !== 'string' || !StrKey.isValidContract(req.token)) {
    throw new TransferError(
      'INVALID_TOKEN_CONTRACT',
      'Token must be a contract address (C..., 56 characters).'
    );
  }
  if (!isAddress(req.sender)) {
    throw new TransferError(
      'INVALID_SENDER',
      'Sender must be an account (G...) or contract (C...) address.'
    );
  }
  if (!isAddress(req.recipient)) {
    throw new TransferError(
      'INVALID_RECIPIENT',
      'Recipient must be an account (G...) or contract (C...) address.'
    );
  }
  if (req.sender === req.recipient) {
    throw new TransferError('INVALID_RECIPIENT', 'Sender and recipient are the same address.');
  }
  if (req.recipient === req.token) {
    throw new TransferError(
      'INVALID_RECIPIENT',
      'Recipient is the token contract itself; tokens sent there are usually unrecoverable.'
    );
  }

  // A transaction source must be a classic account, so a contract sender needs a separate source.
  const source = req.source ?? req.sender;
  if (!StrKey.isValidEd25519PublicKey(source)) {
    throw new TransferError(
      'INVALID_SOURCE',
      'The transaction source must be an account (G...); provide `source` when the sender is a contract.'
    );
  }

  return {
    network: req.network,
    networkPassphrase: net.passphrase,
    rpcUrl,
    token: req.token,
    sender: req.sender,
    recipient: req.recipient,
    amount: parseAmount(req.amount),
    source,
  };
}

/** Arguments for the SEP-41 `transfer(from: Address, to: Address, amount: i128)` function. */
export function transferArgs(
  cfg: Pick<TransferConfig, 'sender' | 'recipient' | 'amount'>
): xdr.ScVal[] {
  return [
    new Address(cfg.sender).toScVal(),
    new Address(cfg.recipient).toScVal(),
    nativeToScVal(cfg.amount, { type: 'i128' }),
  ];
}

/**
 * Build the unsigned transfer transaction.
 *
 * `sequence` is the source account's CURRENT sequence number; the builder uses sequence + 1.
 * Passing `auth` pre-attaches (signed) authorization entries to the operation. Resource fees and
 * the Soroban footprint are NOT set here: they come from simulation (see simulation.ts).
 */
export function buildTransferTransaction(
  cfg: TransferConfig,
  sequence: string,
  auth?: xdr.SorobanAuthorizationEntry[]
): Transaction {
  const hostFn = new Contract(cfg.token)
    .call('transfer', ...transferArgs(cfg))
    .body()
    .invokeHostFunctionOp()
    .hostFunction();
  return new TransactionBuilder(new Account(cfg.source, sequence), {
    fee: BASE_FEE,
    networkPassphrase: cfg.networkPassphrase,
  })
    .addOperation(Operation.invokeHostFunction({ func: hostFn, auth: auth ?? [] }))
    .setTimeout(300)
    .build();
}
