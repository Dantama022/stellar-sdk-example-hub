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
 * Soroban Simulation Result Analysis Example
 *
 * Simulation answers far more than "will this succeed?". The response carries a
 * resource budget, the exact ledger entries the invocation will touch, the
 * authorizations the host will demand, the value the contract returns, and a
 * diagnostic event log explaining what happened inside the host.
 *
 * This example is about **reading that response**. It does not cover assembling
 * and submitting the resulting transaction — see `68-soroban-contract-simulation`
 * for the simulate-then-submit flow, and `100-authorization-entry-inspection`
 * for decoding the authorization entries in detail.
 *
 * The response comes in three shapes, and telling them apart is the first job:
 *
 *   error    – the invocation trapped. `error` holds the message; `events` usually
 *              explains why in more detail than the message does.
 *   restore  – the invocation *would* succeed, but only because simulation
 *              pretended archived entries were present. A `restorePreamble` says
 *              what must be restored first. Submitting without restoring fails.
 *   success  – ready to assemble and submit.
 *
 * This example demonstrates:
 *   1. Classifying a simulation response
 *   2. Reading the resource budget and minimum resource fee
 *   3. Decoding the footprint into read-only and read-write ledger keys
 *   4. Decoding the return value
 *   5. Summarising authorization requirements
 *   6. Decoding diagnostic events, including contract logs
 *   7. Detecting a restore preamble before it becomes a submission failure
 */

export async function run(): Promise<void> {
  const rpcUrl = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
  // Default to the native XLM Stellar Asset Contract: its address is derived
  // deterministically from the network passphrase and it is always deployed, so the
  // example runs out of the box instead of against a placeholder that does not exist.
  const contractId = process.env.CONTRACT_ID || Asset.native().contractId(Networks.TESTNET);
  // `decimals` is a read-only SAC method taking no arguments — a safe default probe.
  const contractMethod = process.env.CONTRACT_METHOD || 'decimals';

  console.log(chalk.bold('Soroban Simulation Result Analysis Example'));
  console.log(
    chalk.gray('Interpret every part of a simulateTransaction response, not just success/failure.'),
  );
  console.log(chalk.blue(`\nConnecting to Soroban RPC: ${rpcUrl}`));

  const server = new rpc.Server(rpcUrl);

  // ──────────────────────────────────────────────────────────────────────────
  // Step 1: Confirm connectivity
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 1: Confirming RPC connectivity...'));
  try {
    const health = await server.getLatestLedger();
    console.log(chalk.green(`Connected. Latest ledger sequence: ${health.sequence}`));
  } catch (err: any) {
    console.error(chalk.red('Failed to reach Soroban RPC:'), err.message);
    return;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 2: Simulate
  //
  // Simulation is free and changes nothing, so a throwaway source account with
  // sequence 0 is sufficient — it need not exist or be funded.
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 2: Simulating the invocation...'));
  console.log(chalk.gray(`  Contract: ${contractId}`));
  console.log(chalk.gray(`  Method:   ${contractMethod}`));

  const caller = Keypair.random();
  const source = new Account(caller.publicKey(), '0');

  let simulation: rpc.Api.SimulateTransactionResponse;
  try {
    const contract = new Contract(contractId);
    const tx = new TransactionBuilder(source, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(contract.call(contractMethod))
      .setTimeout(30)
      .build();

    simulation = await server.simulateTransaction(tx);
  } catch (err: any) {
    console.error(chalk.red('  Simulation request failed:'), err.message);
    console.log(chalk.gray('  Set CONTRACT_ID and CONTRACT_METHOD to a reachable contract.'));
    return;
  }

  console.log(chalk.gray(`  Server latest ledger at simulation: ${simulation.latestLedger}`));

  // ──────────────────────────────────────────────────────────────────────────
  // Step 3: Classify the response
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 3: Classifying the response...'));

  if (rpc.Api.isSimulationError(simulation)) {
    console.log(chalk.red('  Result: ERROR — the invocation trapped during simulation.'));
    console.log(chalk.gray(`  Message: ${simulation.error}`));
    console.log(
      chalk.gray(
        '  The diagnostic events below usually say more than the message does — they are the\n' +
          '  single most useful part of a failed simulation.',
      ),
    );
    reportDiagnosticEvents(simulation.events);
    return;
  }

  if (rpc.Api.isSimulationRestore(simulation)) {
    console.log(chalk.yellow('  Result: RESTORE REQUIRED'));
    console.log(
      chalk.gray(
        '  The invocation succeeded only because simulation assumed archived entries were\n' +
          '  live. Submitting as-is will fail. Restore them first, then simulate again.',
      ),
    );
    console.log(
      chalk.gray(`  Restore minResourceFee: ${simulation.restorePreamble.minResourceFee} stroops`),
    );
  } else {
    console.log(chalk.green('  Result: SUCCESS — ready to assemble and submit.'));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 4: Resource budget
  //
  // These numbers determine the fee and whether the transaction fits inside the
  // network's per-transaction limits. An invocation can be logically correct and
  // still be unsubmittable because it reads too much.
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 4: Resource budget'));
  console.log(`  Minimum resource fee : ${simulation.minResourceFee} stroops`);

  const sorobanData = simulation.transactionData.build();
  const resources = sorobanData.resources();

  console.log(`  CPU instructions     : ${resources.instructions().toLocaleString()}`);
  console.log(`  Read bytes           : ${resources.readBytes().toLocaleString()}`);
  console.log(`  Write bytes          : ${resources.writeBytes().toLocaleString()}`);
  console.log(
    chalk.gray(
      '  The resource fee pays for these directly. Reducing entries read, or reading smaller\n' +
        '  entries, is usually the cheapest optimisation available.',
    ),
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Step 5: Footprint
  //
  // The footprint is the exact set of ledger entries the invocation touches.
  // Read-write entries are the ones that will actually change.
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 5: Ledger footprint'));

  const footprint = resources.footprint();
  const readOnly = footprint.readOnly();
  const readWrite = footprint.readWrite();

  console.log(chalk.cyan(`  Read-only entries (${readOnly.length}):`));
  if (readOnly.length === 0) {
    console.log(chalk.gray('    (none)'));
  } else {
    readOnly.forEach((key) => console.log(`    - ${describeLedgerKey(key)}`));
  }

  console.log(chalk.cyan(`  Read-write entries (${readWrite.length}):`));
  if (readWrite.length === 0) {
    console.log(chalk.gray('    (none — this invocation does not modify state)'));
  } else {
    readWrite.forEach((key) => console.log(`    - ${describeLedgerKey(key)}`));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 6: Return value and authorization requirements
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 6: Return value and authorization'));

  const result = simulation.result;
  if (!result) {
    console.log(chalk.gray('  No host-function result — this was not an invocation simulation.'));
  } else {
    console.log(`  Return value : ${formatScVal(result.retval)}`);

    if (result.auth.length === 0) {
      console.log(chalk.gray('  Authorization: none required.'));
    } else {
      console.log(
        chalk.gray(
          `  Authorization: ${result.auth.length} entr${result.auth.length === 1 ? 'y' : 'ies'} required.`,
        ),
      );
      console.log(chalk.gray('  Run 100-authorization-entry-inspection to decode them in full.'));
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 7: State changes
  // ──────────────────────────────────────────────────────────────────────────
  const stateChanges = simulation.stateChanges ?? [];
  console.log(chalk.yellow(`\nStep 7: State changes (${stateChanges.length})`));
  if (stateChanges.length === 0) {
    console.log(chalk.gray('  No state diff reported.'));
  } else {
    stateChanges.forEach((change, i) => {
      const kind =
        change.before === null ? 'created' : change.after === null ? 'removed' : 'updated';
      console.log(`  [${i}] ${kind}: ${describeLedgerKey(change.key)}`);
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 8: Diagnostic events
  // ──────────────────────────────────────────────────────────────────────────
  reportDiagnosticEvents(simulation.events);

  console.log(chalk.bold.green('\nSimulation analysis complete.'));
}

/**
 * Decode the diagnostic event log.
 *
 * Diagnostics are off by default on some nodes; an empty log does not mean
 * nothing happened. When present they include contract `log!` output and the
 * host's own reasoning, which is where failure causes actually surface.
 */
function reportDiagnosticEvents(events: xdr.DiagnosticEvent[]): void {
  console.log(chalk.yellow(`\nDiagnostic events (${events.length})`));

  if (events.length === 0) {
    console.log(
      chalk.gray(
        '  None returned. Some RPC providers disable diagnostics — if you are debugging a\n' +
          '  failure and see nothing here, try a node with diagnostics enabled.',
      ),
    );
    return;
  }

  events.forEach((diagnostic, index) => {
    try {
      const successful = diagnostic.inSuccessfulContractCall();
      const event = diagnostic.event();
      const label = successful ? chalk.green('ok  ') : chalk.red('fail');

      console.log(`  [${index}] ${label} type=${event.type().name}`);

      const contractId = event.contractId();
      if (contractId) {
        console.log(chalk.gray(`        contract: ${contractId.toString('hex')}`));
      }

      const body = event.body().v0();

      const topics = body.topics();
      if (topics.length > 0) {
        const rendered = topics.map((topic) => formatScVal(topic)).join(', ');
        console.log(chalk.gray(`        topics  : [${rendered}]`));
      }

      console.log(chalk.gray(`        data    : ${formatScVal(body.data())}`));
    } catch (err: any) {
      // A malformed or unexpected event should not abort the whole report.
      console.log(chalk.gray(`  [${index}] (could not decode: ${err.message})`));
    }
  });
}

/**
 * Render a ledger key compactly. Contract data keys are the interesting ones —
 * they carry the durability tier that determines archival behaviour.
 */
function describeLedgerKey(key: xdr.LedgerKey): string {
  try {
    switch (key.switch()) {
      case xdr.LedgerEntryType.contractData(): {
        const data = key.contractData();
        const durability = data.durability().name;
        const contract = formatScVal(xdr.ScVal.scvAddress(data.contract()));
        return `contractData  contract=${contract}  durability=${durability}  key=${describeDataKey(data.key())}`;
      }
      case xdr.LedgerEntryType.contractCode():
        return `contractCode  hash=${key.contractCode().hash().toString('hex').slice(0, 16)}…`;
      case xdr.LedgerEntryType.account():
        return 'account';
      case xdr.LedgerEntryType.trustline():
        return 'trustline';
      default:
        return key.switch().name;
    }
  } catch {
    return '(undecodable ledger key)';
  }
}

/** Decode an ScVal for display, degrading gracefully rather than throwing. */
function formatScVal(value: xdr.ScVal): string {
  try {
    const native = scValToNative(value);
    return formatNative(native);
  } catch {
    return `(could not decode ${value.switch().name})`;
  }
}

/**
 * Name the special contract-data keys rather than letting them decode to
 * `undefined`, which is what `scValToNative` returns for the instance key.
 */
function describeDataKey(key: xdr.ScVal): string {
  if (key.switch() === xdr.ScValType.scvLedgerKeyContractInstance()) {
    return '<contract instance>';
  }
  if (key.switch() === xdr.ScValType.scvLedgerKeyNonce()) {
    return `<nonce ${key.nonceKey().nonce().toString()}>`;
  }
  return formatScVal(key);
}

/** Render a decoded value compactly; bytes read far better as hex. */
function formatNative(native: unknown): string {
  if (native === undefined) return '(none)';
  if (native instanceof Uint8Array) return `0x${Buffer.from(native).toString('hex')}`;
  if (typeof native === 'object' && native !== null) {
    return JSON.stringify(native, bigintReplacer);
  }
  return String(native);
}

/** JSON.stringify cannot serialise bigint, which i128/u64 decode to. */
function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`;
  // JSON.stringify has already turned Buffers into {type:'Buffer',data:[...]} by
  // the time a replacer sees them nested, so catch that shape too.
  if (
    typeof value === 'object' &&
    value !== null &&
    (value as any).type === 'Buffer' &&
    Array.isArray((value as any).data)
  ) {
    return `0x${Buffer.from((value as any).data as number[]).toString('hex')}`;
  }
  return value;
}
