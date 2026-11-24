/**
 * Step 4: inspect and sign Soroban authorization entries.
 *
 * Why a transfer needs authorization: the token's `transfer(from, to, amount)` calls
 * `from.require_auth()`. The host then demands proof that `from` approved THIS invocation with
 * THESE arguments. That proof is a SorobanAuthorizationEntry, and there are two kinds:
 *
 *  - source-account credentials: `from` is also the transaction source. The transaction envelope
 *    signature covers the authorization, so there is nothing separate to sign.
 *  - address credentials: `from` is a different address from the source. The entry carries its
 *    own signature over (network, nonce, expiration ledger, invocation). That signature is NOT
 *    the transaction-envelope signature and the two are not interchangeable.
 *
 * Address credentials for a contract account (C...) are checked by that contract's `__check_auth`
 * function, so the signature format is defined by the account contract. This example only signs
 * for classic accounts (G...) and refuses to guess for contract accounts.
 */
import {
  Address,
  Keypair,
  authorizeEntry,
  hash,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { TransferConfig } from './transfer';
import { TransferError } from './types';

export interface AuthRequirement {
  kind: 'source-account' | 'address';
  /** Present for address credentials. */
  address?: string;
  /** Source-account entries count as signed: the envelope signature covers them. */
  signed: boolean;
  expiresAtLedger?: number;
  /** The root invocation is exactly token.transfer(sender, recipient, amount) from the config. */
  matchesTransfer: boolean;
  /** Nested authorized calls. A plain transfer has none. */
  subInvocations: number;
  problem?: string;
}

/** Signs authorization-entry preimages. Separate from the transaction-envelope signer. */
export interface AuthSigner {
  publicKey: string;
  sign(preimage: xdr.HashIdPreimage): Promise<Buffer | Uint8Array>;
}

/** Adapter for a local keypair. Hardware wallets or remote signers implement AuthSigner directly. */
export function keypairAuthSigner(keypair: Keypair): AuthSigner {
  return {
    publicKey: keypair.publicKey(),
    sign: async (preimage) => keypair.sign(hash(preimage.toXDR())),
  };
}

function matchesTransfer(
  entry: xdr.SorobanAuthorizationEntry,
  cfg: TransferConfig
): { ok: boolean; problem?: string } {
  const inv = entry.rootInvocation();
  const fn = inv.function();
  if (fn.switch().name !== 'sorobanAuthorizedFunctionTypeContractFn') {
    return { ok: false, problem: 'authorizes something other than a contract function call' };
  }
  const call = fn.contractFn();
  const target = Address.fromScAddress(call.contractAddress()).toString();
  const name = call.functionName().toString();
  if (target !== cfg.token || name !== 'transfer') {
    return { ok: false, problem: `authorizes ${target}.${name}, not ${cfg.token}.transfer` };
  }
  const args = call.args();
  try {
    const [from, to, amount] = [
      Address.fromScVal(args[0]).toString(),
      Address.fromScVal(args[1]).toString(),
      scValToNative(args[2]) as bigint,
    ];
    if (args.length !== 3 || from !== cfg.sender || to !== cfg.recipient || amount !== cfg.amount) {
      return { ok: false, problem: 'authorized arguments differ from the requested transfer' };
    }
  } catch {
    return { ok: false, problem: 'authorized arguments could not be decoded' };
  }
  return { ok: true };
}

/** Describe what each authorization entry needs, and whether it covers the intended transfer. */
export function inspectAuthEntries(
  entries: xdr.SorobanAuthorizationEntry[],
  cfg: TransferConfig
): AuthRequirement[] {
  return entries.map((entry): AuthRequirement => {
    const match = matchesTransfer(entry, cfg);
    const base = {
      matchesTransfer: match.ok,
      subInvocations: entry.rootInvocation().subInvocations().length,
      problem: match.problem,
    };
    const creds = entry.credentials();
    if (creds.switch().name === 'sorobanCredentialsSourceAccount') {
      return { kind: 'source-account', signed: true, ...base };
    }
    const addr = creds.address();
    return {
      kind: 'address',
      address: Address.fromScAddress(addr.address()).toString(),
      signed: addr.signature().switch().name !== 'scvVoid',
      expiresAtLedger: addr.signatureExpirationLedger(),
      ...base,
    };
  });
}

/**
 * Sign the unsigned address-credential entries that belong to `signer`.
 *
 * Entries for other addresses are returned untouched; preflight then reports them as missing
 * authorization rather than this function guessing. Throws for entries it must not sign.
 */
export async function signAuthEntries(
  entries: xdr.SorobanAuthorizationEntry[],
  cfg: TransferConfig,
  signer: AuthSigner | undefined,
  validUntilLedger: number
): Promise<xdr.SorobanAuthorizationEntry[]> {
  const reqs = inspectAuthEntries(entries, cfg);
  const out: xdr.SorobanAuthorizationEntry[] = [];

  for (let i = 0; i < entries.length; i++) {
    const req = reqs[i];
    if (req.kind === 'source-account' || req.signed) {
      out.push(entries[i]);
      continue;
    }
    // Never sign something that is not exactly the requested transfer.
    if (!req.matchesTransfer || req.subInvocations > 0) {
      throw new TransferError(
        'UNSUPPORTED_AUTHORIZATION',
        `Refusing to sign an authorization entry that ${req.problem ?? 'includes nested invocations'}.`
      );
    }
    if (req.address!.startsWith('C')) {
      throw new TransferError(
        'UNSUPPORTED_AUTHORIZATION',
        `${req.address} is a contract account. Its signature format is defined by the account contract's __check_auth, so it cannot be signed generically here.`
      );
    }
    if (!signer || signer.publicKey !== req.address) {
      out.push(entries[i]); // left unsigned on purpose; preflight will flag it
      continue;
    }
    try {
      out.push(
        await authorizeEntry(
          entries[i],
          // The SDK checks the returned signature against the payload before accepting it.
          async (preimage) => ({
            signature: await signer.sign(preimage),
            publicKey: signer.publicKey,
          }),
          validUntilLedger,
          cfg.networkPassphrase
        )
      );
    } catch (e) {
      const message = (e as Error).message;
      throw /doesn't match payload/.test(message)
        ? new TransferError('INVALID_SIGNATURE', `Authorization signature is invalid: ${message}`)
        : new TransferError('AUTH_SIGNING_FAILED', `Authorization signing failed: ${message}`);
    }
  }
  return out;
}
