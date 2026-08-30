import {
  Account,
  Asset,
  Horizon,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';

export interface MixedOperationParams {
  sourceAccount?: string;
  dryRun?: boolean | string;
  json?: boolean | string;
}

export interface OperationSummary {
  index: number;
  type: string;
  sourceAccount: string;
  description: string;
}

export interface MixedTransactionReport {
  dryRun: true;
  transactionSourceAccount: string;
  sequenceNumber: string;
  fee: string;
  operationCount: number;
  operationTypes: string[];
  operations: OperationSummary[];
  transactionHash: string;
  envelopeXdr: string;
  validation: {
    valid: boolean;
    message: string;
  };
  atomicity: string;
}

function wantsJson(params: MixedOperationParams): boolean {
  return (
    params.json === true ||
    params.json === 'true' ||
    process.env.JSON_OUTPUT === 'true' ||
    process.argv.includes('--json')
  );
}

function isDryRun(params: MixedOperationParams): boolean {
  return !(
    params.dryRun === false ||
    params.dryRun === 'false' ||
    process.env.DRY_RUN === 'false' ||
    process.argv.includes('--submit')
  );
}

function describeOperation(type: string): string {
  switch (type) {
    case 'payment':
      return 'Send 1 XLM to the generated destination account';
    case 'manageData':
      return 'Write a small account data entry';
    case 'bumpSequence':
      return 'Advance the operation source account sequence';
    default:
      return 'Operation-specific parameters are preserved in the shared envelope';
  }
}

export function buildMixedOperationTransaction(
  sourceAccount: Account,
  operationSourceA: string,
  operationSourceB: string,
  destination: string,
): Transaction {
  if (operationSourceA === operationSourceB) {
    throw new Error('Operation-specific source accounts must be distinct in this example.');
  }
  if (destination === sourceAccount.accountId()) {
    throw new Error('The generated payment destination must differ from the transaction source.');
  }

  return new TransactionBuilder(sourceAccount, {
    fee: '300',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        source: operationSourceA,
        destination,
        asset: Asset.native(),
        amount: '1',
      }),
    )
    .addOperation(
      Operation.manageData({
        source: operationSourceB,
        name: 'mixed-operation-demo',
        value: Buffer.from('dry-run'),
      }),
    )
    .addOperation(
      Operation.bumpSequence({
        source: sourceAccount.accountId(),
        bumpTo: (BigInt(sourceAccount.sequenceNumber()) + 1n).toString(),
      }),
    )
    .setTimeout(300)
    .build();
}

export function inspectMixedTransaction(transaction: Transaction): MixedTransactionReport {
  const envelopeXdr = transaction.toXDR('base64');
  let validation: MixedTransactionReport['validation'];

  try {
    const restored = new Transaction(envelopeXdr, Networks.TESTNET);
    validation = {
      valid: restored.operations.length === transaction.operations.length,
      message: `XDR round-trip decoded ${restored.operations.length} operation(s) from the shared envelope.`,
    };
  } catch (error) {
    validation = {
      valid: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const operations = transaction.operations.map((operation, index) => ({
    index: index + 1,
    type: operation.type,
    sourceAccount: operation.source || transaction.source,
    description: describeOperation(operation.type),
  }));

  return {
    dryRun: true,
    transactionSourceAccount: transaction.source,
    sequenceNumber: transaction.sequence,
    fee: transaction.fee,
    operationCount: operations.length,
    operationTypes: operations.map((operation) => operation.type),
    operations,
    transactionHash: transaction.hash().toString('hex'),
    envelopeXdr,
    validation,
    atomicity:
      'All operations share one transaction envelope and commit atomically: one failed operation causes the entire transaction to fail and rolls back every operation.',
  };
}

export function formatMixedTransactionReport(report: MixedTransactionReport): string {
  const lines = [
    '=== Stellar Mixed-Operation Transaction ===',
    `Transaction source account: ${report.transactionSourceAccount}`,
    `Sequence number: ${report.sequenceNumber}`,
    `Transaction fee: ${report.fee} stroops`,
    `Operation count: ${report.operationCount}`,
    `Operation types: ${report.operationTypes.join(', ')}`,
    `Transaction hash: ${report.transactionHash}`,
    '',
    'Operations:',
  ];

  for (const operation of report.operations) {
    lines.push(`  #${operation.index} ${operation.type}`);
    lines.push(`     Source account: ${operation.sourceAccount}`);
    lines.push(`     ${operation.description}`);
  }

  lines.push(
    '',
    'Envelope XDR:',
    report.envelopeXdr,
    '',
    `Validation: ${report.validation.valid ? 'PASSED' : 'FAILED'}`,
    report.validation.message,
    '',
    `Atomicity: ${report.atomicity}`,
    'Dry-run: no transaction was submitted. A real submission requires valid signatures for every operation source account.',
  );
  return lines.join('\n');
}

export async function run(params: MixedOperationParams = {}): Promise<void> {
  const sourceAccountId =
    params.sourceAccount?.trim() || process.env.SOURCE_ACCOUNT?.trim() || process.argv[3]?.trim();
  const json = wantsJson(params);

  try {
    if (!sourceAccountId) {
      throw new Error(
        'Provide SOURCE_ACCOUNT for an existing account on the selected Horizon network.',
      );
    }
    if (!isDryRun(params)) {
      throw new Error(
        'Submission is intentionally disabled; this example is inspection-only and supports dry-run mode.',
      );
    }

    const horizonUrl = process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
    const sourceAccount = await new Horizon.Server(horizonUrl).loadAccount(sourceAccountId);
    const operationSourceA = Keypair.random().publicKey();
    const operationSourceB = Keypair.random().publicKey();
    const destination = Keypair.random().publicKey();
    const transaction = buildMixedOperationTransaction(
      sourceAccount,
      operationSourceA,
      operationSourceB,
      destination,
    );
    const report = inspectMixedTransaction(transaction);
    console.log(json ? JSON.stringify(report, null, 2) : formatMixedTransactionReport(report));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      console.log(
        JSON.stringify({ error: 'Unable to build mixed-operation transaction', message }, null, 2),
      );
    } else {
      console.error(`Unable to build mixed-operation transaction: ${message}`);
    }
  }
}
