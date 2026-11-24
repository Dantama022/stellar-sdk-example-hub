/**
 * CLI: ts-node index.ts --network testnet --token C... --sender G... --recipient G... --amount 1000000
 *        [--source G...] [--rpc-url URL] [--submit]
 *
 * Dry run by default: the transaction is built, simulated, authorized and preflight-checked, but
 * NOT submitted. Pass --submit to send it after a clean preflight.
 *
 * Secrets come from the environment only, never from arguments or source:
 *   SENDER_SECRET   secret key of the sender (signs the authorization entry, and the envelope
 *                   unless SOURCE_SECRET is set)
 *   SOURCE_SECRET   optional, a separate fee-paying source account
 *   SOROBAN_RPC_URL optional RPC endpoint (required on mainnet)
 */
import { Keypair } from '@stellar/stellar-sdk';
import { keypairAuthSigner } from './authorization';
import { formatReport } from './preflight';
import { createRpcClient } from './rpc';
import { TransferError } from './types';
import { executeTransfer } from './workflow';

export * from './authorization';
export * from './preflight';
export * from './rpc';
export * from './simulation';
export * from './submit';
export * from './transfer';
export * from './types';
export * from './workflow';

const USAGE =
  'Usage: ts-node index.ts --network <testnet|mainnet> --token C... --sender G... --recipient G... --amount <integer> [--source G...] [--rpc-url URL] [--submit]';

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const token = flag('--token');
  const sender = flag('--sender');
  const recipient = flag('--recipient');
  const amount = flag('--amount');
  if (!token || !sender || !recipient || !amount) {
    console.error(USAGE);
    return 2;
  }

  try {
    const senderKey = process.env.SENDER_SECRET ? Keypair.fromSecret(process.env.SENDER_SECRET) : undefined;
    const sourceKey = process.env.SOURCE_SECRET ? Keypair.fromSecret(process.env.SOURCE_SECRET) : senderKey;
    if (senderKey && senderKey.publicKey() !== sender) {
      console.error('SENDER_SECRET does not belong to --sender.');
      return 2;
    }

    const request = {
      network: flag('--network'),
      rpcUrl: flag('--rpc-url') ?? process.env.SOROBAN_RPC_URL,
      token,
      sender,
      recipient,
      amount,
      source: flag('--source') ?? sourceKey?.publicKey(),
    };
    const rpcUrl =
      request.rpcUrl ?? (request.network === 'testnet' ? 'https://soroban-testnet.stellar.org' : '');
    if (!rpcUrl) {
      console.error('Provide --rpc-url or SOROBAN_RPC_URL.');
      return 2;
    }

    const outcome = await executeTransfer(
      request,
      {
        client: createRpcClient(rpcUrl),
        authSigner: senderKey && keypairAuthSigner(senderKey),
        envelopeSigner: sourceKey,
      },
      { submit: args.includes('--submit') }
    );

    console.log(formatReport(outcome.report));
    if (outcome.error) console.error(`\nStopped: [${outcome.error.code}] ${outcome.error.message}`);
    if (outcome.submission) {
      console.log(`\n${outcome.submission.outcome.toUpperCase()}: ${outcome.submission.message}`);
      console.log(`hash: ${outcome.submission.hash}`);
      if (outcome.submission.resultCode) console.log(`result: ${outcome.submission.resultCode}`);
      return outcome.submission.outcome === 'success' ? 0 : 1;
    }
    if (outcome.report.ok) console.log('\nDry run only. Re-run with --submit to send.');
    return outcome.report.ok ? 0 : 1;
  } catch (e) {
    if (e instanceof TransferError) {
      console.error(`[${e.code}] ${e.message}`);
      return 2;
    }
    throw e;
  }
}

if (require.main === module) {
  main(process.argv).then((code) => process.exit(code));
}
