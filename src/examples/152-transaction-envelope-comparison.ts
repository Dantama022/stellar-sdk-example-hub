import { TransactionBuilder, Keypair, Networks, xdr, Account } from '@stellar/stellar-sdk';

/**
 * Example 152: Transaction Envelope Comparison
 *
 * When debugging transaction-building issues, developers often need to compare two Stellar
 * transaction envelopes and identify exactly what changed. Comparing base64 XDR strings
 * directly is difficult because even a small change can produce a completely different
 * encoded representation.
 *
 * This example decodes two Stellar transaction envelopes and produces a structured
 * field-by-field comparison using the Stellar JavaScript/TypeScript SDK. It identifies
 * meaningful differences in transaction payloads, operations, fees, memos, sequence
 * numbers, and signatures.
 */

interface TransactionDetails {
  envelopeType: string;
  sourceAccount: string;
  fee: string;
  sequence: string;
  memo: {
    type: string;
    value?: string | null;
  };
  operationCount: number;
  operations: Array<{
    index: number;
    type: string;
    details: Record<string, unknown>;
  }>;
  signatureCount: number;
  signatures: Array<{
    index: number;
    hint: string;
  }>;
  network: string;
  timeBounds?: {
    minTime: string;
    maxTime: string;
  };
}

interface ComparisonResult {
  envelope1: TransactionDetails;
  envelope2: TransactionDetails;
  differences: string[];
}

function decodeTransactionEnvelope(envelopeXdr: string): TransactionDetails {
  try {
    // Parse the base64-encoded XDR
    const envelope = xdr.TransactionEnvelope.fromXDR(envelopeXdr, 'base64');

    // Get the envelope type
    const envelopeType = envelope.switch().name;

    let txDetails: TransactionDetails;

    if (envelope.isVariant('txTypeV1')) {
      const tx = envelope.v1()?.tx();
      if (!tx) throw new Error('Invalid transaction structure');

      txDetails = extractTransactionV1Details(tx, envelopeType, envelope);
    } else if (envelope.isVariant('txTypeTxFeeBump')) {
      const feeBump = envelope.feeBump()?.tx();
      if (!feeBump) throw new Error('Invalid fee bump transaction structure');

      txDetails = extractFeeBumpTransactionDetails(feeBump, envelopeType, envelope);
    } else {
      throw new Error(`Unknown envelope type: ${envelopeType}`);
    }

    return txDetails;
  } catch (error) {
    throw new Error(`Failed to decode transaction envelope: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function extractTransactionV1Details(
  tx: xdr.Transaction,
  envelopeType: string,
  envelope: xdr.TransactionEnvelope,
): TransactionDetails {
  const sourceAccount = tx.sourceAccount().accountId().ed25519().toString('hex');
  const sourceAccountStr = Keypair.fromPublicKey(
    Buffer.from(sourceAccount, 'hex').toString('base64'),
  ).publicKey();

  // Extract fee
  const fee = tx.fee().toString();

  // Extract sequence number
  const sequence = tx.seqNum().toString();

  // Extract memo
  const memoDetails = extractMemoDetails(tx.memo());

  // Extract operations
  const operations = tx.operations().map((op, index) => ({
    index,
    type: op.body().switch().name,
    details: extractOperationDetails(op),
  }));

  // Extract signatures from envelope
  const signatureCount = envelope.v1()?.signatures().length || 0;
  const signatures = (envelope.v1()?.signatures() || []).map((sig, index) => ({
    index,
    hint: sig.hint().toString('hex'),
  }));

  // Extract time bounds
  const timeBounds = tx.timeBounds();
  const timeBoundsDetails =
    timeBounds && timeBounds.minTime().toNumber() !== 0
      ? {
          minTime: timeBounds.minTime().toString(),
          maxTime: timeBounds.maxTime().toString(),
        }
      : undefined;

  // Extract network
  const network = extractNetworkPassphrase(tx);

  return {
    envelopeType,
    sourceAccount: sourceAccountStr,
    fee,
    sequence,
    memo: memoDetails,
    operationCount: operations.length,
    operations,
    signatureCount,
    signatures,
    network,
    timeBounds: timeBoundsDetails,
  };
}

function extractFeeBumpTransactionDetails(
  feeBump: xdr.FeeBumpTransaction,
  envelopeType: string,
  envelope: xdr.TransactionEnvelope,
): TransactionDetails {
  const innerTx = feeBump.innerTx();

  let details: TransactionDetails;

  if (innerTx.isVariant('txTypeV1')) {
    const tx = innerTx.v1();
    if (!tx) throw new Error('Invalid inner transaction');
    details = extractTransactionV1Details(tx, envelopeType, envelope);
  } else {
    throw new Error('Unsupported inner transaction type in fee bump');
  }

  // Override fee for fee bump
  details.fee = feeBump.fee().toString();

  return details;
}

function extractMemoDetails(memo: xdr.Memo): TransactionDetails['memo'] {
  const memoType = memo.switch().name;

  switch (memoType) {
    case 'memoTypeNone':
      return { type: 'NONE' };
    case 'memoTypeId':
      return { type: 'ID', value: memo.id()?.toString() };
    case 'memoTypeHash':
      return { type: 'HASH', value: memo.hash()?.toString('base64') };
    case 'memoTypeReturn':
      return { type: 'RETURN', value: memo.retHash()?.toString('base64') };
    case 'memoTypeText':
      return { type: 'TEXT', value: memo.text()?.toString() };
    default:
      return { type: 'UNKNOWN' };
  }
}

function extractOperationDetails(op: xdr.Operation): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  const body = op.body();

  // Extract destination for operations that have it
  if (body.isVariant('createAccountOp')) {
    const createAccountOp = body.createAccountOp();
    if (createAccountOp) {
      details.destination = Keypair.fromPublicKey(
        Buffer.from(createAccountOp.destination().accountId().ed25519().toString('hex'), 'hex').toString('base64'),
      ).publicKey();
      details.startingBalance = createAccountOp.startingBalance().toString();
    }
  } else if (body.isVariant('paymentOp')) {
    const paymentOp = body.paymentOp();
    if (paymentOp) {
      details.destination = Keypair.fromPublicKey(
        Buffer.from(paymentOp.destination().accountId().ed25519().toString('hex'), 'hex').toString('base64'),
      ).publicKey();
      details.amount = paymentOp.amount().toString();
    }
  } else if (body.isVariant('manageBuyOfferOp')) {
    const manageBuyOfferOp = body.manageBuyOfferOp();
    if (manageBuyOfferOp) {
      details.offerId = manageBuyOfferOp.offerId().toString();
      details.buyingAmount = manageBuyOfferOp.buyingAmount().toString();
      details.price = {
        n: manageBuyOfferOp.price().n().toString(),
        d: manageBuyOfferOp.price().d().toString(),
      };
    }
  }

  return details;
}

function extractNetworkPassphrase(tx: xdr.Transaction): string {
  // The network passphrase is typically known from context when building the tx
  // For comparison purposes, we can try to identify it from the transaction structure
  const txHash = tx.hash();
  if (!txHash) return 'UNKNOWN';
  return 'Network-specific (check context)';
}

function compareTransactionDetails(details1: TransactionDetails, details2: TransactionDetails): string[] {
  const differences: string[] = [];

  // Compare source accounts
  if (details1.sourceAccount !== details2.sourceAccount) {
    differences.push(`Source Account differs: ${details1.sourceAccount} vs ${details2.sourceAccount}`);
  }

  // Compare fees
  if (details1.fee !== details2.fee) {
    differences.push(`Fee differs: ${details1.fee} stroops vs ${details2.fee} stroops`);
  }

  // Compare sequence numbers
  if (details1.sequence !== details2.sequence) {
    differences.push(`Sequence Number differs: ${details1.sequence} vs ${details2.sequence}`);
  }

  // Compare memo
  if (JSON.stringify(details1.memo) !== JSON.stringify(details2.memo)) {
    differences.push(
      `Memo differs: ${details1.memo.type}${details1.memo.value ? `(${details1.memo.value})` : ''} vs ${details2.memo.type}${details2.memo.value ? `(${details2.memo.value})` : ''}`,
    );
  }

  // Compare operation count
  if (details1.operationCount !== details2.operationCount) {
    differences.push(
      `Operation count differs: ${details1.operationCount} operations vs ${details2.operationCount} operations`,
    );
  }

  // Compare operations in detail
  for (let i = 0; i < Math.max(details1.operationCount, details2.operationCount); i++) {
    const op1 = details1.operations[i];
    const op2 = details2.operations[i];

    if (!op1) {
      differences.push(`Operation ${i}: Missing in first envelope`);
    } else if (!op2) {
      differences.push(`Operation ${i}: Missing in second envelope`);
    } else if (op1.type !== op2.type) {
      differences.push(`Operation ${i}: Type differs: ${op1.type} vs ${op2.type}`);
    } else if (JSON.stringify(op1.details) !== JSON.stringify(op2.details)) {
      differences.push(`Operation ${i}: Details differ`);
    }
  }

  // Compare time bounds
  if (JSON.stringify(details1.timeBounds) !== JSON.stringify(details2.timeBounds)) {
    differences.push(
      `Time bounds differ: ${JSON.stringify(details1.timeBounds)} vs ${JSON.stringify(details2.timeBounds)}`,
    );
  }

  // Compare signature count
  if (details1.signatureCount !== details2.signatureCount) {
    differences.push(
      `Signature count differs: ${details1.signatureCount} signatures vs ${details2.signatureCount} signatures`,
    );
  }

  return differences;
}

export async function run(): Promise<void> {
  console.log('\n=== Transaction Envelope Comparison Example ===\n');

  // Create two sample transactions for comparison
  const keypair1 = Keypair.random();
  const keypair2 = Keypair.random();

  // Transaction 1: Basic payment
  console.log('Creating Transaction 1: Basic payment...');
  const sourceAccount1 = new Account(keypair1.publicKey(), '100');
  const tx1 = new TransactionBuilder(sourceAccount1, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation({
      destination: keypair2.publicKey(),
      amount: '10.5',
      asset: { code: 'native', issuer: '' },
      type: 'payment',
    })
    .addMemo({ type: 'text', value: 'Payment for services' })
    .setTimeout(300)
    .build();

  tx1.sign(keypair1);
  const envelope1 = tx1.toEnvelope().toXDR('base64');
  console.log('Transaction 1 created');

  // Transaction 2: Same as Transaction 1 but with different sequence number
  console.log('Creating Transaction 2: Same payment with different sequence...');
  const sourceAccount2 = new Account(keypair1.publicKey(), '101');
  const tx2 = new TransactionBuilder(sourceAccount2, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation({
      destination: keypair2.publicKey(),
      amount: '10.5',
      asset: { code: 'native', issuer: '' },
      type: 'payment',
    })
    .addMemo({ type: 'text', value: 'Payment for services' })
    .setTimeout(300)
    .build();

  tx2.sign(keypair1);
  const envelope2 = tx2.toEnvelope().toXDR('base64');
  console.log('Transaction 2 created\n');

  // Decode and compare
  console.log('Decoding Transaction 1...');
  const details1 = decodeTransactionEnvelope(envelope1);

  console.log('Decoding Transaction 2...');
  const details2 = decodeTransactionEnvelope(envelope2);

  console.log('\n--- Transaction 1 Details ---');
  console.log(`Envelope Type: ${details1.envelopeType}`);
  console.log(`Source Account: ${details1.sourceAccount}`);
  console.log(`Fee: ${details1.fee} stroops`);
  console.log(`Sequence: ${details1.sequence}`);
  console.log(`Memo: ${details1.memo.type}${details1.memo.value ? ` - ${details1.memo.value}` : ''}`);
  console.log(`Operations: ${details1.operationCount}`);
  console.log(`Signatures: ${details1.signatureCount}`);
  if (details1.timeBounds) {
    console.log(`Time Bounds: ${details1.timeBounds.minTime} - ${details1.timeBounds.maxTime}`);
  }

  console.log('\n--- Transaction 2 Details ---');
  console.log(`Envelope Type: ${details2.envelopeType}`);
  console.log(`Source Account: ${details2.sourceAccount}`);
  console.log(`Fee: ${details2.fee} stroops`);
  console.log(`Sequence: ${details2.sequence}`);
  console.log(`Memo: ${details2.memo.type}${details2.memo.value ? ` - ${details2.memo.value}` : ''}`);
  console.log(`Operations: ${details2.operationCount}`);
  console.log(`Signatures: ${details2.signatureCount}`);
  if (details2.timeBounds) {
    console.log(`Time Bounds: ${details2.timeBounds.minTime} - ${details2.timeBounds.maxTime}`);
  }

  // Perform comparison
  console.log('\n--- Comparison Results ---');
  const differences = compareTransactionDetails(details1, details2);

  if (differences.length === 0) {
    console.log('✓ No differences found between the two envelopes.');
  } else {
    console.log(`Found ${differences.length} difference(s):\n`);
    differences.forEach((diff, index) => {
      console.log(`${index + 1}. ${diff}`);
    });
  }

  console.log('\n=== Example Complete ===\n');
}
