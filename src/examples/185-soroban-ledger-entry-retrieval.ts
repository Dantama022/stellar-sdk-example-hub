import { Address, Asset, Contract, Keypair, Networks, rpc, scValToNative, xdr } from '@stellar/stellar-sdk';
import chalk from 'chalk';

import { decodeScVal, renderDecodedValue } from '../utils/scval-decoder';

/**
 * Soroban RPC Ledger Entry Retrieval Example
 *
 * Soroban RPC exposes `getLedgerEntries`, a low-level API that retrieves any
 * active ledger entry by its XDR key — without invoking a transaction.  It is
 * the same mechanism used by block explorers, indexers, and debugging tools to
 * inspect on-chain state at a given ledger.
 *
 * Ledger entries are the atoms of Stellar's ledger: every account, trustline,
 * SDEX offer, liquidity-pool share, claimable balance, and piece of Soroban
 * contract state lives in exactly one entry.  Their keys share a common type
 * (`LedgerKey`) with a discriminant that names the entry type.
 *
 * Key types supported here:
 *
 *   ContractData  – Soroban contract storage (instance, persistent, temporary).
 *                   The most commonly queried Soroban entry type.
 *   ContractCode  – The deployed WASM bytecode, identified by its SHA-256 hash.
 *   Account       – A classic Stellar account (sequence, balance, signers …).
 *   Trustline     – An account's opt-in to hold a non-native asset.
 *   Offer         – A resting SDEX limit order.
 *   Data          – A Manage Data entry (key-value blob on an account).
 *   ClaimableBalance – A funded claimable balance waiting to be claimed.
 *   LiquidityPool – An AMM constant-product pool with two reserve assets.
 *   Ttl           – A synthetic entry holding only the `liveUntilLedgerSeq`
 *                   for a rent-bearing entry (ContractData / ContractCode).
 *
 * This example demonstrates:
 *   1. Connecting to a Soroban RPC endpoint and confirming connectivity
 *   2. Constructing `LedgerKey` XDR for every supported key type
 *   3. Parsing and validating raw XDR keys supplied by the caller
 *   4. Querying multiple keys in a single `getLedgerEntries` call
 *   5. Decoding returned entries: key, entry type, value, metadata
 *   6. Displaying raw XDR alongside decoded values for every field
 *   7. Reporting `lastModifiedLedgerSeq` and `liveUntilLedgerSeq` where present
 *   8. Handling missing entries, expired/archived entries, and RPC failures
 *   9. Emitting the full result set as structured JSON on request
 *
 * All operations are read-only — no transaction is built or submitted.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Public types (exported for tests)
// ─────────────────────────────────────────────────────────────────────────────

/** Every supported ledger-key type discriminant. */
export type LedgerKeyType =
  | 'ContractData'
  | 'ContractCode'
  | 'Account'
  | 'Trustline'
  | 'Offer'
  | 'Data'
  | 'ClaimableBalance'
  | 'LiquidityPool'
  | 'Ttl'
  | 'Unknown';

/** Decoded representation of a single ledger key. */
export interface DecodedLedgerKey {
  type: LedgerKeyType;
  rawXdr: string;
  description: string;
  /** Parsed fields for known types; null for unknown types. */
  fields: Record<string, unknown> | null;
}

/** A single entry result returned by getLedgerEntries, with decoded metadata. */
export interface LedgerEntryResult {
  key: DecodedLedgerKey;
  /** Whether the RPC returned an entry for this key. */
  found: boolean;
  /** Set when the entry appears to be archived (Persistent ContractData/Code). */
  archived: boolean;
  /** Raw base64 XDR of the LedgerEntry value, or null when not found. */
  rawEntryXdr: string | null;
  /** Decoded entry type (mirrors the LedgerKey type in most cases). */
  entryType: string | null;
  /** Human-readable decoded value, or null when decoding is not supported. */
  decodedValue: string | null;
  /** Whether decodedValue is a full decode or only a partial / raw fallback. */
  fullyDecoded: boolean;
  /** lastModifiedLedgerSeq from the entry metadata. */
  lastModifiedLedger: number | null;
  /** liveUntilLedgerSeq (only for ContractData and ContractCode entries). */
  liveUntilLedger: number | null;
  /** Any error message produced during key construction or entry decoding. */
  error: string | null;
}

/** Aggregated report emitted by this example. */
export interface LedgerEntryReport {
  rpcUrl: string;
  currentLedger: number;
  queriedAt: string;
  entries: LedgerEntryResult[];
  totalQueried: number;
  totalFound: number;
  totalMissing: number;
  totalArchived: number;
  totalErrors: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Key-construction helpers (exported for tests)
// ─────────────────────────────────────────────────────────────────────────────

/** Build a ContractData LedgerKey for contract instance storage. */
export function buildContractInstanceKey(contractId: string): xdr.LedgerKey {
  const contract = new Contract(contractId);
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: contract.address().toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

/** Build a ContractData LedgerKey for an arbitrary symbol key and durability. */
export function buildContractDataKey(
  contractId: string,
  keyScVal: xdr.ScVal,
  durability: 'persistent' | 'temporary',
): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: keyScVal,
      durability:
        durability === 'persistent'
          ? xdr.ContractDataDurability.persistent()
          : xdr.ContractDataDurability.temporary(),
    }),
  );
}

/** Build a ContractCode LedgerKey from a hex-encoded WASM hash. */
export function buildContractCodeKey(codeHashHex: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: Buffer.from(codeHashHex, 'hex') }),
  );
}

/** Build an Account LedgerKey from a G-address. */
export function buildAccountKey(accountId: string): xdr.LedgerKey {
  return xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({
      accountId: Keypair.fromPublicKey(accountId).xdrPublicKey(),
    }),
  );
}

/** Build a Trustline LedgerKey. */
export function buildTrustlineKey(accountId: string, assetStr: string): xdr.LedgerKey {
  const asset = parseAsset(assetStr);
  const xdrAsset = asset.toXDRObject();
  // LedgerKeyTrustLine requires xdr.TrustLineAsset, not xdr.Asset
  let tlAsset: xdr.TrustLineAsset;
  const discriminant = xdrAsset.switch().name;
  if (discriminant === 'assetTypeNative') {
    tlAsset = xdr.TrustLineAsset.assetTypeNative();
  } else if (discriminant === 'assetTypeCreditAlphanum4') {
    tlAsset = xdr.TrustLineAsset.assetTypeCreditAlphanum4(xdrAsset.alphaNum4());
  } else {
    tlAsset = xdr.TrustLineAsset.assetTypeCreditAlphanum12(xdrAsset.alphaNum12());
  }
  return xdr.LedgerKey.trustline(
    new xdr.LedgerKeyTrustLine({
      accountId: Keypair.fromPublicKey(accountId).xdrPublicKey(),
      asset: tlAsset,
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Key-decoding helpers (exported for tests)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decode a `LedgerKey` XDR object into a structured `DecodedLedgerKey`.
 * Unknown or malformed keys are reported with type "Unknown" instead of
 * throwing.
 */
export function decodeLedgerKey(key: xdr.LedgerKey): DecodedLedgerKey {
  let rawXdr = '';
  try {
    rawXdr = key.toXDR('base64');
  } catch {
    rawXdr = '(serialization failed)';
  }

  try {
    const discriminant = key.switch();
    const name = discriminant.name as string;

    switch (name) {
      case 'account': {
        const accountId = key.account().accountId();
        const pubkey = accountId.switch().name === 'publicKeyTypeEd25519'
          ? encodePublicKey(accountId.ed25519())
          : `(${accountId.switch().name})`;
        return {
          type: 'Account',
          rawXdr,
          description: `Account: ${pubkey}`,
          fields: { accountId: pubkey },
        };
      }

      case 'trustline': {
        const tl = key.trustLine();
        const accountId = tl.accountId();
        const pubkey = accountId.switch().name === 'publicKeyTypeEd25519'
          ? encodePublicKey(accountId.ed25519())
          : `(${accountId.switch().name})`;
        const assetStr = decodeTrustLineAsset(tl.asset());
        return {
          type: 'Trustline',
          rawXdr,
          description: `Trustline: ${pubkey} / ${assetStr}`,
          fields: { accountId: pubkey, asset: assetStr },
        };
      }

      case 'offer': {
        const offer = key.offer();
        const sellerId = encodePublicKey(offer.sellerId().ed25519());
        const offerId = offer.offerId().toString();
        return {
          type: 'Offer',
          rawXdr,
          description: `Offer #${offerId} by ${sellerId}`,
          fields: { sellerId, offerId },
        };
      }

      case 'data': {
        const data = key.data();
        const accountId = data.accountId().switch().name === 'publicKeyTypeEd25519'
          ? encodePublicKey(data.accountId().ed25519())
          : `(${data.accountId().switch().name})`;
        const dataName = data.dataName();
        return {
          type: 'Data',
          rawXdr,
          description: `ManageData "${dataName}" on ${accountId}`,
          fields: { accountId, dataName },
        };
      }

      case 'claimableBalance': {
        const balanceId = key.claimableBalance().balanceId();
        const idHex = balanceId.toXDR('hex');
        return {
          type: 'ClaimableBalance',
          rawXdr,
          description: `ClaimableBalance ${idHex}`,
          fields: { balanceId: idHex },
        };
      }

      case 'liquidityPool': {
        const poolIdBuf = key.liquidityPool().liquidityPoolId();
        const poolId = (poolIdBuf as unknown as Buffer).toString('hex');
        return {
          type: 'LiquidityPool',
          rawXdr,
          description: `LiquidityPool ${poolId}`,
          fields: { liquidityPoolId: poolId },
        };
      }

      case 'contractData': {
        const cd = key.contractData();
        const contract = contractAddressFromScAddress(cd.contract());
        const keyVal = cd.key();
        const durability = cd.durability().name;
        let keyDesc: string;
        // The contract instance sentinel (scvLedgerKeyContractInstance) converts
        // to undefined with scValToNative — give it a readable label instead.
        if (keyVal.switch().name === 'scvLedgerKeyContractInstance') {
          keyDesc = 'ContractInstance';
        } else {
          try {
            const native = scValToNative(keyVal);
            keyDesc = native !== undefined ? JSON.stringify(native, bigintReplacer) : keyVal.switch().name;
          } catch {
            keyDesc = keyVal.switch().name;
          }
        }
        return {
          type: 'ContractData',
          rawXdr,
          description: `ContractData ${contract} key=${keyDesc} durability=${durability}`,
          fields: { contract, key: keyDesc, durability },
        };
      }

      case 'contractCode': {
        const hashHex = key.contractCode().hash().toString('hex');
        return {
          type: 'ContractCode',
          rawXdr,
          description: `ContractCode WASM hash=${hashHex}`,
          fields: { codeHash: hashHex },
        };
      }

      case 'ttl': {
        const hashHex = key.ttl().keyHash().toString('hex');
        return {
          type: 'Ttl',
          rawXdr,
          description: `TTL entry for key hash=${hashHex}`,
          fields: { keyHash: hashHex },
        };
      }

      default:
        return {
          type: 'Unknown',
          rawXdr,
          description: `Unknown LedgerKey type: ${name}`,
          fields: null,
        };
    }
  } catch (err: any) {
    return {
      type: 'Unknown',
      rawXdr,
      description: `Could not decode LedgerKey: ${err?.message ?? String(err)}`,
      fields: null,
    };
  }
}

/**
 * Parse a raw base64 XDR string into a `LedgerKey`.
 * Returns null and sets `error` on failure.
 */
export function parseLedgerKeyXdr(xdrB64: string): { key: xdr.LedgerKey | null; error: string | null } {
  try {
    const key = xdr.LedgerKey.fromXDR(xdrB64, 'base64');
    return { key, error: null };
  } catch (err: any) {
    return { key: null, error: `Malformed LedgerKey XDR: ${err?.message ?? String(err)}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry-decoding helpers (exported for tests)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decode a `LedgerEntry` returned by `getLedgerEntries`.
 * Returns a human-readable description and decoded value where possible,
 * falling back to raw XDR for types that cannot be decoded further.
 */
export function decodeLedgerEntry(
  entry: rpc.Api.LedgerEntryResult,
  keyType: LedgerKeyType,
): { entryType: string; decodedValue: string; fullyDecoded: boolean } {
  try {
    const ledgerEntry = entry.val as unknown as xdr.LedgerEntry;
    const data = ledgerEntry.data();
    const discriminant = data.switch().name as string;

    switch (discriminant) {
      case 'account': {
        const acct = data.account();
        const balance = acct.balance().toString();
        const seqNum = acct.seqNum().toString();
        const numSubEntries = acct.numSubEntries();
        return {
          entryType: 'Account',
          decodedValue: `balance=${balance} stroops, seqNum=${seqNum}, subEntries=${numSubEntries}`,
          fullyDecoded: true,
        };
      }

      case 'trustline': {
        const tl = data.trustLine();
        const balance = tl.balance().toString();
        const limit = tl.limit().toString();
        const flags = tl.flags();
        const assetStr = decodeTrustLineAsset(tl.asset());
        return {
          entryType: 'Trustline',
          decodedValue: `asset=${assetStr}, balance=${balance}, limit=${limit}, flags=${flags}`,
          fullyDecoded: true,
        };
      }

      case 'offer': {
        const offer = data.offer();
        const selling = decodeXdrAsset(offer.selling());
        const buying = decodeXdrAsset(offer.buying());
        const amount = offer.amount().toString();
        const offerId = offer.offerId().toString();
        return {
          entryType: 'Offer',
          decodedValue: `id=${offerId} selling=${selling} buying=${buying} amount=${amount}`,
          fullyDecoded: true,
        };
      }

      case 'data': {
        const managedData = data.data();
        const name = managedData.dataName();
        const value = managedData.dataValue();
        const valueStr = value ? value.toString('base64') : '(empty)';
        return {
          entryType: 'ManageData',
          decodedValue: `name="${name}", value=${valueStr}`,
          fullyDecoded: true,
        };
      }

      case 'claimableBalance': {
        const cb = data.claimableBalance();
        const asset = decodeXdrAsset(cb.asset());
        const amount = cb.amount().toString();
        const claimantCount = cb.claimants().length;
        return {
          entryType: 'ClaimableBalance',
          decodedValue: `asset=${asset}, amount=${amount}, claimants=${claimantCount}`,
          fullyDecoded: true,
        };
      }

      case 'liquidityPool': {
        const pool = data.liquidityPool();
        const body = pool.body();
        if (body.switch().name === 'liquidityPoolConstantProduct') {
          const cp = body.constantProduct();
          const params = cp.params();
          const assetA = decodeXdrAsset(params.assetA());
          const assetB = decodeXdrAsset(params.assetB());
          const reserveA = cp.reserveA().toString();
          const reserveB = cp.reserveB().toString();
          const totalShares = cp.totalPoolShares().toString();
          return {
            entryType: 'LiquidityPool',
            decodedValue:
              `${assetA}/${assetB} reserveA=${reserveA} reserveB=${reserveB} shares=${totalShares}`,
            fullyDecoded: true,
          };
        }
        return {
          entryType: 'LiquidityPool',
          decodedValue: `(pool body type: ${body.switch().name})`,
          fullyDecoded: false,
        };
      }

      case 'contractData': {
        const cd = data.contractData();
        const val = cd.val();
        if (val.switch() === xdr.ScValType.scvContractInstance()) {
          const instance = val.instance();
          const execType = instance.executable().switch().name;
          let wasmHash = '';
          if (execType === 'contractExecutableWasm') {
            wasmHash = ` wasmHash=${instance.executable().wasmHash().toString('hex')}`;
          }
          const storagePairs = instance.storage() ?? [];
          return {
            entryType: 'ContractData (instance)',
            decodedValue: `contractInstance execType=${execType}${wasmHash} instanceStorageKeys=${storagePairs.length}`,
            fullyDecoded: true,
          };
        }
        // Generic ScVal decoding
        const decoded = decodeScVal(val);
        return {
          entryType: 'ContractData',
          decodedValue: renderDecodedValue(decoded),
          fullyDecoded: decoded.decoded,
        };
      }

      case 'contractCode': {
        const code = data.contractCode();
        const codeLen = code.code().length;
        const hashHex = code.hash ? code.hash().toString('hex') : '(hash unavailable)';
        return {
          entryType: 'ContractCode',
          decodedValue: `WASM size=${codeLen} bytes, hash=${hashHex}`,
          fullyDecoded: true,
        };
      }

      default:
        // Preserve raw XDR for types we have not modelled
        try {
          const rawXdr = ledgerEntry.toXDR('base64');
          return {
            entryType: discriminant,
            decodedValue: `(raw XDR) ${truncate(rawXdr, 80)}`,
            fullyDecoded: false,
          };
        } catch {
          return { entryType: discriminant, decodedValue: '(could not serialize)', fullyDecoded: false };
        }
    }
  } catch (err: any) {
    // Fallback: at minimum emit the raw XDR
    let rawXdr = '';
    try {
      rawXdr = (entry.val as unknown as xdr.LedgerEntry).toXDR('base64');
    } catch {
      /* ignore */
    }
    return {
      entryType: keyType,
      decodedValue: rawXdr ? `(raw XDR) ${truncate(rawXdr, 80)}` : '(could not decode)',
      fullyDecoded: false,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Default key set (used when no explicit keys are provided)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a default set of example ledger keys that work out-of-the-box on
 * Testnet.  The native XLM Stellar Asset Contract (SAC) is deterministically
 * deployed, so its instance and code entries are always present.
 */
function buildDefaultKeys(): Array<{ label: string; key: xdr.LedgerKey }> {
  const sacId = Asset.native().contractId(Networks.TESTNET);

  // Native SAC instance key
  const instanceKey = buildContractInstanceKey(sacId);

  // Native SAC: a symbol key "COUNTER" (almost certainly missing — demonstrates
  // the graceful not-found path)
  const counterKey = buildContractDataKey(
    sacId,
    xdr.ScVal.scvSymbol('COUNTER'),
    'persistent',
  );

  // Derive the code hash from the instance entry later; for now return what
  // we can build statically.  The code key needs the hash from the live entry,
  // so we cannot build it upfront without an RPC call.

  return [
    { label: 'Native SAC instance', key: instanceKey },
    { label: 'Native SAC COUNTER key (expected: missing)', key: counterKey },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Core retrieval logic (exported for tests)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Query multiple ledger keys in a single `getLedgerEntries` call, decode
 * every returned entry, and build the aggregated report.
 */
export async function retrieveLedgerEntries(
  server: rpc.Server,
  labelledKeys: Array<{ label: string; key: xdr.LedgerKey }>,
): Promise<LedgerEntryResult[]> {
  if (labelledKeys.length === 0) return [];

  const keys = labelledKeys.map((lk) => lk.key);

  // Single batched request
  let response: rpc.Api.GetLedgerEntriesResponse;
  try {
    response = await server.getLedgerEntries(...keys);
  } catch (err: any) {
    // Surface as an error on every key
    return labelledKeys.map((lk) => ({
      key: decodeLedgerKey(lk.key),
      found: false,
      archived: false,
      rawEntryXdr: null,
      entryType: null,
      decodedValue: null,
      fullyDecoded: false,
      lastModifiedLedger: null,
      liveUntilLedger: null,
      error: `RPC failure: ${err?.message ?? String(err)}`,
    }));
  }

  // Build a lookup from raw base64 key XDR → returned entry
  const entryMap = new Map<string, rpc.Api.LedgerEntryResult>();
  for (const entry of response.entries ?? []) {
    let keyXdr = '';
    try {
      keyXdr = (entry.key as xdr.LedgerKey).toXDR('base64');
    } catch {
      /* skip unmappable entries */
    }
    if (keyXdr) entryMap.set(keyXdr, entry);
  }

  const results: LedgerEntryResult[] = [];

  for (const { label, key } of labelledKeys) {
    const decodedKey = decodeLedgerKey(key);
    // Annotate the key description with the caller-supplied label when different
    if (label && !decodedKey.description.includes(label)) {
      decodedKey.description = `[${label}] ${decodedKey.description}`;
    }

    let keyXdr = '';
    try {
      keyXdr = key.toXDR('base64');
    } catch {
      results.push({
        key: decodedKey,
        found: false,
        archived: false,
        rawEntryXdr: null,
        entryType: null,
        decodedValue: null,
        fullyDecoded: false,
        lastModifiedLedger: null,
        liveUntilLedger: null,
        error: 'Could not serialize this key — skipped.',
      });
      continue;
    }

    const entry = entryMap.get(keyXdr);

    if (!entry) {
      // Determine whether this looks like it could be an archived Persistent
      // entry (ContractData / ContractCode) versus simply never existing.
      const mightBeArchived =
        decodedKey.type === 'ContractData' || decodedKey.type === 'ContractCode';
      results.push({
        key: decodedKey,
        found: false,
        archived: mightBeArchived,
        rawEntryXdr: null,
        entryType: null,
        decodedValue: null,
        fullyDecoded: false,
        lastModifiedLedger: null,
        liveUntilLedger: null,
        error: null,
      });
      continue;
    }

    // Decode the returned entry
    let rawEntryXdr: string | null = null;
    try {
      rawEntryXdr = (entry.val as unknown as xdr.LedgerEntry).toXDR('base64');
    } catch {
      rawEntryXdr = null;
    }

    let entryType: string | null = null;
    let decodedValue: string | null = null;
    let fullyDecoded = false;
    let entryError: string | null = null;

    try {
      const decoded = decodeLedgerEntry(entry, decodedKey.type);
      entryType = decoded.entryType;
      decodedValue = decoded.decodedValue;
      fullyDecoded = decoded.fullyDecoded;
    } catch (err: any) {
      entryError = `Decode error: ${err?.message ?? String(err)}`;
      entryType = decodedKey.type;
    }

    const lastModifiedLedger = entry.lastModifiedLedgerSeq ?? null;
    const liveUntilLedger = (entry as any).liveUntilLedgerSeq ?? null;

    results.push({
      key: decodedKey,
      found: true,
      archived: false,
      rawEntryXdr,
      entryType,
      decodedValue,
      fullyDecoded,
      lastModifiedLedger,
      liveUntilLedger,
      error: entryError,
    });
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Display helpers
// ─────────────────────────────────────────────────────────────────────────────

function displayResult(result: LedgerEntryResult, index: number, total: number): void {
  const prefix = chalk.gray(`[${index + 1}/${total}]`);
  console.log();
  console.log(`${prefix} ${chalk.bold(result.key.description)}`);
  console.log(chalk.gray(`  Key type          : ${result.key.type}`));
  console.log(chalk.gray(`  Raw key XDR       : ${truncate(result.key.rawXdr, 72)}`));

  if (result.error && !result.found) {
    console.log(chalk.red(`  Error             : ${result.error}`));
    return;
  }

  if (!result.found) {
    if (result.archived) {
      console.log(
        chalk.yellow('  Status            : NOT FOUND (possibly archived or never written)'),
      );
      console.log(
        chalk.gray(
          '  Note: Persistent ContractData/ContractCode entries that have passed their\n' +
            '        liveUntilLedgerSeq are archived and removed from active state. Use\n' +
            '        Operation.restoreFootprint to bring them back.',
        ),
      );
    } else {
      console.log(chalk.gray('  Status            : NOT FOUND (entry absent or never created)'));
    }
    return;
  }

  console.log(chalk.green('  Status            : FOUND'));
  console.log(`  Entry type        : ${result.entryType ?? '(unknown)'}`);

  if (result.rawEntryXdr) {
    console.log(chalk.gray(`  Raw entry XDR     : ${truncate(result.rawEntryXdr, 72)}`));
  }

  if (result.decodedValue !== null) {
    const colour = result.fullyDecoded ? chalk.white : chalk.yellow;
    console.log(colour(`  Decoded value     : ${result.decodedValue}`));
    if (!result.fullyDecoded) {
      console.log(chalk.gray('  (partial decode — raw XDR preserved above)'));
    }
  }

  if (result.lastModifiedLedger !== null) {
    console.log(chalk.gray(`  Last modified     : ledger ${result.lastModifiedLedger}`));
  }

  if (result.liveUntilLedger !== null) {
    console.log(chalk.gray(`  Live until ledger : ${result.liveUntilLedger}`));
    console.log(
      chalk.gray(
        '  (TTL-bearing entry: extend via Operation.extendFootprintTtl before expiry)',
      ),
    );
  }

  if (result.error) {
    console.log(chalk.yellow(`  Warning           : ${result.error}`));
  }
}

function displaySummary(report: LedgerEntryReport): void {
  console.log();
  console.log(chalk.bold('═══ Summary ═══'));
  console.log(`  Queried at        : ${report.queriedAt}`);
  console.log(`  Current ledger    : ${report.currentLedger}`);
  console.log(`  Total queried     : ${report.totalQueried}`);
  console.log(chalk.green(`  Found             : ${report.totalFound}`));
  console.log(chalk.gray(`  Missing           : ${report.totalMissing}`));
  if (report.totalArchived > 0) {
    console.log(chalk.yellow(`  Possibly archived : ${report.totalArchived}`));
  }
  if (report.totalErrors > 0) {
    console.log(chalk.red(`  Errors            : ${report.totalErrors}`));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Param-parsing helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a ledger-key specification supplied as a string.
 *
 * Accepted formats:
 *   contract:<contractId>               → ContractData instance key
 *   contract:<contractId>:<symbol>      → ContractData persistent symbol key
 *   account:<accountId>                 → Account entry
 *   xdr:<base64>                        → Raw LedgerKey XDR
 *
 * Returns null (and logs a warning) when the spec is unrecognised.
 */
export function parseLedgerKeySpec(
  spec: string,
): { label: string; key: xdr.LedgerKey } | null {
  const trimmed = spec.trim();
  if (!trimmed) return null;

  try {
    if (trimmed.startsWith('xdr:')) {
      const b64 = trimmed.slice(4).trim();
      const { key, error } = parseLedgerKeyXdr(b64);
      if (!key) throw new Error(error ?? 'could not parse XDR');
      return { label: 'raw XDR key', key };
    }

    if (trimmed.startsWith('contract:')) {
      const parts = trimmed.slice('contract:'.length).split(':');
      const contractId = parts[0];
      if (!contractId) throw new Error('contract ID is empty');
      if (parts.length === 1) {
        return { label: `contract:${contractId} instance`, key: buildContractInstanceKey(contractId) };
      }
      const sym = parts.slice(1).join(':');
      return {
        label: `contract:${contractId} key=${sym}`,
        key: buildContractDataKey(contractId, xdr.ScVal.scvSymbol(sym), 'persistent'),
      };
    }

    if (trimmed.startsWith('account:')) {
      const accountId = trimmed.slice('account:'.length).trim();
      if (!accountId) throw new Error('account ID is empty');
      return { label: `account:${accountId}`, key: buildAccountKey(accountId) };
    }

    // Treat bare 56-char C-addresses as contract instance keys
    if (/^C[A-Z2-7]{55}$/.test(trimmed)) {
      return { label: `contract:${trimmed} instance`, key: buildContractInstanceKey(trimmed) };
    }

    console.warn(chalk.yellow(`  Unrecognised key spec (skipped): "${trimmed}"`));
    return null;
  } catch (err: any) {
    console.warn(chalk.yellow(`  Could not parse key spec "${trimmed}": ${err?.message ?? String(err)}`));
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entrypoint
// ─────────────────────────────────────────────────────────────────────────────

export interface RunParams {
  rpcUrl?: string;
  /** Comma-separated key specifications.  See parseLedgerKeySpec for format. */
  keys?: string;
  json?: boolean;
}

export async function run(params?: RunParams): Promise<void> {
  const rpcUrl =
    params?.rpcUrl ??
    process.env.SOROBAN_RPC_URL ??
    'https://soroban-testnet.stellar.org';

  const jsonOutput =
    params?.json === true ||
    process.env.JSON_OUTPUT === 'true' ||
    process.argv.includes('--json');

  // Accept key specs from params, env, or CLI args
  const keySpecRaw =
    params?.keys ??
    process.env.LEDGER_KEYS ??
    process.argv.slice(3).filter((a) => !a.startsWith('--')).join(',');

  if (!jsonOutput) {
    console.log(chalk.bold('Soroban RPC Ledger Entry Retrieval Example'));
    console.log(
      chalk.gray(
        'Retrieve and decode Soroban ledger entries via getLedgerEntries without mutating state.',
      ),
    );
    console.log(chalk.blue(`\nConnecting to Soroban RPC: ${rpcUrl}`));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 1: Confirm connectivity
  // ──────────────────────────────────────────────────────────────────────────
  if (!jsonOutput) console.log(chalk.yellow('\nStep 1: Confirming RPC connectivity...'));

  const server = new rpc.Server(rpcUrl);
  let currentLedger = 0;
  try {
    const latest = await server.getLatestLedger();
    currentLedger = latest.sequence;
    if (!jsonOutput) {
      console.log(chalk.green(`  Connected. Current ledger: ${currentLedger}`));
    }
  } catch (err: any) {
    const msg = `Failed to reach Soroban RPC: ${err?.message ?? String(err)}`;
    if (jsonOutput) {
      console.log(JSON.stringify({ error: msg }, null, 2));
    } else {
      console.error(chalk.red(msg));
    }
    return;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 2: Build or parse the ledger key list
  // ──────────────────────────────────────────────────────────────────────────
  if (!jsonOutput) console.log(chalk.yellow('\nStep 2: Building ledger key list...'));

  let labelledKeys: Array<{ label: string; key: xdr.LedgerKey }>;

  if (keySpecRaw) {
    const specs = keySpecRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    labelledKeys = specs
      .map((spec) => parseLedgerKeySpec(spec))
      .filter((k): k is { label: string; key: xdr.LedgerKey } => k !== null);

    if (labelledKeys.length === 0) {
      const msg =
        'No valid ledger keys could be parsed. Check LEDGER_KEYS format and try again.\n' +
        'Accepted formats: contract:<id>, contract:<id>:<symbol>, account:<id>, xdr:<base64>, or bare contract ID.';
      if (jsonOutput) {
        console.log(JSON.stringify({ error: msg }, null, 2));
      } else {
        console.error(chalk.red(msg));
      }
      return;
    }
  } else {
    // No keys supplied — use the default Testnet set
    labelledKeys = buildDefaultKeys();
    if (!jsonOutput) {
      console.log(
        chalk.gray(
          '  No LEDGER_KEYS supplied. Querying default Testnet entries:\n' +
            '  • Native XLM Stellar Asset Contract instance\n' +
            '  • Native SAC COUNTER key (demonstrates missing-entry handling)\n\n' +
            '  To query specific entries set LEDGER_KEYS=contract:<id>,account:<id>,xdr:<b64>',
        ),
      );
    }
  }

  if (!jsonOutput) {
    console.log(chalk.green(`  ${labelledKeys.length} key(s) to query.`));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 3: Retrieve all ledger entries in a single batched call
  // ──────────────────────────────────────────────────────────────────────────
  if (!jsonOutput) {
    console.log(
      chalk.yellow(
        `\nStep 3: Calling getLedgerEntries with ${labelledKeys.length} key(s)...`,
      ),
    );
    console.log(
      chalk.gray(
        '  getLedgerEntries accepts up to 200 keys per request. Missing entries are simply\n' +
          '  absent from the response — they do not cause a failure.',
      ),
    );
  }

  const results = await retrieveLedgerEntries(server, labelledKeys);

  // ──────────────────────────────────────────────────────────────────────────
  // Step 4: Display / emit results
  // ──────────────────────────────────────────────────────────────────────────
  const totalFound = results.filter((r) => r.found).length;
  const totalMissing = results.filter((r) => !r.found && !r.archived && !r.error).length;
  const totalArchived = results.filter((r) => r.archived).length;
  const totalErrors = results.filter((r) => !!r.error).length;

  const report: LedgerEntryReport = {
    rpcUrl,
    currentLedger,
    queriedAt: new Date().toISOString(),
    entries: results,
    totalQueried: results.length,
    totalFound,
    totalMissing,
    totalArchived,
    totalErrors,
  };

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (!jsonOutput) console.log(chalk.yellow('\nStep 4: Decoding and displaying results...'));

  for (let i = 0; i < results.length; i++) {
    displayResult(results[i], i, results.length);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 5: Summary
  // ──────────────────────────────────────────────────────────────────────────
  displaySummary(report);

  console.log();
  console.log(
    chalk.cyan(
      'Ledger entry retrieval complete. No transactions were submitted.\n' +
        'Set LEDGER_KEYS=contract:<id>,account:<id>,xdr:<b64> to query custom entries,\n' +
        'or JSON_OUTPUT=true for structured output.',
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal utilities
// ─────────────────────────────────────────────────────────────────────────────

/** StrKey-encode a raw 32-byte Ed25519 public key. */
function encodePublicKey(raw: Buffer): string {
  try {
    const stellarSdk = require('@stellar/stellar-sdk');
    return stellarSdk.StrKey.encodeEd25519PublicKey(raw);
  } catch {
    return `0x${raw.toString('hex')}`;
  }
}

/** Decode an XDR Asset to a human-readable string. */
function decodeXdrAsset(asset: xdr.Asset): string {
  try {
    const discriminant = asset.switch().name;
    if (discriminant === 'assetTypeNative') return 'XLM (native)';
    if (discriminant === 'assetTypeCreditAlphanum4') {
      const a4 = asset.alphaNum4();
      const code = a4.assetCode().toString().replace(/\0/g, '');
      const issuer = encodePublicKey(a4.issuer().ed25519());
      return `${code}:${issuer}`;
    }
    if (discriminant === 'assetTypeCreditAlphanum12') {
      const a12 = asset.alphaNum12();
      const code = a12.assetCode().toString().replace(/\0/g, '');
      const issuer = encodePublicKey(a12.issuer().ed25519());
      return `${code}:${issuer}`;
    }
    return `(${discriminant})`;
  } catch {
    return '(could not decode asset)';
  }
}

/**
 * Decode an XDR TrustLineAsset to a human-readable string.
 * TrustLineAsset is a separate XDR type from Asset but shares the same
 * discriminant values plus `assetTypePoolShare`.
 */
function decodeTrustLineAsset(asset: xdr.TrustLineAsset): string {
  try {
    const discriminant = asset.switch().name;
    if (discriminant === 'assetTypeNative') return 'XLM (native)';
    if (discriminant === 'assetTypeCreditAlphanum4') {
      const a4 = asset.alphaNum4();
      const code = a4.assetCode().toString().replace(/\0/g, '');
      const issuer = encodePublicKey(a4.issuer().ed25519());
      return `${code}:${issuer}`;
    }
    if (discriminant === 'assetTypeCreditAlphanum12') {
      const a12 = asset.alphaNum12();
      const code = a12.assetCode().toString().replace(/\0/g, '');
      const issuer = encodePublicKey(a12.issuer().ed25519());
      return `${code}:${issuer}`;
    }
    if (discriminant === 'assetTypePoolShare') {
      const poolId = (asset.liquidityPoolId() as unknown as Buffer).toString('hex');
      return `PoolShare(${poolId})`;
    }
    return `(${discriminant})`;
  } catch {
    return '(could not decode trustline asset)';
  }
}

/** Extract a contract/account address string from an ScAddress. */
function contractAddressFromScAddress(scAddress: xdr.ScAddress): string {
  try {
    const name = scAddress.switch().name;
    if (name === 'scAddressTypeContract') {
      const contractId = scAddress.contractId();
      const stellarSdk = require('@stellar/stellar-sdk');
      return stellarSdk.StrKey.encodeContract(contractId);
    }
    if (name === 'scAddressTypeAccount') {
      return encodePublicKey(scAddress.accountId().ed25519());
    }
    return `(${name})`;
  } catch {
    return '(could not decode address)';
  }
}

/** Parse an asset string ("native", "XLM", "CODE:ISSUER"). */
function parseAsset(assetStr: string): Asset {
  const trimmed = assetStr.trim();
  if (trimmed === 'native' || trimmed === 'XLM') return Asset.native();
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx > 0) {
    const code = trimmed.slice(0, colonIdx);
    const issuer = trimmed.slice(colonIdx + 1);
    return new Asset(code, issuer);
  }
  throw new Error(`Cannot parse asset "${assetStr}" — use "native" or "CODE:ISSUER"`);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
