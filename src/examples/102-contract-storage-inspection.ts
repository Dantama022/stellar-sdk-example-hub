import { Asset, Networks, rpc, scValToNative, xdr } from '@stellar/stellar-sdk';
import chalk from 'chalk';

/**
 * Soroban Contract Storage Inspection Example
 *
 * Contract state lives in ledger entries, and during debugging the question is
 * usually "what is actually stored under this key, and is it where I think it
 * is?". Getting that wrong is easy, because the *same key symbol* can exist
 * independently in three durability tiers:
 *
 *   Instance    – collocated with the contract instance. Shared configuration:
 *                 admin address, fee rate, paused flag. Always Persistent.
 *   Persistent  – long-lived per-key state: balances, counters, allowances.
 *                 Survives archival, but must have its rent extended.
 *   Temporary   – deleted permanently once its TTL lapses. Cheap. Suitable for
 *                 nonces and short-lived locks — never for balances.
 *
 * A key present in Temporary is invisible to a Persistent lookup and vice versa,
 * so "my value vanished" is often really "I read the wrong tier".
 *
 * This example is a **sweep**: it probes a set of keys across every tier and
 * prints a table of what exists where, with raw and decoded values side by side.
 * For a narrative walkthrough of a single contract's instance storage, see
 * `69-soroban-contract-storage`; for keeping entries alive, see
 * `103-storage-ttl-management`.
 *
 * This example demonstrates:
 *   1. Connecting to a Soroban RPC endpoint
 *   2. Probing the same key across Persistent and Temporary durability
 *   3. Reading instance storage, including keys held inside the instance entry
 *   4. Displaying storage type, raw ScVal XDR, and decoded value together
 *   5. Handling missing keys without aborting the sweep
 *   6. Handling values that cannot be decoded
 */

/** One probe result, collected so the run can end with a summary table. */
interface ProbeResult {
  key: string;
  durability: string;
  found: boolean;
  decoded: string;
}

export async function run(): Promise<void> {
  const rpcUrl = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
  // Default to the native XLM Stellar Asset Contract: its address is derived
  // deterministically from the network passphrase and it is always deployed, so the
  // example runs out of the box instead of against a placeholder that does not exist.
  const contractId = process.env.CONTRACT_ID || Asset.native().contractId(Networks.TESTNET);

  // Comma-separated symbol keys to probe. Defaults cover names common in
  // tutorial and token contracts.
  const keyNames = (process.env.STORAGE_KEYS || 'COUNTER,Counter,counter,Admin,State')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);

  console.log(chalk.bold('Soroban Contract Storage Inspection Example'));
  console.log(
    chalk.gray('Probe contract storage across durability tiers and decode what is found.'),
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

  console.log(chalk.gray(`\nInspecting contract: ${contractId}`));
  console.log(chalk.gray(`Probing keys        : ${keyNames.join(', ')}`));

  const results: ProbeResult[] = [];

  // ──────────────────────────────────────────────────────────────────────────
  // Step 2: Instance storage
  //
  // The instance entry is keyed by a dedicated ScVal rather than by a symbol,
  // so it is fetched differently from ordinary contract data.
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 2: Instance storage'));
  console.log(
    chalk.gray(
      '  Held alongside the contract instance and shared by every caller. Read it first —\n' +
        '  contracts usually keep their admin and configuration here.',
    ),
  );

  results.push(
    await probe(
      server,
      contractId,
      'contract instance',
      xdr.ScVal.scvLedgerKeyContractInstance(),
      rpc.Durability.Persistent,
    ),
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Step 3: Sweep each key across both durability tiers
  //
  // Probing both tiers is the point: it shows not only what a key holds but
  // which tier it lives in, which is the detail most often misremembered.
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 3: Sweeping named keys across Persistent and Temporary'));

  for (const name of keyNames) {
    console.log(chalk.cyan(`\n  Key: ${name}`));
    const key = xdr.ScVal.scvSymbol(name);

    results.push(await probe(server, contractId, name, key, rpc.Durability.Persistent));
    results.push(await probe(server, contractId, name, key, rpc.Durability.Temporary));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 4: Summary
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 4: Summary'));

  const found = results.filter((r) => r.found);
  if (found.length === 0) {
    console.log(
      chalk.gray(
        '  No entries found. That is an expected outcome for an arbitrary contract — set\n' +
          '  CONTRACT_ID and STORAGE_KEYS to a contract whose keys you know.',
      ),
    );
  } else {
    console.log(chalk.green(`  ${found.length} of ${results.length} probes found an entry:\n`));
    console.log(chalk.bold('    KEY                    DURABILITY    VALUE'));
    for (const r of found) {
      console.log(`    ${pad(r.key, 22)} ${pad(r.durability, 13)} ${r.decoded}`);
    }
  }

  console.log(
    chalk.gray(
      '\n  A key absent from one tier may still exist in the other. If a value seems to have\n' +
        '  disappeared, check the tier before concluding the contract deleted it — and note that\n' +
        '  a lapsed Temporary entry is gone for good, while an archived Persistent entry can be\n' +
        '  restored. See 103-storage-ttl-management.',
    ),
  );

  console.log(chalk.bold.green('\nStorage inspection complete.'));
}

/**
 * Fetch one key at one durability and report what came back.
 *
 * A missing key is an ordinary result here, not an error — the sweep is meant to
 * run to completion and show absence as much as presence.
 */
async function probe(
  server: rpc.Server,
  contractId: string,
  keyLabel: string,
  key: xdr.ScVal,
  durability: rpc.Durability,
): Promise<ProbeResult> {
  const durabilityLabel = durability === rpc.Durability.Persistent ? 'Persistent' : 'Temporary';
  const miss: ProbeResult = {
    key: keyLabel,
    durability: durabilityLabel,
    found: false,
    decoded: '(not found)',
  };

  let entry: rpc.Api.LedgerEntryResult;
  try {
    entry = await server.getContractData(contractId, key, durability);
  } catch (err: any) {
    // The RPC reports a missing entry as an error; treat that as "absent" and
    // surface anything else as a genuine problem.
    if (isNotFound(err)) {
      console.log(chalk.gray(`    ${durabilityLabel.padEnd(10)} not found`));
    } else {
      console.log(chalk.red(`    ${durabilityLabel.padEnd(10)} lookup failed: ${err.message}`));
    }
    return miss;
  }

  console.log(chalk.green(`    ${durabilityLabel.padEnd(10)} found`));

  // Raw XDR first: it is what the ledger actually holds, and it is still useful
  // when decoding fails.
  let raw = '(unavailable)';
  try {
    raw = entry.val.toXDR('base64');
  } catch {
    /* keep the placeholder */
  }
  console.log(chalk.gray(`      Raw ScVal        : ${truncate(raw, 72)}`));

  const decoded = decodeEntryValue(entry);
  console.log(`      Decoded value    : ${decoded}`);

  if (entry.lastModifiedLedgerSeq !== undefined) {
    console.log(chalk.gray(`      Last modified    : ledger ${entry.lastModifiedLedgerSeq}`));
  }
  if (entry.liveUntilLedgerSeq !== undefined) {
    console.log(chalk.gray(`      Live until       : ledger ${entry.liveUntilLedgerSeq}`));
  }

  return { key: keyLabel, durability: durabilityLabel, found: true, decoded };
}

/**
 * Decode a contract-data entry's value.
 *
 * Custom contract types decode to plain objects; anything the SDK cannot map
 * falls back to a description rather than throwing, so one exotic value does not
 * end the sweep.
 */
function decodeEntryValue(entry: rpc.Api.LedgerEntryResult): string {
  try {
    const value = entry.val.contractData().val();

    // A contract instance is not an ordinary value: scValToNative returns its
    // XDR internals, which are unreadable. Unpack the executable and the
    // instance storage map by hand instead.
    if (value.switch() === xdr.ScValType.scvContractInstance()) {
      return describeContractInstance(value);
    }

    const native = scValToNative(value);
    if (typeof native === 'object' && native !== null) {
      return JSON.stringify(native, bigintReplacer);
    }
    return String(native);
  } catch (err: any) {
    return chalk.gray(`(could not decode: ${err.message})`);
  }
}

/**
 * Render a contract instance: what kind of contract it is, plus the key/value
 * pairs held in its instance storage.
 */
function describeContractInstance(value: xdr.ScVal): string {
  const instance = value.instance();
  const executable = instance.executable().switch().name;

  const storage = instance.storage();
  if (!storage || storage.length === 0) {
    return `contract instance (executable: ${executable}, instance storage empty)`;
  }

  const pairs = storage.map((mapEntry) => {
    const key = safeNative(mapEntry.key());
    const val = safeNative(mapEntry.val());
    return `${key}=${val}`;
  });

  return `contract instance (executable: ${executable}) { ${pairs.join(', ')} }`;
}

/** Decode a single ScVal to a compact string, never throwing. */
function safeNative(value: xdr.ScVal): string {
  try {
    const native = scValToNative(value);
    if (typeof native === 'object' && native !== null) {
      return JSON.stringify(native, bigintReplacer);
    }
    return String(native);
  } catch {
    return `(${value.switch().name})`;
  }
}

/** Distinguish "no such entry" from a transport or server failure. */
function isNotFound(err: any): boolean {
  const message = String(err?.message ?? '').toLowerCase();
  return message.includes('not found') || message.includes('could not obtain');
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width - 1) + '…' : value.padEnd(width);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** JSON.stringify cannot serialise bigint, which i128/u64 decode to. */
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
