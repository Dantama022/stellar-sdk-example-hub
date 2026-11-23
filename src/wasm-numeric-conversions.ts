#!/usr/bin/env node
import { parseNumericConversionArgs, run } from './examples/269-wasm-numeric-conversions';

run(parseNumericConversionArgs(process.argv.slice(2))).catch((error: unknown) => {
  console.error(
    `WASM numeric conversion analysis failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
