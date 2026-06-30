import { Keypair, Horizon, TransactionBuilder, Networks, Operation } from '@stellar/stellar-sdk';

/**
 * Manage Data Entries Example
 *
 * This example demonstrates the `manageData` operation, which allows accounts
 * to attach, update, and remove arbitrary key-value data entries on the Stellar
 * ledger.
 *
 * Key concepts:
 * ─────────────
 * • Reserve requirements:
 *   Each data entry increases the account's minimum balance (base reserve) by
 *   one base reserve unit (currently 0.5 XLM on mainnet). The account must
 *   maintain this balance to keep the entry on-ledger.
 *
 * • Storage costs:
 *   Because data entries consume ledger space, they increase the account's
 *   required minimum balance. Removing an entry frees that reserve.
 *
 * • Size limitations:
 *   - Key: up to 64 bytes (UTF-8 string)
 *   - Value: up to 64 bytes (raw bytes, typically base64-encoded when read back)
 *   If you need larger storage, consider Soroban contract state or off-chain
 *   solutions with on-chain anchoring.
 *
 * • Common use cases:
 *   - Storing configuration flags for wallets or anchors
 *   - Anchoring off-chain metadata (e.g., IPFS hashes, domain verification)
 *   - SEP-1 stellar.toml domain ownership proof (web_auth_endpoint data)
 *   - Application-specific state that needs to be publicly verifiable
 *
 * Workflow:
 *   1. Fund a testnet account
 *   2. Create a data entry (key-value pair)
 *   3. Query and display the account data
 *   4. Update the data entry with a new value
 *   5. Query and display the updated data
 *   6. Remove the entry by passing null as the value
 *   7. Confirm removal
 */
export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const server = new Horizon.Server(horizonUrl);

  console.log('Starting Manage Data Entries Example...');
  console.log(`Using Horizon: ${horizonUrl}`);

  // 1. Generate and fund a testnet account
  const account = Keypair.random();
  console.log(`\nAccount Public Key: ${account.publicKey()}`);

  console.log('Funding account via Friendbot...');
  const fundResponse = await fetch(
    `https://friendbot.stellar.org/?addr=${encodeURIComponent(account.publicKey())}`,
  );
  if (!fundResponse.ok) {
    throw new Error(`Failed to fund account: ${fundResponse.statusText}`);
  }
  console.log('Account funded successfully.');

  const dataKey = 'app_config';

  // 2. Create a data entry
  //    Store a JSON-like configuration value under the key "app_config".
  //    The value is stored as raw bytes on-ledger and returned as base64.
  console.log('\n--- Creating Data Entry ---');
  console.log(`Key: "${dataKey}"`);
  const initialValue = 'version=1.0;env=testnet';
  console.log(`Value: "${initialValue}"`);

  const createAccount = await server.loadAccount(account.publicKey());
  const createDataTx = new TransactionBuilder(createAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.manageData({
        name: dataKey,
        value: initialValue,
      }),
    )
    .setTimeout(30)
    .build();

  createDataTx.sign(account);
  const createResult = await server.submitTransaction(createDataTx);
  console.log(`Create data entry transaction hash: ${createResult.hash}`);

  // 3. Query account data after creation
  console.log('\nQuerying account data after creation...');
  const accountAfterCreate = await server.loadAccount(account.publicKey());
  const dataAfterCreate = accountAfterCreate.data_attr;
  console.log('Account data entries:');
  for (const [key, value] of Object.entries(dataAfterCreate)) {
    const decoded = Buffer.from(value as string, 'base64').toString('utf-8');
    console.log(`  "${key}" = "${decoded}"`);
  }

  // 4. Update the data entry with a new value
  console.log('\n--- Updating Data Entry ---');
  const updatedValue = 'version=2.0;env=testnet;feature=data-mgmt';
  console.log(`New value: "${updatedValue}"`);

  const updateAccount = await server.loadAccount(account.publicKey());
  const updateDataTx = new TransactionBuilder(updateAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.manageData({
        name: dataKey,
        value: updatedValue,
      }),
    )
    .setTimeout(30)
    .build();

  updateDataTx.sign(account);
  const updateResult = await server.submitTransaction(updateDataTx);
  console.log(`Update data entry transaction hash: ${updateResult.hash}`);

  // 5. Query account data after update
  console.log('\nQuerying account data after update...');
  const accountAfterUpdate = await server.loadAccount(account.publicKey());
  const dataAfterUpdate = accountAfterUpdate.data_attr;
  console.log('Account data entries:');
  for (const [key, value] of Object.entries(dataAfterUpdate)) {
    const decoded = Buffer.from(value as string, 'base64').toString('utf-8');
    console.log(`  "${key}" = "${decoded}"`);
  }

  // 6. Remove the data entry by passing null as the value
  //    Setting the value to null signals Stellar to delete the entry from the
  //    ledger, freeing the associated base reserve.
  console.log('\n--- Removing Data Entry ---');
  console.log(`Removing key: "${dataKey}"`);

  const removeAccount = await server.loadAccount(account.publicKey());
  const removeDataTx = new TransactionBuilder(removeAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.manageData({
        name: dataKey,
        value: null, // null removes the entry
      }),
    )
    .setTimeout(30)
    .build();

  removeDataTx.sign(account);
  const removeResult = await server.submitTransaction(removeDataTx);
  console.log(`Remove data entry transaction hash: ${removeResult.hash}`);

  // 7. Confirm removal by querying account data
  console.log('\nQuerying account data after removal...');
  const accountAfterRemove = await server.loadAccount(account.publicKey());
  const dataAfterRemove = accountAfterRemove.data_attr;
  const remainingKeys = Object.keys(dataAfterRemove);
  if (remainingKeys.length === 0) {
    console.log('No data entries found — removal confirmed.');
  } else {
    console.log(`Remaining entries: ${remainingKeys.join(', ')}`);
  }

  console.log('\nManage Data Entries example completed successfully.');
}
