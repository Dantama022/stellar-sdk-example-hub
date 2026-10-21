import { Account, Asset, FeeBumpTransaction, Keypair, Networks, Operation, StrKey, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';

export interface RelayerPolicy {
  networkPassphrase: string;
  allowedOperationTypes: string[];
  allowedDestinations: string[];
  maxFeeStroops: string;
  baseFeeStroops: string;
}

/** XDR does not encode network identity: the original network must come from trusted context. */
export function parseInner(xdr: string, trustedOriginalNetwork: string, expectedNetwork: string): Transaction {
  if (!xdr || trustedOriginalNetwork !== expectedNetwork || !expectedNetwork) {
    throw new Error('Missing transaction or trusted network context; cross-network sponsorship rejected');
  }
  try {
    const decoded = TransactionBuilder.fromXDR(xdr, expectedNetwork);
    if (!(decoded instanceof Transaction)) throw new Error('Fee-bump envelope cannot be sponsored as an inner transaction');
    return decoded;
  } catch {
    throw new Error('Invalid or unsupported inner transaction envelope');
  }
}

export function validatePolicy(policy: RelayerPolicy, feeSource: string): void {
  if (!policy.networkPassphrase?.trim()) throw new Error('Missing relayer network passphrase');
  if (!StrKey.isValidEd25519PublicKey(feeSource)) throw new Error('Invalid fee-source public key');
  if (!Array.isArray(policy.allowedOperationTypes) || policy.allowedOperationTypes.length === 0) throw new Error('No allowed operations configured');
  if (!Array.isArray(policy.allowedDestinations)) throw new Error('Invalid destination allowlist');
  if (!/^\d+$/.test(policy.maxFeeStroops) || BigInt(policy.maxFeeStroops) < 1n) throw new Error('Invalid max sponsored fee');
  if (!/^\d+$/.test(policy.baseFeeStroops) || BigInt(policy.baseFeeStroops) < 100n) throw new Error('Invalid fee bid (minimum 100 stroops)');
}

export function inspectInner(tx: Transaction, policy: RelayerPolicy): void {
  if (tx.networkPassphrase !== policy.networkPassphrase) throw new Error('Inner transaction network mismatch');
  if (!tx.signatures.length) throw new Error('Inner transaction has no signatures');
  if (!tx.operations.length) throw new Error('Inner transaction has no operations');
  for (const op of tx.operations) {
    if (!policy.allowedOperationTypes.includes(op.type)) throw new Error(`Operation blocked by relayer policy: ${op.type}`);
    if ('destination' in op && typeof op.destination === 'string' && !policy.allowedDestinations.includes(op.destination)) {
      throw new Error('Destination blocked by relayer policy');
    }
    if (!('destination' in op) && op.type === 'payment') throw new Error('Payment missing destination');
  }
  // Signature presence is not signature validity. Real relayers must verify signers and network state.
}

export function createSponsoredEnvelope(tx: Transaction, feeSource: string, policy: RelayerPolicy): FeeBumpTransaction {
  validatePolicy(policy, feeSource);
  inspectInner(tx, policy);
  let wrapped: FeeBumpTransaction;
  try {
    wrapped = TransactionBuilder.buildFeeBumpTransaction(feeSource, policy.baseFeeStroops, tx, policy.networkPassphrase);
  } catch { throw new Error('Could not construct fee-bump envelope'); }
  if (BigInt(wrapped.fee) > BigInt(policy.maxFeeStroops)) throw new Error('Sponsored fee exceeds relayer budget');
  return wrapped;
}

/** Prevent repeated requests in the same process. Durable relayers require an external transaction ledger. */
export class SponsorshipTracker {
  private readonly hashes = new Set<string>();
  reserve(hash: string): void {
    if (this.hashes.has(hash)) throw new Error('Transaction already reserved for sponsorship');
    this.hashes.add(hash);
  }
  release(hash: string): void { this.hashes.delete(hash); }
}

/** Signing is an explicit separate action; no private key exists in the default example. */
export function signOuter(tx: FeeBumpTransaction, signer: Keypair, configuredFeeSource: string): void {
  if (signer.publicKey() !== configuredFeeSource) throw new Error('Fee payer signer does not match configured fee-source');
  tx.sign(signer);
}

export async function submitSponsored(tx: FeeBumpTransaction, send: (transaction: FeeBumpTransaction) => Promise<{ hash: string }>): Promise<string> {
  if (tx.signatures.length === 0) throw new Error('Unsigned outer fee-bump envelope cannot be submitted');
  try {
    const response = await send(tx);
    if (!response || typeof response.hash !== 'string' || response.hash.length === 0) throw new Error('Missing confirmation hash');
    return response.hash;
  } catch { throw new Error('Fee-bump submission failed or status is uncertain; check network before retrying'); }
}

export async function run(): Promise<void> {
  const source = Keypair.random(); // disposable in-memory educational fixture
  const destination = Keypair.random().publicKey();
  const feeSource = Keypair.random().publicKey();
  const inner = new TransactionBuilder(new Account(source.publicKey(), '0'), {
    fee: '100', networkPassphrase: Networks.TESTNET,
  }).addOperation(Operation.payment({ destination, asset: Asset.native(), amount: '1' })).setTimeout(60).build();
  inner.sign(source); // fixture only; never submitted or associated with a funded account
  const policy: RelayerPolicy = {
    networkPassphrase: Networks.TESTNET,
    allowedOperationTypes: ['payment'], allowedDestinations: [destination],
    maxFeeStroops: '1000', baseFeeStroops: '200',
  };
  const candidate = parseInner(inner.toXDR(), Networks.TESTNET, Networks.TESTNET);
  const bump = createSponsoredEnvelope(candidate, feeSource, policy);
  console.log(`Inner source: ${candidate.source}; fee-paying account: ${feeSource}`);
  console.log(`Inner signatures: ${candidate.signatures.length}; outer signatures: ${bump.signatures.length}`);
  console.log(`Sponsored fee (stroops): ${bump.fee}; limit: ${policy.maxFeeStroops}`);
  console.log('Prepared an unsigned fee-bump envelope; no real signing or network submission performed.');
}
