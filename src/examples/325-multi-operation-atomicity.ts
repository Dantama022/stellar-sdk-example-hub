/** ISSUE-325: Ordered classic operations: establish a trustline, then receive issuer payment. */
import { Account, Asset, Horizon, Keypair, Networks, Operation, StrKey, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';

export interface BatchInput {
  receiver: string;
  issuer: string;
  assetCode: string;
  amount: string;
  sequence: string;
  fee?: string;
}
export function validateBatch(input: BatchInput): void {
  if (!StrKey.isValidEd25519PublicKey(input.receiver) || !StrKey.isValidEd25519PublicKey(input.issuer)) {
    throw new Error('Receiver and issuer must be Stellar G-addresses');
  }
  if (input.receiver === input.issuer) throw new Error('Issuer and trustline receiver must be distinct');
  if (!/^[A-Za-z0-9]{1,12}$/.test(input.assetCode)) throw new Error('Asset code must have 1..12 alphanumeric characters');
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,7})?$/.test(input.amount) || Number(input.amount) <= 0) {
    throw new Error('Amount must be positive with at most seven decimal places');
  }
  if (!/^\d+$/.test(input.sequence)) throw new Error('Account sequence must be nonnegative integer');
  if (input.fee !== undefined && (!/^\d+$/.test(input.fee) || BigInt(input.fee) < 100n)) {
    throw new Error('Base fee must be at least 100 stroops per operation');
  }
}
export function validateOperationCount(count: number): void {
  // Classic Stellar transaction operation count limit is 100.
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('A transaction must have 1..100 operations');
}
export function buildBatch(input: BatchInput, minTime = 1000, maxTime = 1100): Transaction {
  validateBatch(input);
  validateOperationCount(2);
  if (!Number.isSafeInteger(minTime) || !Number.isSafeInteger(maxTime) || minTime < 0 || maxTime <= minTime) {
    throw new Error('Finite, ordered transaction time bounds are required');
  }
  const asset = new Asset(input.assetCode, input.issuer);
  const tx = new TransactionBuilder(new Account(input.receiver, input.sequence), {
    fee: input.fee || '100', networkPassphrase: Networks.TESTNET, timebounds: {minTime, maxTime},
  }).addOperation(Operation.changeTrust({asset}))
    .addOperation(Operation.payment({source: input.issuer, destination: input.receiver, asset, amount: input.amount}))
    .build();
  validateOperationCount(tx.operations.length);
  return tx;
}

export function describeAtomicity(tx: Transaction): { operations: string[]; atomic: true; signed: false } {
  return { operations: tx.operations.map((op) => op.type), atomic: true, signed: false };
}
export function classifySubmissionFailure(error: unknown): string {
  // Do not include raw HTTP response bodies, secrets or network headers.
  const candidate = error as {response?: {status?: number; data?: {extras?: {result_codes?: {transaction?: string; operations?: string[]}}}}};
  const codes = candidate?.response?.data?.extras?.result_codes;
  if (typeof codes?.transaction === 'string' && /^tx_[a-z_]+$/.test(codes.transaction)) {
    const ops = Array.isArray(codes.operations) ? codes.operations.filter((op) => /^op_[a-z_]+$/.test(op)) : [];
    return `Transaction rejected: ${codes.transaction}; operation result codes: ${ops.join(', ') || 'not provided'}`;
  }
  const status = candidate?.response?.status;
  return `Submission failed${typeof status === 'number' ? ` (HTTP ${status})` : ''}; inspect current ledger status before retrying`;
}

export async function submitTestnetOnly(
  config: { enabled: boolean; receiverSecret: string; issuerSecret: string; horizonUrl: string; amount: string; assetCode: string },
): Promise<{hash: string; successful: boolean}> {
  if (!config.enabled || process.env.ALLOW_TESTNET_MULTI_OP_SUBMIT !== 'true') {
    throw new Error('Submission disabled: set explicit config flag and ALLOW_TESTNET_MULTI_OP_SUBMIT=true');
  }
  if (!config.horizonUrl.startsWith('https://horizon-testnet.stellar.org')) {
    throw new Error('This demo only permits the official Stellar testnet Horizon');
  }
  // Secrets are supplied externally, never logged or persisted.
  const receiver = Keypair.fromSecret(config.receiverSecret);
  const issuer = Keypair.fromSecret(config.issuerSecret);
  const server = new Horizon.Server(config.horizonUrl);
  const account = await server.loadAccount(receiver.publicKey());
  const now = Math.floor(Date.now() / 1000);
  const tx = buildBatch({receiver: receiver.publicKey(), issuer: issuer.publicKey(),
    sequence: account.sequenceNumber(), amount: config.amount, assetCode: config.assetCode}, now, now + 120);
  tx.sign(receiver, issuer);
  try {
    const response = await server.submitTransaction(tx); // Exactly one submission; never auto-retries.
    if (!response.successful) throw new Error('Testnet transaction not successful');
    return {hash: response.hash, successful: response.successful};
  } catch (error) { throw new Error(classifySubmissionFailure(error)); }
}

export async function run(): Promise<void> {
  const receiver = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey();
  const issuer = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 8)).publicKey();
  const tx = buildBatch({receiver, issuer, amount: '3.5000000', assetCode: 'DEMO', sequence: '1'});
  console.log(JSON.stringify({ ...describeAtomicity(tx), submitted: false,
    notes: ['Trustline must be created before receiving the issued asset',
      'Issuer authorization is required for the issuer-sourced payment',
      'Both operations apply atomically on success; failed transactions can still charge fees and consume sequence']}, null, 2));
}
