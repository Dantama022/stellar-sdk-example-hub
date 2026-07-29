import {
  Account,
  contract,
  Contract,
  Keypair,
  Networks,
  nativeToScVal,
  rpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import chalk from 'chalk';

/**
 * Generated Soroban Client Usage Example
 *
 * A Soroban contract's WASM carries an `ScSpec`: a machine-readable description
 * of every exported function, its argument names and types, and its return type.
 * `stellar contract bindings typescript` reads that spec and writes out a
 * package containing two things — the spec, embedded as XDR, and a `Client`
 * class built from it. The result is a client whose methods mirror the
 * contract's, with argument and return types your editor autocompletes and the
 * compiler checks.
 *
 * This example builds the same thing without the codegen step, so you can see
 * exactly what generated bindings are:
 *
 *   const spec   = new contract.Spec(entries);        // what bindings embed
 *   const client = new contract.Client(spec, opts);   // what bindings export
 *
 * `contract.Client.from({ contractId, ... })` is the third variant: it fetches
 * the spec off the ledger at runtime instead of embedding it, which is handy for
 * contract IDs you only learn at runtime, at the cost of a network round trip and
 * a dependency on the contract still being live.
 *
 * Calling `client.someMethod({ arg: value })` returns an `AssembledTransaction`
 * that has already been simulated, with the footprint and resource fee filled in,
 * the return value decoded into a native JS value, and `signAndSend()` ready for
 * state-changing calls.
 *
 * This example demonstrates:
 *   1. Declaring a contract spec the way generated bindings embed it
 *   2. Constructing a client from that spec
 *   3. Inspecting the typed methods it exposes
 *   4. Invoking methods with typed arguments and reading decoded results
 *   5. The submission path for state-changing calls
 *   6. The equivalent manual invocation, for comparison
 *   7. Graceful handling of initialization and invocation failures
 */

const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';

// Native XLM Stellar Asset Contract on Testnet. Always deployed, and it
// implements the standard token interface declared below.
const DEFAULT_CONTRACT_ID = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const BASE_FEE = '500000';

export interface GeneratedClientParams {
  rpcUrl?: string;
  contractId?: string;
  fetchSpec?: boolean;
}

/**
 * A client exposes contract methods as ordinary properties, so calling one by
 * name needs an index signature. Narrowing through this type keeps the `any`
 * contained to one documented place — CLI-generated bindings do not need it,
 * because there every method is declared statically.
 */
type DynamicClient = contract.Client & Record<string, (args?: any) => Promise<any>>;

/** Builds one `ScSpecEntry` for a contract function. */
function specFunction(
  name: string,
  inputs: Array<{ name: string; type: xdr.ScSpecTypeDef }>,
  output: xdr.ScSpecTypeDef,
  doc = '',
): xdr.ScSpecEntry {
  return xdr.ScSpecEntry.scSpecEntryFunctionV0(
    new xdr.ScSpecFunctionV0({
      doc,
      name,
      inputs: inputs.map(
        (input) => new xdr.ScSpecFunctionInputV0({ doc: '', name: input.name, type: input.type }),
      ),
      outputs: [output],
    }),
  );
}

/**
 * The subset of SEP-41's token interface this example calls. A real generated
 * binding embeds the equivalent entries as base64 XDR strings — the shape is
 * identical, it is just emitted by a tool instead of written by hand.
 */
export function tokenSpecEntries(): xdr.ScSpecEntry[] {
  return [
    specFunction('decimals', [], xdr.ScSpecTypeDef.scSpecTypeU32(), 'Decimal precision.'),
    specFunction('name', [], xdr.ScSpecTypeDef.scSpecTypeString(), 'Human-readable token name.'),
    specFunction('symbol', [], xdr.ScSpecTypeDef.scSpecTypeString(), 'Token symbol.'),
    specFunction(
      'balance',
      [{ name: 'id', type: xdr.ScSpecTypeDef.scSpecTypeAddress() }],
      xdr.ScSpecTypeDef.scSpecTypeI128(),
      'Balance held by an address.',
    ),
  ];
}

/**
 * Lists the callable method names a client's spec exposes, skipping the
 * `__constructor` entry that appears for contracts that declare one.
 */
export function listClientMethods(client: contract.Client): string[] {
  try {
    return client.spec
      .funcs()
      .map((func) => func.name().toString())
      .filter((name) => name !== '__constructor')
      .sort();
  } catch {
    return [];
  }
}

/**
 * Formats a decoded contract return value together with its JS type, so the
 * spec-driven decoding is visible. Clients hand back native values, which means
 * `bigint` for the 64/128/256-bit integer types and `Buffer` for bytes — neither
 * survives `JSON.stringify`, so both are converted here.
 */
export function formatTypedResult(value: unknown): string {
  if (typeof value === 'bigint') return `${value} (bigint)`;
  if (value === undefined) return 'undefined (void return)';
  if (value === null) return 'null';
  if (Buffer.isBuffer(value)) return `0x${value.toString('hex')} (Buffer)`;
  if (typeof value === 'object') {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === 'bigint') return val.toString();
      if (Buffer.isBuffer(val)) return `0x${val.toString('hex')}`;
      return val;
    });
  }
  return `${String(value)} (${typeof value})`;
}

/**
 * Maps client initialization and invocation failures onto actionable guidance.
 * Never throws — intended for use inside a `catch`.
 */
export function explainClientFailure(errorMessage: unknown): string {
  const lower = String(errorMessage ?? '').toLowerCase();

  if (lower.includes('metadata') || lower.includes('destructure')) {
    return 'That contract exposes no readable spec. Stellar Asset Contracts and other built-in executables run native host code rather than WASM, so Client.from() has nothing to read — supply the spec yourself, as this example does, or invoke the contract manually.';
  }
  if (lower.includes('not found') || lower.includes('no such contract')) {
    return 'The contract ID does not exist on this network. Confirm the ID and that you are pointed at the right RPC endpoint.';
  }
  if (lower.includes('spec') || lower.includes('wasm')) {
    return 'The contract spec could not be read. Contracts built without spec metadata cannot back a client — invoke them manually instead.';
  }
  if (lower.includes('is not a function')) {
    return 'That method is not part of the spec. A spec-derived client only exposes functions the spec declares — check the method list printed above.';
  }
  if (lower.includes('unauthorized') || lower.includes('auth')) {
    return 'The invocation requires authorization the signer did not provide. Call signAuthEntries() before signAndSend() for multi-party auth.';
  }
  return 'Review the raw error above, then verify the contract ID, method name, argument types, and RPC endpoint.';
}

export async function run(params: GeneratedClientParams = {}): Promise<void> {
  const rpcUrl = params.rpcUrl || process.env.SOROBAN_RPC_URL || DEFAULT_RPC_URL;
  const contractId = params.contractId?.trim() || process.env.CONTRACT_ID || DEFAULT_CONTRACT_ID;
  const fetchSpec = params.fetchSpec ?? process.env.FETCH_SPEC === 'true';

  console.log(chalk.bold('Generated Soroban Client Usage Example'));
  console.log(
    chalk.gray('Invoke a contract through a spec-derived client instead of hand-built XDR.'),
  );
  console.log(chalk.blue(`\nRPC endpoint : ${rpcUrl}`));
  console.log(chalk.blue(`Contract     : ${contractId}`));

  const server = new rpc.Server(rpcUrl);
  const keypair = Keypair.random();
  const signer = contract.basicNodeSigner(keypair, Networks.TESTNET);

  // ──────────────────────────────────────────────────────────────────────────
  // Step 1: Fund an account to invoke from
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 1: Funding an account to invoke from...'));
  console.log(`Account: ${keypair.publicKey()}`);
  try {
    const res = await fetch(`https://friendbot.stellar.org/?addr=${keypair.publicKey()}`);
    if (!res.ok) throw new Error(`Friendbot returned HTTP ${res.status}`);
    console.log(chalk.green('Funded via Friendbot.'));
  } catch (err: any) {
    console.error(chalk.red('Friendbot funding failed:'), err.message ?? String(err));
    console.log(chalk.gray('  Simulation needs a real account to invoke from — stopping here.'));
    return;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 2: Obtain a client
  // ──────────────────────────────────────────────────────────────────────────
  let client: contract.Client;
  try {
    if (fetchSpec) {
      console.log(chalk.yellow('\nStep 2: Fetching the spec off the ledger (Client.from)...'));
      client = await contract.Client.from({
        contractId,
        rpcUrl,
        networkPassphrase: Networks.TESTNET,
        publicKey: keypair.publicKey(),
        ...signer,
      });
      console.log(chalk.green('Client built from the on-chain spec.'));
    } else {
      console.log(chalk.yellow('\nStep 2: Building a client from an embedded spec...'));
      const spec = new contract.Spec(tokenSpecEntries());
      client = new contract.Client(spec, {
        contractId,
        rpcUrl,
        networkPassphrase: Networks.TESTNET,
        publicKey: keypair.publicKey(),
        ...signer,
      });
      console.log(
        chalk.green(
          `Client built from ${tokenSpecEntries().length} spec entries — no codegen, no network call.`,
        ),
      );
      console.log(
        chalk.gray(
          '  Set FETCH_SPEC=true to use contract.Client.from() instead and read the spec off the\n' +
            '  ledger. That works for WASM-backed contracts; the native token contract used here is\n' +
            '  a built-in executable with no WASM to read, which is why its spec is supplied locally.',
        ),
      );
    }
  } catch (err: any) {
    const raw = err.message ?? String(err);
    console.error(chalk.red('Client initialization failed:'), raw);
    console.log(chalk.cyan(`  ${explainClientFailure(raw)}`));
    return;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 3: Inspect the typed surface
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 3: Methods exposed by this client'));
  const methods = listClientMethods(client);
  console.log(chalk.gray(`  ${methods.length > 0 ? methods.join(', ') : '(none found in spec)'}`));
  console.log(
    chalk.gray(
      '  Each is a real method on the client object. With CLI-generated bindings the editor\n' +
        '  autocompletes them and the compiler rejects wrong argument types before the code ever\n' +
        '  runs — that is the core benefit over string-keyed manual invocation.',
    ),
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Step 4: Invoke with typed arguments, read decoded results
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 4: Invoking methods through the client...'));

  const dynamicClient = client as DynamicClient;

  // Named arguments, not a positional list — there is no argument order to get
  // wrong, and the spec converts each value to the right ScVal on the way in.
  const invocations: Array<{ method: string; args: Record<string, unknown> }> = [
    { method: 'decimals', args: {} },
    { method: 'symbol', args: {} },
    { method: 'balance', args: { id: keypair.publicKey() } },
  ].filter((invocation) => methods.length === 0 || methods.includes(invocation.method));

  let lastAssembled: any;
  for (const { method, args } of invocations) {
    try {
      const assembled = await dynamicClient[method](args);
      lastAssembled = assembled;
      const argSummary = Object.keys(args).length > 0 ? JSON.stringify(args) : '(no arguments)';
      console.log(chalk.green(`  ${method}(${argSummary})`));
      console.log(`    → ${formatTypedResult(assembled.result)}`);
    } catch (err: any) {
      const raw = err.message ?? String(err);
      console.warn(chalk.red(`  ${method} failed:`), raw);
      console.log(chalk.cyan(`    ${explainClientFailure(raw)}`));
    }
  }

  console.log(
    chalk.gray(
      '\n  Note what did not appear above: no nativeToScVal() on the way in, no scValToNative() on\n' +
        '  the way out. The spec drove both conversions — a `u32` came back as a number, a `String`\n' +
        '  as a string, and an `i128` as a bigint, which is the only JS type that can hold it.\n' +
        '  The Address argument was accepted as a plain `G...` string and encoded for you.',
    ),
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Step 5: The submission path
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 5: The submission path'));
  if (lastAssembled?.isReadCall) {
    console.log(
      chalk.gray(
        '  Every method called above only reads state, so simulation already produced the answer\n' +
          '  and signAndSend() is unnecessary — the SDK refuses it for read calls unless you pass\n' +
          '  { force: true }. A state-changing method is submitted with the very same object:\n' +
          '      const sent = await client.transfer({ from, to, amount });\n' +
          '      await sent.signAndSend();     // signs, submits, polls to completion\n' +
          '      sent.result;                  // decoded return value\n' +
          '  For multi-party auth, call sent.needsNonInvokerSigningBy() and signAuthEntries()\n' +
          '  before signAndSend().',
      ),
    );
  } else if (lastAssembled) {
    try {
      const sent = await lastAssembled.signAndSend();
      console.log(chalk.green('  Signed and submitted.'));
      console.log(`  Status : ${sent.getTransactionResponse?.status ?? 'unknown'}`);
      console.log(`  Result : ${formatTypedResult(sent.result)}`);
    } catch (err: any) {
      const raw = err.message ?? String(err);
      console.warn(chalk.red('  Submission failed:'), raw);
      console.log(chalk.cyan(`  ${explainClientFailure(raw)}`));
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 6: The same call, done manually, for comparison
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 6: The equivalent manual invocation'));
  try {
    const account = await server
      .getAccount(keypair.publicKey())
      .catch(() => new Account(keypair.publicKey(), '0'));

    const manualTx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        // Every argument is converted by hand, and the type must be right:
        // `balance` takes an Address, so a plain string would be rejected.
        new Contract(contractId).call(
          'balance',
          nativeToScVal(keypair.publicKey(), { type: 'address' }),
        ),
      )
      .setTimeout(30)
      .build();

    const simulation = await server.simulateTransaction(manualTx);
    if (rpc.Api.isSimulationError(simulation)) {
      throw new Error(simulation.error);
    }
    const decoded = simulation.result?.retval ? scValToNative(simulation.result.retval) : undefined;

    console.log(chalk.gray('  Manual path, step by step:'));
    console.log(
      chalk.gray(
        '    nativeToScVal(value, { type })            ← you convert every argument, correctly\n' +
          '    new Contract(id).call(method, ...args)    ← you name the method as a string\n' +
          '    new TransactionBuilder(...).build()      ← you own fee, timeout, sequence\n' +
          '    server.simulateTransaction(tx)           ← you check for simulation errors\n' +
          '    rpc.assembleTransaction(tx, sim).build() ← you apply the footprint (for writes)\n' +
          '    tx.sign(kp); server.sendTransaction(tx)  ← you submit and poll\n' +
          '    scValToNative(result.retval)             ← you decode the response',
      ),
    );
    console.log(`  Manual balance result: ${formatTypedResult(decoded)}`);
    console.log(
      chalk.gray(
        '  Same answer, six more steps, and every one of them a place to get a type wrong that\n' +
          '  nothing catches until the network rejects it.',
      ),
    );
  } catch (err: any) {
    console.warn(chalk.red('  Manual comparison failed:'), err.message ?? String(err));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 7: When to prefer which
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 7: Choosing between generated clients and manual invocation'));
  console.log(
    chalk.cyan(
      '  Prefer a generated client when:\n' +
        '    • You call the same contract repeatedly from application code — type safety and\n' +
        '      autocomplete catch argument mistakes at compile time, not on-chain.\n' +
        '    • You want simulate / assemble / sign / submit / decode handled for you.\n' +
        '    • The contract has a stable published interface you can regenerate bindings against.\n' +
        '  Prefer manual invocation when:\n' +
        '    • The contract has no spec metadata — Stellar Asset Contracts and other built-in\n' +
        '      executables run native host code, so there is no WASM spec to generate from.\n' +
        '    • You need unusual control over the envelope: custom time bounds, fee bumps,\n' +
        '      multi-contract batching, or a hand-tuned footprint.\n' +
        '    • You are inspecting or debugging raw XDR, where the abstraction hides what you need.',
    ),
  );

  console.log(
    chalk.cyan(
      '\nSummary: Declared a contract spec the way generated bindings embed it, built a client from\n' +
        'it, listed its typed methods, invoked several with named arguments and decoded results,\n' +
        'walked the submission path, and contrasted it with the manual convert-build-simulate-\n' +
        'assemble-sign-decode sequence.',
    ),
  );
}
