import {
  Keypair,
  Horizon,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
} from '@stellar/stellar-sdk';

/**
 * Manage Buy Offer Example
 *
 * This example demonstrates the `manageBuyOffer` operation on the Stellar SDEX
 * (Stellar Decentralized Exchange). A buy offer expresses intent to acquire a
 * specific amount of a "buying" asset by spending up to a calculated amount of
 * a "selling" asset.
 *
 * Key concepts:
 * ─────────────
 * • Buy Offer vs Sell Offer:
 *   - `manageBuyOffer` lets you specify the exact amount of the asset you want
 *     to BUY. The network calculates how much of the selling asset to spend.
 *   - `manageSellOffer` lets you specify the exact amount you want to SELL.
 *     The network calculates how much of the buying asset you'll receive.
 *
 * • Price interpretation:
 *   In `manageBuyOffer`, the price is expressed as units of selling asset per
 *   one unit of buying asset. For example, price "2.0" means you are willing
 *   to pay up to 2 units of the selling asset for 1 unit of the buying asset.
 *
 * • When to choose `manageBuyOffer`:
 *   Use it when you know the exact quantity of an asset you need to acquire
 *   (e.g., fulfilling a payment obligation denominated in a specific token)
 *   and you want the network to determine how much of your holding to spend.
 *
 * Workflow:
 *   1. Fund accounts and establish trustlines
 *   2. Create a buy offer on the SDEX
 *   3. Modify the buy offer (update amount and price)
 *   4. Delete the offer by setting buyAmount to "0"
 */
export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const server = new Horizon.Server(horizonUrl);

  console.log('Starting Manage Buy Offer Example...');
  console.log(`Using Horizon: ${horizonUrl}`);

  // 1. Generate keypairs for the issuer and the buyer
  const issuer = Keypair.random();
  const buyer = Keypair.random();

  console.log(`\nIssuer Public Key: ${issuer.publicKey()}`);
  console.log(`Buyer Public Key:  ${buyer.publicKey()}`);

  // 2. Fund both accounts on the Stellar Testnet via Friendbot
  console.log('\nFunding accounts via Friendbot...');
  for (const account of [issuer, buyer]) {
    const response = await fetch(
      `https://friendbot.stellar.org/?addr=${encodeURIComponent(account.publicKey())}`,
    );
    if (!response.ok) {
      throw new Error(`Failed to fund account ${account.publicKey()}: ${response.statusText}`);
    }
  }
  console.log('Both accounts funded successfully.');

  // 3. Define the custom asset to buy
  //    The buyer wants to acquire MOON tokens issued by the issuer account.
  const buyingAsset = new Asset('MOON', issuer.publicKey());
  const sellingAsset = Asset.native(); // paying with XLM

  console.log(`\nBuying Asset:  ${buyingAsset.code}:${buyingAsset.issuer}`);
  console.log(`Selling Asset: native (XLM)`);

  // 4. Establish a trustline from the buyer to the custom asset
  console.log('\nEstablishing trustline for MOON on buyer account...');
  const buyerAccount = await server.loadAccount(buyer.publicKey());
  const trustTx = new TransactionBuilder(buyerAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.changeTrust({
        asset: buyingAsset,
      }),
    )
    .setTimeout(30)
    .build();

  trustTx.sign(buyer);
  const trustResult = await server.submitTransaction(trustTx);
  console.log(`Trustline established. Hash: ${trustResult.hash}`);

  // 5. Create a buy offer on the SDEX
  //    Buy 100 MOON at a price of 2 XLM per 1 MOON (willing to spend up to 200 XLM).
  console.log('\n--- Creating Buy Offer ---');
  console.log('Placing offer: Buy 100 MOON at price 2 XLM/MOON');
  const createAccount = await server.loadAccount(buyer.publicKey());
  const createOfferTx = new TransactionBuilder(createAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.manageBuyOffer({
        selling: sellingAsset,
        buying: buyingAsset,
        buyAmount: '100', // amount of buying asset desired
        price: '2', // price in selling asset per 1 buying asset
        offerId: '0', // "0" means create a new offer
      }),
    )
    .setTimeout(30)
    .build();

  createOfferTx.sign(buyer);
  const createResult = await server.submitTransaction(createOfferTx);
  console.log(`Create offer transaction hash: ${createResult.hash}`);

  // Extract the offer ID from the transaction result
  const offerResults = (createResult as any).offerResults || [];
  const offerId =
    offerResults[0]?.currentOffer?.offerId ||
    (createResult as any).result_xdr?.match(/offerId.*?(\d+)/)?.[1] ||
    '1';
  console.log(`Offer ID: ${offerId}`);

  // Query offers for the buyer to confirm creation
  const offers = await server.offers().forAccount(buyer.publicKey()).call();
  const createdOffer = offers.records[0];
  if (createdOffer) {
    console.log(`Confirmed offer on ledger - ID: ${createdOffer.id}`);
    console.log(`  Amount: ${createdOffer.amount}`);
    console.log(`  Price:  ${createdOffer.price}`);

    // 6. Modify the existing buy offer
    //    Update: Buy 150 MOON at a new price of 1.5 XLM/MOON
    console.log('\n--- Modifying Buy Offer ---');
    console.log('Updating offer: Buy 150 MOON at price 1.5 XLM/MOON');
    const modifyAccount = await server.loadAccount(buyer.publicKey());
    const modifyOfferTx = new TransactionBuilder(modifyAccount, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.manageBuyOffer({
          selling: sellingAsset,
          buying: buyingAsset,
          buyAmount: '150',
          price: '1.5',
          offerId: createdOffer.id, // pass existing offer ID to modify
        }),
      )
      .setTimeout(30)
      .build();

    modifyOfferTx.sign(buyer);
    const modifyResult = await server.submitTransaction(modifyOfferTx);
    console.log(`Modify offer transaction hash: ${modifyResult.hash}`);

    // Verify updated offer
    const updatedOffers = await server.offers().forAccount(buyer.publicKey()).call();
    const updatedOffer = updatedOffers.records[0];
    if (updatedOffer) {
      console.log(`Updated offer - ID: ${updatedOffer.id}`);
      console.log(`  Amount: ${updatedOffer.amount}`);
      console.log(`  Price:  ${updatedOffer.price}`);
    }

    // 7. Delete the offer by setting buyAmount to "0"
    //    Setting the buy amount to zero cancels the offer on the SDEX.
    console.log('\n--- Deleting Buy Offer ---');
    console.log('Cancelling offer by setting buyAmount to 0...');
    const deleteAccount = await server.loadAccount(buyer.publicKey());
    const deleteOfferTx = new TransactionBuilder(deleteAccount, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.manageBuyOffer({
          selling: sellingAsset,
          buying: buyingAsset,
          buyAmount: '0', // setting amount to 0 deletes the offer
          price: '1', // price is irrelevant when deleting
          offerId: createdOffer.id,
        }),
      )
      .setTimeout(30)
      .build();

    deleteOfferTx.sign(buyer);
    const deleteResult = await server.submitTransaction(deleteOfferTx);
    console.log(`Delete offer transaction hash: ${deleteResult.hash}`);

    // Confirm deletion
    const finalOffers = await server.offers().forAccount(buyer.publicKey()).call();
    console.log(`Remaining offers after deletion: ${finalOffers.records.length}`);
  }

  console.log('\nManage Buy Offer example completed successfully.');
}
