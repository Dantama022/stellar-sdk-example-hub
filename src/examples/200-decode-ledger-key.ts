import {
  booleanFlag,
  decodeLedgerKeyXdr,
  parseCommonFlags,
  stableStringify,
} from '../utils/soroban-state-inspection';
export interface DecodeLedgerKeyOptions {
  inputs?: string[] | string;
  compact?: boolean;
  json?: boolean;
}
export function parseDecodeLedgerKeyArgs(args: string[]): DecodeLedgerKeyOptions {
  const { positional, flags } = parseCommonFlags(args);
  return {
    inputs: positional,
    compact: booleanFlag(flags, 'compact'),
    json: booleanFlag(flags, 'json'),
  };
}
function normalizeInputs(inputs: string[] | string | undefined): string[] {
  if (Array.isArray(inputs)) return inputs;
  if (typeof inputs === 'string') return inputs.split(/\s+/).filter(Boolean);
  return [];
}
export function decodeLedgerKeys(inputs: string[]) {
  return inputs.map(decodeLedgerKeyXdr);
}
export async function run(options: DecodeLedgerKeyOptions = {}): Promise<void> {
  const inputs = normalizeInputs(options.inputs);
  if (!inputs.length) throw new Error('Provide at least one base64-encoded ledger-key XDR value.');
  const reports = decodeLedgerKeys(inputs);
  if (options.json) {
    console.log(stableStringify(reports));
    return;
  }
  reports.forEach((report, index) => {
    if (options.compact) {
      console.log(
        `${index + 1}. ${report.ledgerKeyType}${report.contractId ? ` contract=${report.contractId}` : ''}${report.durability ? ` durability=${report.durability}` : ''}${report.error ? ` error=${report.error}` : ''}`,
      );
      return;
    }
    console.log(`\n=== Ledger Key #${index + 1} ===`);
    console.log(`Type: ${report.ledgerKeyType}`);
    console.log(`Supported: ${report.supported ? 'yes' : 'no'}`);
    if (report.contractId) console.log(`Contract ID: ${report.contractId}`);
    if (report.durability) console.log(`Durability: ${report.durability}`);
    if (report.decodedKey !== undefined)
      console.log(`Decoded key: ${stableStringify(report.decodedKey)}`);
    console.log(`Raw XDR: ${report.rawXdr}`);
    if (report.error) console.log(`Diagnostic: ${report.error}`);
  });
}
if (require.main === module)
  run(parseDecodeLedgerKeyArgs(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
