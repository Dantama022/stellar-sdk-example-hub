import {
  Asset,
  Account,
  Contract,
  Keypair,
  Networks,
  rpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import chalk from 'chalk';

/**
 * Soroban Authorization Entry Inspection Example
 *
 * A `SorobanAuthorizationEntry` records that a specific account consented to a
 * specific contract call, with specific arguments, for a bounded period. Wallets,
 * account-abstraction contracts, and signing UIs must be able to *read* these
 * entries before asking a user to approve them — otherwise the user is signing
 * an opaque blob.
 *
 * This example is about **decoding** an authorization entry: taking the XDR and
 * answering "who is being asked to authorize what?". It deliberately does not
 * repeat the signing flow — see `70-soroban-authorization` for obtaining and
 * signing entries end to end, and `68-soroban-contract-simulation` for
 * simulation in general.
 *
 * An entry has two halves:
 *
 *   credentials     – *who* authorizes, and under what replay protection.
 *                     Either `sourceAccount` (the transaction submitter, implicit,
 *                     no nonce needed) or `address` (any account, carrying a nonce
 *                     and an expiration ledger).
 *
 *   rootInvocation  – *what* is authorized: a contract, a function, its arguments,
 *                     and a tree of sub-invocations the callee may make in turn.
 *                     The tree matters — authorizing a swap may implicitly
 *                     authorize the token transfers underneath it.
 *
 * This example demonstrates:
 *   1. Obtaining authorization entries from simulation
 *   2. Decoding credentials, distinguishing source-account from address credentials
 *   3. Walking the invocation tree, including nested sub-invocations
 *   4. Decoding invocation arguments into native values
 *   5. Reporting replay-protection fields (nonce, signature expiration ledger)
 *   6. Decoding a standalone entry supplied as base64 XDR, as a wallet would
 */

export async function run(): Promise<void> {
  const rpcUrl = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
  // Default to the native XLM Stellar Asset Contract: its address is derived
  // deterministically from the network passphrase and it is always deployed, so the
  // example runs out of the box instead of against a placeholder that does not exist.
  const contractId = process.env.CONTRACT_ID || Asset.native().contractId(Networks.TESTNET);
  // `decimals` is a read-only SAC method taking no arguments — a safe default probe.
  const contractMethod = process.env.CONTRACT_METHOD || 'decimals';

  console.log(chalk.bold('Soroban Authorization Entry Inspection Example'));
  console.log(
    chalk.gray(
      'Decode a SorobanAuthorizationEntry to see who is authorizing which call, with what arguments.',
    ),
  );
  console.log(chalk.blue(`\nConnecting to Soroban RPC: ${rpcUrl}`));

  const server = new rpc.Server(rpcUrl);

  // ──────────────────────────────────────────────────────────────────────────
  // Step 1: Confirm connectivity
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 1: Confirming RPC connectivity...'));
  let latestLedger: number;
  try {
    const health = await server.getLatestLedger();
    latestLedger = health.sequence;
    console.log(chalk.green(`Connected. Latest ledger sequence: ${latestLedger}`));
  } catch (err: any) {
    console.error(chalk.red('Failed to reach Soroban RPC:'), err.message);
    return;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 2: Decode a standalone entry, if one was supplied
  //
  // This is the wallet path: a dApp hands you base64 XDR and you must render it
  // for a human before collecting a signature. No network access is required to
  // decode — only to interpret expiration against the current ledger.
  // ──────────────────────────────────────────────────────────────────────────
  const suppliedXdr = process.env.AUTH_ENTRY_XDR;
  if (suppliedXdr) {
    console.log(chalk.yellow('\nStep 2: Decoding AUTH_ENTRY_XDR supplied by the caller...'));
    try {
      const entry = xdr.SorobanAuthorizationEntry.fromXDR(suppliedXdr, 'base64');
      describeAuthorizationEntry(entry, 0, latestLedger);
    } catch (err: any) {
      console.error(
        chalk.red('  Could not decode AUTH_ENTRY_XDR — is it a base64 SorobanAuthorizationEntry?'),
      );
      console.error(chalk.gray(`  ${err.message}`));
    }
  } else {
    console.log(
      chalk.gray(
        '\nStep 2: Skipped — set AUTH_ENTRY_XDR=<base64> to decode an entry supplied by a dApp.',
      ),
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 3: Obtain entries from simulation
  //
  // Simulation reports which accounts the host will require authorization from.
  // The entries come back *unsigned*: credentials are present, signatures are not.
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 3: Simulating an invocation to obtain its auth entries...'));
  console.log(chalk.gray(`  Contract: ${contractId}`));
  console.log(chalk.gray(`  Method:   ${contractMethod}`));

  // A throwaway keypair is fine: simulation never submits, so the account need
  // not exist or hold a balance. Sequence 0 is accepted for a dry run.
  const caller = Keypair.random();
  const sourceAccount = new Account(caller.publicKey(), '0');

  let simulation: rpc.Api.SimulateTransactionResponse;
  try {
    const contract = new Contract(contractId);
    const tx = new TransactionBuilder(sourceAccount, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(contract.call(contractMethod))
      .setTimeout(30)
      .build();

    simulation = await server.simulateTransaction(tx);
  } catch (err: any) {
    console.error(chalk.red('  Simulation request failed:'), err.message);
    console.log(
      chalk.gray('  Set CONTRACT_ID and CONTRACT_METHOD to a contract reachable on this network.'),
    );
    return;
  }

  if (rpc.Api.isSimulationError(simulation)) {
    console.log(chalk.red('  Simulation returned an error:'));
    console.log(chalk.gray(`    ${simulation.error}`));
    console.log(
      chalk.gray(
        '  A contract that does not exist, or a method name that does not match, both land here.',
      ),
    );
    return;
  }

  const entries = rpc.Api.isSimulationSuccess(simulation) ? (simulation.result?.auth ?? []) : [];

  if (entries.length === 0) {
    console.log(chalk.green('  Simulation succeeded and required no authorization entries.'));
    console.log(
      chalk.gray(
        '  That is normal: a method that neither moves value nor calls `require_auth` needs no\n' +
          '  explicit consent. Try a token transfer to see a populated entry.',
      ),
    );
  } else {
    console.log(
      chalk.green(`  Simulation returned ${entries.length} authorization entr${plural(entries)}.`),
    );
    entries.forEach((entry, index) => describeAuthorizationEntry(entry, index, latestLedger));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 4: What to check before signing
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 4: What a wallet should verify before signing'));
  console.log(
    chalk.gray(
      '  - The invoked contract is the one the user believes they are dealing with.\n' +
        '  - Every sub-invocation is expected. A single approval can authorize a whole tree.\n' +
        '  - Arguments match what the UI displayed, especially amounts and destinations.\n' +
        '  - signatureExpirationLedger is near, not years away — a distant expiry widens the\n' +
        '    window in which a captured signature can be replayed.\n' +
        '  - The nonce has not been seen before for this address.',
    ),
  );

  console.log(chalk.bold.green('\nAuthorization entry inspection complete.'));
  console.log(
    chalk.gray(
      'See 70-soroban-authorization for signing these entries, and 101-simulation-result-analysis\n' +
        'for the rest of what simulation reports.',
    ),
  );
}

/** `entr(y|ies)` without the awkward parenthetical. */
function plural(items: unknown[]): string {
  return items.length === 1 ? 'y' : 'ies';
}

/**
 * Print one authorization entry: who authorizes, and what they authorize.
 */
function describeAuthorizationEntry(
  entry: xdr.SorobanAuthorizationEntry,
  index: number,
  latestLedger: number,
): void {
  console.log(chalk.bold(`\n  Authorization entry #${index + 1}`));

  describeCredentials(entry.credentials(), latestLedger);

  console.log(chalk.cyan('    Invocation tree:'));
  describeInvocation(entry.rootInvocation(), 3);
}

/**
 * Decode the credentials half — *who* is authorizing, and the replay protection
 * that binds their consent.
 */
function describeCredentials(credentials: xdr.SorobanCredentials, latestLedger: number): void {
  switch (credentials.switch()) {
    case xdr.SorobanCredentialsType.sorobanCredentialsSourceAccount(): {
      console.log(chalk.cyan('    Credentials: source account'));
      console.log(
        chalk.gray(
          '      The transaction source implicitly authorizes this call. No nonce or\n' +
            '      expiration is carried — the transaction sequence number already prevents replay,\n' +
            '      and no separate signature is needed.',
        ),
      );
      break;
    }

    case xdr.SorobanCredentialsType.sorobanCredentialsAddress(): {
      const address = credentials.address();
      const expiration = address.signatureExpirationLedger();

      console.log(chalk.cyan('    Credentials: address'));
      console.log(`      Address    : ${describeScAddress(address.address())}`);
      console.log(`      Nonce      : ${address.nonce().toString()}`);
      console.log(`      Expires at : ledger ${expiration}`);

      // Relate the expiry to now, so the reader can judge whether it is sane.
      if (latestLedger > 0) {
        const remaining = expiration - latestLedger;
        if (remaining <= 0) {
          console.log(
            chalk.red(
              `      This entry expired ${Math.abs(remaining)} ledger(s) ago and will be rejected.`,
            ),
          );
        } else {
          console.log(
            chalk.gray(
              `      Valid for ~${remaining} more ledger(s) (roughly ${estimateMinutes(remaining)} minutes).`,
            ),
          );
        }
      }

      const signature = address.signature();
      const signed = signature.switch() !== xdr.ScValType.scvVoid();
      console.log(
        signed
          ? chalk.green('      Signature  : present (entry has been signed)')
          : chalk.gray('      Signature  : absent (unsigned — as returned by simulation)'),
      );
      break;
    }

    default:
      console.log(
        chalk.gray(`    Credentials: unrecognised variant (${credentials.switch().name})`),
      );
  }
}

/**
 * Walk the invocation tree.
 *
 * Sub-invocations are the part most easily overlooked: approving the root also
 * approves everything beneath it, so a signing UI must render the whole tree.
 */
function describeInvocation(invocation: xdr.SorobanAuthorizedInvocation, depth: number): void {
  const pad = '  '.repeat(depth);
  const fn = invocation.function();

  switch (fn.switch()) {
    case xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn(): {
      const contractFn = fn.contractFn();
      console.log(`${pad}Contract : ${describeScAddress(contractFn.contractAddress())}`);
      console.log(`${pad}Function : ${contractFn.functionName().toString()}`);

      const args = contractFn.args();
      if (args.length === 0) {
        console.log(`${pad}Args     : (none)`);
      } else {
        console.log(`${pad}Args     :`);
        args.forEach((arg, i) => {
          console.log(`${pad}  [${i}] ${formatScVal(arg)}`);
        });
      }
      break;
    }

    case xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeCreateContractHostFn(): {
      console.log(`${pad}Function : create contract (host function)`);
      console.log(
        chalk.gray(
          `${pad}           Authorizes deploying a new contract, not calling an existing one.`,
        ),
      );
      break;
    }

    default:
      console.log(`${pad}Function : unrecognised variant (${fn.switch().name})`);
  }

  const subInvocations = invocation.subInvocations();
  if (subInvocations.length > 0) {
    console.log(
      chalk.gray(
        `${pad}Sub-invocations (${subInvocations.length}) — also authorized by this entry:`,
      ),
    );
    subInvocations.forEach((sub) => describeInvocation(sub, depth + 1));
  }
}

/** Render an ScAddress as a readable account or contract identifier. */
function describeScAddress(address: xdr.ScAddress): string {
  try {
    // scValToNative understands addresses once wrapped back into an ScVal.
    return String(scValToNative(xdr.ScVal.scvAddress(address)));
  } catch {
    return `(undecodable ${address.switch().name})`;
  }
}

/**
 * Decode an argument for display, falling back to its XDR type rather than
 * throwing — an example that dies on one unusual argument is not much use.
 */
function formatScVal(value: xdr.ScVal): string {
  try {
    const native = scValToNative(value);
    if (typeof native === 'object' && native !== null) {
      return JSON.stringify(native, bigintReplacer);
    }
    return String(native);
  } catch {
    return chalk.gray(`(could not decode ${value.switch().name})`);
  }
}

/** JSON.stringify cannot serialise bigint, which Soroban i128/u64 decode to. */
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/** Ledgers close roughly every 5 seconds on Stellar. */
function estimateMinutes(ledgers: number): number {
  return Math.round((ledgers * 5) / 60);
}
