import { Horizon, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const FRIENDBOT_URL = 'https://friendbot.stellar.org';
const BASE_FEE = '100';

interface ThresholdSnapshot {
  masterWeight: number;
  lowThreshold: number;
  mediumThreshold: number;
  highThreshold: number;
}

/**
 * Finds the weight assigned to an account's master key.
 *
 * Horizon includes the master key in the account's signers collection.
 * Signer weights are compared with account thresholds to determine whether
 * a transaction has enough authorization for its operations.
 */
export function getMasterKeyWeight(account: Horizon.AccountResponse): number {
  const masterSigner = account.signers.find((signer) => signer.key === account.account_id);

  return masterSigner?.weight ?? 0;
}

/**
 * Creates a small snapshot of the threshold-related account configuration.
 * Keeping the original values allows the example to restore the account
 * after the demonstration.
 */
export function getThresholdSnapshot(account: Horizon.AccountResponse): ThresholdSnapshot {
  return {
    masterWeight: getMasterKeyWeight(account),
    lowThreshold: account.thresholds.low_threshold,
    mediumThreshold: account.thresholds.med_threshold,
    highThreshold: account.thresholds.high_threshold,
  };
}

/**
 * Prints threshold information in a consistent, readable format.
 */
export function displayThresholds(label: string, account: Horizon.AccountResponse): void {
  const snapshot = getThresholdSnapshot(account);

  console.log(`\n--- ${label} ---`);
  console.log(`Account: ${account.account_id}`);
  console.log(`Master key weight: ${snapshot.masterWeight}`);
  console.log(`Low threshold: ${snapshot.lowThreshold}`);
  console.log(`Medium threshold: ${snapshot.mediumThreshold}`);
  console.log(`High threshold: ${snapshot.highThreshold}`);
}

/**
 * Confirms that Horizon returned the expected threshold configuration.
 */
export function verifyThresholds(
  account: Horizon.AccountResponse,
  expected: ThresholdSnapshot,
): void {
  const actual = getThresholdSnapshot(account);

  if (
    actual.masterWeight !== expected.masterWeight ||
    actual.lowThreshold !== expected.lowThreshold ||
    actual.mediumThreshold !== expected.mediumThreshold ||
    actual.highThreshold !== expected.highThreshold
  ) {
    throw new Error(
      `Threshold verification failed. Expected ${JSON.stringify(
        expected,
      )}, received ${JSON.stringify(actual)}.`,
    );
  }
}

/**
 * Funds a newly generated account through Stellar Testnet Friendbot.
 */
async function fundTestnetAccount(publicKey: string): Promise<void> {
  const response = await fetch(`${FRIENDBOT_URL}/?addr=${encodeURIComponent(publicKey)}`);

  if (!response.ok) {
    const responseBody = await response.text();

    throw new Error(
      `Friendbot could not fund account ${publicKey}. ` +
        `HTTP ${response.status}: ${responseBody}`,
    );
  }
}

/**
 * Builds, signs, and submits a setOptions transaction that changes the
 * account's master-key weight and low, medium, and high thresholds.
 */
async function updateThresholds(
  server: Horizon.Server,
  account: Horizon.AccountResponse,
  signer: Keypair,
  thresholds: ThresholdSnapshot,
): Promise<string> {
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.setOptions({
        masterWeight: thresholds.masterWeight,
        lowThreshold: thresholds.lowThreshold,
        medThreshold: thresholds.mediumThreshold,
        highThreshold: thresholds.highThreshold,
      }),
    )
    .setTimeout(30)
    .build();

  transaction.sign(signer);

  const result = await server.submitTransaction(transaction);

  return result.hash;
}

/**
 * Demonstrates account threshold configuration without implementing a full
 * multi-signature wallet.
 *
 * Thresholds specify the total signer weight required to authorize an
 * operation. They do not create or remove signers; signer management is a
 * separate use of Operation.setOptions.
 */
export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const server = new Horizon.Server(horizonUrl);
  const accountKeypair = Keypair.random();

  console.log('Starting Account Threshold Configuration Example...');
  console.log(`Using Horizon: ${horizonUrl}`);
  console.log(`Temporary Testnet account: ${accountKeypair.publicKey()}`);

  console.log('\nThreshold authorization overview:');
  console.log(
    '- Low threshold: operations such as allowTrust, setTrustLineFlags, bumpSequence, and claimClaimableBalance.',
  );
  console.log('- Medium threshold: most everyday operations, including payments and changeTrust.');
  console.log(
    '- High threshold: security-sensitive operations such as setOptions and accountMerge.',
  );
  console.log(
    '- A transaction succeeds when its valid signer weights meet or exceed the required threshold.',
  );
  console.log(
    '- Threshold configuration controls required authorization; it is different from adding or removing signers.',
  );

  console.log('\nFunding the temporary account through Friendbot...');
  await fundTestnetAccount(accountKeypair.publicKey());

  const initialAccount = await server.loadAccount(accountKeypair.publicKey());
  const originalConfiguration = getThresholdSnapshot(initialAccount);

  displayThresholds('Thresholds Before Update', initialAccount);

  /*
   * The temporary account begins with a master-key weight of 1 and thresholds
   * of 0. For this demonstration, the master-key weight becomes 3 while the
   * thresholds become 1, 2, and 3.
   *
   * Keeping the master-key weight equal to the high threshold ensures that
   * the same key can authorize the restoration setOptions operation.
   */
  const demonstrationConfiguration: ThresholdSnapshot = {
    masterWeight: 3,
    lowThreshold: 1,
    mediumThreshold: 2,
    highThreshold: 3,
  };

  let configurationChanged = false;

  try {
    console.log('\nSubmitting threshold configuration transaction...');

    const updateHash = await updateThresholds(
      server,
      initialAccount,
      accountKeypair,
      demonstrationConfiguration,
    );

    configurationChanged = true;

    console.log(`Threshold update transaction hash: ${updateHash}`);

    const updatedAccount = await server.loadAccount(accountKeypair.publicKey());

    displayThresholds('Thresholds After Update', updatedAccount);
    verifyThresholds(updatedAccount, demonstrationConfiguration);

    console.log('\nHorizon verification succeeded.');
    console.log(
      'The master key now has weight 3, which satisfies the configured low, medium, and high thresholds.',
    );
    console.log(
      'In a multi-signature account, the weights of all valid signatures would be added together and compared with the relevant threshold.',
    );
  } finally {
    if (configurationChanged) {
      console.log('\nRestoring the account configuration...');

      /*
       * Reloading is essential because the successful update transaction
       * consumed the previous account sequence number.
       */
      const accountForRestoration = await server.loadAccount(accountKeypair.publicKey());

      const restorationHash = await updateThresholds(
        server,
        accountForRestoration,
        accountKeypair,
        originalConfiguration,
      );

      console.log(`Restoration transaction hash: ${restorationHash}`);

      const restoredAccount = await server.loadAccount(accountKeypair.publicKey());

      displayThresholds('Thresholds After Restoration', restoredAccount);
      verifyThresholds(restoredAccount, originalConfiguration);

      console.log(
        '\nOriginal threshold configuration restored successfully. The temporary account remains usable.',
      );
    }
  }

  console.log('\nAccount threshold demonstration completed successfully.');
}
