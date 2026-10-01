#!/usr/bin/env node
import { parseWasmFeatureArgs, run } from './examples/252-wasm-features';

try {
  run(parseWasmFeatureArgs(process.argv.slice(2)));
} catch (error: unknown) {
  console.error(
    `WASM feature analysis failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
