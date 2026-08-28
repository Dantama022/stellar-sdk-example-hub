import {
  Horizon,
  TransactionBuilder,
  Networks,
  Keypair,
  Transaction,
  Account,
  Operation,
  Asset,
} from '@stellar/stellar-sdk';

export async function run(params?: any): Promise<void> {
  const server = new Horizon.Server(
    process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org',
  );

  const accountId = params?.accountId || 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
  let xdr = params?.envelopeXdr;

  if (!xdr) {
    // Dynamically build a dummy transaction to guarantee valid XDR
    const dummyAccount = new Account(accountId, '1');
    const txObj = new TransactionBuilder(dummyAccount, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({ destination: accountId, asset: Asset.native(), amount: '1' }),
      )
      .setTimeout(1000)
      .build();
    xdr = txObj.toEnvelope().toXDR('base64');
  }

  try {
    const account = await server.loadAccount(accountId);
    const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as Transaction;
    const txHash = tx.hash();

    let collectedWeight = 0;
    const matchedSigners: any[] = [];

    tx.signatures.forEach((sig) => {
      const signatureData = sig.signature();
      for (const signer of account.signers) {
        try {
          if (signer.type === 'ed25519_public_key') {
            const keypair = Keypair.fromPublicKey(signer.key);
            if (keypair.verify(txHash, signatureData)) {
              collectedWeight += signer.weight;
              matchedSigners.push({ key: signer.key, weight: signer.weight });
            }
          }
        } catch {
          // Ignore failed cryptographic checks
        }
      }
    });

    const requiredThreshold = account.thresholds.high_threshold;
    const isAuthorized = collectedWeight >= requiredThreshold;

    const output = {
      accountId,
      thresholds: account.thresholds,
      signers: account.signers.map((s) => ({ key: s.key, weight: s.weight })),
      collectedWeight,
      requiredThreshold,
      missingWeight: Math.max(0, requiredThreshold - collectedWeight),
      isAuthorized,
      matchedSigners,
    };

    console.log(params?.json ? JSON.stringify(output, null, 2) : output);
  } catch (error: any) {
    console.error('Error inspecting multisignature threshold:', error.message);
  }
}
