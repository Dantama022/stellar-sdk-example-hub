#!/usr/bin/env node
import { parseWasmFingerprintArgs, run } from './examples/251-wasm-fingerprint';

try {
  run(parseWasmFingerprintArgs(process.argv.slice(2)));
} catch (error: unknown) {
  console.error(
    `WASM fingerprint failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
