import { Keypair, Horizon, TransactionBuilder, Networks, Operation } from '@stellar/stellar-sdk';

export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const server = new Horizon.Server(horizonUrl);

  console.log('Starting Account Signer Management Example...');
  console.log(
    'Demonstrating how to add, modify, and remove multi-signature signers using thresholds.\n',
  );

  const account = Keypair.random();
  const secondarySigner = Keypair.random();

  console.log(`Primary Account: ${account.publicKey()}`);
  console.log(`Secondary Signer: ${secondarySigner.publicKey()}`);

  console.log('\nFunding primary account via Friendbot...');
  await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(account.publicKey())}`);

  let sourceAcc = await server.loadAccount(account.publicKey());

  const displaySigners = (acc: Horizon.AccountResponse, step: string) => {
    console.log(`\n--- ${step} ---`);
    console.log('Current Signers Configuration:');
    acc.signers.forEach((s) => console.log(` - Key: ${s.key}, Weight: ${s.weight}`));
  };

  displaySigners(sourceAcc, 'Initial State');

  // 1. Add Signer
  console.log('\nAdding secondary signer with weight 1...');
  let tx = new TransactionBuilder(sourceAcc, { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(
      Operation.setOptions({
        signer: {
          ed25519PublicKey: secondarySigner.publicKey(),
          weight: 1, // Weight > 0 adds or modifies the signer
        },
      }),
    )
    .setTimeout(30)
    .build();
  tx.sign(account);
  await server.submitTransaction(tx);

  sourceAcc = await server.loadAccount(account.publicKey());
  displaySigners(sourceAcc, 'After Adding Signer');

  // 2. Update Signer Weight
  console.log('\nUpdating secondary signer weight to 2...');
  tx = new TransactionBuilder(sourceAcc, { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(
      Operation.setOptions({
        signer: {
          ed25519PublicKey: secondarySigner.publicKey(),
          weight: 2,
        },
      }),
    )
    .setTimeout(30)
    .build();
  tx.sign(account);
  await server.submitTransaction(tx);

  sourceAcc = await server.loadAccount(account.publicKey());
  displaySigners(sourceAcc, 'After Updating Weight');

  // 3. Remove Signer
  console.log('\nRemoving secondary signer (by setting weight to 0)...');
  tx = new TransactionBuilder(sourceAcc, { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(
      Operation.setOptions({
        signer: {
          ed25519PublicKey: secondarySigner.publicKey(),
          weight: 0, // Setting weight to 0 completely removes the signer
        },
      }),
    )
    .setTimeout(30)
    .build();
  tx.sign(account);
  await server.submitTransaction(tx);

  sourceAcc = await server.loadAccount(account.publicKey());
  displaySigners(sourceAcc, 'After Removing Signer');

  console.log('\nSigner management lifecycle completed successfully.');
}
