import {
  FeeBumpTransaction,
  Horizon,
  Keypair,
  Networks,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_BUMP_FEE = '500';

export interface FeeBumpWrappingParams {
  innerEnvelope?: string;
  feeSourceAccount?: string;
  bumpFee?: string;
  dryRun?: boolean | string;
  json?: boolean | string;
}

export interface InnerTransactionSnapshot {
  source: string;
  sequence: string;
  operationCount: number;
  operationXdr: string[];
  memo: string;
  timeBounds: string;
  signatureXdr: string[];
  hash: string;
}

export interface FeeBumpReport {
  dryRun: boolean;
  originalTransactionFee: string;
  feeBumpFee: string;
  feeSourceAccount: string;
  innerTransactionHash: string;
  feeBumpTransactionHash: string;
  inner: InnerTransactionSnapshot;
  wrappedInner: InnerTransactionSnapshot;
  innerUnchanged: {
    source: boolean;
    sequence: boolean;
    operations: boolean;
    memo: boolean;
    timeBounds: boolean;
    signatures: boolean;
  };
  outerSignatureCount: number;
  innerSignatureCount: number;
  feeBumpEnvelopeType: string;
  feeBumpEnvelopeXdr: string;
  signing: {
    attempted: boolean;
    signed: boolean;
    message: string;
  };
}

function wantsJson(params: FeeBumpWrappingParams): boolean {
  return (
    params.json === true ||
    params.json === 'true' ||
    process.env.JSON_OUTPUT === 'true' ||
    process.argv.includes('--json')
  );
}

function wantsDryRun(params: FeeBumpWrappingParams): boolean {
  return !(
    params.dryRun === false ||
    params.dryRun === 'false' ||
    process.env.DRY_RUN === 'false' ||
    process.argv.includes('--submit')
  );
}

function serializeOperations(transaction: Transaction): string[] {
  return transaction.operations.map((operation) => operation.toXDR('base64'));
}

function serializeMemo(transaction: Transaction): string {
  return transaction.memo.toXDR('base64');
}

function serializeTimeBounds(transaction: Transaction): string {
  const timeBounds = (transaction as unknown as { timeBounds?: unknown }).timeBounds;
  return JSON.stringify(timeBounds ?? null);
}

export function decodeInnerTransaction(
  encodedEnvelope: string,
  networkPassphrase: string = Networks.TESTNET,
): Transaction {
  if (!encodedEnvelope || typeof encodedEnvelope !== 'string') {
    throw new Error('The inner transaction envelope is required.');
  }

  try {
    const decoded = TransactionBuilder.fromXDR(encodedEnvelope.trim(), networkPassphrase);
    if (!(decoded instanceof Transaction)) {
      throw new Error('Expected a standard Transaction envelope, but received a fee-bump envelope.');
    }
    return decoded;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid base64 Stellar transaction envelope: ${message}`);
  }
}

export function snapshotTransaction(transaction: Transaction): InnerTransactionSnapshot {
  return {
    source: transaction.source,
    sequence: transaction.sequence,
    operationCount: transaction.operations.length,
    operationXdr: serializeOperations(transaction),
    memo: serializeMemo(transaction),
    timeBounds: serializeTimeBounds(transaction),
    signatureXdr: transaction.signatures.map((signature) => signature.toXDR('base64')),
    hash: transaction.hash().toString('hex'),
  };
}

function compareSnapshots(
  before: InnerTransactionSnapshot,
  after: InnerTransactionSnapshot,
): FeeBumpReport['innerUnchanged'] {
  return {
    source: before.source === after.source,
    sequence: before.sequence === after.sequence,
    operations:
      before.operationCount === after.operationCount &&
      JSON.stringify(before.operationXdr) === JSON.stringify(after.operationXdr),
    memo: before.memo === after.memo,
    timeBounds: before.timeBounds === after.timeBounds,
    signatures: JSON.stringify(before.signatureXdr) === JSON.stringify(after.signatureXdr),
  };
}

export function wrapAndInspectFeeBump(
  innerTransaction: Transaction,
  feeSourceAccount: string,
  bumpFee: string,
  dryRun = true,
): { feeBump: FeeBumpTransaction; report: FeeBumpReport } {
  if (!feeSourceAccount || !/^G[A-Z2-7]{55}$/.test(feeSourceAccount)) {
    throw new Error('The fee-source account must be a valid Stellar G... account ID.');
  }
  if (!/^\d+$/.test(bumpFee) || Number(bumpFee) < 1) {
    throw new Error('The fee-bump fee must be a positive integer number of stroops.');
  }

  const before = snapshotTransaction(innerTransaction);
  const feeBump = TransactionBuilder.buildFeeBumpTransaction(
    feeSourceAccount,
    bumpFee,
    innerTransaction,
    Networks.TESTNET,
  );
  const wrappedInner = feeBump.innerTransaction;
  const after = snapshotTransaction(wrappedInner);
  const feeBumpEnvelopeXdr = feeBump.toXDR();

  const report: FeeBumpReport = {
    dryRun,
    originalTransactionFee: innerTransaction.fee,
    feeBumpFee: feeBump.fee,
    feeSourceAccount,
    innerTransactionHash: innerTransaction.hash().toString('hex'),
    feeBumpTransactionHash: feeBump.hash().toString('hex'),
    inner: before,
    wrappedInner: after,
    innerUnchanged: compareSnapshots(before, after),
    outerSignatureCount: feeBump.signatures.length,
    innerSignatureCount: wrappedInner.signatures.length,
    feeBumpEnvelopeType: feeBump.toEnvelope().switch().name,
    feeBumpEnvelopeXdr,
    signing: {
      attempted: false,
      signed: false,
      message: 'Fee-bump signing has not been attempted.',
    },
  };

  return { feeBump, report };
}

export function signFeeBump(
  feeBump: FeeBumpTransaction,
  feeSourceSecret: string,
  expectedFeeSource: string,
): FeeBumpReport['signing'] {
  try {
    const keypair = Keypair.fromSecret(feeSourceSecret);
    if (keypair.publicKey() !== expectedFeeSource) {
      return {
        attempted: true,
        signed: false,
        message: 'Fee-source secret does not match the configured fee-source account.',
      };
    }
    feeBump.sign(keypair);
    return {
      attempted: true,
      signed: true,
      message: 'Fee-bump envelope signed; the inner signatures were not modified.',
    };
  } catch (error) {
    return {
      attempted: true,
      signed: false,
      message: `Fee-source signing failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function formatFeeBumpReport(report: FeeBumpReport): string {
  const unchanged = Object.values(report.innerUnchanged).every(Boolean);
  const lines = [
    '=== Stellar Fee-Bump Wrapping and Validation ===',
    `Dry run: ${report.dryRun ? 'YES' : 'NO'}`,
    `Original transaction fee: ${report.originalTransactionFee} stroops`,
    `Fee-bump fee: ${report.feeBumpFee} stroops per operation`,
    `Fee-source account: ${report.feeSourceAccount}`,
    `Inner transaction hash: ${report.innerTransactionHash}`,
    `Fee-bump transaction hash: ${report.feeBumpTransactionHash}`,
    '',
    `Inner source: ${report.inner.source}`,
    `Sequence number: ${report.inner.sequence}`,
    `Operation count: ${report.inner.operationCount}`,
    `Memo preserved: ${report.innerUnchanged.memo ? 'YES' : 'NO'}`,
    `Time bounds preserved: ${report.innerUnchanged.timeBounds ? 'YES' : 'NO'}`,
    `Inner signatures: ${report.innerSignatureCount}`,
    `Outer signatures: ${report.outerSignatureCount}`,
    `Inner transaction unchanged: ${unchanged ? 'YES' : 'NO'}`,
    `Signing: ${report.signing.message}`,
    '',
    'Fee-bump envelope XDR:',
    report.feeBumpEnvelopeXdr,
    '',
    'A fee bump changes the fee payer and outer envelope only. The original operations, source, sequence, memo, time bounds, and signatures remain inside the inner transaction.',
    'No transaction was submitted by this example.',
  ];
  return lines.join('\n');
}

export async function run(params: FeeBumpWrappingParams = {}): Promise<void> {
  const encodedEnvelope =
    params.innerEnvelope?.trim() || process.env.INNER_ENVELOPE_XDR?.trim() || process.argv[3]?.trim();
  const feeSourceAccount =
    params.feeSourceAccount?.trim() || process.env.FEE_SOURCE_ACCOUNT?.trim() || process.argv[4]?.trim();
  const bumpFee = params.bumpFee?.trim() || process.env.FEE_BUMP_BASE_FEE?.trim() || process.argv[5]?.trim() || DEFAULT_BUMP_FEE;
  const json = wantsJson(params);
  const dryRun = wantsDryRun(params);

  try {
    if (!dryRun) {
      throw new Error('Submission is intentionally disabled; use dry-run mode to inspect and sign safely.');
    }
    if (!encodedEnvelope) throw new Error('Provide a base64-encoded inner transaction envelope.');
    if (!feeSourceAccount) throw new Error('Provide an existing fee-source account ID.');

    const server = new Horizon.Server(process.env.HORIZON_URL || DEFAULT_HORIZON_URL);
    await server.loadAccount(feeSourceAccount);
    const innerTransaction = decodeInnerTransaction(encodedEnvelope);
    const { feeBump, report } = wrapAndInspectFeeBump(
      innerTransaction,
      feeSourceAccount,
      bumpFee,
      dryRun,
    );

    const feeSourceSecret = process.env.FEE_SOURCE_SECRET?.trim();
    if (feeSourceSecret) report.signing = signFeeBump(feeBump, feeSourceSecret, feeSourceAccount);
    if (json) console.log(JSON.stringify(report, null, 2));
    else console.log(formatFeeBumpReport(report));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) console.log(JSON.stringify({ error: 'Unable to wrap fee-bump transaction', message }, null, 2));
    else console.error(`Unable to wrap fee-bump transaction: ${message}`);
  }
}
