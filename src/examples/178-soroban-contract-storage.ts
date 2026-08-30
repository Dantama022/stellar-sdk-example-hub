import { rpc, StrKey, Address, xdr } from '@stellar/stellar-sdk';

import { decodeScVal, renderDecodedValue } from '../utils/scval-decoder';

/**
 * Example 178: Soroban Contract Storage Inspection
 *
 * Inspects Soroban contract storage entries across instance, persistent, and
 * temporary durability tiers. Decodes storage keys and values, displays TTL
 * information, and handles missing or archived entries gracefully.
 */

const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';

export interface StorageInspectionParams {
  contractId?: string;
  storageKey?: string;
  rpcUrl?: string;
  json?: boolean;
}

function normalizeContractId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('Missing contract ID.');
  if (!StrKey.isValidContract(trimmed)) {
    throw new Error(`Invalid contract ID "${trimmed}".`);
  }
  return trimmed;
}

function buildStorageKey(storageKeyStr: string): xdr.ScVal {
  try {
    if (storageKeyStr === '<instance>') {
      return xdr.ScVal.scvLedgerKeyContractInstance();
    }
    if (storageKeyStr.startsWith('symbol:')) {
      return xdr.ScVal.scvSymbol(storageKeyStr.slice(7));
    }
    if (storageKeyStr.startsWith('address:')) {
      const address = storageKeyStr.slice(8).trim();
      return Address.fromString(address).toScVal();
    }
    if (storageKeyStr.startsWith('u32:')) {
      return xdr.ScVal.scvU32(parseInt(storageKeyStr.slice(4).trim(), 10));
    }
    if (storageKeyStr.startsWith('i32:')) {
      return xdr.ScVal.scvI32(parseInt(storageKeyStr.slice(4).trim(), 10));
    }
    if (storageKeyStr.startsWith('bytes:')) {
      const hex = storageKeyStr.slice(6).trim().replace(/^0x/, '');
      const buf = Buffer.from(hex, 'hex');
      return xdr.ScVal.scvBytes(buf);
    }
    return xdr.ScVal.scvSymbol(storageKeyStr);
  } catch (err: any) {
    throw new Error(`Could not build ScVal from key "${storageKeyStr}": ${err.message}`);
  }
}

function describeKey(key: xdr.ScVal): string {
  try {
    if (key.switch() === xdr.ScValType.scvLedgerKeyContractInstance()) {
      return '<contract instance>';
    }
    return renderDecodedValue(decodeScVal(key));
  } catch {
    return key.switch().name;
  }
}

function formatEntry(
  label: string,
  contractId: string,
  durability: string,
  keyScVal: xdr.ScVal,
  entry: rpc.Api.LedgerEntryResult,
): string {
  const lines: string[] = [];
  lines.push(`\n  [${label}]`);
  lines.push(`    Contract ID    : ${contractId}`);
  lines.push(`    Durability     : ${durability}`);
  lines.push(`    Storage key    : ${describeKey(keyScVal)}`);

  if (!entry?.val) {
    lines.push('    Value          : (entry not found)');
    if (entry?.liveUntilLedgerSeq !== undefined) {
      lines.push(`    Live until     : ${entry.liveUntilLedgerSeq}`);
    }
    return lines.join('\n');
  }

  let decodedValue: string;
  try {
    const valScVal = entry.val.contractData().val();
    decodedValue = renderDecodedValue(decodeScVal(valScVal));
  } catch {
    try {
      decodedValue = entry.val.toXDR('base64').slice(0, 60) + '…';
    } catch {
      decodedValue = '(could not decode)';
    }
  }

  lines.push(
    `    Raw XDR        : ${(() => {
      try {
        const valScVal = entry.val.contractData().val();
        const decoded = decodeScVal(valScVal);
        return decoded.rawXdr;
      } catch {
        return '(unavailable)';
      }
    })()}`,
  );
  lines.push(`    Decoded value  : ${decodedValue}`);

  if (entry.liveUntilLedgerSeq !== undefined) {
    lines.push(`    Live until     : ${entry.liveUntilLedgerSeq}`);
  }

  return lines.join('\n');
}

function isNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes('not found') || msg.includes('entrynotfound') || msg.includes('missing');
}

export async function run(params: StorageInspectionParams = {}): Promise<void> {
  const rpcUrl = params.rpcUrl || process.env.SOROBAN_RPC_URL || DEFAULT_RPC_URL;
  const contractInput =
    params.contractId?.trim() || process.env.CONTRACT_ID?.trim() || process.argv[3]?.trim();
  const storageKeyInput =
    params.storageKey?.trim() || process.env.STORAGE_KEY?.trim() || process.argv[4]?.trim();
  const jsonOutput = params.json === true || process.env.JSON_OUTPUT === 'true';

  console.log('Soroban Contract Storage Inspection');
  console.log(`Soroban RPC: ${rpcUrl}`);

  let contractId: string;
  try {
    contractId = normalizeContractId(
      contractInput || 'CDW6BR4A6MGGCW23SCAVBBBZ3HW4V5C3TJ35OC3D4RQ4A6MGGCW23SCA',
    );
  } catch (err: any) {
    console.log(`\n${err?.message ?? err}`);
    return;
  }
  console.log(`Contract: ${contractId}`);

  const server = new rpc.Server(rpcUrl);

  // Confirm connectivity
  let latestLedger: number;
  try {
    const health = await server.getLatestLedger();
    latestLedger = health.sequence;
    console.log(`Latest ledger: ${latestLedger}`);
  } catch (err: any) {
    console.log(`Could not reach Soroban RPC: ${err?.message ?? err}`);
    return;
  }

  const results: Array<{
    label: string;
    contractId: string;
    durability: string;
    storageKey: string;
    rawXdr: string;
    decodedValue: string;
    liveUntilLedgerSeq?: number;
    found: boolean;
    error?: string;
  }> = [];

  // Step 1: Inspect contract instance storage
  console.log('\n--- Contract Instance Storage ---');
  try {
    const entry = await server.getContractData(
      contractId,
      xdr.ScVal.scvLedgerKeyContractInstance(),
      rpc.Durability.Persistent,
    );

    if (entry?.val) {
      const decodedVal = decodeScVal(entry.val.contractData().val());
      const result = {
        label: 'Instance',
        contractId,
        durability: 'persistent',
        storageKey: '<contract instance>',
        rawXdr: decodedVal.rawXdr,
        decodedValue: renderDecodedValue(decodedVal),
        liveUntilLedgerSeq: entry.liveUntilLedgerSeq,
        found: true,
      };
      results.push(result);
      console.log(
        formatEntry(
          'Instance',
          contractId,
          'persistent',
          xdr.ScVal.scvLedgerKeyContractInstance(),
          entry,
        ),
      );
    } else {
      console.log('  Instance entry not found — contract may be archived or expired.');
    }
  } catch (err: any) {
    if (isNotFoundError(err)) {
      console.log('  Instance entry not found (not present on ledger).');
    } else {
      console.log(`  Failed to query instance: ${err?.message ?? err}`);
    }
  }

  // Step 2: Query a named persistent key if provided
  if (storageKeyInput) {
    console.log(`\n--- Named Storage Key: ${storageKeyInput} ---`);
    let keyScVal: xdr.ScVal;
    try {
      keyScVal = buildStorageKey(storageKeyInput);
    } catch (err: any) {
      console.log(`  ${err?.message ?? err}`);
      return;
    }

    for (const durability of ['persistent', 'temporary'] as const) {
      const rpcDurability =
        durability === 'persistent' ? rpc.Durability.Persistent : rpc.Durability.Temporary;
      try {
        const entry = await server.getContractData(contractId, keyScVal, rpcDurability);
        if (entry?.val) {
          const decodedVal = decodeScVal(entry.val.contractData().val());
          const result = {
            label: `${storageKeyInput} (${durability})`,
            contractId,
            durability,
            storageKey: describeKey(keyScVal),
            rawXdr: decodedVal.rawXdr,
            decodedValue: renderDecodedValue(decodedVal),
            liveUntilLedgerSeq: entry.liveUntilLedgerSeq,
            found: true,
          };
          results.push(result);
          console.log(
            formatEntry(
              `${storageKeyInput} (${durability})`,
              contractId,
              durability,
              keyScVal,
              entry,
            ),
          );
        }
      } catch (err: any) {
        if (!isNotFoundError(err)) {
          console.log(`  ${durability} query failed: ${err?.message ?? err}`);
        }
      }
    }
  }

  // Step 3: Handle missing key gracefully
  if (!storageKeyInput) {
    console.log('\n--- Missing Key Demo ("nonexistent_key") ---');
    const demoKey = xdr.ScVal.scvSymbol('nonexistent_key');
    try {
      const entry = await server.getContractData(contractId, demoKey, rpc.Durability.Persistent);
      if (entry?.val) {
        const decodedVal = decodeScVal(entry.val.contractData().val());
        console.log(`  Found: ${renderDecodedValue(decodedVal)}`);
      } else {
        console.log('  Key "nonexistent_key" not found (expected for most contracts).');
      }
    } catch (err: any) {
      if (isNotFoundError(err)) {
        console.log('  Key "nonexistent_key" not present in contract storage (expected).');
      } else {
        console.log(`  Query failed: ${err?.message ?? err}`);
      }
    }
  }

  if (jsonOutput) {
    console.log('\n' + JSON.stringify(results, null, 2));
  }

  // Summary
  console.log('\n--- Storage Categories ---');
  console.log(
    '  Instance   : Shared config stored alongside the contract entry (always Persistent).',
  );
  console.log('  Persistent : Long-lived state that survives archival; may need TTL extension.');
  console.log('  Temporary  : Automatically deleted after TTL; cheap but ephemeral.');

  console.log('\nSoroban contract storage inspection completed.');
}
