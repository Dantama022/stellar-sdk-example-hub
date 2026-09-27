import * as fs from 'fs';
import * as path from 'path';
import {
  CanonicalSnapshot,
  duplicateKeys,
  parseFlags,
  getFlag,
  hasFlag,
  parseSnapshot,
  readJsonFile,
  stableStringify,
  valuesConflict,
} from '../utils/soroban-state-snapshot';

export interface NormalizeOptions {
  snapshotFile?: string;
  outputFile?: string;
  check?: boolean;
  json?: boolean;
}

export interface NormalizeResult {
  canonical: boolean;
  snapshot: CanonicalSnapshot;
  duplicateKeys: string[];
  conflictingKeys: string[];
}

export function normalizeSnapshot(raw: unknown): NormalizeResult {
  const snapshot = parseSnapshot(raw);
  const duplicates = duplicateKeys(snapshot.entries);
  const conflictingKeys = snapshot.entries
    .filter(valuesConflict)
    .map((entry) => entry.ledgerKey)
    .sort();
  if (duplicates.length)
    throw new Error(`duplicate normalized ledger keys: ${duplicates.join(', ')}`);
  if (conflictingKeys.length) {
    throw new Error(`conflicting encoded/decoded representations: ${conflictingKeys.join(', ')}`);
  }
  return { canonical: false, snapshot, duplicateKeys: duplicates, conflictingKeys };
}

export function parseStateNormalizeArgs(args: string[]): NormalizeOptions {
  const { positional, flags } = parseFlags(args);
  return {
    snapshotFile: positional[0],
    outputFile: getFlag(flags, 'o', 'output'),
    check: hasFlag(flags, 'check'),
    json: hasFlag(flags, 'json'),
  };
}

export async function run(options: NormalizeOptions = {}): Promise<number> {
  const file = options.snapshotFile ?? process.argv[3];
  if (!file) throw new Error('Missing snapshot file path.');
  const { text, raw } = readJsonFile(file);
  const result = normalizeSnapshot(raw);
  const canonicalText = `${stableStringify(result.snapshot)}\n`;
  result.canonical = text.replace(/\r\n/g, '\n') === canonicalText;

  if (options.check) {
    if (options.json) console.log(stableStringify({ canonical: result.canonical }));
    else console.log(result.canonical ? 'Snapshot is canonical.' : 'Snapshot is not canonical.');
    return result.canonical ? 0 : 1;
  }

  if (options.outputFile) {
    const target = path.resolve(options.outputFile);
    fs.writeFileSync(target, canonicalText, 'utf8');
    if (!options.json) console.log(`Normalized snapshot written to ${target}`);
  } else {
    console.log(options.json ? stableStringify(result.snapshot) : canonicalText.trimEnd());
  }
  return 0;
}

if (require.main === module) {
  run(parseStateNormalizeArgs(process.argv.slice(2)))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    });
}
