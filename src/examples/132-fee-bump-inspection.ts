import {
  Asset,
  Account,
  Keypair,
  Networks,
  Operation,
  Transaction,
  FeeBumpTransaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import chalk from 'chalk';

export interface FeeBumpInspectionSummary {
  envelopeType: string;
  isFeeBump: boolean;
  feeSource?: string;
  feeBumpFee?: string;
  innerSource?: string;
  innerFee?: string;
  operationCount: number;
  operationTypes: string[];
  signaturesCount: number;
  signerHints: string[];
}

export function inspectTransactionEnvelope(
  envelopeXdr: string,
  networkPassphrase: string = Networks.TESTNET,
): FeeBumpInspectionSummary {
  let parsed: Transaction | FeeBumpTransaction;
  try {
    parsed = TransactionBuilder.fromXDR(envelopeXdr, networkPassphrase);
  } catch (error: any) {
    throw new Error(`Invalid transaction XDR: ${error.message || error}`);
  }

  if (parsed instanceof FeeBumpTransaction) {
    const innerTx = parsed.innerTransaction;

    return {
      envelopeType: 'envelopeTypeTxFeeBump',
      isFeeBump: true,
      feeSource: parsed.feeSource,
      feeBumpFee: parsed.fee,
      innerSource: innerTx.source,
      innerFee: innerTx.fee,
      operationCount: innerTx.operations.length,
      operationTypes: innerTx.operations.map((op) => op.type),
      signaturesCount: parsed.signatures.length,
      signerHints: parsed.signatures.map((sig) => sig.hint().toString('hex')),
    };
  } else {
    const tx = parsed;
    return {
      envelopeType: 'envelopeTypeTx',
      isFeeBump: false,
      innerSource: tx.source,
      innerFee: tx.fee,
      operationCount: tx.operations.length,
      operationTypes: tx.operations.map((op) => op.type),
      signaturesCount: tx.signatures.length,
      signerHints: tx.signatures.map((sig) => sig.hint().toString('hex')),
    };
  }
}

export async function run(params?: any): Promise<void> {
  console.log(chalk.bold.green('\n🔍 Fee-Bump Transaction Inspection Example'));

  let envelopeXdr = params?.envelopeXdr;

  if (!envelopeXdr) {
    const sourceKeypair = Keypair.random();
    const feeSourceKeypair = Keypair.random();

    const account = new Account(sourceKeypair.publicKey(), '1');
    const innerTx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: sourceKeypair.publicKey(),
          asset: Asset.native(),
          amount: '10000000',
        }),
      )
      .setTimeout(30)
      .build();

    innerTx.sign(sourceKeypair);

    const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
      feeSourceKeypair.publicKey(),
      '500',
      innerTx,
      Networks.TESTNET,
    );
    feeBumpTx.sign(feeSourceKeypair);

    envelopeXdr = feeBumpTx.toXDR();
    console.log(
      chalk.gray('No XDR provided. Generated a sample fee-bump transaction envelope offline.'),
    );
  }

  try {
    const summary = inspectTransactionEnvelope(envelopeXdr);

    console.log(chalk.bold.cyan('\n📋 Inspection Report:'));
    console.log(`  Envelope Type:     ${summary.envelopeType}`);
    console.log(`  Is Fee-Bump?       ${summary.isFeeBump ? 'YES ✅' : 'NO ❌'}`);

    if (summary.isFeeBump) {
      console.log(`  Outer Fee Source:  ${summary.feeSource}`);
      console.log(`  Fee-Bump Fee:      ${summary.feeBumpFee} stroops`);
      console.log(`  Inner Source:      ${summary.innerSource}`);
      console.log(`  Inner Fee:         ${summary.innerFee} stroops`);
    } else {
      console.log(`  Transaction Source: ${summary.innerSource}`);
      console.log(`  Transaction Fee:    ${summary.innerFee} stroops`);
    }

    console.log(`  Operation Count:   ${summary.operationCount}`);
    console.log(`  Operation Types:   ${summary.operationTypes.join(', ') || 'None'}`);
    console.log(`  Signatures Count:  ${summary.signaturesCount}`);
    console.log(`  Signer Hints:      ${summary.signerHints.join(', ') || 'None'}`);
  } catch (error: any) {
    console.error(chalk.red(`\n❌ Error parsing transaction envelope: ${error.message}`));
  }
}
