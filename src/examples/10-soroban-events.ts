import { rpc, scValToNative } from '@stellar/stellar-sdk';
import chalk from 'chalk';

export async function run(): Promise<void> {
  const rpcUrl = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
  console.log(chalk.blue(`Connecting to Soroban RPC at: ${rpcUrl}`));
  const server = new rpc.Server(rpcUrl);

  // A known contract ID on testnet or a placeholder.
  // We'll use a commonly deployed testnet contract or catch empty streams.
  const contractId = 'CDW6BR4A6MGGCW23SCAVBBBZ3HW4V5C3TJ35OC3D4RQ4A6MGGCW23SCA';

  console.log(chalk.yellow(`\nStep 1: Fetching latest ledger for context...`));
  let latestLedger;
  try {
    const health = await server.getLatestLedger();
    latestLedger = health.sequence;
    console.log(chalk.green(`Latest ledger sequence: ${latestLedger}`));
  } catch (error: any) {
    console.error(chalk.red('Failed to fetch latest ledger:'), error.message);
    return;
  }

  // We look back a few ledgers to find recent events
  const startLedger = Math.max(1, latestLedger - 100);

  console.log(chalk.yellow(`\nStep 2: Retrieving events for contract ID: ${contractId}`));
  console.log(`Searching from ledger ${startLedger} to ${latestLedger}...`);

  try {
    const eventsResponse = await server.getEvents({
      startLedger,
      filters: [
        {
          type: 'contract',
          contractIds: [contractId],
        },
      ],
      limit: 10,
    });

    if (!eventsResponse.events || eventsResponse.events.length === 0) {
      console.log(chalk.gray('No events found for this contract in the recent ledgers.'));
      console.log(
        chalk.cyan(
          '\nSummary: Demonstrated connecting to Soroban event stream and handling an empty stream result.',
        ),
      );
      return;
    }

    console.log(chalk.green(`Found ${eventsResponse.events.length} event(s)!`));

    console.log(chalk.yellow('\nStep 3: Decoding events...'));
    eventsResponse.events.forEach((event, index) => {
      console.log(chalk.magenta(`\n--- Event #${index + 1} ---`));
      console.log(`Type: ${event.type}`);
      console.log(`Ledger: ${event.ledger}`);
      console.log(`Transaction Hash: ${event.txHash}`);
      console.log(`Contract ID: ${event.contractId}`);

      const topics = event.topic.map((t) => {
        try {
          return scValToNative(t);
        } catch {
          return '[Complex Topic]';
        }
      });
      console.log(`Topics: ${JSON.stringify(topics)}`);

      try {
        const payload = scValToNative(event.value);

        // Handle common ScVal types (ScInt conversion is handled by scValToNative which returns bigints or numbers)
        const formatPayload = (p: any): any => {
          if (typeof p === 'bigint') return p.toString();
          if (Buffer.isBuffer(p)) return p.toString('hex'); // Bytes decoding
          if (Array.isArray(p)) return p.map(formatPayload);
          if (typeof p === 'object' && p !== null) {
            const out: any = {};
            for (const key in p) out[key] = formatPayload(p[key]);
            return out;
          }
          return p; // Strings, numbers, booleans, addresses (usually stringified)
        };

        console.log(`Payload:`, JSON.stringify(formatPayload(payload), null, 2));
      } catch (err) {
        console.warn(chalk.red('Failed to decode event payload.'), err);
      }
    });

    console.log(
      chalk.cyan(
        '\nSummary: Demonstrated retrieving, parsing, and decoding Soroban contract events including topics and payloads.',
      ),
    );
  } catch (error: any) {
    console.error(chalk.red('Failed to retrieve events:'), error.message);
  }
}
