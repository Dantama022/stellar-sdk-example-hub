import { Keypair } from '@stellar/stellar-sdk';
import chalk from 'chalk';

import {
  describeUnsupportedJsType,
  encodeNested,
  roundTrip,
  trySerialize,
} from '../utils/scval-utils';

/**
 * Example 106: ScVal Serialization and Deserialization
 *
 * Soroban contracts exchange data as XDR-encoded ScVal values. This example
 * demonstrates converting common JavaScript values to ScVal and back using
 * reusable helpers, displaying raw base64 XDR, and comparing originals with
 * decoded round-trip results.
 */

interface DemoCase {
  label: string;
  value: unknown;
  hint: { type: string; element?: { type: string }; key?: { type: string }; value?: { type: string } };
}

const DEMO_CASES: DemoCase[] = [
  { label: 'Boolean', value: true, hint: { type: 'bool' } },
  { label: 'Integer (u32)', value: 42, hint: { type: 'u32' } },
  { label: 'BigInt (i128)', value: 10_000_000_000n, hint: { type: 'i128' } },
  { label: 'String', value: 'hello Soroban', hint: { type: 'string' } },
  { label: 'Symbol', value: 'transfer', hint: { type: 'symbol' } },
  { label: 'Bytes', value: Buffer.from('cafebabe', 'hex'), hint: { type: 'bytes' } },
  {
    label: 'Address',
    value: Keypair.random().publicKey(),
    hint: { type: 'address' },
  },
  {
    label: 'Vector<u32>',
    value: [1, 2, 3, 5, 8],
    hint: { type: 'vec', element: { type: 'u32' } },
  },
  {
    label: 'Map<symbol,u32>',
    value: [
      ['alice', 100],
      ['bob', 250],
    ],
    hint: { type: 'map', key: { type: 'symbol' }, value: { type: 'u32' } },
  },
];

function printRoundTrip(result: ReturnType<typeof roundTrip>): void {
  console.log(`  original : ${JSON.stringify(result.original)}`);
  console.log(`  xdr type : ${chalk.cyan(result.encoded.xdrType)}`);
  console.log(`  raw XDR  : ${result.encoded.rawXdr}`);
  console.log(`  decoded  : ${JSON.stringify(result.decoded)}`);
  console.log(
    result.matches
      ? chalk.green('  match    : yes')
      : chalk.yellow('  match    : no (see serialization pitfalls below)'),
  );
}

export function explainSerializationPitfalls(): string {
  return [
    'Serialization pitfalls:',
    '  - JavaScript numbers above 2^53-1 must use BigInt for u64/i128/u256 types.',
    '  - Symbol (scvSymbol) is not the same as String (scvString); contracts validate strictly.',
    '  - Soroban maps decode to [key, value][] arrays, not plain objects, unless reshaped.',
    '  - Option<T> uses scvVoid for None; undefined is not a valid ScVal input.',
    '  - Passing the wrong hint throws before any RPC call — validate locally first.',
  ].join('\n');
}

export async function run(): Promise<void> {
  console.log(chalk.bold('ScVal Serialization and Deserialization Example'));
  console.log(chalk.gray('Offline round-trip encoding using reusable scval-utils helpers.\n'));

  console.log(chalk.bold('Primitive and collection types'));
  for (const demo of DEMO_CASES) {
    console.log(chalk.yellow(`\n${demo.label}`));
    printRoundTrip(roundTrip(demo.value, demo.hint));
  }

  console.log(chalk.bold('\nNested object (manual scvMap construction)'));
  const nested = {
    active: true,
    count: 3,
    label: 'nested',
    scores: [10, 20, 30],
    meta: { version: 2, owner: 'alice' },
  };
  const nestedScVal = encodeNested(nested);
  console.log(`  original : ${JSON.stringify(nested)}`);
  console.log(`  xdr type : ${chalk.cyan(nestedScVal.switch().name)}`);
  console.log(`  raw XDR  : ${nestedScVal.toXDR('base64')}`);

  console.log(chalk.bold('\nUnsupported JavaScript types'));
  for (const bad of [undefined, () => 'noop', new Date()]) {
    const attempt = trySerialize(bad, { type: 'u32' });
    if (!attempt.ok) {
      console.log(chalk.red(`  ✗ ${describeUnsupportedJsType(bad)}`));
      console.log(chalk.gray(`    encoder error: ${attempt.error}`));
    }
  }

  console.log('\n' + explainSerializationPitfalls());
  console.log(chalk.green('\nScVal serialization example completed.'));
}
