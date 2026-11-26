/**
 * Expected return type model. Written by hand or derived from a contract
 * specification (see specification.ts). Pure data; no SDK imports.
 */

export type PrimitiveKind =
  | 'void'
  | 'bool'
  | 'u32'
  | 'i32'
  | 'u64'
  | 'i64'
  | 'u128'
  | 'i128'
  | 'u256'
  | 'i256'
  | 'timepoint'
  | 'duration'
  | 'string'
  | 'symbol'
  | 'bytes'
  | 'address';

export interface StructField {
  name: string;
  type: ExpectedType;
}
export interface EnumCase {
  name: string;
  value: number;
}
export interface UnionCase {
  name: string;
  values: readonly ExpectedType[];
}

export type ExpectedType =
  | { kind: PrimitiveKind }
  | { kind: 'bytesN'; length: number }
  | { kind: 'option'; value: ExpectedType }
  | { kind: 'vec'; element: ExpectedType }
  | { kind: 'tuple'; elements: readonly ExpectedType[] }
  | { kind: 'map'; key: ExpectedType; value: ExpectedType }
  | { kind: 'struct'; name?: string; fields: readonly StructField[] }
  | { kind: 'enum'; name?: string; cases: readonly EnumCase[] }
  | { kind: 'union'; name?: string; cases: readonly UnionCase[] };

export function formatType(type: ExpectedType): string {
  switch (type.kind) {
    case 'bytesN':
      return `bytes${type.length}`;
    case 'option':
      return `option<${formatType(type.value)}>`;
    case 'vec':
      return `vec<${formatType(type.element)}>`;
    case 'tuple':
      return `(${type.elements.map(formatType).join(', ')})`;
    case 'map':
      return `map<${formatType(type.key)}, ${formatType(type.value)}>`;
    case 'struct':
      return type.name ? `struct ${type.name}` : `struct {${type.fields.map((f) => f.name).join(', ')}}`;
    case 'enum':
      return type.name ? `enum ${type.name}` : 'enum';
    case 'union':
      return type.name ? `union ${type.name}` : 'union';
    default:
      return type.kind;
  }
}

/** Checks an explicitly supplied expected type is well formed. Returns a list of problems. */
export function validateExpectedType(type: unknown, path = 'type'): string[] {
  const errors: string[] = [];
  if (typeof type !== 'object' || type === null || typeof (type as { kind?: unknown }).kind !== 'string') {
    return [`${path}: must be an object with a "kind"`];
  }
  const t = type as ExpectedType;
  switch (t.kind) {
    case 'bytesN':
      if (!Number.isInteger(t.length) || t.length < 1) errors.push(`${path}: bytesN needs a positive integer length`);
      break;
    case 'option':
      errors.push(...validateExpectedType(t.value, `${path}.value`));
      break;
    case 'vec':
      errors.push(...validateExpectedType(t.element, `${path}.element`));
      break;
    case 'tuple':
      if (!Array.isArray(t.elements) || t.elements.length === 0) errors.push(`${path}: tuple needs at least one element`);
      else t.elements.forEach((e, i) => errors.push(...validateExpectedType(e, `${path}[${i}]`)));
      break;
    case 'map':
      errors.push(...validateExpectedType(t.key, `${path}.key`), ...validateExpectedType(t.value, `${path}.value`));
      break;
    case 'struct':
      if (!Array.isArray(t.fields) || t.fields.length === 0) errors.push(`${path}: struct needs at least one field`);
      else {
        const seen = new Set<string>();
        for (const f of t.fields) {
          if (!f || typeof f.name !== 'string' || !f.name) errors.push(`${path}: struct field needs a name`);
          else if (seen.has(f.name)) errors.push(`${path}: duplicate field "${f.name}"`);
          else {
            seen.add(f.name);
            errors.push(...validateExpectedType(f.type, `${path}.${f.name}`));
          }
        }
      }
      break;
    case 'enum':
      if (!Array.isArray(t.cases) || t.cases.length === 0) errors.push(`${path}: enum needs at least one case`);
      else if (t.cases.some((c) => !c || typeof c.name !== 'string' || !Number.isInteger(c.value))) errors.push(`${path}: enum cases need a name and an integer value`);
      break;
    case 'union':
      if (!Array.isArray(t.cases) || t.cases.length === 0) errors.push(`${path}: union needs at least one case`);
      else {
        for (const c of t.cases) {
          if (!c || typeof c.name !== 'string' || !c.name) errors.push(`${path}: union case needs a name`);
          else (c.values ?? ([] as readonly ExpectedType[])).forEach((v: ExpectedType, i: number) => errors.push(...validateExpectedType(v, `${path}.${c.name}[${i}]`)));
        }
      }
      break;
    default:
      if (!PRIMITIVES.includes((t as { kind: PrimitiveKind }).kind)) errors.push(`${path}: unsupported kind "${String((t as { kind: string }).kind)}"`);
  }
  return errors;
}

const PRIMITIVES: readonly string[] = [
  'void', 'bool', 'u32', 'i32', 'u64', 'i64', 'u128', 'i128', 'u256', 'i256', 'timepoint', 'duration', 'string', 'symbol', 'bytes', 'address',
];
