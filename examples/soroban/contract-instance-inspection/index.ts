/**
 * CLI: ts-node index.ts <CONTRACT_ADDRESS> [--network testnet|mainnet]
 *        [--rpc-url URL] [--no-values] [--include-xdr]
 * Read-only. The RPC URL may also come from SOROBAN_RPC_URL.
 */
import { inspectContractInstance, NetworkName } from './inspector';
import { InspectionResult } from './types';

export { inspectContractInstance } from './inspector';
export * from './decoder';
export * from './types';

/** Replace decoded values with type names only, so output is safe to paste into logs. */
function redact(result: InspectionResult): InspectionResult {
  return {
    ...result,
    storage: result.storage.map((e) => ({
      index: e.index,
      key: { type: e.key.type, supported: e.key.supported },
      value: { type: e.value.type, supported: e.value.supported },
    })),
    instance: result.instance && { ...result.instance, entryXdr: undefined },
  };
}

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const address = args.find(
    (a, i) => !a.startsWith('--') && !['--network', '--rpc-url'].includes(args[i - 1])
  );
  if (!address) {
    console.error(
      'Usage: ts-node index.ts <CONTRACT_ADDRESS> [--network testnet|mainnet] [--rpc-url URL] [--no-values] [--include-xdr]'
    );
    return 2;
  }
  const network = (flag('--network') ?? 'testnet') as NetworkName;
  if (network !== 'testnet' && network !== 'mainnet') {
    console.error('--network must be "testnet" or "mainnet"');
    return 2;
  }

  const result = await inspectContractInstance(address, {
    network,
    rpcUrl: flag('--rpc-url') ?? process.env.SOROBAN_RPC_URL,
    retainXdr: args.includes('--include-xdr'),
  });
  const output = args.includes('--no-values') ? redact(result) : result;
  console.log(JSON.stringify(output, null, 2));
  return result.status === 'ok' ? 0 : 1;
}

if (require.main === module) {
  main(process.argv).then((code) => process.exit(code));
}
