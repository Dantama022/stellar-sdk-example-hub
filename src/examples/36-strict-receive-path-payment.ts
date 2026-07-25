import { Keypair, Horizon, TransactionBuilder, Networks, Operation, Asset } from '@stellar/stellar-sdk';

export function formatPathAssets(
  path: Array<{ asset_type: string; asset_code?: string; asset_issuer?: string }>,
): string {
  return path
    .map((hop) =>
      hop.asset_type === 'native' ? 'XLM' : `${hop.asset_code}:${hop.asset_issuer?.slice(0, 8)}…`,
    )
    .join(' → ');
}

export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const server = new Horizon.Server(horizonUrl);

  console.log('Starting Strict Receive Path Payment Example...');
  console.log(
    'Strict receive fixes the destination amount; the source spend varies up to sendMax.',
  );
  console.log(
    'Contrast with strict send (example 37), which fixes the source amount and lets the receive amount float.',
  );

  const issuer = Keypair.random();
  const source = Keypair.random();
  const destination = Keypair.random();

  console.log('\nFunding accounts via Friendbot...');
  await Promise.all([
    fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(issuer.publicKey())}`),
    fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(source.publicKey())}`),
    fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(destination.publicKey())}`),
  ]);

  const customAsset = new Asset('RCVAST', issuer.publicKey());

  const issuerAcc = await server.loadAccount(issuer.publicKey());
  const destAcc = await server.loadAccount(destination.publicKey());

  console.log('\nSetting up destination trustline...');
  let tx = new TransactionBuilder(destAcc, { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: customAsset }))
    .setTimeout(30)
    .build();
  tx.sign(destination);
  await server.submitTransaction(tx);

  console.log('Providing SDEX liquidity (issuer sells RCVAST for XLM)...');
  tx = new TransactionBuilder(issuerAcc, { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(
      Operation.manageSellOffer({
        selling: customAsset,
        buying: Asset.native(),
        amount: '1000',
        price: '1',
      }),
    )
    .setTimeout(30)
    .build();
  tx.sign(issuer);
  await server.submitTransaction(tx);

  const destinationAmount = '25';
  const sendMax = '50';

  console.log('\nQuerying Horizon for strict receive paths...');
  const paths = await server
    .strictReceivePaths(source.publicKey(), customAsset, destinationAmount)
    .call();

  if (paths.records.length === 0) {
    throw new Error('No strict-receive paths found for the requested destination amount.');
  }

  const pathRecord = paths.records[0];
  const formattedPath = pathRecord.path.map((hop) =>
    hop.asset_type === 'native' ? Asset.native() : new Asset(hop.asset_code!, hop.asset_issuer!),
  );

  console.log('Selected path:');
  console.log(`  Hops:              ${formatPathAssets(pathRecord.path)}`);
  console.log(`  Destination amount (exact): ${destinationAmount} RCVAST`);
  console.log(`  Source amount (quoted):     ${pathRecord.source_amount} XLM`);
  console.log(`  Configured send max:        ${sendMax} XLM`);

  if (Number(pathRecord.source_amount) > Number(sendMax)) {
    throw new Error('Quoted source amount exceeds configured sendMax; widen sendMax or pick another path.');
  }

  const sourceAcc = await server.loadAccount(source.publicKey());

  console.log('\nSubmitting pathPaymentStrictReceive transaction...');
  const paymentTx = new TransactionBuilder(sourceAcc, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.pathPaymentStrictReceive({
        sendAsset: Asset.native(),
        sendMax,
        destination: destination.publicKey(),
        destAsset: customAsset,
        destAmount: destinationAmount,
        path: formattedPath,
      }),
    )
    .setTimeout(30)
    .build();

  paymentTx.sign(source);
  const result = await server.submitTransaction(paymentTx);
  console.log(`\nStrict receive payment succeeded. Hash: ${result.hash}`);

  const balances = await server.loadAccount(destination.publicKey());
  const line = balances.balances.find(
    (balance) =>
      balance.asset_type !== 'native' &&
      balance.asset_type !== 'liquidity_pool_shares' &&
      balance.asset_code === 'RCVAST',
  );

  if (!line || line.asset_type === 'native') {
    throw new Error('Destination trustline balance not found after payment.');
  }

  console.log(`Destination RCVAST balance: ${line.balance}`);
  console.log('The recipient received the exact destination amount configured in destAmount.');
}
