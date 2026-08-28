import {
  Address,
  Asset,
  authorizeEntry,
  hash,
  Keypair,
  Networks,
  nativeToScVal,
  Operation,
  rpc,
  scValToNative,
  StrKey,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import chalk from 'chalk';

/**
 * Example 112: Soroban Authorization Signing
 *
 * Soroban authorization is different from ordinary Stellar transaction
 * signatures.
 *
 * A transaction signature authorizes the transaction source account to submit
 * the transaction and pay its fee.
 *
 * A SorobanAuthorizationEntry authorizes a specific address to approve a
 * specific contract invocation tree. This is necessary when a contract calls
 * `require_auth()` for an address other than the transaction source.
 *
 * This example uses the Testnet native Stellar Asset Contract (SAC):
 *
 *   transfer(from, to, amount)
 *
 * The transaction source is deliberately different from `from`. Therefore the
 * SAC requires an authorization entry signed by the asset owner rather than
 * relying on the transaction source signature.
 *
 * Workflow:
 *
 *   1. Create and fund a fee payer, asset owner, and recipient.
 *   2. Derive the Testnet native SAC contract ID.
 *   3. Build a SAC transfer requiring authorization from the owner.
 *   4. Simulate the invocation.
 *   5. Extract the SorobanAuthorizationEntry values returned by simulation.
 *   6. Identify the required signer for each entry.
 *   7. Demonstrate detection of a missing signature.
 *   8. Demonstrate detection of an invalid/wrong signature.
 *   9. Sign the real authorization entries with the correct keypair.
 *  10. Verify the signatures locally before submission.
 *  11. Attach the signed entries to the invocation.
 *  12. Assemble the transaction with the simulation footprint.
 *  13. Sign the transaction envelope separately with the fee payer.
 *
 * The final transaction is intentionally not broadcast. The focus of this
 * example is Soroban authorization signing rather than general transaction
 * submission.
 */

const RPC_URL = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const FRIEND_BOT_URL = 'https://friendbot.stellar.org';
const NETWORK_PASSPHRASE = Networks.TESTNET;
const BASE_FEE = '100000';

// 0.1 XLM expressed in stroops. SAC token amounts use the asset's smallest
// unit and the standard token interface represents amounts as i128.
const TRANSFER_AMOUNT = 1_000_000n;

export interface AuthorizationEntrySummary {
  index: number;
  credentialType: string;
  signer: string;
  contractId: string | null;
  functionName: string;
  nonce: string | null;
  expirationLedger: number | null;
  xdr: string;
}

export type AuthorizationSignatureState =
  | 'missing'
  | 'valid'
  | 'invalid'
  | 'source-account'
  | 'unsupported';

export interface AuthorizationSignatureCheck {
  state: AuthorizationSignatureState;
  signer: string | null;
  message: string;
}

/**
 * Return a readable error string without requiring callers to cast unknown
 * errors throughout the example.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fund a randomly generated Testnet account using Friendbot.
 */
async function fundTestnetAccount(keypair: Keypair, label: string): Promise<void> {
  console.log(`  ${label}: ${keypair.publicKey()}`);

  const response = await fetch(`${FRIEND_BOT_URL}/?addr=${keypair.publicKey()}`);

  if (!response.ok) {
    throw new Error(
      `Friendbot could not fund ${label} (${keypair.publicKey()}): HTTP ${response.status}`,
    );
  }

  console.log(chalk.green(`  ${label} funded.`));
}

/**
 * Extract the address whose authorization is represented by an entry.
 *
 * Source-account credentials are authorized by the transaction envelope and
 * therefore do not contain a separate address credential.
 */
export function getAuthorizationSigner(
  entry: xdr.SorobanAuthorizationEntry,
  transactionSource?: string,
): string {
  const credentials = entry.credentials();
  const credentialType = credentials.switch().name;

  if (credentialType === 'sorobanCredentialsSourceAccount') {
    return transactionSource || '(transaction source account)';
  }

  if (credentialType === 'sorobanCredentialsAddress') {
    return Address.fromScAddress(credentials.address().address()).toString();
  }

  return `(unsupported credential type: ${credentialType})`;
}

/**
 * Return the contract ID and function name from the root invocation.
 */
export function getAuthorizedFunction(entry: xdr.SorobanAuthorizationEntry): {
  contractId: string | null;
  functionName: string;
} {
  const authorizedFunction = entry.rootInvocation().function();
  const functionType = authorizedFunction.switch().name;

  if (functionType !== 'sorobanAuthorizedFunctionTypeContractFn') {
    return {
      contractId: null,
      functionName: functionType,
    };
  }

  const contractFunction = authorizedFunction.contractFn();

  return {
    contractId: Address.fromScAddress(contractFunction.contractAddress()).toString(),
    functionName: contractFunction.functionName().toString(),
  };
}

/**
 * Produce a readable authorization-entry representation.
 */
export function summarizeAuthorizationEntry(
  entry: xdr.SorobanAuthorizationEntry,
  index: number,
  transactionSource?: string,
): AuthorizationEntrySummary {
  const credentials = entry.credentials();
  const credentialType = credentials.switch().name;
  const signer = getAuthorizationSigner(entry, transactionSource);
  const invocation = getAuthorizedFunction(entry);

  let nonce: string | null = null;
  let expirationLedger: number | null = null;

  if (credentialType === 'sorobanCredentialsAddress') {
    const addressCredentials = credentials.address();

    nonce = addressCredentials.nonce().toString();
    expirationLedger = addressCredentials.signatureExpirationLedger();
  }

  return {
    index,
    credentialType,
    signer,
    contractId: invocation.contractId,
    functionName: invocation.functionName,
    nonce,
    expirationLedger,
    xdr: entry.toXDR('base64'),
  };
}

/**
 * Reconstruct the payload that an address-based authorization entry signs.
 *
 * The repository currently uses Stellar SDK 13.x, whose Soroban address
 * credentials use the original ENVELOPE_TYPE_SOROBAN_AUTHORIZATION preimage.
 */
export function buildAuthorizationSigningPayload(
  entry: xdr.SorobanAuthorizationEntry,
  networkPassphrase: string,
): Buffer {
  const credentials = entry.credentials();

  if (credentials.switch().name !== 'sorobanCredentialsAddress') {
    throw new Error('Only address authorization credentials have a separate signing payload.');
  }

  const addressCredentials = credentials.address();

  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(networkPassphrase)),
      nonce: addressCredentials.nonce(),
      invocation: entry.rootInvocation(),
      signatureExpirationLedger: addressCredentials.signatureExpirationLedger(),
    }),
  );

  return hash(preimage.toXDR());
}

/**
 * Decode the SDK-standard Stellar account signature structure stored inside
 * SorobanAddressCredentials.signature.
 *
 * authorizeEntry() stores signatures as:
 *
 * [
 *   {
 *     public_key: bytes,
 *     signature: bytes
 *   }
 * ]
 */
function decodeAuthorizationSignature(signatureValue: xdr.ScVal): {
  publicKey: string;
  signature: Buffer;
} | null {
  const nativeValue = scValToNative(signatureValue);

  if (!Array.isArray(nativeValue) || nativeValue.length === 0) {
    return null;
  }

  const firstSignature = nativeValue[0];

  if (
    firstSignature === null ||
    typeof firstSignature !== 'object' ||
    Array.isArray(firstSignature)
  ) {
    return null;
  }

  const signatureObject = firstSignature as Record<string, unknown>;
  const publicKeyBytes = signatureObject.public_key;
  const signatureBytes = signatureObject.signature;

  if (!(publicKeyBytes instanceof Uint8Array) || !(signatureBytes instanceof Uint8Array)) {
    return null;
  }

  return {
    publicKey: StrKey.encodeEd25519PublicKey(Buffer.from(publicKeyBytes)),
    signature: Buffer.from(signatureBytes),
  };
}

/**
 * Verify that an authorization entry:
 *
 *   - contains a signature,
 *   - contains the expected signer public key, and
 *   - contains a valid Ed25519 signature for the authorization preimage.
 *
 * This check happens before transaction submission.
 */
export function verifyAuthorizationSignature(
  entry: xdr.SorobanAuthorizationEntry,
  expectedSigner: string,
  networkPassphrase: string,
): AuthorizationSignatureCheck {
  const credentials = entry.credentials();
  const credentialType = credentials.switch().name;

  if (credentialType === 'sorobanCredentialsSourceAccount') {
    return {
      state: 'source-account',
      signer: expectedSigner,
      message: 'Source-account authorization is covered by the transaction envelope signature.',
    };
  }

  if (credentialType !== 'sorobanCredentialsAddress') {
    return {
      state: 'unsupported',
      signer: null,
      message: `Unsupported authorization credential type: ${credentialType}`,
    };
  }

  const credentialSigner = Address.fromScAddress(credentials.address().address()).toString();
  const decodedSignature = decodeAuthorizationSignature(credentials.address().signature());

  if (!decodedSignature) {
    return {
      state: 'missing',
      signer: credentialSigner,
      message: 'Authorization entry does not contain a usable signature.',
    };
  }

  if (credentialSigner !== expectedSigner) {
    return {
      state: 'invalid',
      signer: credentialSigner,
      message:
        `Authorization entry belongs to ${credentialSigner}, ` +
        `but ${expectedSigner} was expected.`,
    };
  }

  if (decodedSignature.publicKey !== expectedSigner) {
    return {
      state: 'invalid',
      signer: decodedSignature.publicKey,
      message:
        `Signature was created by ${decodedSignature.publicKey}, ` +
        `but authorization is required from ${expectedSigner}.`,
    };
  }

  try {
    const payload = buildAuthorizationSigningPayload(entry, networkPassphrase);

    const isValid = Keypair.fromPublicKey(expectedSigner).verify(
      payload,
      decodedSignature.signature,
    );

    return isValid
      ? {
          state: 'valid',
          signer: expectedSigner,
          message: 'Authorization signature matches the required signer and invocation payload.',
        }
      : {
          state: 'invalid',
          signer: decodedSignature.publicKey,
          message: 'Authorization signature does not verify against the invocation payload.',
        };
  } catch (error: unknown) {
    return {
      state: 'invalid',
      signer: decodedSignature.publicKey,
      message: `Could not verify authorization signature: ${errorMessage(error)}`,
    };
  }
}

/**
 * Print the important fields from an authorization entry.
 */
function displayAuthorizationEntry(summary: AuthorizationEntrySummary): void {
  console.log(chalk.bold(`\n  Authorization entry [${summary.index}]`));
  console.log(`    Credential type : ${summary.credentialType}`);
  console.log(`    Required signer : ${summary.signer}`);
  console.log(`    Contract ID     : ${summary.contractId || '(not a contract function)'}`);
  console.log(`    Function        : ${summary.functionName}`);
  console.log(`    Nonce           : ${summary.nonce ?? '(source-account credential)'}`);
  console.log(`    Expiry ledger   : ${summary.expirationLedger ?? '(source-account credential)'}`);

  const xdrPreview = summary.xdr.length > 120 ? `${summary.xdr.slice(0, 120)}...` : summary.xdr;

  console.log(`    Entry XDR       : ${xdrPreview}`);
}

/**
 * Explain the difference between the two independent signature layers.
 */
export function authorizationVsTransactionSignatureExplanation(): string {
  return (
    'Transaction signature vs. Soroban authorization signature:\n' +
    '  - Transaction signature: signs the complete transaction envelope. The transaction\n' +
    '    source uses it to authorize submission and payment of network/resource fees.\n' +
    '  - Soroban authorization signature: signs a SorobanAuthorizationEntry representing\n' +
    '    a specific authorized invocation tree, nonce, network, and expiration ledger.\n' +
    '  - They can be signed by different accounts. In this example the fee payer signs\n' +
    '    the transaction, while the asset owner signs the SAC transfer authorization.'
  );
}

/**
 * Run Example 112.
 */
export async function run(): Promise<void> {
  console.log(chalk.bold('Soroban Authorization Signing Example'));
  console.log(
    chalk.gray(
      'Simulate a SAC transfer, extract authorization entries, sign them with the required ' +
        'account, verify the signatures, and attach them to the final transaction.',
    ),
  );

  console.log(chalk.blue(`\nNetwork     : Testnet`));
  console.log(chalk.blue(`Soroban RPC : ${RPC_URL}`));

  const server = new rpc.Server(RPC_URL);

  // ---------------------------------------------------------------------------
  // Step 1: Confirm RPC connectivity.
  // ---------------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 1: Connecting to Soroban RPC...'));

  let currentLedger: number;

  try {
    const latestLedger = await server.getLatestLedger();
    currentLedger = latestLedger.sequence;

    console.log(chalk.green(`Connected. Latest ledger: ${currentLedger}`));
  } catch (error: unknown) {
    console.error(chalk.red(`Could not connect to Soroban RPC: ${errorMessage(error)}`));
    return;
  }

  // ---------------------------------------------------------------------------
  // Step 2: Create three separate accounts.
  //
  // feePayer -> transaction envelope signer
  // owner    -> Soroban authorization signer
  // recipient -> receives the simulated SAC transfer
  // ---------------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 2: Creating Testnet participants...'));

  const feePayer = Keypair.random();
  const owner = Keypair.random();
  const recipient = Keypair.random();

  try {
    await fundTestnetAccount(feePayer, 'Fee payer ');
    await fundTestnetAccount(owner, 'Asset owner');
    await fundTestnetAccount(recipient, 'Recipient  ');
  } catch (error: unknown) {
    console.error(chalk.red(`Could not prepare Testnet accounts: ${errorMessage(error)}`));
    console.log(
      chalk.gray(
        'Friendbot is required because the native SAC transfer reads real Testnet balances.',
      ),
    );
    return;
  }

  // ---------------------------------------------------------------------------
  // Step 3: Derive the native SAC.
  // ---------------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 3: Deriving the native Stellar Asset Contract...'));

  const nativeAsset = Asset.native();
  const sacContractId = nativeAsset.contractId(NETWORK_PASSPHRASE);

  console.log(`  Asset            : XLM`);
  console.log(`  SAC contract ID  : ${sacContractId}`);
  console.log(`  Contract method  : transfer`);
  console.log(`  From             : ${owner.publicKey()}`);
  console.log(`  To               : ${recipient.publicKey()}`);
  console.log(`  Amount           : ${TRANSFER_AMOUNT.toString()} stroops (0.1 XLM)`);

  // ---------------------------------------------------------------------------
  // Step 4: Build an invocation that requires authorization from owner.
  // ---------------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 4: Building SAC transfer invocation...'));

  let sourceAccount;

  try {
    sourceAccount = await server.getAccount(feePayer.publicKey());
  } catch (error: unknown) {
    console.error(
      chalk.red(`Could not load the fee-payer account from RPC: ${errorMessage(error)}`),
    );
    return;
  }

  const transferArguments: xdr.ScVal[] = [
    Address.fromString(owner.publicKey()).toScVal(),
    Address.fromString(recipient.publicKey()).toScVal(),
    nativeToScVal(TRANSFER_AMOUNT, { type: 'i128' }),
  ];

  const unsignedTransferOperation = Operation.invokeContractFunction({
    contract: sacContractId,
    function: 'transfer',
    args: transferArguments,
  });

  const unsignedTransaction = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(unsignedTransferOperation)
    .setTimeout(60)
    .build();

  console.log(chalk.green('Unsigned contract invocation constructed.'));
  console.log(
    chalk.gray(
      '  The fee payer and asset owner are deliberately different accounts, so the owner ' +
        'must provide Soroban authorization separately.',
    ),
  );

  // ---------------------------------------------------------------------------
  // Step 5: Simulate and obtain authorization entries.
  // ---------------------------------------------------------------------------

  console.log(
    chalk.yellow('\nStep 5: Simulating invocation to discover authorization requirements...'),
  );

  let simulation: rpc.Api.SimulateTransactionSuccessResponse;

  try {
    const simulationResponse = await server.simulateTransaction(unsignedTransaction);

    if (rpc.Api.isSimulationError(simulationResponse)) {
      console.error(chalk.red('Simulation failed.'));
      console.error(chalk.gray(simulationResponse.error));
      return;
    }

    if (!rpc.Api.isSimulationSuccess(simulationResponse)) {
      console.error(chalk.red('Simulation returned an unexpected response.'));
      return;
    }

    simulation = simulationResponse;
  } catch (error: unknown) {
    console.error(chalk.red(`Simulation request failed: ${errorMessage(error)}`));
    return;
  }

  console.log(chalk.green('Simulation succeeded.'));
  console.log(`  Minimum resource fee : ${simulation.minResourceFee} stroops`);

  const authorizationEntries = simulation.result?.auth ?? [];

  console.log(`  Authorization count  : ${authorizationEntries.length}`);

  if (authorizationEntries.length === 0) {
    console.error(
      chalk.red(
        'Expected at least one authorization entry for the SAC transfer, but simulation returned none.',
      ),
    );
    console.log(
      chalk.gray(
        'The transfer must use an asset owner different from the transaction source so that ' +
          'the SAC records explicit address authorization.',
      ),
    );
    return;
  }

  // ---------------------------------------------------------------------------
  // Step 6: Inspect required signers and invocation structure.
  // ---------------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 6: Inspecting authorization entries...'));

  authorizationEntries.forEach((entry, index) => {
    const summary = summarizeAuthorizationEntry(entry, index, feePayer.publicKey());

    displayAuthorizationEntry(summary);
  });

  // ---------------------------------------------------------------------------
  // Step 7: Missing-signature handling.
  // ---------------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 7: Demonstrating missing-signature detection...'));

  authorizationEntries.forEach((entry, index) => {
    const signer = getAuthorizationSigner(entry, feePayer.publicKey());

    const check = verifyAuthorizationSignature(entry, signer, NETWORK_PASSPHRASE);

    console.log(`  Entry [${index}] signature status: ${check.state.toUpperCase()}`);
    console.log(chalk.gray(`    ${check.message}`));
  });

  // ---------------------------------------------------------------------------
  // Step 8: Invalid-signature handling.
  //
  // Sign a copy with an unrelated keypair. The signature itself is valid for
  // the wrong key, but it does not satisfy authorization for the asset owner.
  // ---------------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 8: Demonstrating invalid-signature detection...'));

  const wrongSigner = Keypair.random();
  const firstAddressEntry = authorizationEntries.find(
    (entry) => entry.credentials().switch().name === 'sorobanCredentialsAddress',
  );

  if (firstAddressEntry) {
    try {
      const wrongSignedEntry = await authorizeEntry(
        firstAddressEntry,
        wrongSigner,
        currentLedger + 100,
        NETWORK_PASSPHRASE,
      );

      const requiredSigner = getAuthorizationSigner(firstAddressEntry, feePayer.publicKey());

      const invalidCheck = verifyAuthorizationSignature(
        wrongSignedEntry,
        requiredSigner,
        NETWORK_PASSPHRASE,
      );

      console.log(`  Wrong signer       : ${wrongSigner.publicKey()}`);
      console.log(`  Required signer    : ${requiredSigner}`);
      console.log(`  Signature status   : ${invalidCheck.state.toUpperCase()}`);
      console.log(chalk.gray(`    ${invalidCheck.message}`));

      if (invalidCheck.state !== 'invalid') {
        console.warn(
          chalk.yellow(
            '  Warning: the intentionally incorrect signature was not classified as invalid.',
          ),
        );
      }
    } catch (error: unknown) {
      console.log(
        chalk.green(`  Invalid signature attempt rejected while signing: ${errorMessage(error)}`),
      );
    }
  } else {
    console.log(
      chalk.gray(
        '  No address-based authorization entry was available for the invalid-signature demonstration.',
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // Step 9: Sign each address authorization entry with the correct account.
  // ---------------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 9: Signing authorization entries correctly...'));

  const validUntilLedger = currentLedger + 100;
  const signedAuthorizationEntries: xdr.SorobanAuthorizationEntry[] = [];

  for (let index = 0; index < authorizationEntries.length; index += 1) {
    const entry = authorizationEntries[index];
    const credentialType = entry.credentials().switch().name;

    if (credentialType === 'sorobanCredentialsSourceAccount') {
      signedAuthorizationEntries.push(entry);

      console.log(
        chalk.gray(
          `  Entry [${index}] uses source-account credentials; no separate auth signature required.`,
        ),
      );

      continue;
    }

    if (credentialType !== 'sorobanCredentialsAddress') {
      console.warn(
        chalk.yellow(`  Entry [${index}] uses unsupported credential type "${credentialType}".`),
      );
      continue;
    }

    const requiredSigner = getAuthorizationSigner(entry, feePayer.publicKey());

    if (requiredSigner !== owner.publicKey()) {
      console.warn(
        chalk.yellow(
          `  Entry [${index}] requires ${requiredSigner}, but this example only owns the key for ` +
            `${owner.publicKey()}.`,
        ),
      );
      continue;
    }

    try {
      const signedEntry = await authorizeEntry(entry, owner, validUntilLedger, NETWORK_PASSPHRASE);

      signedAuthorizationEntries.push(signedEntry);

      console.log(chalk.green(`  Entry [${index}] signed by asset owner ${owner.publicKey()}.`));
    } catch (error: unknown) {
      console.error(
        chalk.red(`  Could not sign authorization entry [${index}]: ${errorMessage(error)}`),
      );
      return;
    }
  }

  if (signedAuthorizationEntries.length !== authorizationEntries.length) {
    console.error(
      chalk.red(
        'Not every authorization entry could be signed. The transaction will not be prepared.',
      ),
    );
    return;
  }

  // ---------------------------------------------------------------------------
  // Step 10: Verify signatures before putting them in the final transaction.
  // ---------------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 10: Verifying authorization signatures...'));

  let allAuthorizationValid = true;

  signedAuthorizationEntries.forEach((entry, index) => {
    const requiredSigner = getAuthorizationSigner(entry, feePayer.publicKey());

    const check = verifyAuthorizationSignature(entry, requiredSigner, NETWORK_PASSPHRASE);

    console.log(
      `  Entry [${index}] signature status: ${
        check.state === 'valid' || check.state === 'source-account'
          ? chalk.green(check.state.toUpperCase())
          : chalk.red(check.state.toUpperCase())
      }`,
    );

    console.log(chalk.gray(`    ${check.message}`));

    if (check.state !== 'valid' && check.state !== 'source-account') {
      allAuthorizationValid = false;
    }
  });

  if (!allAuthorizationValid) {
    console.error(
      chalk.red(
        'Authorization verification failed. The transaction will not be prepared or submitted.',
      ),
    );
    return;
  }

  console.log(chalk.green('All required authorization signatures verified.'));

  // ---------------------------------------------------------------------------
  // Step 11: Attach signed authorization entries to the contract invocation.
  // ---------------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 11: Attaching signed entries to the SAC invocation...'));

  const authorizedTransferOperation = Operation.invokeContractFunction({
    contract: sacContractId,
    function: 'transfer',
    args: transferArguments,
    auth: signedAuthorizationEntries,
  });

  const authorizedTransaction = TransactionBuilder.cloneFrom(unsignedTransaction)
    .clearOperations()
    .addOperation(authorizedTransferOperation)
    .build();

  const authorizedOperation = authorizedTransaction.operations[0];

  const attachedAuthorizationCount =
    authorizedOperation.type === 'invokeHostFunction' ? (authorizedOperation.auth?.length ?? 0) : 0;

  console.log(
    chalk.green(
      `Attached ${attachedAuthorizationCount} signed authorization entr${
        attachedAuthorizationCount === 1 ? 'y' : 'ies'
      }.`,
    ),
  );

  if (attachedAuthorizationCount !== signedAuthorizationEntries.length) {
    console.error(chalk.red('Authorization attachment verification failed.'));
    return;
  }

  // ---------------------------------------------------------------------------
  // Step 12: Assemble transaction using the simulation footprint/resource fee.
  //
  // Because the transaction already contains auth entries, assembleTransaction
  // preserves these explicitly signed entries rather than replacing them with
  // the unsigned entries from simulation.
  // ---------------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 12: Assembling transaction from simulation data...'));

  let preparedTransaction;

  try {
    preparedTransaction = rpc.assembleTransaction(authorizedTransaction, simulation).build();
  } catch (error: unknown) {
    console.error(chalk.red(`Transaction assembly failed: ${errorMessage(error)}`));
    return;
  }

  const preparedOperation = preparedTransaction.operations[0];

  const preparedAuthorizationCount =
    preparedOperation.type === 'invokeHostFunction' ? (preparedOperation.auth?.length ?? 0) : 0;

  console.log(chalk.green('Transaction assembled successfully.'));
  console.log(`  Attached auth entries : ${preparedAuthorizationCount}`);

  // ---------------------------------------------------------------------------
  // Step 13: Transaction-level signature.
  //
  // This is deliberately performed separately from Soroban authorization to
  // make the distinction visible.
  // ---------------------------------------------------------------------------

  console.log(chalk.yellow('\nStep 13: Signing the transaction envelope separately...'));

  preparedTransaction.sign(feePayer);

  console.log(chalk.green('Transaction envelope signed by the fee payer.'));
  console.log(`  Transaction signer : ${feePayer.publicKey()}`);
  console.log(`  Auth signer        : ${owner.publicKey()}`);

  console.log(chalk.cyan(`\n${authorizationVsTransactionSignatureExplanation()}`));

  // This example intentionally stops before sendTransaction().
  console.log(
    chalk.yellow(
      '\nSubmission skipped intentionally: this example focuses on authorization-entry signing.',
    ),
  );

  console.log(chalk.green('\nAuthorization signing workflow completed successfully.'));

  console.log(
    chalk.cyan(
      'Summary: built a SAC transfer requiring authorization, simulated it, extracted the ' +
        'required authorization entries, identified the signer, demonstrated missing and ' +
        'invalid signature handling, signed the entries correctly, verified them locally, ' +
        'attached them to the invocation, assembled the transaction, and separately signed ' +
        'the transaction envelope.',
    ),
  );
}
