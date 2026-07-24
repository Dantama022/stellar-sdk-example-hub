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

  console.log('Starting Manage Sell Offer Example...');

  // 1. Setup Accounts and Assets
  const issuer = Keypair.random();
  const seller = Keypair.random();
  const customAsset = new Asset('TEST', issuer.publicKey());

  console.log('Funding issuer and seller accounts via Friendbot...');
  await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(issuer.publicKey())}`);
  await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(seller.publicKey())}`);

  // Establish trustline and issue assets to the seller so they have something to sell
  const sellerAccount = await server.loadAccount(seller.publicKey());
  let tx = new TransactionBuilder(sellerAccount, { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: customAsset, limit: '1000' }))
    .setTimeout(30)
    .build();
  tx.sign(seller);
  await server.submitTransaction(tx);

  const issuerAccount = await server.loadAccount(issuer.publicKey());
  tx = new TransactionBuilder(issuerAccount, { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({ destination: seller.publicKey(), asset: customAsset, amount: '500' }))
    .setTimeout(30)
    .build();
  tx.sign(issuer);
  await server.submitTransaction(tx);

  console.log('Setup complete. Seller funded with 500 TEST assets.');

  // 2. Create the Sell Offer
  console.log('\n--- Creating Sell Offer ---');
  console.log('Action: Selling 100 TEST for native XLM at a price of 2.0 XLM per TEST');
  let sellerSeqAccount = await server.loadAccount(seller.publicKey());
  
  tx = new TransactionBuilder(sellerSeqAccount, { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(
      Operation.manageSellOffer({
        selling: customAsset,
        buying: Asset.native(),
        amount: '100',
        price: '2.0', // Price of 1 unit of selling in terms of buying
      })
    )
    .setTimeout(30)
    .build();
  
  tx.sign(seller);
  let response = await server.submitTransaction(tx);
  console.log(`Sell offer created! Transaction Hash: ${response.hash}`);

  // Fetch the offer ID from Horizon
  let offers = await server.offers().forAccount(seller.publicKey()).call();
  let offerId = offers.records[0].id;
  console.log(`Active Offer ID: ${offerId}`);

  // 3. Update the Sell Offer
  console.log('\n--- Updating Sell Offer ---');
  console.log('Action: Updating offer to sell 150 TEST at a price of 2.5 XLM per TEST');
  sellerSeqAccount = await server.loadAccount(seller.publicKey());

  tx = new TransactionBuilder(sellerSeqAccount, { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(
      Operation.manageSellOffer({
        selling: customAsset,
        buying: Asset.native(),
        amount: '150',
        price: '2.5',
        offerId: offerId, // Providing the ID updates the existing offer
      })
    )
    .setTimeout(30)
    .build();
  
  tx.sign(seller);
  response = await server.submitTransaction(tx);
  console.log(`Sell offer updated! Transaction Hash: ${response.hash}`);

  // 4. Delete the Sell Offer
  console.log('\n--- Deleting Sell Offer ---');
  console.log('Action: Removing the offer by setting the amount to 0');
  sellerSeqAccount = await server.loadAccount(seller.publicKey());

  tx = new TransactionBuilder(sellerSeqAccount, { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(
      Operation.manageSellOffer({
        selling: customAsset,
        buying: Asset.native(),
        amount: '0', // Amount 0 deletes the offer
        price: '2.5',
        offerId: offerId,
      })
    )
    .setTimeout(30)
    .build();
  
  tx.sign(seller);
  response = await server.submitTransaction(tx);
  console.log(`Sell offer deleted! Transaction Hash: ${response.hash}`);

  offers = await server.offers().forAccount(seller.publicKey()).call();
  console.log(`Active offers remaining: ${offers.records.length}`);
}