import {
  Keypair,
  Horizon,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
} from '@stellar/stellar-sdk';

export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const server = new Horizon.Server(horizonUrl);

  // 1. Prepare trustline receiver keypair
  console.log('Preparing receiver account...');
  const receiver = Keypair.random();
  console.log(`Receiver Public Key: ${receiver.publicKey()}`);

  // Fund receiver on testnet to pay fee for trustline creation
  await fetch(`https://friendbot.stellar.org/?addr=${receiver.publicKey()}`);
  console.log('Receiver funded with XLM.');

  // 2. Define custom asset (e.g., USD issued by a mock account)
  const issuerPublicKey = 'GA2C5RFPE6CXENJUAJZFSQX6TQW6P4662ZZJCGS4S5GGPN67M6B2ZWFF'; // Issuer ID
  const customAsset = new Asset('USD', issuerPublicKey);
  console.log(`\nDefining custom Asset: Code=${customAsset.code}, Issuer=${customAsset.issuer}`);

  // 3. Load receiver account details
  const receiverAccount = await server.loadAccount(receiver.publicKey());

  // 4. Build Transaction with changeTrust operation
  console.log('\nBuilding changeTrust transaction...');
  const tx = new TransactionBuilder(receiverAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.changeTrust({
        asset: customAsset,
        limit: '1000000', // max balance limit
      }),
    )
    .setTimeout(30)
    .build();

  // 5. Sign transaction
  tx.sign(receiver);

  // 6. Submit to Horizon
  console.log('Submitting trustline transaction to Horizon...');
  const response = await server.submitTransaction(tx);
  console.log('Trustline established successfully!');
  console.log(`Hash: ${response.hash}`);
}
