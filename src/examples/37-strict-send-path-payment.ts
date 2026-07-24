import { Keypair, Horizon, TransactionBuilder, Networks, Operation, Asset } from '@stellar/stellar-sdk';

export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const server = new Horizon.Server(horizonUrl);

  console.log('Starting Strict Send Path Payment Example...');
  console.log('Strict Send ensures the exact source amount is spent, while the received amount varies based on the path.');
  
  const issuer = Keypair.random();
  const source = Keypair.random();
  const destination = Keypair.random();
  
  console.log('\nFunding accounts via Friendbot...');
  await Promise.all([
    fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(issuer.publicKey())}`),
    fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(source.publicKey())}`),
    fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(destination.publicKey())}`)
  ]);
  
  const customAsset = new Asset('PATHASSET', issuer.publicKey());
  
  // Setup trustlines and liquidity so a path actually exists
  const issuerAcc = await server.loadAccount(issuer.publicKey());
  const destAcc = await server.loadAccount(destination.publicKey());
  
  console.log('\nSetting up destination trustline...');
  let tx = new TransactionBuilder(destAcc, { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: customAsset }))
    .setTimeout(30).build();
  tx.sign(destination);
  await server.submitTransaction(tx);
  
  console.log('Providing market liquidity (Issuer selling PATHASSET for XLM)...');
  tx = new TransactionBuilder(issuerAcc, { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.manageSellOffer({
      selling: customAsset,
      buying: Asset.native(),
      amount: '1000',
      price: '1' // 1 PATHASSET = 1 XLM
    }))
    .setTimeout(30).build();
  tx.sign(issuer);
  await server.submitTransaction(tx);
  
  console.log('\nQuerying Horizon for strict send paths...');
  // We want to spend exactly 10 XLM, delivering PATHASSET
  const exactSourceAmount = '10';
  const paths = await server.strictSendPaths(source.publicKey(), Asset.native(), exactSourceAmount, [customAsset]).call();
  
  if (paths.records.length === 0) {
    throw new Error('No paths found. The market might not have sufficient liquidity.');
  }
  
  const pathRecord = paths.records[0];
  console.log(`Valid Path Found!`);
  console.log(` - Source Amount (Exact Spend): ${pathRecord.source_amount} XLM`);
  console.log(` - Destination Amount (Expected Receive): ${pathRecord.destination_amount} PATHASSET`);
  
  const sourceAcc = await server.loadAccount(source.publicKey());
  
  // Format the intermediate path assets for the SDK
  const formattedPath = pathRecord.path.map((p: any) => 
    p.asset_type === 'native' ? Asset.native() : new Asset(p.asset_code, p.asset_issuer)
  );

  console.log('\nSubmitting pathPaymentStrictSend transaction...');
  const strictSendTx = new TransactionBuilder(sourceAcc, { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.pathPaymentStrictSend({
      sendAsset: Asset.native(),
      sendAmount: exactSourceAmount,       // The exact amount being spent
      destination: destination.publicKey(),
      destAsset: customAsset,
      destMin: pathRecord.destination_amount, // The minimum acceptable amount to receive
      path: formattedPath
    }))
    .setTimeout(30).build();
    
  strictSendTx.sign(source);
  const result = await server.submitTransaction(strictSendTx);
  console.log(`Strict send executed successfully. Hash: ${result.hash}`);
}