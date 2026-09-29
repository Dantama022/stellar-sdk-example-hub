import { xdr } from '@stellar/stellar-sdk';
import {
  CanonicalEntry,
  JsonObject,
  duplicateKeys,
  hasFlag,
  normalizeInteger,
  normalizeEntry,
  normalizeLedgerKey,
  parseFlags,
  parseJsonPreservingLargeIntegers,
  stableStringify,
  validateContractId,
  valuesConflict,
} from '../utils/soroban-state-snapshot';

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  entryIndex?: number;
  ledgerKey?: string;
}

export interface ValidationReport {
  valid: boolean;
  strict: boolean;
  diagnostics: Diagnostic[];
  summary: { errors: number; warnings: number; info: number };
}

export interface ValidateOptions {
  snapshotFile?: string;
  strict?: boolean;
  json?: boolean;
}

function push(
  diagnostics: Diagnostic[],
  severity: Severity,
  code: string,
  message: string,
  entryIndex?: number,
  ledgerKey?: string,
): void {
  diagnostics.push({ severity, code, message, entryIndex, ledgerKey });
}

export function validateRawSnapshot(raw: unknown, strict = false): ValidationReport {
  const diagnostics: Diagnostic[] = [];
  if (!raw || (typeof raw !== 'object' && !Array.isArray(raw))) {
    push(diagnostics, 'error', 'snapshot.type', 'Snapshot must be an object or array.');
    return finish(diagnostics, strict);
  }

  const obj = Array.isArray(raw) ? { entries: raw } : (raw as JsonObject);
  if (
    !Array.isArray(raw) &&
    obj.version !== undefined &&
    obj.version !== 1 &&
    obj.version !== '1'
  ) {
    push(
      diagnostics,
      'error',
      'snapshot.version',
      `Unsupported snapshot version: ${String(obj.version)}`,
    );
  }
  if (!Array.isArray(raw) && obj.version === undefined) {
    push(
      diagnostics,
      'warning',
      'snapshot.version.missing',
      'Snapshot version metadata is missing.',
    );
  }
  if (!Array.isArray(obj.entries)) {
    push(diagnostics, 'error', 'snapshot.entries', 'Snapshot requires an entries array.');
    return finish(diagnostics, strict);
  }
  if (!Array.isArray(raw) && obj.ledger === undefined && obj.ledgerSeq === undefined) {
    push(diagnostics, 'warning', 'snapshot.ledger.missing', 'Snapshot ledger metadata is missing.');
  }
  if (obj.ledger !== undefined || obj.ledgerSeq !== undefined) {
    try {
      normalizeInteger(obj.ledger ?? obj.ledgerSeq, 'ledger');
    } catch (error) {
      push(diagnostics, 'error', 'snapshot.ledger.invalid', (error as Error).message);
    }
  }

  const canonicalEntries: CanonicalEntry[] = [];
  obj.entries.forEach((rawEntry, index) => {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      push(diagnostics, 'error', 'entry.type', 'Entry must be an object.', index);
      return;
    }
    const entry = rawEntry as JsonObject;
    let ledgerKey: string | undefined;
    try {
      ledgerKey = normalizeLedgerKey(entry.ledgerKey ?? entry.keyXdr ?? entry.key);
      try {
        xdr.LedgerKey.fromXDR(ledgerKey, 'base64');
      } catch {
        push(
          diagnostics,
          'warning',
          'entry.ledgerKey.nonXdr',
          'Ledger key is not valid LedgerKey XDR; preserved as a stable textual identifier.',
          index,
          ledgerKey,
        );
      }
    } catch (error) {
      push(diagnostics, 'error', 'entry.ledgerKey.invalid', (error as Error).message, index);
      return;
    }

    const durability =
      typeof entry.durability === 'string' ? entry.durability.toLowerCase() : undefined;
    if (durability !== undefined && durability !== 'persistent' && durability !== 'temporary') {
      push(
        diagnostics,
        'warning',
        'entry.durability',
        'Unknown durability value.',
        index,
        ledgerKey,
      );
    }
    if (entry.contractId !== undefined) {
      if (typeof entry.contractId !== 'string' || !validateContractId(entry.contractId)) {
        push(
          diagnostics,
          'error',
          'entry.contractId',
          'Invalid Soroban contract ID.',
          index,
          ledgerKey,
        );
      }
    }
    for (const field of ['lastModifiedLedgerSeq', 'liveUntilLedgerSeq'] as const) {
      if (entry[field] !== undefined) {
        try {
          normalizeInteger(entry[field], field);
        } catch (error) {
          push(diagnostics, 'error', `entry.${field}`, (error as Error).message, index, ledgerKey);
        }
      }
    }

    const last = safeInteger(entry.lastModifiedLedgerSeq);
    const live = safeInteger(entry.liveUntilLedgerSeq);
    if (last !== undefined && live !== undefined && live < last) {
      push(
        diagnostics,
        'error',
        'entry.ttl.relationship',
        'liveUntilLedgerSeq is earlier than lastModifiedLedgerSeq.',
        index,
        ledgerKey,
      );
    }

    if (entry.valueXdr !== undefined) {
      if (typeof entry.valueXdr !== 'string') {
        push(
          diagnostics,
          'error',
          'entry.valueXdr.type',
          'valueXdr must be a string.',
          index,
          ledgerKey,
        );
      } else {
        try {
          xdr.ScVal.fromXDR(entry.valueXdr, 'base64');
        } catch {
          push(
            diagnostics,
            'error',
            'entry.valueXdr.invalid',
            'valueXdr is not valid ScVal XDR.',
            index,
            ledgerKey,
          );
        }
      }
    } else if (entry.valueDecoded === undefined) {
      push(
        diagnostics,
        'warning',
        'entry.value.missing',
        'Entry has neither valueXdr nor valueDecoded.',
        index,
        ledgerKey,
      );
    }

    try {
      const normalized = normalizeEntry(rawEntry);
      canonicalEntries.push(normalized);
      if (valuesConflict(normalized)) {
        push(
          diagnostics,
          'error',
          'entry.value.conflict',
          'Encoded and decoded value representations conflict.',
          index,
          ledgerKey,
        );
      }
    } catch (error) {
      push(diagnostics, 'error', 'entry.normalize', (error as Error).message, index, ledgerKey);
    }
  });

  for (const key of duplicateKeys(canonicalEntries)) {
    push(
      diagnostics,
      'error',
      'entry.duplicate',
      'Duplicate normalized ledger key.',
      undefined,
      key,
    );
  }
  if (obj.entries.length === 0) {
    push(diagnostics, 'info', 'snapshot.empty', 'Snapshot contains no entries.');
  }
  return finish(diagnostics, strict);
}

function safeInteger(value: unknown): bigint | undefined {
  try {
    const normalized = normalizeInteger(value, 'ledger');
    return normalized === undefined ? undefined : BigInt(normalized);
  } catch {
    return undefined;
  }
}

function finish(diagnostics: Diagnostic[], strict: boolean): ValidationReport {
  diagnostics.sort(
    (a, b) =>
      (a.entryIndex ?? -1) - (b.entryIndex ?? -1) ||
      a.code.localeCompare(b.code) ||
      (a.ledgerKey ?? '').localeCompare(b.ledgerKey ?? ''),
  );
  const summary = {
    errors: diagnostics.filter((item) => item.severity === 'error').length,
    warnings: diagnostics.filter((item) => item.severity === 'warning').length,
    info: diagnostics.filter((item) => item.severity === 'info').length,
  };
  return {
    valid: summary.errors === 0 && (!strict || summary.warnings === 0),
    strict,
    diagnostics,
    summary,
  };
}

export function parseStateValidateArgs(args: string[]): ValidateOptions {
  const { positional, flags } = parseFlags(args);
  return {
    snapshotFile: positional[0],
    strict: hasFlag(flags, 'strict'),
    json: hasFlag(flags, 'json'),
  };
}

export async function run(options: ValidateOptions = {}): Promise<number> {
  const fs = await import('fs');
  const file = options.snapshotFile ?? process.argv[3];
  if (!file) throw new Error('Missing snapshot file path.');
  let raw: unknown;
  try {
    raw = parseJsonPreservingLargeIntegers(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    const report: ValidationReport = {
      valid: false,
      strict: Boolean(options.strict),
      diagnostics: [
        { severity: 'error', code: 'snapshot.json', message: (error as Error).message },
      ],
      summary: { errors: 1, warnings: 0, info: 0 },
    };
    if (options.json) console.log(stableStringify(report));
    else console.log(`ERROR snapshot.json: ${report.diagnostics[0].message}`);
    return 2;
  }

  const report = validateRawSnapshot(raw, Boolean(options.strict));
  if (options.json) {
    console.log(stableStringify(report));
  } else {
    console.log('=== Soroban State Snapshot Validation ===');
    for (const item of report.diagnostics) {
      const location = item.entryIndex === undefined ? '' : ` entry[${item.entryIndex}]`;
      console.log(`${item.severity.toUpperCase()} ${item.code}${location}: ${item.message}`);
    }
    console.log(`Errors: ${report.summary.errors}`);
    console.log(`Warnings: ${report.summary.warnings}`);
    console.log(`Info: ${report.summary.info}`);
    console.log(report.valid ? 'VALID' : 'INVALID');
  }
  return report.valid ? 0 : 1;
}

if (require.main === module) {
  run(parseStateValidateArgs(process.argv.slice(2)))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    });
}
