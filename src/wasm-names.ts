#!/usr/bin/env node
import { run } from './examples/253-wasm-names';

export function parseWasmNamesArgs(args: string[]): {
  wasmFile?: string;
  compareFile?: string;
  json: boolean;
} {
  const json = args.includes('--json') || args.includes('--json=true');
  const files: string[] = [];
  let compareFile: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json' || arg === '--json=true') continue;
    if (arg === '--compare') {
      compareFile = args[index + 1];
      if (!compareFile) throw new Error('--compare requires a WASM file path');
      index += 1;
    } else if (arg.startsWith('--compare=')) {
      compareFile = arg.slice('--compare='.length);
      if (!compareFile) throw new Error('--compare requires a WASM file path');
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else files.push(arg);
  }
  return {
    wasmFile: files[0],
    compareFile: compareFile ?? files[1],
    json,
  };
}

export async function runWasmNamesCli(args: string[]): Promise<number> {
  try {
    await run(parseWasmNamesArgs(args));
    return 0;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (require.main === module) {
  runWasmNamesCli(process.argv.slice(2)).then(process.exit);
}
