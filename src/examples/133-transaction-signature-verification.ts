import {
  TransactionBuilder,
  Networks,
  Keypair,
  FeeBumpTransaction,
  Account,
  Operation,
  Asset,
} from '@stellar/stellar-sdk';

export async function run(params?: any): Promise<void> {
  let xdr = params?.envelopeXdr;
  let candidates: string[] = [];

  if (!xdr) {
    // Fallback: Generate a valid signed transaction dynamically to guarantee valid XDR
    const kp = Keypair.random();
    const account = new Account(kp.publicKey(), '1');
    const txObj = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({ destination: kp.publicKey(), asset: Asset.native(), amount: '1' }),
      )
      .setTimeout(1000)
      .build();
    txObj.sign(kp);
    xdr = txObj.toEnvelope().toXDR('base64');
    candidates = [kp.publicKey()];
  } else {
    const candidateKeysInput =
      params?.publicKeys || 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
    candidates = candidateKeysInput.split(',').map((k: string) => k.trim());
  }

  try {
    const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
    const isFeeBump = tx instanceof FeeBumpTransaction;
    const hash = tx.hash();

    const output = {
      envelopeType: isFeeBump ? 'FeeBumpTransaction' : 'Transaction',
      transactionHash: hash.toString('hex'),
      signatureCount: tx.signatures.length,
      signatures: [] as any[],
      validCount: 0,
      invalidCount: 0,
    };

    tx.signatures.forEach((sig) => {
      const hint = sig.hint().toString('hex');
      const signatureData = sig.signature();
      let isValid = false;
      let matchedKey = null;

      for (const pk of candidates) {
        try {
          const keypair = Keypair.fromPublicKey(pk);
          if (keypair.verify(hash, signatureData)) {
            isValid = true;
            matchedKey = pk;
            break;
          }
        } catch {
          // Ignore invalid keys
        }
      }

      if (isValid) output.validCount++;
      else output.invalidCount++;

      output.signatures.push({ hint, isValid, matchedKey });
    });

    console.log(params?.json ? JSON.stringify(output, null, 2) : output);
  } catch (error: any) {
    console.error('Error verifying signatures:', error.message);
  }
}
