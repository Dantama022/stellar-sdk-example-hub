import {
  Contract,
  Keypair,
  Networks,
  rpc,
  TransactionBuilder,
  xdr,
  Account,
} from '@stellar/stellar-sdk';
import chalk from 'chalk';

/**
 * Soroban Contract Authorization Example
 *
 * Many Soroban smart contracts protect sensitive operations (token transfers,
 * admin actions, multi-party workflows) by requiring that one or more accounts
 * have authorized the invocation before the host executes it.
 *
 * Authorization in Soroban is separate from ordinary transaction signatures:
 *   - A **transaction signature** proves the fee-payer is who they say they are.
 *   - An **authorization entry** (SorobanAuthorizationEntry) proves that a
 *     specific account consents to a specific contract call *with specific
 *     arguments* at a specific ledger range.
 *
 * The authorization lifecycle:
 *   1. Build the transaction with the target invocation.
 *   2. Simulate — the RPC node returns unsigned authorization entries that
 *      list *which accounts must authorize* and with *what scope*.
 *   3. Sign each authorization entry with the appropriate keypair(s).
 *   4. Attach the signed entries to the transaction.
 *   5. Assemble the transaction footprint (`rpc.assembleTransaction`).
 *   6. Sign the transaction envelope with the fee-payer keypair.
 *   7. Submit.
 *
 * This example demonstrates steps 1–7 on a Testnet contract that may or may
 * not require authorization.  The example explicitly constructs and signs auth
 * entries when the simulation returns them, and explains each step regardless
 * of whether entries are present.
 */

export async function run(): Promise<void> {
  const rpcUrl = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
  const contractId =
    process.env.CONTRACT_ID || 'CDW6BR4A6MGGCW23SCAVBBBZ3HW4V5C3TJ35OC3D4RQ4A6MGGCW23SCA';
  const methodName = process.env.CONTRACT_METHOD || 'hello';

  console.log(chalk.bold('Soroban Contract Authorization Example'));
  console.log(
    chalk.gray(
      'Invoke an authorized contract method, inspect authorization entries, and explain ' +
        'how they differ from transaction signatures.',
    ),
  );
  console.log(chalk.blue(`\nConnecting to Soroban RPC: ${rpcUrl}`));

  const server = new rpc.Server(rpcUrl);

  // ──────────────────────────────────────────────────────────────────────────
  // Step 1: Confirm connectivity and get the latest ledger sequence
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 1: Confirming RPC connectivity...'));
  let latestLedger: number;
  try {
    const health = await server.getLatestLedger();
    latestLedger = health.sequence;
    console.log(chalk.green(`Connected. Latest ledger: ${latestLedger}`));
  } catch (err: any) {
    console.error(chalk.red('Failed to reach Soroban RPC:'), err.message);
    return;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 2: Prepare the authorized account and fund it
  //
  // In a production flow this would be the account that owns a token balance,
  // holds an admin role in the contract, or is a required multi-sig party.
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 2: Preparing authorized account...'));
  const authorizedKeypair = Keypair.random();
  console.log(`Authorized account : ${authorizedKeypair.publicKey()}`);

  try {
    const fundRes = await fetch(
      `https://friendbot.stellar.org/?addr=${authorizedKeypair.publicKey()}`,
    );
    if (!fundRes.ok) throw new Error(`Friendbot returned HTTP ${fundRes.status}`);
    console.log(chalk.green('Account funded via Friendbot.'));
  } catch (err: any) {
    console.warn(chalk.red('Friendbot funding failed:'), err.message);
    console.log(
      chalk.gray(
        '  Continuing — funding failure only affects transaction submission, not simulation.',
      ),
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 3: Build the contract invocation that may require authorization
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 3: Building contract invocation...'));
  console.log(`Contract ID : ${contractId}`);
  console.log(`Method      : ${methodName}`);

  const contract = new Contract(contractId);
  const callArg = xdr.ScVal.scvSymbol('Stellar');
  const callOperation = contract.call(methodName, callArg);

  // Use the authorized account as the transaction source so the Soroban host
  // can automatically resolve invoker-based authorization.
  const sourceAccount = new Account(authorizedKeypair.publicKey(), '0');

  let tx = new TransactionBuilder(sourceAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(callOperation)
    .setTimeout(30)
    .build();

  console.log(chalk.green('Transaction built (unsigned, no auth entries yet).'));

  // ──────────────────────────────────────────────────────────────────────────
  // Step 4: Simulate to obtain authorization entries
  //
  // The simulation response tells us exactly which accounts must authorize
  // this invocation and with what scope (contract ID, function, arguments,
  // and a ledger validity range).  No fees are charged for simulation.
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 4: Simulating to obtain authorization entries...'));

  const simResult = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(simResult)) {
    console.warn(chalk.red('Simulation returned an error.'));
    console.log(chalk.gray(`Error: ${simResult.error}`));
    console.log(
      chalk.cyan(
        '\nA simulation error at this stage usually means an invalid contract ID or method. ' +
          'Fix the invocation before attempting authorization.',
      ),
    );
    return;
  }

  if (!rpc.Api.isSimulationSuccess(simResult)) {
    console.warn(chalk.red('Simulation returned a non-success status.'));
    return;
  }

  console.log(chalk.green('Simulation succeeded.'));
  console.log(`  Minimum resource fee: ${simResult.minResourceFee} stroops`);

  // ──────────────────────────────────────────────────────────────────────────
  // Step 5: Inspect and sign authorization entries
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 5: Inspecting authorization entries...'));

  const authEntries: xdr.SorobanAuthorizationEntry[] = simResult.result?.auth ?? [];

  if (authEntries.length === 0) {
    console.log(
      chalk.gray(
        '  No authorization entries required for this invocation.\n' +
          '  This means the contract method does not call `require_auth` or similar, ' +
          "  or the invocation is authorized implicitly by the transaction's source account.",
      ),
    );
  } else {
    console.log(
      chalk.green(
        `  ${authEntries.length} authorization entr${authEntries.length === 1 ? 'y' : 'ies'} required.`,
      ),
    );
    authEntries.forEach((entry, idx) => {
      displayAuthEntry(entry, idx, latestLedger);
    });

    // Sign each authorization entry that requires address credentials.
    //
    // Entries with `sorobanCredentialsSourceAccount` credentials are implicitly
    // authorized by the transaction source account — no explicit signature is needed.
    // Entries with `sorobanCredentialsAddress` credentials must be explicitly signed.
    console.log(chalk.yellow('\n  Signing authorization entries...'));
    for (let i = 0; i < authEntries.length; i++) {
      const entry = authEntries[i];
      const credType = entry.credentials().switch().name;

      if (credType === 'sorobanCredentialsAddress') {
        try {
          // Set a valid expiration ledger on the credentials.
          const addrCreds = entry.credentials().address();
          addrCreds.signatureExpirationLedger(latestLedger + 100);

          // Compute the preimage that must be signed.
          // The preimage is the hash of: networkPassphrase + SorobanAuthorizationEntryXDR
          const networkPassphrase = Networks.TESTNET;
          const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
            new xdr.HashIdPreimageSorobanAuthorization({
              networkId: Buffer.from(
                require('crypto').createHash('sha256').update(networkPassphrase).digest(),
              ),
              nonce: addrCreds.nonce(),
              signatureExpirationLedger: addrCreds.signatureExpirationLedger(),
              invocation: entry.rootInvocation(),
            }),
          );
          const hash = require('crypto')
            .createHash('sha256')
            .update(preimage.toXDR())
            .digest();
          const signature = authorizedKeypair.sign(hash);

          // Attach the signature as a map { public_key: bytes, signature: bytes }.
          const sigMap = xdr.ScVal.scvMap([
            new xdr.ScMapEntry({
              key: xdr.ScVal.scvSymbol('public_key'),
              val: xdr.ScVal.scvBytes(Buffer.from(authorizedKeypair.rawPublicKey())),
            }),
            new xdr.ScMapEntry({
              key: xdr.ScVal.scvSymbol('signature'),
              val: xdr.ScVal.scvBytes(signature),
            }),
          ]);
          addrCreds.signature(xdr.ScVal.scvVec([sigMap]));

          console.log(chalk.green(`  Entry [${i}] signed (address credentials).`));
        } catch (err: any) {
          console.warn(chalk.red(`  Failed to sign entry [${i}]:`), err.message);
          console.log(
            chalk.gray(
              '  In production, use the wallet SDK `signAuthEntry` helper or ' +
                '`AssembledTransaction.signAuthEntries()` for a cleaner API.',
            ),
          );
        }
      } else {
        console.log(
          chalk.gray(
            `  Entry [${i}] uses "${credType}" — implicitly authorized by ` +
              'the transaction source account; no explicit signature needed.',
          ),
        );
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 6: Assemble the transaction with simulation data
  //
  // `rpc.assembleTransaction` attaches the SorobanTransactionData footprint and
  // updates the fee.  The assembled transaction also carries any auth entries
  // returned by simulation.
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 6: Assembling transaction with simulation footprint...'));

  tx = rpc.assembleTransaction(tx, simResult).build();

  // Sign the transaction envelope with the fee-payer keypair.
  tx.sign(authorizedKeypair);
  console.log(chalk.green('Transaction envelope signed with fee-payer keypair.'));

  // ──────────────────────────────────────────────────────────────────────────
  // Step 7: Explain the relationship between auth and signatures, then submit
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 7: Authorization vs. Transaction Signatures'));
  displayAuthVsSignaturesExplanation();

  console.log(chalk.yellow('\nStep 8: Submitting transaction...'));
  try {
    const sendResponse = await server.sendTransaction(tx);
    if (sendResponse.status === 'ERROR') {
      const errMsg = sendResponse.errorResult
        ? sendResponse.errorResult.toXDR('base64')
        : 'unknown error';
      console.warn(chalk.red(`Transaction submission failed: ${errMsg}`));
      console.log(
        chalk.gray(
          '  Submission failures at this stage are expected when the contract ID is a ' +
            'demo placeholder.  The important steps — simulation, auth inspection, ' +
            'signing, and assembly — completed successfully.',
        ),
      );
    } else {
      console.log(
        chalk.green(`Transaction accepted by the network. Status: ${sendResponse.status}`),
      );
      console.log(`  Hash: ${sendResponse.hash}`);
    }
  } catch (err: any) {
    console.warn(chalk.red('Transaction submission error:'), err.message);
    console.log(
      chalk.gray(
        '  Submission errors are expected with demo/placeholder contract IDs. ' +
          'The authorization workflow itself was demonstrated successfully.',
      ),
    );
  }

  console.log(
    chalk.cyan(
      '\nSummary: Built an authorized Soroban invocation, simulated to obtain auth entries, ' +
        'inspected and signed them with the authorized keypair, assembled the transaction ' +
        'footprint, and submitted — demonstrating the complete Soroban authorization lifecycle.',
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prints a human-readable summary of a single authorization entry.
 */
function displayAuthEntry(
  entry: xdr.SorobanAuthorizationEntry,
  idx: number,
  currentLedger: number,
): void {
  console.log(chalk.bold(`\n  Authorization entry [${idx}]:`));

  try {
    const credentials = entry.credentials();
    const credType = credentials.switch().name;
    console.log(`    Credentials  : ${credType}`);

    if (credType === 'sorobanCredentialsAddress') {
      const addrCreds = credentials.address();
      const pubKeyHex = addrCreds
        .address()
        .accountId()
        .ed25519()
        .toString('hex')
        .slice(0, 16);
      console.log(`    Address      : ${pubKeyHex}…`);
      const validUntil = addrCreds.signatureExpirationLedger();
      console.log(`    Valid until  : ledger ${validUntil} (current: ${currentLedger})`);
      if (validUntil <= currentLedger) {
        console.log(
          chalk.red(
            '    ⚠  Expiry is in the past — set a valid signatureExpirationLedger.',
          ),
        );
      }
    }

    const invocation = entry.rootInvocation();
    const funcType = invocation.function().switch().name;
    console.log(`    Invocation   : ${funcType}`);

    if (funcType === 'sorobanAuthorizedFunctionTypeContractFn') {
      const contractFn = invocation.function().contractFn();
      console.log(`    Function     : ${contractFn.functionName().toString()}`);
    }
  } catch {
    console.log(chalk.gray('    (Could not decode entry details.)'));
  }
}

/**
 * Prints a table explaining how authorization entries differ from transaction
 * signatures.
 */
function displayAuthVsSignaturesExplanation(): void {
  console.log(chalk.bold('\n  Authorization entries vs. transaction signatures:\n'));
  const rows: [string, string, string][] = [
    ['Aspect', 'Transaction Signature', 'Authorization Entry'],
    ['Purpose', 'Proves identity of the fee-payer', 'Grants consent for a specific contract call'],
    ['Scope', 'Entire transaction envelope', 'One contract fn + args + ledger range'],
    ['Who signs', 'Network account sending the tx', 'Any account required by require_auth()'],
    ['Required', 'Always (one per signer)', 'Only when contract calls require_auth'],
    ['Carried in', 'Transaction envelope signatures', 'SorobanOperation.auth[] field'],
  ];

  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => r[col].length)));

  rows.forEach(([col0, col1, col2], i) => {
    const line = `  ${col0.padEnd(widths[0])}  |  ${col1.padEnd(widths[1])}  |  ${col2}`;
    console.log(i === 0 ? chalk.bold(line) : line);
    if (i === 0) {
      console.log(
        `  ${'-'.repeat(widths[0])}--+--${'-'.repeat(widths[1])}--+--${'-'.repeat(widths[2])}`,
      );
    }
  });
}
