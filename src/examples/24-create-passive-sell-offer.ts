import {
  Keypair,
  Horizon,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
} from '@stellar/stellar-sdk';

/**
 * Create Passive Sell Offer Example
 *
 * This example demonstrates the `createPassiveSellOffer` operation on Stellar's
 * decentralized exchange (SDEX).
 *
 * Key concepts:
 * ─────────────
 * • Passive Offers vs Standard (Active) Offers:
 *   - A standard offer (via `manageSellOffer` or `manageBuyOffer`) actively
 *     crosses the order book: if a matching counter-offer exists, the trade
 *     executes immediately.
 *   - A passive sell offer does NOT cross existing offers at the same price.
 *     It sits on the order book and waits to be taken by another party. If an
 *     existing offer matches at exactly the same price, neither is executed —
 *     the passive offer is simply placed alongside it.
 *
 * • SDEX Interaction & Order Book Behavior:
 *   Passive offers are visible in the order book like any other offer. They
 *   will only execute when a new active offer crosses them. This means they
 *   provide liquidity without consuming existing liquidity.
 *
 * • Liquidity Provisioning Use Cases:
 *   - Market makers who want to provide both sides of an order book without
 *     self-trading (matching their own offers).
 *   - Anchors that issue assets and want to place standing offers for
 *     redemption without accidentally filling their own sell orders.
 *   - DEX aggregators that place resting liquidity for other traders to hit.
 *
 * Workflow:
 *   1. Fund accounts and establish trustlines
 *   2. Issue tokens to the seller so they have inventory to sell
 *   3. Create a passive sell offer on the SDEX
 *   4. Query Horizon to retrieve offer details
 *   5. Print transaction hash and offer information
 */
export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const server = new Horizon.Server(horizonUrl);

  console.log('Starting Create Passive Sell Offer Example...');
  console.log(`Using Horizon: ${horizonUrl}`);

  // 1. Generate keypairs for issuer and seller
  const issuer = Keypair.random();
  const seller = Keypair.random();

  console.log(`\nIssuer Public Key: ${issuer.publicKey()}`);
  console.log(`Seller Public Key: ${seller.publicKey()}`);

  // 2. Fund both accounts via Friendbot
  console.log('\nFunding accounts via Friendbot...');
  for (const account of [issuer, seller]) {
    const response = await fetch(
      `https://friendbot.stellar.org/?addr=${encodeURIComponent(account.publicKey())}`,
    );
    if (!response.ok) {
      throw new Error(`Failed to fund account ${account.publicKey()}: ${response.statusText}`);
    }
  }
  console.log('Both accounts funded successfully.');

  // 3. Define assets
  //    The seller will offer STAR tokens in exchange for XLM.
  const sellingAsset = new Asset('STAR', issuer.publicKey());
  const buyingAsset = Asset.native(); // wants XLM in return

  console.log(`\nSelling Asset: ${sellingAsset.code}:${sellingAsset.issuer}`);
  console.log(`Buying Asset:  native (XLM)`);

  // 4. Establish trustline from seller to the custom asset
  console.log('\nEstablishing trustline for STAR on seller account...');
  const sellerAccount = await server.loadAccount(seller.publicKey());
  const trustTx = new TransactionBuilder(sellerAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.changeTrust({
        asset: sellingAsset,
      }),
    )
    .setTimeout(30)
    .build();

  trustTx.sign(seller);
  const trustResult = await server.submitTransaction(trustTx);
  console.log(`Trustline established. Hash: ${trustResult.hash}`);

  // 5. Issue STAR tokens from the issuer to the seller
  console.log('\nIssuing 500 STAR tokens to seller...');
  const issuerAccount = await server.loadAccount(issuer.publicKey());
  const issueTx = new TransactionBuilder(issuerAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: seller.publicKey(),
        asset: sellingAsset,
        amount: '500',
      }),
    )
    .setTimeout(30)
    .build();

  issueTx.sign(issuer);
  const issueResult = await server.submitTransaction(issueTx);
  console.log(`Tokens issued. Hash: ${issueResult.hash}`);

  // 6. Create a passive sell offer
  //    Sell 200 STAR at a price of 0.5 XLM per 1 STAR.
  //    This offer will sit on the order book without crossing existing offers
  //    at the same price.
  console.log('\n--- Creating Passive Sell Offer ---');
  console.log('Placing passive offer: Sell 200 STAR at 0.5 XLM/STAR');
  const offerAccount = await server.loadAccount(seller.publicKey());
  const passiveOfferTx = new TransactionBuilder(offerAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.createPassiveSellOffer({
        selling: sellingAsset,
        buying: buyingAsset,
        amount: '200', // amount of selling asset to offer
        price: '0.5', // price in buying asset per 1 selling asset
      }),
    )
    .setTimeout(30)
    .build();

  passiveOfferTx.sign(seller);
  const offerResult = await server.submitTransaction(passiveOfferTx);
  console.log(`Passive sell offer transaction hash: ${offerResult.hash}`);

  // 7. Query Horizon to retrieve offer details
  console.log('\nQuerying offers for seller account...');
  const offers = await server.offers().forAccount(seller.publicKey()).call();

  if (offers.records.length > 0) {
    console.log(`\nFound ${offers.records.length} offer(s):`);
    for (const offer of offers.records) {
      console.log(`  Offer ID: ${offer.id}`);
      console.log(
        `    Selling: ${offer.selling.asset_type === 'native' ? 'XLM' : `${(offer.selling as any).asset_code}:${(offer.selling as any).asset_issuer}`}`,
      );
      console.log(
        `    Buying:  ${offer.buying.asset_type === 'native' ? 'XLM' : `${(offer.buying as any).asset_code}:${(offer.buying as any).asset_issuer}`}`,
      );
      console.log(`    Amount:  ${offer.amount}`);
      console.log(`    Price:   ${offer.price}`);
    }
  } else {
    console.log('No offers found (offer may have been immediately filled).');
  }

  console.log('\nCreate Passive Sell Offer example completed successfully.');
}
