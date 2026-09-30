import { resolve } from 'path';
import { readFileSync } from 'fs';
import { diffWasmModules, DiffResult, OutputMode } from '../wasmDiff';

/**
 * Commander action for the `wasm-diff` subcommand.
 *
 * @param oldWasmPath Path to the original WASM file.
 * @param newWasmPath Path to the updated WASM file.
 * @param options     Parsed CLI options (currently only `json`).
 */
export async function wasmDiffCommand(
  oldWasmPath: string,
  newWasmPath: string,
  options: { json?: boolean }
): Promise<void> {
  try {
    const oldPath = resolve(process.cwd(), oldWasmPath);
    const newPath = resolve(process.cwd(), newWasmPath);
    const oldBuffer = readFileSync(oldPath);
    const newBuffer = readFileSync(newPath);

    const mode: OutputMode = options.json ? 'json' : 'human';
    const result: DiffResult = diffWasmModules(oldBuffer, newBuffer);

    if (mode === 'json') {
      console.log(JSON.stringify(result, null, 2));
    } else {
      // Human‑readable output
      console.log('WASM Section Diff');
      console.log('===================');
      for (const sec of result.sections) {
        const status = sec.status.toUpperCase();
        const sizeInfo =
          sec.oldSize !== undefined && sec.newSize !== undefined
            ? `${sec.oldSize} → ${sec.newSize} (Δ ${sec.delta})`
            : sec.oldSize !== undefined
            ? `${sec.oldSize} (removed)`
            : `${sec.newSize} (added)`;
        console.log(`${status}: ${sec.id}${sec.name ? ` (${sec.name})` : ''} – ${sizeInfo}`);
        if (sec.oldHash && sec.newHash) {
          console.log(`  Old hash: ${sec.oldHash}`);
          console.log(`  New hash: ${sec.newHash}`);
        } else if (sec.oldHash) {
          console.log(`  Old hash: ${sec.oldHash}`);
        } else if (sec.newHash) {
          console.log(`  New hash: ${sec.newHash}`);
        }
      }
    }
  } catch (err) {
    console.error('Error:', (err as Error).message);
    process.exit(1);
  }
}
