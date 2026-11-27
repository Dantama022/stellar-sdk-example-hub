#!/usr/bin/env node
import { parseUnreachableArgs, run } from './examples/273-wasm-unreachable';

run(parseUnreachableArgs(process.argv.slice(2))).catch((error: unknown) => {
  console.error(
    `WASM unreachable-path analysis failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
