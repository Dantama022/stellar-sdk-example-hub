/**
 * Pure XDR -> readable decoding. No network access happens here, which keeps it
 * easy to test with hand-built ScVals.
 */
import { Address, scValToBigInt, xdr } from '@stellar/stellar-sdk';
import {
  DecodeOptions,
  DecodedMapEntry,
  DecodedValue,
  ExecutableInfo,
  InspectionError,
} from './types';

const DEFAULT_MAX_DEPTH = 16;

function toBase64(val: xdr.ScVal): string | undefined {
  try {
    return val.toXDR('base64');
  } catch {
    return undefined;
  }
}

/** Decode base64 XDR into an ScVal, throwing InspectionError on malformed input. */
export function scValFromBase64(b64: string): xdr.ScVal {
  try {
    return xdr.ScVal.fromXDR(b64, 'base64');
  } catch (e) {
    throw new InspectionError(
      'XDR_DECODE_FAILED',
      `Could not decode ScVal XDR: ${(e as Error).message}`
    );
  }
}

/** Decode base64 XDR into LedgerEntryData, throwing InspectionError on malformed input. */
export function ledgerEntryDataFromBase64(b64: string): xdr.LedgerEntryData {
  try {
    return xdr.LedgerEntryData.fromXDR(b64, 'base64');
  } catch (e) {
    throw new InspectionError(
      'XDR_DECODE_FAILED',
      `Could not decode LedgerEntryData XDR: ${(e as Error).message}`
    );
  }
}

function unsupported(val: xdr.ScVal, type: string, warning: string): DecodedValue {
  return { type, supported: false, xdr: toBase64(val), warning };
}

function safeTypeName(val: xdr.ScVal): string {
  try {
    return val.switch().name;
  } catch {
    return 'unknown';
  }
}

/**
 * Decode one ScVal. Never throws: anything that cannot be decoded safely is
 * returned with `supported: false` and the original XDR retained.
 */
export function decodeScVal(
  val: xdr.ScVal,
  options: DecodeOptions = {},
  depth = 0
): DecodedValue {
  const type = safeTypeName(val);
  try {
    const decoded = decodeInner(val, type, options, depth);
    if (options.retainXdr && decoded.xdr === undefined) {
      decoded.xdr = toBase64(val);
    }
    return decoded;
  } catch (e) {
    return unsupported(val, type, `Decoding failed: ${(e as Error).message}`);
  }
}

function decodeInner(
  val: xdr.ScVal,
  type: string,
  options: DecodeOptions,
  depth: number
): DecodedValue {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

  switch (type) {
    case 'scvBool':
      return { type, supported: true, value: val.b() };
    case 'scvVoid':
      return { type, supported: true, value: null };
    case 'scvU32':
      return { type, supported: true, value: val.u32() };
    case 'scvI32':
      return { type, supported: true, value: val.i32() };
    case 'scvU64':
    case 'scvI64':
    case 'scvU128':
    case 'scvI128':
    case 'scvU256':
    case 'scvI256':
    case 'scvTimepoint':
    case 'scvDuration':
      // Decimal strings: JSON cannot represent bigint and Number loses precision.
      return { type, supported: true, value: scValToBigInt(val).toString() };
    case 'scvBytes':
      return { type, supported: true, value: Buffer.from(val.bytes()).toString('hex') };
    case 'scvString': {
      const raw = Buffer.from(val.str());
      try {
        return {
          type,
          supported: true,
          value: new TextDecoder('utf-8', { fatal: true }).decode(raw),
        };
      } catch {
        // Contract strings are arbitrary bytes; they are not guaranteed to be UTF-8.
        return {
          type,
          supported: false,
          value: raw.toString('hex'),
          xdr: toBase64(val),
          warning: 'String is not valid UTF-8; value shown as hex.',
        };
      }
    }
    case 'scvSymbol':
      return { type, supported: true, value: val.sym().toString() };
    case 'scvAddress':
      return { type, supported: true, value: Address.fromScAddress(val.address()).toString() };
    case 'scvVec': {
      const items = val.vec();
      if (items === null) return { type, supported: true, value: null };
      if (depth >= maxDepth) return unsupported(val, type, `Maximum depth (${maxDepth}) exceeded.`);
      return {
        type,
        supported: true,
        value: items.map((v) => decodeScVal(v, options, depth + 1)),
      };
    }
    case 'scvMap': {
      const entries = val.map();
      if (entries === null) return { type, supported: true, value: null };
      if (depth >= maxDepth) return unsupported(val, type, `Maximum depth (${maxDepth}) exceeded.`);
      const out: DecodedMapEntry[] = entries.map((e) => ({
        key: decodeScVal(e.key(), options, depth + 1),
        value: decodeScVal(e.val(), options, depth + 1),
      }));
      return { type, supported: true, value: out };
    }
    default:
      // scvError, scvContractInstance, scvLedgerKey*, and anything added later.
      return unsupported(val, type, `ScVal type "${type}" has no readable decoder in this example.`);
  }
}

/** Describe the executable half of an ScContractInstance. */
export function describeExecutable(exec: xdr.ContractExecutable): ExecutableInfo {
  const name = exec.switch().name;
  if (name === 'contractExecutableWasm') {
    return { type: 'wasm', wasmHash: Buffer.from(exec.wasmHash()).toString('hex') };
  }
  if (name === 'contractExecutableStellarAsset') {
    return { type: 'stellar_asset' };
  }
  return { type: 'unknown', xdr: exec.toXDR('base64') };
}
