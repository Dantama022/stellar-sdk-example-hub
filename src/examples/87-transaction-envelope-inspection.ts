import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  BASE_FEE,
} from '@stellar/stellar-sdk';

export interface EnvelopeSummary {
  envelopeType: string;
  source: string;
  fee: string;
  sequence: string;
  operationCount: number;
  operationTypes: string[];
  signatureCount: number;
  signerHints: string[];
}

/**
 * Summarizes a transaction envelope: payload, metadata, and attached signatures.
 */
export function summarizeEnvelope(transaction: Transaction): EnvelopeSummary {
  const envelope = transaction.toEnvelope();

  return {
    envelopeType: envelope.switch().name,
    source: transaction.source,
    fee: transaction.fee,
    sequence: transaction.sequence,
    operationCount: transaction.operations.length,
    operationTypes: transaction.operations.map((op) => op.type),
    signatureCount: transaction.signatures.length,
    signerHints: transaction.signatures.map((sig) => sig.hint().toString('hex')),
  };
}

/**
 * Parses an envelope XDR string back into a transaction object.
 */
export function parseEnvelopeXdr(xdr: string, networkPassphrase: string): Transaction {
  try {
    return new Transaction(xdr, networkPassphrase);
  } catch (error: any) {
    throw new Error(`Invalid transaction envelope XDR: ${error.message || error}`);
  }
}

/**
 * Runs the transaction envelope inspection example.
 */
export async function run(): Promise<void> {
  console.log('Starting Transaction Envelope Inspection Example...');

  const signer = Keypair.random();
  const account = new Account(signer.publicKey(), '0');

  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({ destination: signer.publicKey(), asset: Asset.native(), amount: '5' }),
    )
    .addOperation(Operation.bumpSequence({ bumpTo: '10' }))
    .setTimeout(60)
    .build();

  console.log('\nBefore signing:');
  console.log(summarizeEnvelope(transaction));

  transaction.sign(signer);

  console.log('\nAfter signing:');
  const summary = summarizeEnvelope(transaction);
  console.log(summary);
  console.log(
    `\nSigner hints are the last 4 bytes of each signer's public key, letting validators`,
  );
  console.log('match signatures to signers without trying every key on the account.');

  const xdr = transaction.toXDR();
  console.log(`\nSerialized envelope XDR (${xdr.length} chars):`);
  console.log(xdr);

  const restored = parseEnvelopeXdr(xdr, Networks.TESTNET);
  console.log(`\nRound-trip successful: hash matches = ${restored.hash().equals(transaction.hash())}`);
  console.log(`Restored signature count: ${restored.signatures.length}`);

  try {
    parseEnvelopeXdr('not-valid-xdr', Networks.TESTNET);
  } catch (error: any) {
    console.log(`\nHandled invalid envelope: ${error.message}`);
  }

  console.log('\nWorkflow: build -> serialize to envelope XDR -> pass to each signer ->');
  console.log('each signer appends a signature -> submit the fully signed envelope to Horizon.');

  console.log('\nEnvelope inspection completed successfully.');
}
