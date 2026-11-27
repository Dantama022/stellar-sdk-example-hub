/**
 * CLI: ts-node index.ts <TOKEN_CONTRACT> <ACCOUNT> [--spender ADDRESS] [--decimals N]
 *        [--network testnet|mainnet] [--rpc-url URL]
 * Read-only: simulates balance / allowance / decimals calls; nothing is signed or submitted.
 * The RPC URL may also come from SOROBAN_RPC_URL.
 */
import { inspectToken } from './inspector';

export { inspectToken } from './inspector';
export * from './allowance';
export * from './balance';
export * from './config';
export * from './decode';
export * from './format';
export * from './spec';
export * from './types';

const VALUE_FLAGS = ['--spender', '--decimals', '--network', '--rpc-url'];
const USAGE =
  'Usage: ts-node index.ts <TOKEN_CONTRACT> <ACCOUNT> [--spender ADDRESS] [--decimals N] [--network testnet|mainnet] [--rpc-url URL]';

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const positional = args.filter(
    (a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(args[i - 1])
  );
  if (positional.length !== 2) {
    console.error(USAGE);
    return 2;
  }
  const network = flag('--network') ?? 'testnet';
  if (network !== 'testnet' && network !== 'mainnet') {
    console.error('--network must be "testnet" or "mainnet"');
    return 2;
  }
  const decimalsArg = flag('--decimals');
  if (decimalsArg !== undefined && !/^\d+$/.test(decimalsArg)) {
    console.error('--decimals must be a non-negative integer');
    return 2;
  }

  const result = await inspectToken(positional[0], positional[1], {
    network,
    rpcUrl: flag('--rpc-url') ?? process.env.SOROBAN_RPC_URL,
    spender: flag('--spender'),
    decimals: decimalsArg === undefined ? undefined : Number(decimalsArg),
  });
  // bigint is not JSON-serialisable; print raw amounts as exact decimal strings.
  console.log(JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  return result.status === 'error' ? 1 : 0;
}

if (require.main === module) {
  main(process.argv).then((code) => process.exit(code));
}
