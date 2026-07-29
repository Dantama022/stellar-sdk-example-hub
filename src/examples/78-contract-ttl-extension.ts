import {
  Contract,
  Keypair,
  Networks,
  Operation,
  rpc,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import chalk from 'chalk';
import { pollRawTransaction } from '../utils/raw-transaction-poll';

/**
 * Soroban Contract TTL Extension Example
 *
 * A deployed Soroban contract is not one ledger entry but two:
 *
 *   • the **instance** — a CONTRACT_DATA entry keyed by
 *     `scvLedgerKeyContractInstance()`, holding the contract's storage root and
 *     a pointer to its code;
 *   • the **code** — a CONTRACT_CODE entry holding the WASM itself, shared by
 *     every contract deployed from the same upload.
 *
 * Both are rent-bearing, and each carries its own `liveUntilLedgerSeq`. When the
 * network's ledger sequence passes that value, the entry is archived and calls
 * into the contract begin to fail. `ExtendFootprintTTL` pushes the value
 * further out: `extendTo` is a number of ledgers *from now*, and the network
 * takes the maximum of the current and requested lifetimes — extending is never
 * a downgrade, and extending past the network maximum is rejected.
 *
 * Note that both entries must stay alive. A live instance pointing at archived
 * code is just as unusable as an archived instance, so production deployments
 * usually extend both in a single transaction.
 *
 * This example demonstrates:
 *   1. Connecting to Soroban RPC and validating a contract ID
 *   2. Reading the instance and code entries and their current TTLs
 *   3. Reporting remaining ledger lifetime in ledgers and approximate time
 *   4. Building, simulating, signing, and submitting an ExtendFootprintTTL
 *   5. Re-reading the entries to confirm the TTL increased
 *   6. Handling invalid IDs and non-extendable entries gracefully
 */

const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';
const DEFAULT_CONTRACT_ID = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const BASE_FEE = '1000000';
const POLL_ATTEMPTS = 25;

/** Testnet closes a ledger roughly every 5 seconds. */
const SECONDS_PER_LEDGER = 5;

export interface ContractTtlParams {
  rpcUrl?: string;
  contractId?: string;
  extendTo?: string | number;
}

export interface TtlSnapshot {
  liveUntilLedgerSeq?: number;
  ledgersRemaining?: number;
}

/**
 * Validates a contract ID as a well-formed `C...` strkey before any network
 * call, so a typo produces a clear message instead of an opaque RPC error.
 */
export function isValidContractId(contractId: string): boolean {
  try {
    return StrKey.isValidContract(contractId);
  } catch {
    return false;
  }
}

/** Ledger key for a contract's instance entry. */
export function instanceLedgerKey(contractId: string): xdr.LedgerKey {
  return new Contract(contractId).getFootprint();
}

/**
 * Ledger key for the CONTRACT_CODE entry a contract instance points at, or
 * `null` when the instance does not reference uploaded WASM (as is the case for
 * Stellar Asset Contracts, which run native host code).
 */
export function codeLedgerKeyFromInstance(entry: rpc.Api.LedgerEntryResult): xdr.LedgerKey | null {
  try {
    const instance = entry.val.contractData().val().instance();
    const executable = instance.executable();
    if (executable.switch().name !== 'contractExecutableWasm') {
      return null;
    }
    return xdr.LedgerKey.contractCode(
      new xdr.LedgerKeyContractCode({ hash: executable.wasmHash() }),
    );
  } catch {
    return null;
  }
}

/**
 * Turns a raw `liveUntilLedgerSeq` into a snapshot relative to the current
 * ledger. A missing `liveUntilLedgerSeq` means the entry is not rent-bearing
 * and has no TTL to extend.
 */
export function summarizeTtl(
  liveUntilLedgerSeq: number | undefined,
  latestLedger: number,
): TtlSnapshot {
  if (liveUntilLedgerSeq === undefined) return {};
  return {
    liveUntilLedgerSeq,
    ledgersRemaining: liveUntilLedgerSeq - latestLedger,
  };
}

/** Formats a ledger count as an approximate human-readable duration. */
export function describeLedgerSpan(ledgers: number): string {
  if (ledgers <= 0) return 'already archived';
  const seconds = ledgers * SECONDS_PER_LEDGER;
  const days = seconds / 86400;
  if (days >= 1) return `~${days.toFixed(1)} days`;
  const hours = seconds / 3600;
  if (hours >= 1) return `~${hours.toFixed(1)} hours`;
  return `~${Math.round(seconds / 60)} minutes`;
}

/** Maps a TTL-extension failure to actionable guidance. Never throws. */
export function explainTtlFailure(errorMessage: unknown): string {
  const lower = String(errorMessage ?? '').toLowerCase();

  if (lower.includes('not found') || lower.includes('missing')) {
    return 'The entry is not in the live ledger — it is archived, not merely expiring. Use Operation.restoreFootprint first, then extend.';
  }
  if (lower.includes('max') || lower.includes('too large') || lower.includes('exceed')) {
    return 'extendTo exceeds the network maximum entry lifetime. Lower it (Testnet caps at roughly 120 days of ledgers) and retry.';
  }
  if (lower.includes('insufficient') || lower.includes('underfunded')) {
    return 'The fee-payer cannot cover the rent bump. Extension cost scales with entry size and extension length — fund the account or extend less far.';
  }
  if (lower.includes('malformed') || lower.includes('footprint')) {
    return 'The footprint was rejected. ExtendFootprintTTL requires the entries in the read-only footprint, never the read-write one.';
  }
  return 'Review the raw error above and confirm the contract ID, the extendTo value, and that the entries are live rather than archived.';
}

export async function run(params: ContractTtlParams = {}): Promise<void> {
  const rpcUrl = params.rpcUrl || process.env.SOROBAN_RPC_URL || DEFAULT_RPC_URL;
  const contractId = params.contractId?.trim() || process.env.CONTRACT_ID || DEFAULT_CONTRACT_ID;
  const extendTo = Number(params.extendTo ?? process.env.EXTEND_TO ?? 100_000);

  console.log(chalk.bold('Soroban Contract TTL Extension Example'));
  console.log(chalk.gray("Inspect a contract's remaining lifetime and push it further out."));
  console.log(chalk.blue(`\nRPC endpoint : ${rpcUrl}`));
  console.log(chalk.blue(`Contract     : ${contractId}`));

  // ──────────────────────────────────────────────────────────────────────────
  // Step 1: Validate input before touching the network
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 1: Validating the contract ID...'));
  if (!isValidContractId(contractId)) {
    console.error(chalk.red(`Not a valid contract ID: ${contractId}`));
    console.log(
      chalk.cyan('  Contract IDs are strkeys beginning with "C" and are 56 characters long.'),
    );
    return;
  }
  console.log(chalk.green('Contract ID is a well-formed strkey.'));

  if (!Number.isInteger(extendTo) || extendTo <= 0) {
    console.error(
      chalk.red(`extendTo must be a positive whole number of ledgers; got ${extendTo}`),
    );
    return;
  }

  const server = new rpc.Server(rpcUrl);

  // ──────────────────────────────────────────────────────────────────────────
  // Step 2: Read the current TTLs
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 2: Reading current contract TTL...'));

  let latestLedger: number;
  let instanceEntry: rpc.Api.LedgerEntryResult | undefined;
  let codeKey: xdr.LedgerKey | null = null;
  let codeEntry: rpc.Api.LedgerEntryResult | undefined;

  const instanceKey = instanceLedgerKey(contractId);

  try {
    latestLedger = (await server.getLatestLedger()).sequence;
    const response = await server.getLedgerEntries(instanceKey);
    instanceEntry = response.entries[0];
  } catch (err: any) {
    console.error(chalk.red('Failed to read the contract instance:'), err.message ?? String(err));
    console.log(chalk.cyan(`  ${explainTtlFailure(err.message ?? err)}`));
    return;
  }

  if (!instanceEntry) {
    console.error(chalk.red('No live instance entry found for this contract.'));
    console.log(chalk.cyan(`  ${explainTtlFailure('not found')}`));
    return;
  }

  console.log(chalk.green(`Latest ledger: ${latestLedger}`));

  const instanceTtl = summarizeTtl(instanceEntry.liveUntilLedgerSeq, latestLedger);
  if (instanceTtl.liveUntilLedgerSeq === undefined) {
    console.log(chalk.gray('  Instance entry reports no liveUntilLedgerSeq (not rent-bearing).'));
  } else {
    console.log(`  Instance live until ledger : ${instanceTtl.liveUntilLedgerSeq}`);
    console.log(
      `  Instance ledgers remaining : ${instanceTtl.ledgersRemaining} (${describeLedgerSpan(
        instanceTtl.ledgersRemaining ?? 0,
      )})`,
    );
  }

  codeKey = codeLedgerKeyFromInstance(instanceEntry);
  if (!codeKey) {
    console.log(
      chalk.gray(
        '  This contract has no separate WASM entry — it is a built-in (Stellar Asset Contract)\n' +
          '  executable, so only the instance entry carries a TTL.',
      ),
    );
  } else {
    try {
      const codeResponse = await server.getLedgerEntries(codeKey);
      codeEntry = codeResponse.entries[0];
      const codeTtl = summarizeTtl(codeEntry?.liveUntilLedgerSeq, latestLedger);
      if (codeTtl.liveUntilLedgerSeq === undefined) {
        console.log(chalk.gray('  Code entry reports no liveUntilLedgerSeq.'));
      } else {
        console.log(`  Code live until ledger     : ${codeTtl.liveUntilLedgerSeq}`);
        console.log(
          `  Code ledgers remaining     : ${codeTtl.ledgersRemaining} (${describeLedgerSpan(
            codeTtl.ledgersRemaining ?? 0,
          )})`,
        );
      }
    } catch (err: any) {
      console.warn(chalk.red('  Could not read the code entry:'), err.message ?? String(err));
      codeKey = null;
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 3: Should we extend?
  // ──────────────────────────────────────────────────────────────────────────
  const currentRemaining = instanceTtl.ledgersRemaining ?? 0;
  console.log(chalk.yellow('\nStep 3: Deciding whether to extend'));
  if (currentRemaining >= extendTo) {
    console.log(
      chalk.gray(
        `  The instance already lives ${currentRemaining} ledgers out, which is at least the requested\n` +
          `  extendTo of ${extendTo}. The network takes the maximum of current and requested lifetimes,\n` +
          '  so this extension would be a no-op. Raise EXTEND_TO to see a change.',
      ),
    );
  } else {
    console.log(
      chalk.gray(
        `  Requesting extendTo=${extendTo} ledgers (${describeLedgerSpan(extendTo)}), up from ` +
          `${currentRemaining}.`,
      ),
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 4: Extend, unless the user opted out
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 4: Building and submitting the extension transaction...'));

  // Anyone can pay to extend anyone's entries — rent is not tied to ownership —
  // so an ephemeral Friendbot account suffices. Set SECRET_KEY to pay from a
  // specific account instead.
  const secretKey = process.env.SECRET_KEY;
  let keypair: Keypair;

  if (secretKey) {
    try {
      keypair = Keypair.fromSecret(secretKey);
    } catch {
      console.error(chalk.red('SECRET_KEY is not a valid Stellar secret key (S...).'));
      return;
    }
    console.log(chalk.gray(`  Paying from SECRET_KEY account ${keypair.publicKey()}`));
  } else {
    keypair = Keypair.random();
    try {
      const res = await fetch(`https://friendbot.stellar.org/?addr=${keypair.publicKey()}`);
      if (!res.ok) throw new Error(`Friendbot returned HTTP ${res.status}`);
      console.log(chalk.gray(`  Paying from ephemeral funded account ${keypair.publicKey()}`));
    } catch (err: any) {
      console.warn(chalk.red('  Friendbot funding failed:'), err.message ?? String(err));
      console.log(
        chalk.gray('  Set SECRET_KEY to a funded account to submit the extension instead.'),
      );
      printGuidance();
      return;
    }
  }

  try {
    const account = await server.getAccount(keypair.publicKey());

    // ExtendFootprintTTL names its targets in the READ-ONLY footprint. Both the
    // instance and (when present) the code entry go in, so a single transaction
    // keeps the whole contract alive.
    const readOnlyKeys = codeKey ? [instanceKey, codeKey] : [instanceKey];
    const sorobanData = new SorobanDataBuilder().setFootprint(readOnlyKeys, []).build();

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .setSorobanData(sorobanData)
      .addOperation(Operation.extendFootprintTtl({ extendTo }))
      .setTimeout(60)
      .build();

    const simulation = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(simulation)) {
      throw new Error(`Simulation failed: ${simulation.error}`);
    }
    console.log(chalk.green(`  Simulated. Resource fee: ${simulation.minResourceFee} stroops`));

    const prepared = rpc.assembleTransaction(tx, simulation).build();
    prepared.sign(keypair);

    const sent = await server.sendTransaction(prepared);
    if (sent.status === 'ERROR') {
      throw new Error(`Submission rejected: ${sent.errorResult?.toXDR('base64')}`);
    }
    console.log(chalk.green(`  Submitted. Hash: ${sent.hash}`));

    // Polled over raw JSON-RPC so a protocol newer than the installed SDK cannot
    // break the wait on metadata this example never needs to decode.
    const settled = await pollRawTransaction(rpcUrl, sent.hash, { attempts: POLL_ATTEMPTS });
    if (settled.status !== 'SUCCESS') {
      throw new Error(`Transaction finished with status ${settled.status}`);
    }
    console.log(chalk.green('  Extension confirmed.'));

    // ────────────────────────────────────────────────────────────────────────
    // Step 5: Verify the new TTL
    // ────────────────────────────────────────────────────────────────────────
    console.log(chalk.yellow('\nStep 5: Verifying the updated TTL...'));
    const afterLedger = (await server.getLatestLedger()).sequence;
    const after = await server.getLedgerEntries(instanceKey);
    const afterTtl = summarizeTtl(after.entries[0]?.liveUntilLedgerSeq, afterLedger);

    console.log(`  Before : live until ${instanceTtl.liveUntilLedgerSeq ?? 'n/a'}`);
    console.log(`  After  : live until ${afterTtl.liveUntilLedgerSeq ?? 'n/a'}`);

    if (
      afterTtl.liveUntilLedgerSeq !== undefined &&
      instanceTtl.liveUntilLedgerSeq !== undefined &&
      afterTtl.liveUntilLedgerSeq > instanceTtl.liveUntilLedgerSeq
    ) {
      console.log(
        chalk.green(
          `  TTL increased by ${afterTtl.liveUntilLedgerSeq - instanceTtl.liveUntilLedgerSeq} ledgers.`,
        ),
      );
    } else {
      console.log(
        chalk.gray(
          '  TTL unchanged — the entry already lived at least extendTo ledgers out, so the network\n' +
            '  kept the longer existing lifetime.',
        ),
      );
    }
  } catch (err: any) {
    const raw = err.message ?? String(err);
    console.warn(chalk.red('  Extension failed:'), raw);
    console.log(chalk.cyan(`  ${explainTtlFailure(raw)}`));
  }

  printGuidance();
}

function printGuidance(): void {
  console.log(chalk.yellow('\nWhen TTL extension matters'));
  console.log(
    chalk.cyan(
      '  • Availability: once the instance or code entry is archived, every call into the contract\n' +
        '    fails until it is restored. Extension is how you avoid that outage.\n' +
        '  • Extend both entries: a live instance pointing at archived code is still unusable.\n' +
        '  • Extend early and on a schedule. Extension is cheaper than restoration, and unlike\n' +
        '    restoration it never causes downtime.\n' +
        '  • Cost scales with entry size × extension length, so pick a cadence rather than always\n' +
        '    requesting the network maximum.\n' +
        '  • extendTo is relative to the current ledger and applied as a maximum, so re-running an\n' +
        '    extension is safe — it can never shorten a lifetime.',
    ),
  );

  console.log(
    chalk.cyan(
      '\nSummary: Validated a contract ID, read the instance and code TTLs with their remaining\n' +
        'lifetimes, built and submitted an ExtendFootprintTTL transaction over both entries, and\n' +
        're-read the ledger to confirm the new expiry.',
    ),
  );
}
