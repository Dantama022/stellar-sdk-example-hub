/**
 * ScVal decoding. Turns a Soroban return value into a tree of readable nodes.
 *
 * Decoding answers "what is this value?", not "is it what I expected?" (that
 * is type-validator.ts). Every node keeps its wire type (`scvU128`, `scvMap`,
 * ...). Integers 64 bits and wider stay `bigint`, never `number`. Values the
 * example does not decode keep their raw XDR so nothing is silently dropped.
 */

import { Address, scValToBigInt, xdr } from '@stellar/stellar-sdk';

export type DecodedScalar = null | boolean | number | bigint | string | Uint8Array;

export interface DecodedNode {
  /** Wire type name, e.g. `scvU128`. */
  scType: string;
  /** Decoded scalar (`undefined` for composite or unsupported nodes). */
  value?: DecodedScalar;
  /** Vec elements. */
  items?: DecodedNode[];
  /** Map entries in wire order. */
  entries?: Array<{ key: DecodedNode; value: DecodedNode }>;
  /** Present when the node could not be decoded: base64 XDR of the original ScVal. */
  unsupportedRaw?: string;
}

export type DecodeErrorCode =
  | 'MISSING_RETURN_VALUE'
  | 'INVALID_SCVAL'
  | 'MALFORMED_XDR'
  | 'UNSUPPORTED_TYPE'
  | 'DECODE_FAILURE';

export interface DecodeIssue {
  code: DecodeErrorCode;
  path: string;
  message: string;
}

export type DecodeStatus = 'decoded' | 'partial' | 'failed' | 'missing';

export interface DecodeResult {
  status: DecodeStatus;
  node?: DecodedNode;
  /** Base64 XDR of the top-level ScVal, whenever one could be obtained. */
  rawXdr?: string;
  errors: DecodeIssue[];
  warnings: string[];
}

export type ReturnValueInput = xdr.ScVal | string | Uint8Array | null | undefined;

const UNSUPPORTED_NAMES = new Set([
  'scvError',
  'scvContractInstance',
  'scvLedgerKeyContractInstance',
  'scvLedgerKeyNonce',
]);

function raw(val: xdr.ScVal): string {
  return val.toXDR('base64');
}

function decodeNode(val: xdr.ScVal, path: string, issues: DecodeIssue[], depth: number): DecodedNode {
  if (depth > 64) {
    issues.push({ code: 'DECODE_FAILURE', path, message: 'value is nested more than 64 levels deep' });
    return { scType: val.switch().name, unsupportedRaw: raw(val) };
  }
  const scType = val.switch().name;
  try {
    switch (scType) {
      case 'scvVoid':
        return { scType, value: null };
      case 'scvBool':
        return { scType, value: val.b() };
      case 'scvU32':
        return { scType, value: val.u32() };
      case 'scvI32':
        return { scType, value: val.i32() };
      case 'scvU64':
      case 'scvI64':
      case 'scvU128':
      case 'scvI128':
      case 'scvU256':
      case 'scvI256':
        return { scType, value: scValToBigInt(val) };
      case 'scvTimepoint':
        return { scType, value: BigInt(val.timepoint().toString()) };
      case 'scvDuration':
        return { scType, value: BigInt(val.duration().toString()) };
      case 'scvBytes':
        return { scType, value: Uint8Array.from(val.bytes()) };
      case 'scvString':
        return { scType, value: val.str().toString('utf8') };
      case 'scvSymbol':
        return { scType, value: val.sym().toString('utf8') };
      case 'scvAddress':
        return { scType, value: Address.fromScAddress(val.address()).toString() };
      case 'scvVec': {
        const vec = val.vec();
        // A vec can legitimately be absent (option<vec> uses scvVoid instead), so treat null as empty.
        return { scType, items: (vec ?? []).map((v, i) => decodeNode(v, `${path}[${i}]`, issues, depth + 1)) };
      }
      case 'scvMap': {
        const map = val.map() ?? [];
        return {
          scType,
          entries: map.map((e, i) => ({
            key: decodeNode(e.key(), `${path}.key[${i}]`, issues, depth + 1),
            value: decodeNode(e.val(), `${path}[${i}]`, issues, depth + 1),
          })),
        };
      }
      default:
        if (UNSUPPORTED_NAMES.has(scType)) {
          issues.push({ code: 'UNSUPPORTED_TYPE', path, message: `${scType} is not decoded by this example; raw XDR preserved` });
        } else {
          issues.push({ code: 'UNSUPPORTED_TYPE', path, message: `unknown ScVal type ${scType}; raw XDR preserved` });
        }
        return { scType, unsupportedRaw: raw(val) };
    }
  } catch (err) {
    issues.push({ code: 'DECODE_FAILURE', path, message: `could not decode ${scType}: ${(err as Error).message}` });
    return { scType, unsupportedRaw: raw(val) };
  }
}

/**
 * Decode a return value given as an ScVal, base64 XDR, or raw XDR bytes.
 * `null`/`undefined` means the simulation or transaction produced no return value.
 */
export function decodeReturnValue(input: ReturnValueInput): DecodeResult {
  if (input === null || input === undefined || (typeof input === 'string' && input.trim() === '')) {
    return {
      status: 'missing',
      errors: [{ code: 'MISSING_RETURN_VALUE', path: '$', message: 'no return value was provided (a void function returns scvVoid, not nothing)' }],
      warnings: [],
    };
  }

  let val: xdr.ScVal;
  if (typeof input === 'string' || input instanceof Uint8Array) {
    try {
      val = typeof input === 'string' ? xdr.ScVal.fromXDR(input.trim(), 'base64') : xdr.ScVal.fromXDR(Buffer.from(input));
    } catch (err) {
      return {
        status: 'failed',
        errors: [{ code: 'MALFORMED_XDR', path: '$', message: `input is not a valid ScVal XDR: ${(err as Error).message}` }],
        warnings: [],
      };
    }
  } else if (typeof (input as xdr.ScVal)?.switch === 'function' && typeof (input as xdr.ScVal).toXDR === 'function') {
    val = input;
  } else {
    return {
      status: 'failed',
      errors: [{ code: 'INVALID_SCVAL', path: '$', message: 'expected an xdr.ScVal, base64 XDR string or XDR bytes' }],
      warnings: [],
    };
  }

  const errors: DecodeIssue[] = [];
  const node = decodeNode(val, '$', errors, 0);
  const rawXdr = raw(val);
  const partial = errors.length > 0;
  const topLevelUnsupported = node.unsupportedRaw !== undefined && !node.items && !node.entries;
  const status: DecodeStatus = !partial ? 'decoded' : topLevelUnsupported ? 'failed' : 'partial';
  return { status, node, rawXdr, errors, warnings: partial ? ['some parts of the value could not be decoded; their raw XDR is preserved'] : [] };
}

/** JSON-safe rendering: bigints and timepoints become strings, bytes hex, maps entry lists. */
export function toReadable(node: DecodedNode): unknown {
  if (node.unsupportedRaw !== undefined) return { unsupported: node.scType, rawXdr: node.unsupportedRaw };
  if (node.items) return node.items.map(toReadable);
  if (node.entries) return node.entries.map((e) => ({ key: toReadable(e.key), value: toReadable(e.value) }));
  const v = node.value;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return Buffer.from(v).toString('hex');
  return v ?? null;
}
