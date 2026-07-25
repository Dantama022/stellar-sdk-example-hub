import { Horizon, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_BASE_RESERVE_XLM = 0.5;

export interface AccountDataEntriesParams {
  key?: string;
  initialValue?: string;
  updatedValue?: string;
}

export function decodeDataValue(base64Value: string | undefined): string | null {
  if (!base64Value) {
    return null;
  }

  return Buffer.from(base64Value, 'base64').toString('utf-8');
}

export function estimateMinimumBalanceXlm(
  subentryCount: number,
  baseReserveXlm: number = DEFAULT_BASE_RESERVE_XLM,
): string {
  const estimated = (2 + subentryCount) * baseReserveXlm;
  return estimated.toFixed(7);
}

export function getDecodedDataEntry(
  dataEntries: Record<string, string>,
  key: string,
): string | null {
  return decodeDataValue(dataEntries[key]);
}

async function fundAccount(publicKey: string): Promise<void> {
  const response = await fetch(
    `https://friendbot.stellar.org/?addr=${encodeURIComponent(publicKey)}`,
  );

  if (!response.ok) {
    throw new Error(`Failed to fund account ${publicKey}: ${response.statusText}`);
  }
}

async function submitManageDataTransaction(
  server: Horizon.Server,
  account: Keypair,
  key: string,
  value: string | null,
): Promise<string> {
  const sourceAccount = await server.loadAccount(account.publicKey());

  const transaction = new TransactionBuilder(sourceAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.manageData({
        name: key,
        value,
      }),
    )
    .setTimeout(30)
    .build();

  transaction.sign(account);
  const response = await server.submitTransaction(transaction);
  return response.hash;
}

function verifyDataValue(
  dataEntries: Record<string, string>,
  key: string,
  expectedValue: string | null,
): void {
  const actualValue = getDecodedDataEntry(dataEntries, key);

  if (actualValue !== expectedValue) {
    throw new Error(
      `Data verification failed for key "${key}". Expected "${String(expectedValue)}" but found "${String(actualValue)}".`,
    );
  }
}

export async function run(params: AccountDataEntriesParams = {}): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const server = new Horizon.Server(horizonUrl);

  const dataKey = params.key?.trim() || process.env.DATA_ENTRY_KEY?.trim() || 'app_config';
  const initialValue =
    params.initialValue?.trim() ||
    process.env.DATA_ENTRY_INITIAL?.trim() ||
    'version=1;env=testnet';
  const updatedValue =
    params.updatedValue?.trim() ||
    process.env.DATA_ENTRY_UPDATED?.trim() ||
    'version=2;env=testnet';

  if (dataKey.length === 0) {
    throw new Error('DATA_ENTRY_KEY must not be empty.');
  }

  console.log('Starting Account Data Entry Management Example...');
  console.log(`Using Horizon: ${horizonUrl}`);
  console.log('Key size limit: 64 bytes. Value size limit: 64 bytes.');
  console.log(
    'Reserve note: each data entry increases minimum balance by one base reserve while present.',
  );

  const account = Keypair.random();
  console.log(`\nAccount Public Key: ${account.publicKey()}`);

  console.log('Funding account via Friendbot...');
  await fundAccount(account.publicKey());

  const beforeCreate = await server.loadAccount(account.publicKey());
  console.log(`Subentry count before create: ${beforeCreate.subentry_count}`);
  console.log(
    `Estimated minimum balance before create: ${estimateMinimumBalanceXlm(beforeCreate.subentry_count)} XLM`,
  );

  console.log('\nStep 1: Create data entry');
  const createHash = await submitManageDataTransaction(server, account, dataKey, initialValue);
  console.log(`Create transaction hash: ${createHash}`);

  const afterCreate = await server.loadAccount(account.publicKey());
  verifyDataValue(afterCreate.data_attr, dataKey, initialValue);
  console.log(`Stored value: ${getDecodedDataEntry(afterCreate.data_attr, dataKey)}`);
  console.log(`Subentry count after create: ${afterCreate.subentry_count}`);

  console.log('\nStep 2: Update data entry');
  const updateHash = await submitManageDataTransaction(server, account, dataKey, updatedValue);
  console.log(`Update transaction hash: ${updateHash}`);

  const afterUpdate = await server.loadAccount(account.publicKey());
  verifyDataValue(afterUpdate.data_attr, dataKey, updatedValue);
  console.log(`Updated value: ${getDecodedDataEntry(afterUpdate.data_attr, dataKey)}`);

  console.log('\nStep 3: Remove data entry (value = null)');
  const removeHash = await submitManageDataTransaction(server, account, dataKey, null);
  console.log(`Remove transaction hash: ${removeHash}`);

  const afterRemove = await server.loadAccount(account.publicKey());
  verifyDataValue(afterRemove.data_attr, dataKey, null);
  console.log('Removal verified: key no longer exists on the account.');
  console.log(`Subentry count after removal: ${afterRemove.subentry_count}`);
  console.log(
    `Estimated minimum balance after removal: ${estimateMinimumBalanceXlm(afterRemove.subentry_count)} XLM`,
  );

  console.log('\nAccount data entry lifecycle completed successfully.');
}
