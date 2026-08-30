import { rpc, xdr } from '@stellar/stellar-sdk';

import { decodeScVal, DecodedScVal, renderDecodedValue } from '../utils/scval-decoder';

/**
 * Example 179: Soroban Transaction Footprint Inspection
 *
 * Extracts and analyzes the Soroban ledger footprint from a transaction
 * simulation result. Distinguishes read-only from read-write entries,
 * decodes supported ledger-key types, detects duplicates, and calculates
 * footprint statistics.
 */

const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';

export interface FootprintInspectionParams {
  transactionXdr?: string;
  rpcUrl?: string;
  json?: boolean;
}

interface DecodedLedgerKey {
  xdrType: string;
  decoded: DecodedScVal;
  rawXdr: string;
  description: string;
}

interface FootprintReport {
  readOnlyCount: number;
  readWriteCount: number;
  totalKeys: number;
  readOnlyKeys: DecodedLedgerKey[];
  readWriteKeys: DecodedLedgerKey[];
  duplicateCount: number;
  keyTypeCounts: Record<string, number>;
  contractIds: string[];
}

function decodeLedgerKey(key: xdr.LedgerKey): DecodedLedgerKey {
  const type = key.switch().name;
  let description: string;
  let decoded: DecodedScVal;

  try {
    switch (key.switch()) {
      case xdr.LedgerEntryType.contractData(): {
        const data = key.contractData();
        const contractAddr = xdr.ScVal.scvAddress(data.contract());
        const contractStr = renderDecodedValue(decodeScVal(contractAddr));
        const keyVal = renderDecodedValue(decodeScVal(data.key()));
        const durability = data.durability().name;
        description = `contractData contract=${contractStr} key=${keyVal} durability=${durability}`;
        decoded = decodeScVal(data.key());
        break;
      }
      case xdr.LedgerEntryType.contractCode(): {
        const hash = key.contractCode().hash().toString('hex');
        description = `contractCode hash=${hash.slice(0, 16)}…`;
        decoded = { xdrType: 'hash', value: hash, rawXdr: '', decoded: true };
        break;
      }
      case xdr.LedgerEntryType.account(): {
        description = 'account entry';
        decoded = { xdrType: 'account', value: null, rawXdr: '', decoded: true };
        break;
      }
      case xdr.LedgerEntryType.trustline(): {
        description = 'trustline entry';
        decoded = { xdrType: 'trustline', value: null, rawXdr: '', decoded: true };
        break;
      }
      default: {
        description = type;
        decoded = {
          xdrType: type,
          value: null,
          rawXdr: '',
          decoded: false,
          error: `Unsupported type: ${type}`,
        };
      }
    }
  } catch (err: any) {
    description = `${type} (decode error)`;
    decoded = { xdrType: type, value: null, rawXdr: '', decoded: false, error: err.message };
  }

  let rawXdr: string;
  try {
    rawXdr = key.toXDR('base64');
  } catch {
    rawXdr = '';
  }

  return { xdrType: type, decoded, rawXdr, description };
}

function buildReport(
  readOnlyKeys: xdr.LedgerKey[],
  readWriteKeys: xdr.LedgerKey[],
): FootprintReport {
  const decodedReadOnly = readOnlyKeys.map(decodeLedgerKey);
  const decodedReadWrite = readWriteKeys.map(decodeLedgerKey);
  const allKeys = [...decodedReadOnly, ...decodedReadWrite];

  const keyTypeCounts: Record<string, number> = {};
  const contractIds = new Set<string>();
  const rawKeyStrings = new Set<string>();
  let duplicateCount = 0;

  for (const key of allKeys) {
    keyTypeCounts[key.xdrType] = (keyTypeCounts[key.xdrType] ?? 0) + 1;

    // Extract contract IDs from contractData keys
    if (key.xdrType === 'contractData' && key.decoded.value) {
      try {
        // Try to extract contract from description
        const match = key.description.match(/contract=([A-Z]+)/);
        if (match) contractIds.add(match[1]);
      } catch {
        /* ignore */
      }
    }

    // Detect duplicates
    if (rawKeyStrings.has(key.rawXdr)) {
      duplicateCount++;
    } else {
      rawKeyStrings.add(key.rawXdr);
    }
  }

  return {
    readOnlyCount: decodedReadOnly.length,
    readWriteCount: decodedReadWrite.length,
    totalKeys: decodedReadOnly.length + decodedReadWrite.length,
    readOnlyKeys: decodedReadOnly,
    readWriteKeys: decodedReadWrite,
    duplicateCount,
    keyTypeCounts,
    contractIds: Array.from(contractIds),
  };
}

function formatFootprintReport(report: FootprintReport): string {
  const lines: string[] = [];
  lines.push('=== Soroban Transaction Footprint Inspection ===');
  lines.push('');
  lines.push('Entry Counts:');
  lines.push(`  Read-only  : ${report.readOnlyCount}`);
  lines.push(`  Read-write : ${report.readWriteCount}`);
  lines.push(`  Total      : ${report.totalKeys}`);
  lines.push(`  Duplicates : ${report.duplicateCount}`);

  lines.push('');
  lines.push('Key Types:');
  Object.entries(report.keyTypeCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([type, count]) => {
      lines.push(`  ${type.padEnd(20)} ${count}`);
    });

  if (report.contractIds.length > 0) {
    lines.push('');
    lines.push('Contracts Touched:');
    report.contractIds.forEach((id) => lines.push(`  ${id}`));
  }

  lines.push('');
  lines.push('Read-Only Entries:');
  if (report.readOnlyKeys.length === 0) {
    lines.push('  (none)');
  } else {
    report.readOnlyKeys.forEach((key, i) => {
      lines.push(`  [${i}] ${key.description}`);
      lines.push(`      raw XDR: ${key.rawXdr}`);
    });
  }

  lines.push('');
  lines.push('Read-Write Entries:');
  if (report.readWriteKeys.length === 0) {
    lines.push('  (none — this invocation does not modify state)');
  } else {
    report.readWriteKeys.forEach((key, i) => {
      lines.push(`  [${i}] ${key.description}`);
      lines.push(`      raw XDR: ${key.rawXdr}`);
    });
  }

  return lines.join('\n');
}

export async function run(params: FootprintInspectionParams = {}): Promise<void> {
  const rpcUrl = params.rpcUrl || process.env.SOROBAN_RPC_URL || DEFAULT_RPC_URL;
  const xdrInput =
    params.transactionXdr?.trim() || process.env.TRANSACTION_XDR?.trim() || process.argv[3]?.trim();
  const jsonOutput = params.json === true || process.env.JSON_OUTPUT === 'true';

  console.log('Soroban Transaction Footprint Inspection');
  console.log(`Soroban RPC: ${rpcUrl}`);

  // Confirm connectivity
  const server = new rpc.Server(rpcUrl);
  try {
    const health = await server.getLatestLedger();
    console.log(`Latest ledger: ${health.sequence}`);
  } catch (err: any) {
    console.log(`Could not reach Soroban RPC: ${err?.message ?? err}`);
    return;
  }

  let readOnlyKeys: xdr.LedgerKey[] = [];
  let readWriteKeys: xdr.LedgerKey[] = [];

  if (xdrInput) {
    // Decode from provided XDR
    console.log('\nDecoding supplied XDR...');
    try {
      const envelope = xdr.TransactionEnvelope.fromXDR(xdrInput, 'base64');
      const tx = envelope.value().tx();

      // Try to extract footprint from transaction data
      try {
        const ext = tx.ext();
        if (ext.switch() === 1) {
          // sorobanTransactionData
          const sorobanData = (ext as any).sorobanData();
          if (sorobanData) {
            const footprint = sorobanData.resources().footprint();
            readOnlyKeys = footprint.readOnly();
            readWriteKeys = footprint.readWrite();
            console.log(`Extracted footprint from transaction envelope.`);
          }
        }
      } catch {
        /* ext may not have sorobanData */
      }
    } catch (err: any) {
      console.log(`Failed to decode XDR: ${err?.message ?? err}`);
      console.log('Provide a base64-encoded transaction envelope or simulation result.');
      return;
    }
  } else {
    // Demo: simulate a read-only contract call to extract its footprint
    console.log('\nNo XDR provided — running a demo simulation to extract footprint...');
    console.log('(Provide a transaction envelope XDR to inspect a specific footprint)');

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = require('@stellar/stellar-sdk');
    const { Account, Contract, Keypair, Networks, TransactionBuilder } = sdk;
    const caller = Keypair.random();
    const source = new Account(caller.publicKey(), '0');
    const contractId =
      process.env.CONTRACT_ID || 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

    try {
      const contract = new Contract(contractId);
      const tx = new TransactionBuilder(source, {
        fee: '100',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(contract.call('decimals'))
        .setTimeout(30)
        .build();

      const simulation = await server.simulateTransaction(tx);

      if (rpc.Api.isSimulationError(simulation)) {
        console.log(`Simulation error: ${simulation.error}`);
        console.log('Extracting footprint from error response anyway...');

        // Even on error, transactionData may carry the footprint
        if ((simulation as any).transactionData) {
          const txData = (simulation as any).transactionData.build();
          const footprint = txData.resources().footprint();
          readOnlyKeys = footprint.readOnly();
          readWriteKeys = footprint.readWrite();
        }
      } else {
        const txData = simulation.transactionData.build();
        const footprint = txData.resources().footprint();
        readOnlyKeys = footprint.readOnly();
        readWriteKeys = footprint.readWrite();
      }
    } catch (err: any) {
      console.log(`Demo simulation failed: ${err?.message ?? err}`);
      return;
    }
  }

  // Handle no footprint
  if (readOnlyKeys.length === 0 && readWriteKeys.length === 0) {
    console.log('\nNo Soroban footprint found in the provided input.');
    console.log('This transaction may not be a Soroban invocation.');
    console.log('Provide a Soroban transaction envelope or simulation result XDR.');
    return;
  }

  // Build report
  const report = buildReport(readOnlyKeys, readWriteKeys);

  if (jsonOutput) {
    console.log('\n' + JSON.stringify(report, null, 2));
  } else {
    console.log('\n' + formatFootprintReport(report));
  }

  console.log('\nSoroban footprint inspection completed.');
}
