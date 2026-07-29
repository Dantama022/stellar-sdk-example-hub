import {
  Contract,
  Keypair,
  nativeToScVal,
  Networks,
  rpc,
  scValToNative,
  StrKey,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import chalk from 'chalk';
import { pollRawTransaction, RawTransactionResult } from '../utils/raw-transaction-poll';

/**
 * Soroban Transaction Event Decoding Example
 *
 * When a contract calls `env.events().publish((topics), data)`, the event is
 * recorded in that transaction's result metadata — not in a separate log. So a
 * confirmed transaction carries its own events:
 *
 *   getTransaction(hash).resultMetaXdr
 *     → .v3().sorobanMeta().events()      // contract events, in emission order
 *
 * Each event has an emitting `contractId`, a list of **topics** (the indexed
 * part — by convention a symbol naming the event followed by the addresses or
 * keys you would filter on), and a single **data** payload. Topics and data are
 * both `ScVal`s, so `scValToNative` turns them into ordinary JS values.
 *
 * This is deliberately different from `server.getEvents(...)`, which queries the
 * network's event index over a ledger range. Transaction-scoped decoding answers
 * "what did *my* call just do?" — exact, immediately available, and unaffected by
 * RPC retention windows. Example 105 covers the historical query path.
 *
 * A version note that this example handles explicitly: protocol 23 introduced
 * `TransactionMetaV4`, and an SDK built before it cannot parse that XDR at all
 * (it fails with "Bad union switch: 4"). Rather than pretend otherwise, the
 * example tries the meta path first and falls back to fetching the same events
 * from the event index filtered down to this one transaction hash. The fallback
 * is still transaction-scoped; only the source differs. Upgrading the SDK to a
 * release that knows `TransactionMetaV4` restores the direct path.
 *
 * This example demonstrates:
 *   1. Connecting to Soroban RPC and funding accounts
 *   2. Invoking a contract method that emits an event
 *   3. Waiting for confirmation and retrieving the transaction result
 *   4. Extracting the transaction's contract events from its result metadata
 *   5. Decoding event topics and payloads into readable output
 *   6. Reporting the transaction hash and ledger sequence
 *   7. Handling transactions that emit no events
 */

const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';

// Native XLM Stellar Asset Contract on Testnet. Its `transfer` emits a real
// ("transfer", from, to, asset) event, which is what this example decodes.
const DEFAULT_CONTRACT_ID = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const BASE_FEE = '500000';
const POLL_ATTEMPTS = 25;

/** 10 XLM in stroops — the amount moved by the default `transfer` invocation. */
const TRANSFER_AMOUNT = 100_000_000n;

export interface EventDecodingParams {
  rpcUrl?: string;
  contractId?: string;
  method?: string;
}

export interface DecodedEvent {
  contractId: string;
  type: string;
  topics: unknown[];
  data: unknown;
}

/** Funds a Testnet account via Friendbot, throwing on a non-2xx response. */
async function fundAccount(publicKey: string): Promise<void> {
  const res = await fetch(`https://friendbot.stellar.org/?addr=${publicKey}`);
  if (!res.ok) throw new Error(`Friendbot returned HTTP ${res.status} for ${publicKey}`);
}

/**
 * Renders a decoded value for the console. `scValToNative` returns `bigint` for
 * the wide integer types and `Buffer` for byte payloads, neither of which
 * `JSON.stringify` handles, so both are converted explicitly.
 */
export function formatDecodedValue(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return String(value);
  if (Buffer.isBuffer(value)) return `0x${value.toString('hex')}`;
  if (typeof value === 'object') {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === 'bigint') return val.toString();
      if (Buffer.isBuffer(val)) return `0x${val.toString('hex')}`;
      return val;
    });
  }
  return String(value);
}

/** Decodes a single `ScVal`, falling back to its raw XDR if it cannot be read. */
function decodeScVal(value: xdr.ScVal): unknown {
  try {
    return scValToNative(value);
  } catch {
    return `<undecodable: ${value.toXDR('base64')}>`;
  }
}

/**
 * Decodes one raw contract event from transaction metadata. A single exotic
 * value never costs you the rest of the event — undecodable parts degrade to
 * their raw XDR.
 */
export function decodeContractEvent(event: xdr.ContractEvent): DecodedEvent {
  const body = event.body().v0();

  let contractId = 'unknown';
  try {
    const raw = event.contractId();
    contractId = raw ? StrKey.encodeContract(raw) : 'none';
  } catch {
    contractId = 'unknown';
  }

  return {
    contractId,
    type: event.type().name,
    topics: body.topics().map(decodeScVal),
    data: decodeScVal(body.data()),
  };
}

/** Decodes an event as returned by the RPC event index. */
export function decodeEventResponse(event: rpc.Api.EventResponse): DecodedEvent {
  return {
    contractId: event.contractId?.contractId() ?? 'unknown',
    type: String(event.type),
    topics: event.topic.map(decodeScVal),
    data: decodeScVal(event.value),
  };
}

/**
 * Pulls the contract events out of a transaction's result metadata.
 *
 * Throws when the metadata is a version this SDK build cannot parse — callers
 * are expected to catch that and fall back. Returns an empty array when the
 * transaction simply emitted nothing.
 */
export function decodeEventsFromMeta(resultMetaXdr: string): DecodedEvent[] {
  const meta = xdr.TransactionMeta.fromXDR(resultMetaXdr, 'base64');
  const sorobanMeta = meta.v3().sorobanMeta();
  if (!sorobanMeta) return [];
  return sorobanMeta.events().map(decodeContractEvent);
}

export async function run(params: EventDecodingParams = {}): Promise<void> {
  const rpcUrl = params.rpcUrl || process.env.SOROBAN_RPC_URL || DEFAULT_RPC_URL;
  const contractId = params.contractId?.trim() || process.env.CONTRACT_ID || DEFAULT_CONTRACT_ID;
  // Override CONTRACT_ID/CONTRACT_METHOD to call a no-argument method on a
  // contract of your own; the default invokes the native token's `transfer`.
  const methodName = params.method?.trim() || process.env.CONTRACT_METHOD || 'transfer';
  const isDefaultTransfer = methodName === 'transfer' && contractId === DEFAULT_CONTRACT_ID;

  console.log(chalk.bold('Soroban Transaction Event Decoding Example'));
  console.log(chalk.gray('Read and decode the events a single contract invocation emitted.'));
  console.log(chalk.blue(`\nRPC endpoint : ${rpcUrl}`));
  console.log(chalk.blue(`Contract     : ${contractId}`));
  console.log(chalk.blue(`Method       : ${methodName}`));

  const server = new rpc.Server(rpcUrl);

  // ──────────────────────────────────────────────────────────────────────────
  // Step 1: Connectivity and accounts
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 1: Connecting and funding accounts...'));
  try {
    const latest = await server.getLatestLedger();
    console.log(chalk.green(`Connected. Latest ledger: ${latest.sequence}`));
  } catch (err: any) {
    console.error(chalk.red('Failed to reach Soroban RPC:'), err.message ?? String(err));
    return;
  }

  const keypair = Keypair.random();
  const recipient = Keypair.random();
  try {
    const fundings = [fundAccount(keypair.publicKey())];
    // The default transfer needs a live destination — the native token contract
    // will not create an account that does not exist yet.
    if (isDefaultTransfer) fundings.push(fundAccount(recipient.publicKey()));
    await Promise.all(fundings);
    console.log(chalk.green(`Funded invoker   ${keypair.publicKey()}`));
    if (isDefaultTransfer) {
      console.log(chalk.green(`Funded recipient ${recipient.publicKey()}`));
    }
  } catch (err: any) {
    console.error(chalk.red('Friendbot funding failed:'), err.message ?? String(err));
    console.log(chalk.gray('  Without funded accounts the invocation cannot be submitted.'));
    return;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 2: Invoke the contract
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 2: Invoking the contract...'));

  let txHash: string;
  let result: RawTransactionResult;

  try {
    const account = await server.getAccount(keypair.publicKey());

    // Arguments for the default transfer: (from: Address, to: Address, amount: i128).
    // Authorization is covered by the transaction's source account — simulation
    // returns the matching auth entry and assembleTransaction attaches it.
    const args: xdr.ScVal[] = isDefaultTransfer
      ? [
          nativeToScVal(keypair.publicKey(), { type: 'address' }),
          nativeToScVal(recipient.publicKey(), { type: 'address' }),
          nativeToScVal(TRANSFER_AMOUNT, { type: 'i128' }),
        ]
      : [];

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(new Contract(contractId).call(methodName, ...args))
      .setTimeout(60)
      .build();

    const simulation = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(simulation)) {
      throw new Error(`Simulation failed: ${simulation.error}`);
    }

    const prepared = rpc.assembleTransaction(tx, simulation).build();
    prepared.sign(keypair);

    const sent = await server.sendTransaction(prepared);
    if (sent.status === 'ERROR') {
      throw new Error(`Submission rejected: ${sent.errorResult?.toXDR('base64')}`);
    }
    txHash = sent.hash;
    console.log(chalk.green(`  Submitted. Hash: ${txHash}`));

    // ────────────────────────────────────────────────────────────────────────
    // Step 3: Wait for confirmation and retrieve the result
    // ────────────────────────────────────────────────────────────────────────
    console.log(chalk.yellow('\nStep 3: Waiting for confirmation...'));
    // Polled over raw JSON-RPC so the metadata arrives unparsed — see Step 4.
    result = await pollRawTransaction(rpcUrl, txHash, { attempts: POLL_ATTEMPTS });
    if (result.status !== 'SUCCESS') {
      throw new Error(`Transaction finished with status ${result.status}`);
    }
    console.log(chalk.green(`  Confirmed in ledger ${result.ledger}`));
  } catch (err: any) {
    console.error(chalk.red('Invocation failed:'), err.message ?? String(err));
    console.log(
      chalk.cyan(
        '  Verify the contract ID and method name. Events can only be read from a transaction that\n' +
          '  actually executed — a rejected transaction produces no Soroban metadata.',
      ),
    );
    return;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 4: Extract this transaction's events
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow("\nStep 4: Extracting this transaction's contract events..."));

  let events: DecodedEvent[] = [];
  let source = 'transaction result metadata';

  try {
    if (!result.resultMetaXdr) throw new Error('Response carried no resultMetaXdr');
    events = decodeEventsFromMeta(result.resultMetaXdr);
    console.log(chalk.green('  Read directly from the transaction metadata.'));
  } catch (err: any) {
    console.log(
      chalk.gray(
        `  Metadata could not be parsed by this SDK build (${err.message ?? String(err)}).\n` +
          '  Falling back to the event index, filtered to this transaction hash — same events,\n' +
          '  different source. Upgrade the SDK to a release that knows TransactionMetaV4 to read\n' +
          '  them straight from the metadata.',
      ),
    );
    source = 'event index, filtered to this transaction';
    try {
      const indexed = await server.getEvents({
        startLedger: result.ledger,
        filters: [{ type: 'contract', contractIds: [contractId] }],
        limit: 100,
      });
      events = indexed.events.filter((event) => event.txHash === txHash).map(decodeEventResponse);
    } catch (fallbackErr: any) {
      console.warn(
        chalk.red('  Event index query also failed:'),
        fallbackErr.message ?? String(fallbackErr),
      );
    }
  }

  console.log(`  Transaction hash : ${txHash}`);
  console.log(`  Ledger sequence  : ${result.ledger}`);
  console.log(`  Source           : ${source}`);
  console.log(`  Events emitted   : ${events.length}`);

  // ──────────────────────────────────────────────────────────────────────────
  // Step 5: Decode topics and payloads
  // ──────────────────────────────────────────────────────────────────────────
  if (events.length === 0) {
    console.log(chalk.yellow('\nStep 5: No events to decode'));
    console.log(
      chalk.gray(
        '  This transaction emitted no contract events. That is a normal outcome, not an error:\n' +
          '  read-only methods and any method that never calls events().publish(...) produce none,\n' +
          '  so consumers should treat an empty list as valid rather than as a failure.\n' +
          '  To see decoding in action, invoke a state-changing method — a token transfer, for\n' +
          '  instance, emits a ("transfer", from, to) topic tuple with the amount as its payload.',
      ),
    );
  } else {
    console.log(chalk.yellow('\nStep 5: Decoded events'));
    events.forEach((event, index) => {
      console.log(chalk.bold(`\n  Event #${index + 1}`));
      console.log(`    Emitting contract : ${event.contractId}`);
      console.log(`    Event type        : ${event.type}`);
      console.log(
        `    Topics            : ${
          event.topics.length > 0
            ? event.topics.map((topic) => formatDecodedValue(topic)).join(' | ')
            : '(none)'
        }`,
      );
      console.log(`    Payload           : ${formatDecodedValue(event.data)}`);
    });
    console.log(
      chalk.gray(
        '\n  Topics are the indexed part of an event — by convention the first topic is a symbol\n' +
          '  naming the event, followed by the addresses or keys you want to filter on. The payload\n' +
          '  is a single value, often a map or struct when more than one field is needed.',
      ),
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 6: Transaction events vs historical queries
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 6: Transaction events vs historical event queries'));
  console.log(
    chalk.cyan(
      '  Transaction-scoped (this example):\n' +
        '    • Source: getTransaction(hash).resultMetaXdr → sorobanMeta().events()\n' +
        '    • Exactly the events your call produced, in emission order, no filtering needed.\n' +
        '    • Available the moment the transaction confirms, and never subject to RPC retention.\n' +
        '    • Right for: updating local state after a write, confirming an action took effect,\n' +
        '      showing a receipt, debugging one invocation.\n' +
        '  Historical (server.getEvents, example 105):\n' +
        "    • Source: the RPC node's event index, queried over a ledger range with filters.\n" +
        '    • Spans many transactions and contracts, but is bounded by the retention window and\n' +
        '      needs pagination.\n' +
        '    • Right for: indexers, backfills, analytics, and watching contracts you did not call.',
    ),
  );

  console.log(
    chalk.cyan(
      '\nSummary: Submitted a contract invocation, waited for confirmation, extracted the events\n' +
        'belonging to that one transaction, decoded their topics and payloads into native values\n' +
        'alongside the transaction hash and ledger, and handled the no-event case.',
    ),
  );
}
