import { Keypair, Horizon } from '@stellar/stellar-sdk';

export async function run(): Promise<void> {
  // 1. Generate a random Keypair
  console.log('Generating random Stellar Keypair...');
  const keypair = Keypair.random();
  console.log(`Public Key: ${keypair.publicKey()}`);
  console.log(`Secret Key: ${keypair.secret()} (Keep this secret!)`);

  // 2. Request Friendbot funding on testnet
  const friendbotUrl = `https://friendbot.stellar.org/?addr=${encodeURIComponent(keypair.publicKey())}`;
  console.log(`\nRequesting testnet XLM funding from Friendbot...`);

  const response = await fetch(friendbotUrl);
  if (!response.ok) {
    throw new Error(`Friendbot failed with status: ${response.status}`);
  }

  console.log('Friendbot funding successful!');

  // 3. Load account details from Horizon testnet to verify balances
  const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  console.log(`\nConnecting to Horizon server at: ${horizonUrl}`);
  const server = new Horizon.Server(horizonUrl);

  console.log(`Loading account details for ${keypair.publicKey()}...`);
  const account = await server.loadAccount(keypair.publicKey());

  console.log('\nAccount Details:');
  console.log(`Sequence: ${account.sequenceNumber()}`);
  console.log('Balances:');
  for (const balance of account.balances) {
    const asset =
      balance.asset_type === 'native'
        ? 'XLM'
        : `${(balance as any).asset_code} (Issuer: ${(balance as any).asset_issuer})`;
    console.log(`  - ${balance.balance} ${asset}`);
  }
}
