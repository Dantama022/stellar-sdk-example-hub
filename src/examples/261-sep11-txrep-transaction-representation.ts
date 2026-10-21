import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

const MAX_INT64 = 9_223_372_036_854_775_807n;
const MAX_UINT32 = 4_294_967_295n;
const STROOPS_PER_XLM = 10_000_000n;

const TXREP_FIELDS = [
  'type',
  'tx.sourceAccount',
  'tx.fee',
  'tx.seqNum',
  'tx.cond.type',
  'tx.cond.timeBounds.minTime',
  'tx.cond.timeBounds.maxTime',
  'tx.memo.type',
  'tx.operations.len',
  'tx.operations[0].sourceAccount._present',
  'tx.operations[0].body.type',
  'tx.operations[0].body.paymentOp.destination',
  'tx.operations[0].body.paymentOp.asset',
  'tx.operations[0].body.paymentOp.amount',
  'tx.ext.v',
  'signatures.len',
] as const;

type TxrepField = (typeof TXREP_FIELDS)[number];

function fail(message: string): never {
  throw new Error(`Unsupported or invalid SEP-11 Txrep payment: ${message}`);
}

function validateUnsignedPayment(transaction: Transaction): void {
  const envelope = transaction.toEnvelope();
  if (envelope.switch().name !== 'envelopeTypeTx') {
    fail('only classic V1 transaction envelopes are supported.');
  }

  const v1 = envelope.v1();
  if (v1.signatures().length !== 0) {
    fail('the example profile accepts unsigned envelopes only.');
  }

  const tx = v1.tx();
  if (tx.cond().switch().name !== 'precondTime') {
    fail('only the zero-timeout PRECOND_TIME form is supported.');
  }
  const timeBounds = tx.cond().timeBounds();
  if (timeBounds.minTime().toString() !== '0' || timeBounds.maxTime().toString() !== '0') {
    fail('non-zero transaction time bounds are outside this example profile.');
  }
  if (tx.memo().switch().name !== 'memoNone') {
    fail('transactions with a memo are outside this example profile.');
  }
  if (tx.operations().length !== 1) {
    fail('exactly one operation is required.');
  }
  if (tx.operations()[0].sourceAccount() != null) {
    fail('operation-specific source accounts are outside this example profile.');
  }
  if (tx.operations()[0].body().switch().name !== 'payment') {
    fail('the only supported operation is PAYMENT.');
  }
  if (tx.operations()[0].body().paymentOp().asset().switch().name !== 'assetTypeNative') {
    fail('the only supported asset is native XLM.');
  }
  if (tx.ext().switch() !== 0) {
    fail('unsupported transaction extension.');
  }
  if (!StrKey.isValidEd25519PublicKey(transaction.source)) {
    fail('the source must be an Ed25519 account ID.');
  }

  const payment = transaction.operations[0];
  if (
    payment.type !== 'payment' ||
    payment.asset.code !== 'XLM' ||
    !StrKey.isValidEd25519PublicKey(payment.destination)
  ) {
    fail('the operation must be a native XLM payment to an Ed25519 account.');
  }
}

/** Encode the intentionally small, normalized Txrep profile used in this example. */
export function transactionToTxrep(transaction: Transaction): string {
  validateUnsignedPayment(transaction);

  const tx = transaction.toEnvelope().v1().tx();
  const timeBounds = tx.cond().timeBounds();
  const payment = transaction.operations[0];
  if (payment.type !== 'payment') fail('the only supported operation is PAYMENT.');
  const paymentXdr = tx.operations()[0].body().paymentOp();
  const values: Record<TxrepField, string> = {
    type: 'ENVELOPE_TYPE_TX',
    'tx.sourceAccount': transaction.source,
    'tx.fee': String(tx.fee()),
    'tx.seqNum': tx.seqNum().toString(),
    'tx.cond.type': 'PRECOND_TIME',
    'tx.cond.timeBounds.minTime': timeBounds.minTime().toString(),
    'tx.cond.timeBounds.maxTime': timeBounds.maxTime().toString(),
    'tx.memo.type': 'MEMO_NONE',
    'tx.operations.len': '1',
    'tx.operations[0].sourceAccount._present': 'false',
    'tx.operations[0].body.type': 'PAYMENT',
    'tx.operations[0].body.paymentOp.destination': payment.destination,
    'tx.operations[0].body.paymentOp.asset': 'TestXLM',
    'tx.operations[0].body.paymentOp.amount': paymentXdr.amount().toString(),
    'tx.ext.v': '0',
    'signatures.len': '0',
  };

  return TXREP_FIELDS.map((field) => `${field}: ${values[field]}`).join('\n');
}

function parseUnsignedInteger(value: string, field: string, max: bigint): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    fail(`${field} must be an unsigned decimal integer.`);
  }
  const parsed = BigInt(value);
  if (parsed > max) fail(`${field} is out of range.`);
  return parsed;
}

function parseTxrepFields(txrep: string): Map<string, string> {
  if (typeof txrep !== 'string' || txrep.trim().length === 0) {
    fail('input must be a non-empty string.');
  }

  const knownFields = new Set<string>(TXREP_FIELDS);
  const values = new Map<string, string>();
  for (const [index, rawLine] of txrep.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    if (separator < 1) fail(`line ${index + 1} is missing a field separator.`);

    const field = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!knownFields.has(field)) fail(`field "${field}" is outside this example profile.`);
    if (value.length === 0) fail(`field "${field}" has no value.`);

    // Txrep specifies that later occurrences of a field replace earlier ones.
    values.set(field, value);
  }

  for (const field of TXREP_FIELDS) {
    if (!values.has(field)) fail(`required field "${field}" is missing.`);
  }
  return values;
}

function stroopsToXlm(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_XLM;
  const fraction = (stroops % STROOPS_PER_XLM).toString().padStart(7, '0');
  return `${whole}.${fraction}`;
}

/** Parse the supported Txrep profile and rebuild it with SDK v13 transaction APIs. */
export function transactionFromTxrep(txrep: string): Transaction {
  const fields = parseTxrepFields(txrep);
  const get = (field: TxrepField): string => fields.get(field)!;

  if (get('type') !== 'ENVELOPE_TYPE_TX') fail('expected ENVELOPE_TYPE_TX.');
  if (get('tx.cond.type') !== 'PRECOND_TIME') fail('expected PRECOND_TIME.');
  if (get('tx.cond.timeBounds.minTime') !== '0' || get('tx.cond.timeBounds.maxTime') !== '0') {
    fail('only zero transaction time bounds are supported.');
  }
  if (get('tx.memo.type') !== 'MEMO_NONE') fail('expected MEMO_NONE.');
  if (get('tx.operations.len') !== '1') fail('expected exactly one operation.');
  if (get('tx.operations[0].sourceAccount._present') !== 'false') {
    fail('operation-specific source account must be absent.');
  }
  if (get('tx.operations[0].body.type') !== 'PAYMENT') fail('expected PAYMENT.');
  if (get('tx.operations[0].body.paymentOp.asset') !== 'TestXLM') {
    fail('the asset must use the normalized TestXLM representation.');
  }
  if (get('tx.ext.v') !== '0' || get('signatures.len') !== '0') {
    fail('only extension version 0 and no signatures are supported.');
  }

  const source = get('tx.sourceAccount');
  const destination = get('tx.operations[0].body.paymentOp.destination');
  if (!StrKey.isValidEd25519PublicKey(source) || !StrKey.isValidEd25519PublicKey(destination)) {
    fail('source and destination must be valid Ed25519 account IDs.');
  }

  const fee = parseUnsignedInteger(get('tx.fee'), 'tx.fee', MAX_UINT32);
  const sequence = parseUnsignedInteger(get('tx.seqNum'), 'tx.seqNum', MAX_INT64);
  const amount = parseUnsignedInteger(
    get('tx.operations[0].body.paymentOp.amount'),
    'payment amount',
    MAX_INT64,
  );
  if (sequence < 1n) fail('tx.seqNum must be positive.');
  if (amount < 1n) fail('payment amount must be positive.');

  try {
    return new TransactionBuilder(new Account(source, (sequence - 1n).toString()), {
      fee: fee.toString(),
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination,
          asset: Asset.native(),
          amount: stroopsToXlm(amount),
        }),
      )
      .setTimeout(0)
      .build();
  } catch (error) {
    fail(
      `SDK could not construct the transaction: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function buildDeterministicPayment(): Transaction {
  const source = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x11));
  const destination = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x22));
  return new TransactionBuilder(new Account(source.publicKey(), '7'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: destination.publicKey(),
        asset: Asset.native(),
        amount: '1.25',
      }),
    )
    .setTimeout(0)
    .build();
}

export async function run(): Promise<void> {
  const transaction = buildDeterministicPayment();
  const txrep = transactionToTxrep(transaction);
  const reconstructed = transactionFromTxrep(txrep);
  const payment = reconstructed.operations[0];
  if (payment.type !== 'payment') fail('the reconstructed operation is not PAYMENT.');

  console.log('SEP-11 Txrep transaction-envelope representation');
  console.log('This example does not contact a signing service or submit a transaction.');
  console.log('\nNormalized Txrep (one unsigned Testnet native payment):');
  console.log(txrep);
  console.log('\nXDR round-trip:');
  console.log(
    `  Original and reconstructed envelope match: ${transaction.toXDR() === reconstructed.toXDR()}`,
  );
  console.log(`  Operation: ${payment.type} ${payment.amount} XLM`);
  console.log('  Signatures: none');
}
