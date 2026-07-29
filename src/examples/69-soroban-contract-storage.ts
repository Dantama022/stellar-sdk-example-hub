import { rpc, scValToNative, xdr } from '@stellar/stellar-sdk';
import chalk from 'chalk';

/**
 * Soroban Contract Storage Inspection Example
 *
 * Soroban smart contracts persist application state using three distinct storage
 * durability tiers:
 *
 *   - Persistent  – survives ledger archival; requires periodic rent extension;
 *                   suitable for user balances or important contract state.
 *   - Temporary   – automatically deleted after a TTL; cheap but ephemeral.
 *   - Instance    – stored alongside the contract instance itself; shared by
 *                   all callers; typically holds configuration or admin keys.
 *
 * Soroban RPC exposes `getLedgerEntries` to read any contract data entry
 * directly, given the serialised XDR key.  This is the same mechanism used
 * by block explorers and indexers to inspect on-chain state without invoking
 * a transaction.
 *
 * This example demonstrates:
 *   1. Connecting to a Soroban RPC endpoint
 *   2. Constructing ledger-entry keys for contract storage
 *   3. Querying instance storage (the most accessible tier)
 *   4. Decoding and displaying keys, values, and durability information
 *   5. Handling missing or unknown keys gracefully
 *   6. Explaining how storage differs from contract events
 */

export async function run(): Promise<void> {
  const rpcUrl = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';

  // Accept a contract ID from the environment; fall back to a well-known
  // Testnet contract.  If the contract is expired or unreachable, the example
  // demonstrates the graceful not-found path.
  const contractId =
    process.env.CONTRACT_ID || 'CDW6BR4A6MGGCW23SCAVBBBZ3HW4V5C3TJ35OC3D4RQ4A6MGGCW23SCA';

  console.log(chalk.bold('Soroban Contract Storage Inspection Example'));
  console.log(
    chalk.gray(
      'Read contract storage entries directly via Soroban RPC without invoking a transaction.',
    ),
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

  // ──────────────────────────────────────────────────────────────────────────
  // Step 2: Query contract instance storage
  //
  // Every deployed contract has an on-chain "instance" entry keyed by:
  //   LedgerKey::ContractData { contract, key: ScVal::LedgerKeyContractInstance,
  //                              durability: Persistent }
  //
  // The `rpc.Server.getContractData` helper constructs this key automatically.
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 2: Querying contract instance storage...'));
  console.log(
    chalk.gray(
      '  Instance storage is collocated with the contract instance entry and holds ' +
        'shared configuration (e.g. admin key, asset address, fee rate).  It is always ' +
        'Persistent durability.',
    ),
  );

  await inspectContractInstance(server, contractId);

  // ──────────────────────────────────────────────────────────────────────────
  // Step 3: Demonstrate querying a named persistent key
  //
  // If you know the storage key used by the contract (from its source code or
  // ABI), you can construct the XDR key directly.  Here we attempt a symbol
  // key named "counter" — common in tutorial contracts.
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 3: Querying a named persistent storage key ("counter")...'));
  console.log(
    chalk.gray(
      '  Persistent storage survives archival and is used for long-lived state such as ' +
        'user balances and counters.  Entries may expire if their TTL is not extended.',
    ),
  );

  await inspectNamedKey(server, contractId, xdr.ScVal.scvSymbol('counter'), 'persistent');

  // ──────────────────────────────────────────────────────────────────────────
  // Step 4: Demonstrate handling a missing key
  //
  // Most contracts will not have a key named "nonexistent_key".  We show the
  // graceful not-found path that any indexer or debugger must handle.
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 4: Querying a known-missing key ("nonexistent_key")...'));
  console.log(
    chalk.gray(
      '  Missing keys are not errors — they simply mean the value has never been written ' +
        'or has been deleted.  Callers should treat an absent entry the same way the ' +
        'contract itself treats it (typically as a default or zero value).',
    ),
  );

  await inspectNamedKey(
    server,
    contractId,
    xdr.ScVal.scvSymbol('nonexistent_key'),
    'persistent',
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Step 5: Explain storage vs events
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 5: Storage vs. contract events'));
  displayStorageVsEventsExplanation();

  console.log(
    chalk.cyan(
      '\nSummary: Connected to Soroban RPC, queried contract instance and persistent ' +
        'storage entries, decoded keys and values, displayed durability information, ' +
        'and demonstrated graceful handling of missing keys — all without submitting ' +
        'a transaction.',
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Queries and displays the contract's instance entry (always Persistent).
 * The instance entry holds the WASM hash and any instance-scoped storage.
 */
async function inspectContractInstance(server: rpc.Server, contractId: string): Promise<void> {
  try {
    // `getContractData` wraps `getLedgerEntries` with the correct key structure.
    const entry = await server.getContractData(
      contractId,
      xdr.ScVal.scvLedgerKeyContractInstance(),
      rpc.Durability.Persistent,
    );

    if (!entry || !entry.val) {
      console.log(chalk.gray('  Instance entry not found — contract may be archived or expired.'));
      return;
    }

    console.log(chalk.green('  Instance entry found.'));
    displayLedgerEntry('Contract Instance', entry);
  } catch (err: any) {
    handleStorageError('contract instance', err);
  }
}

/**
 * Queries a named key from contract storage and displays the result.
 * If the entry is absent, reports that gracefully rather than throwing.
 */
async function inspectNamedKey(
  server: rpc.Server,
  contractId: string,
  key: xdr.ScVal,
  durability: 'persistent' | 'temporary',
): Promise<void> {
  const rpcDurability =
    durability === 'persistent' ? rpc.Durability.Persistent : rpc.Durability.Temporary;

  let keyLabel: string;
  try {
    keyLabel = JSON.stringify(scValToNative(key));
  } catch {
    keyLabel = key.switch().name;
  }

  try {
    const entry = await server.getContractData(contractId, key, rpcDurability);

    if (!entry || !entry.val) {
      console.log(chalk.gray(`  Key ${keyLabel}: not found (entry absent or expired).`));
      return;
    }

    console.log(chalk.green(`  Key ${keyLabel}: found.`));
    displayLedgerEntry(keyLabel, entry);
  } catch (err: any) {
    // A 404-style response from getRPC is surfaced as an error with no entry.
    // We distinguish "not found" from actual connectivity failures.
    if (isNotFoundError(err)) {
      console.log(chalk.gray(`  Key ${keyLabel}: not found (not present in contract storage).`));
    } else {
      handleStorageError(`key "${keyLabel}"`, err);
    }
  }
}

/**
 * Formats and prints a single ledger entry with its value and live-until ledger.
 */
function displayLedgerEntry(label: string, entry: rpc.Api.LedgerEntryResult): void {
  // Decode the value to a native JavaScript representation when possible.
  let decodedValue: string;
  try {
    const valScVal = entry.val.contractData().val();
    const native = scValToNative(valScVal);
    decodedValue = formatNative(native);
  } catch {
    try {
      decodedValue = entry.val.toXDR('base64');
    } catch {
      decodedValue = '(could not decode value)';
    }
  }

  console.log(`    Label             : ${label}`);
  console.log(`    Value             : ${decodedValue}`);
  if (entry.liveUntilLedgerSeq !== undefined) {
    console.log(`    Live until ledger : ${entry.liveUntilLedgerSeq}`);
    console.log(
      chalk.gray(
        `    (Entry expires at ledger ${entry.liveUntilLedgerSeq}; extend TTL via ` +
          '`Operation.extendFootprintTtl` before expiry to keep it alive.)',
      ),
    );
  }
}

/**
 * Prints a concise explanation of the difference between contract storage
 * and contract events.
 */
function displayStorageVsEventsExplanation(): void {
  console.log(
    chalk.bold('\n  Contract storage vs. contract events — key differences:\n'),
  );
  const rows: [string, string][] = [
    ['Storage', 'Mutable, queryable at any time via getLedgerEntries'],
    ['Storage', 'Persists between transactions; may be archived and restored'],
    ['Storage', '3 tiers: Instance (shared config), Persistent (long-lived), Temporary (TTL-bound)'],
    ['Events',  'Immutable log of what happened during past transactions'],
    ['Events',  'Queryable via getEvents with a ledger range and contract filter'],
    ['Events',  'Pruned from node history after the retention window; not queryable forever'],
  ];
  rows.forEach(([kind, description]) => {
    const colour = kind === 'Storage' ? chalk.green : chalk.magenta;
    console.log(`  ${colour(kind.padEnd(8))} : ${description}`);
  });
  console.log(
    chalk.gray(
      '\n  Use storage reads to get the current state of a contract. ' +
        'Use events to reconstruct the history of state changes.',
    ),
  );
}

/**
 * Returns true when the error indicates a missing ledger entry rather than
 * a network or server fault.
 */
function isNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('not found') ||
    msg.includes('entrynotfound') ||
    msg.includes('no entry') ||
    msg.includes('missing')
  );
}

/**
 * Logs a storage query failure in a consistent, user-friendly format.
 */
function handleStorageError(label: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(chalk.red(`  Failed to query ${label}: ${message}`));
  console.log(
    chalk.gray(
      '  This may indicate an expired or un-archived contract entry, an invalid contract ' +
        'ID, or a temporary RPC connectivity issue.',
    ),
  );
}

/**
 * Converts a native JS value to a compact, readable string.
 * BigInt values are rendered without the trailing "n".
 */
function formatNative(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (value === null || value === undefined) return '(null)';
  if (Buffer.isBuffer(value)) return `0x${value.toString('hex')}`;
  if (Array.isArray(value)) return JSON.stringify(value.map(formatNative));
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    } catch {
      return String(value);
    }
  }
  return String(value);
}
