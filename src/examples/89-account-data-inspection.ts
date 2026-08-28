import {
  Horizon,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';

export interface AccountDataInspectionParams {
  accountId?: string;
}

export function decodeDataValue(base64Value?: string): string | null {
  if (!base64Value) {
    return null;
  }

  return Buffer.from(base64Value, 'base64').toString('utf-8');
}

function isValidAccountId(accountId: string): boolean {
  return StrKey.isValidEd25519PublicKey(accountId);
}

function isHorizonNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as Record<string, unknown>).name === 'NotFoundError'
  );
}

async function fundAccount(publicKey: string): Promise<void> {
  const response = await fetch(
    `https://friendbot.stellar.org/?addr=${encodeURIComponent(publicKey)}`,
  );

  if (!response.ok) {
    throw new Error(
      `Failed to fund account ${publicKey}: ${response.statusText}`,
    );
  }
}

async function addDataEntry(
  server: Horizon.Server,
  account: Keypair,
  key: string,
  value: string,
): Promise<void> {
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
  await server.submitTransaction(transaction);
}

function displayAccountDataEntries(dataEntries: Record<string, string>): void {
  const keys = Object.keys(dataEntries);
  if (keys.length === 0) {
    console.log('No data entries were found on this account.');
    console.log(
      'Use Manage Data operations to store lightweight key/value metadata on the account ledger entry.',
    );
    return;
  }

  console.log(`Account has ${keys.length} stored data entr${keys.length === 1 ? 'y' : 'ies'}:`);

  keys.forEach((key) => {
    const rawValue = dataEntries[key];
    console.log(`\n- Key: ${key}`);
    console.log(`  Raw value (base64): ${rawValue}`);
    console.log(`  Decoded value: ${decodeDataValue(rawValue)}`);
  });
}

export async function run(
  params: AccountDataInspectionParams = {},
): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const server = new Horizon.Server(horizonUrl);
  const providedAccountId = params.accountId?.trim() || process.env.ACCOUNT_ID?.trim();

  console.log('Starting Account Data Inspection Example...');
  console.log(`Using Horizon: ${horizonUrl}`);
  console.log(
    'Account data entries are stored as base64-encoded values on the account ledger entry.',
  );
  console.log(
    'Manage Data operations create, update, or remove named key/value pairs attached to the account.',
  );
  console.log(
    'Each present data entry increases the account minimum reserve and is reflected in the account subentry count.',
  );

  let accountId = providedAccountId;
  if (!accountId) {
    const sampleAccount = Keypair.random();
    console.log('No account ID was provided. Creating a sample account with example data entries...');
    console.log(`Sample account: ${sampleAccount.publicKey()}`);

    await fundAccount(sampleAccount.publicKey());
    await addDataEntry(server, sampleAccount, 'app_name', 'stellar-sdk-example-hub');
    await addDataEntry(server, sampleAccount, 'environment', 'testnet');
    await addDataEntry(server, sampleAccount, 'version', '1.0.0');

    accountId = sampleAccount.publicKey();
  }

  if (!isValidAccountId(accountId)) {
    throw new Error(
      `Invalid Stellar account ID: ${accountId}. Please provide a valid public key starting with G.`,
    );
  }

  let account;
  try {
    account = await server.loadAccount(accountId);
  } catch (error: unknown) {
    if (isHorizonNotFoundError(error)) {
      console.log(
        `Account ${accountId} was not found on the connected Horizon network.`,
      );
      return;
    }
    throw error;
  }

  console.log(`\nLoaded account ${accountId}`);
  console.log(`Subentry count: ${account.subentry_count}`);
  displayAccountDataEntries(account.data_attr as Record<string, string>);

  console.log(`\nInspecting account data entries completed successfully.`);
}
