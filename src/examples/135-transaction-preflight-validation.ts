import { Horizon, TransactionBuilder, Networks, Transaction, Account, Operation, Asset } from '@stellar/stellar-sdk';

export async function run(params?: any): Promise<void> {
  const server = new Horizon.Server(process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org');
  
  let xdr = params?.envelopeXdr;
  if (!xdr) {
    const accountId = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
    const dummyAccount = new Account(accountId, '1');
    const txObj = new TransactionBuilder(dummyAccount, { fee: '100', networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.payment({ destination: accountId, asset: Asset.native(), amount: '1' }))
      .setTimeout(1000)
      .build();
    xdr = txObj.toEnvelope().toXDR('base64');
  }

  const report = {
    passedChecks: [] as string[],
    warnings: [] as string[],
    errors: [] as string[],
  };

  try {
    const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as Transaction;
    
    // 1. Offline Deterministic Checks
    if (parseInt(tx.fee) < tx.operations.length * 100) {
      report.errors.push(`Fee is too low. Required: ${tx.operations.length * 100}, Provided: ${tx.fee}`);
    } else {
      report.passedChecks.push('Base fee is sufficient.');
    }

    if (tx.signatures.length === 0) {
      report.warnings.push('Transaction has no signatures.');
    } else {
      report.passedChecks.push(`Transaction has ${tx.signatures.length} signature(s).`);
    }

    // 2. Network Dependent Checks
    try {
      const sourceAccount = await server.loadAccount(tx.source);
      
      const txSeq = BigInt(tx.sequence);
      const accSeq = BigInt(sourceAccount.sequenceNumber());
      
      if (txSeq !== accSeq + BigInt(1)) {
        report.errors.push(`Sequence number mismatch. Tx: ${txSeq}, Account expects: ${accSeq + BigInt(1)}`);
      } else {
        report.passedChecks.push('Sequence number is correct.');
      }
      
    } catch (e) {
      report.warnings.push('Could not fetch source account for network checks. It may not exist.');
    }

    console.log(params?.json ? JSON.stringify(report, null, 2) : report);

  } catch (error: any) {
    report.errors.push(`Failed to parse transaction: ${error.message}`);
    console.error(params?.json ? JSON.stringify(report, null, 2) : report);
  }
}