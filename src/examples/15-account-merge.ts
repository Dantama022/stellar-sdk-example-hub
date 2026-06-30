import { Keypair, Horizon, TransactionBuilder, Operation, Networks } from '@stellar/stellar-sdk';
import chalk from 'chalk';

export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  console.log(chalk.blue(`Connecting to Horizon at: ${horizonUrl}`));
  const server = new Horizon.Server(horizonUrl);

  // Step 1: Create a temporary source account to merge
  console.log(chalk.yellow('\nStep 1: Creating and funding a temporary source account...'));
  const sourceKeypair = Keypair.random();
  console.log(`Source Public Key: ${sourceKeypair.publicKey()}`);

  const fundSourceRes = await fetch(
    `https://friendbot.stellar.org/?addr=${sourceKeypair.publicKey()}`,
  );
  if (!fundSourceRes.ok) throw new Error('Failed to fund source account');
  console.log(chalk.green('Source account funded successfully.'));

  // Step 2: Create a destination account to receive the funds
  console.log(chalk.yellow('\nStep 2: Creating and funding a destination account...'));
  const destKeypair = Keypair.random();
  console.log(`Destination Public Key: ${destKeypair.publicKey()}`);

  const fundDestRes = await fetch(`https://friendbot.stellar.org/?addr=${destKeypair.publicKey()}`);
  if (!fundDestRes.ok) throw new Error('Failed to fund destination account');
  console.log(chalk.green('Destination account funded successfully.'));

  // Load balances before merge
  const sourceAccountBefore = await server.loadAccount(sourceKeypair.publicKey());
  const destAccountBefore = await server.loadAccount(destKeypair.publicKey());
  console.log('\nBalances before merge:');
  console.log(
    `Source: ${sourceAccountBefore.balances.find((b) => b.asset_type === 'native')?.balance} XLM`,
  );
  console.log(
    `Destination: ${destAccountBefore.balances.find((b) => b.asset_type === 'native')?.balance} XLM`,
  );

  /**
   * Explanation:
   * Account Merge transfers the native balance (the amount of XLM an account holds) to another account and removes the source account from the ledger.
   * This is useful for recovering the minimum reserve.
   * Requirements:
   * 1. Source account must not own any trustlines, data entries, offers, or signers.
   * 2. Source account must not be the issuer of any assets.
   * 3. The transaction must be signed by the source account.
   */

  // Step 3: Build the merge transaction
  console.log(chalk.yellow('\nStep 3: Building account merge transaction...'));
  const tx = new TransactionBuilder(sourceAccountBefore, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.accountMerge({
        destination: destKeypair.publicKey(),
      }),
    )
    .setTimeout(30)
    .build();

  tx.sign(sourceKeypair);

  // Step 4: Submit the transaction
  console.log(chalk.yellow('\nStep 4: Submitting merge transaction...'));
  try {
    const response = await server.submitTransaction(tx);
    console.log(chalk.green(`Transaction successful! Hash: ${response.hash}`));
  } catch (error: any) {
    console.error(chalk.red('Merge failed:'), error?.response?.data || error.message);
    return;
  }

  // Step 5: Verify balances after merge
  console.log(chalk.yellow('\nStep 5: Verifying state after merge...'));
  try {
    await server.loadAccount(sourceKeypair.publicKey());
    console.log(chalk.red('Error: Source account still exists.'));
  } catch (error: any) {
    if (error.response?.status === 404) {
      console.log(
        chalk.green(
          'Verified: Source account deleted from the ledger (minimum reserve recovered).',
        ),
      );
    } else {
      console.error('Unexpected error checking source account:', error.message);
    }
  }

  const destAccountAfter = await server.loadAccount(destKeypair.publicKey());
  console.log('\nBalances after merge:');
  console.log(
    `Destination: ${destAccountAfter.balances.find((b) => b.asset_type === 'native')?.balance} XLM`,
  );

  console.log(
    chalk.cyan(
      '\nSummary: Successfully created two accounts, merged the temporary account into the destination, verifying that the source was deleted and its balance (including reserve) transferred.',
    ),
  );
}
