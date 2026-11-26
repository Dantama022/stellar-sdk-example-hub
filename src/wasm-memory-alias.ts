#!/usr/bin/env node
import { parseMemoryAliasArgs, run } from './examples/271-wasm-memory-alias';

run(parseMemoryAliasArgs(process.argv.slice(2))).catch((error: unknown) => {
  console.error(
    `WASM memory alias analysis failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
