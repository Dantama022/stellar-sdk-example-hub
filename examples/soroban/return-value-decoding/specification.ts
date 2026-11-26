/**
 * Contract specification parsing.
 *
 * A Soroban contract embeds a spec (the `contractspecv0` custom section of its
 * WASM): a list of base64 `ScSpecEntry` XDR values describing each function and
 * each user-defined type (struct / enum / union). This module turns those
 * entries into the FunctionDefinition model used by the validator and encoder.
 * It does not fetch anything; hand it the entries you obtained elsewhere.
 */

import { xdr } from '@stellar/stellar-sdk';
import type { ExpectedType } from './types';

export class SpecificationError extends Error {
  constructor(public readonly code: 'MALFORMED_SPEC' | 'FUNCTION_NOT_FOUND' | 'UNSUPPORTED_TYPE' | 'UNKNOWN_TYPE' | 'RECURSIVE_TYPE', message: string) {
    super(message);
    this.name = 'SpecificationError';
  }
}

export interface ParsedSpec {
  functions: Map<string, xdr.ScSpecFunctionV0>;
  structs: Map<string, xdr.ScSpecUdtStructV0>;
  enums: Map<string, xdr.ScSpecUdtEnumV0>;
  unions: Map<string, xdr.ScSpecUdtUnionV0>;
}

/** Parse spec entries given as base64 XDR strings or already-decoded ScSpecEntry values. */
export function parseSpecification(entries: Array<string | xdr.ScSpecEntry>): ParsedSpec {
  const spec: ParsedSpec = { functions: new Map(), structs: new Map(), enums: new Map(), unions: new Map() };
  entries.forEach((raw, i) => {
    let entry: xdr.ScSpecEntry;
    try {
      entry = typeof raw === 'string' ? xdr.ScSpecEntry.fromXDR(raw, 'base64') : raw;
    } catch (err) {
      throw new SpecificationError('MALFORMED_SPEC', `spec entry ${i} is not valid ScSpecEntry XDR: ${(err as Error).message}`);
    }
    switch (entry.switch().name) {
      case 'scSpecEntryFunctionV0':
        spec.functions.set(entry.functionV0().name().toString(), entry.functionV0());
        break;
      case 'scSpecEntryUdtStructV0':
        spec.structs.set(entry.udtStructV0().name().toString(), entry.udtStructV0());
        break;
      case 'scSpecEntryUdtEnumV0':
        spec.enums.set(entry.udtEnumV0().name().toString(), entry.udtEnumV0());
        break;
      case 'scSpecEntryUdtUnionV0':
        spec.unions.set(entry.udtUnionV0().name().toString(), entry.udtUnionV0());
        break;
      default:
        // Errors enums and event specs do not affect function arguments.
        break;
    }
  });
  return spec;
}

/** Convert one ScSpecTypeDef into an ExpectedType, resolving user-defined types. */
export function convertTypeDef(def: xdr.ScSpecTypeDef, spec: ParsedSpec, resolving: string[] = []): ExpectedType {
  const name = def.switch().name;
  switch (name) {
    case 'scSpecTypeVoid':
      return { kind: 'void' };
    case 'scSpecTypeBool':
      return { kind: 'bool' };
    case 'scSpecTypeTimepoint':
      return { kind: 'timepoint' };
    case 'scSpecTypeDuration':
      return { kind: 'duration' };
    case 'scSpecTypeU32':
      return { kind: 'u32' };
    case 'scSpecTypeI32':
      return { kind: 'i32' };
    case 'scSpecTypeU64':
      return { kind: 'u64' };
    case 'scSpecTypeI64':
      return { kind: 'i64' };
    case 'scSpecTypeU128':
      return { kind: 'u128' };
    case 'scSpecTypeI128':
      return { kind: 'i128' };
    case 'scSpecTypeU256':
      return { kind: 'u256' };
    case 'scSpecTypeI256':
      return { kind: 'i256' };
    case 'scSpecTypeString':
      return { kind: 'string' };
    case 'scSpecTypeSymbol':
      return { kind: 'symbol' };
    case 'scSpecTypeBytes':
      return { kind: 'bytes' };
    case 'scSpecTypeBytesN':
      return { kind: 'bytesN', length: def.bytesN().n() };
    case 'scSpecTypeAddress':
      return { kind: 'address' };
    case 'scSpecTypeResult':
      // A successful call returns the Ok value directly; an Err aborts the call with a contract error.
      return convertTypeDef(def.result().okType(), spec, resolving);
    case 'scSpecTypeOption':
      return { kind: 'option', value: convertTypeDef(def.option().valueType(), spec, resolving) };
    case 'scSpecTypeVec':
      return { kind: 'vec', element: convertTypeDef(def.vec().elementType(), spec, resolving) };
    case 'scSpecTypeMap':
      return {
        kind: 'map',
        key: convertTypeDef(def.map().keyType(), spec, resolving),
        value: convertTypeDef(def.map().valueType(), spec, resolving),
      };
    case 'scSpecTypeTuple':
      return { kind: 'tuple', elements: def.tuple().valueTypes().map((t) => convertTypeDef(t, spec, resolving)) };
    case 'scSpecTypeUdt':
      return resolveUdt(def.udt().name().toString(), spec, resolving);
    default:
      throw new SpecificationError('UNSUPPORTED_TYPE', `spec type ${name} is not supported by this example`);
  }
}

function resolveUdt(name: string, spec: ParsedSpec, resolving: string[]): ExpectedType {
  if (resolving.includes(name)) {
    throw new SpecificationError('RECURSIVE_TYPE', `type ${name} refers to itself (${[...resolving, name].join(' -> ')})`);
  }
  const next = [...resolving, name];
  const struct = spec.structs.get(name);
  if (struct) {
    return {
      kind: 'struct',
      name,
      fields: struct.fields().map((f) => ({ name: f.name().toString(), type: convertTypeDef(f.type(), spec, next) })),
    };
  }
  const en = spec.enums.get(name);
  if (en) return { kind: 'enum', name, cases: en.cases().map((c) => ({ name: c.name().toString(), value: c.value() })) };
  const union = spec.unions.get(name);
  if (union) {
    return {
      kind: 'union',
      name,
      cases: union.cases().map((c) =>
        c.switch().name === 'scSpecUdtUnionCaseVoidV0'
          ? { name: c.voidCase().name().toString(), values: [] }
          : { name: c.tupleCase().name().toString(), values: c.tupleCase().type().map((t) => convertTypeDef(t, spec, next)) },
      ),
    };
  }
  throw new SpecificationError('UNKNOWN_TYPE', `type ${name} is used but not defined in the specification`);
}

/**
 * The expected return type of a function. A function with no declared output
 * returns void.
 */
export function getReturnType(spec: ParsedSpec, functionName: string): ExpectedType {
  const fn = spec.functions.get(functionName);
  if (!fn) {
    throw new SpecificationError('FUNCTION_NOT_FOUND', `function "${functionName}" is not in the specification (available: ${Array.from(spec.functions.keys()).join(', ') || 'none'})`);
  }
  const outputs = fn.outputs();
  if (outputs.length === 0) return { kind: 'void' };
  if (outputs.length > 1) {
    throw new SpecificationError('MALFORMED_SPEC', `function "${functionName}" declares ${outputs.length} outputs; Soroban functions return at most one value`);
  }
  return convertTypeDef(outputs[0], spec);
}
