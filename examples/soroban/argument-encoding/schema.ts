/**
 * Argument type model for Soroban function arguments.
 *
 * This is a small, explicit description of the types an application can pass.
 * It can be written by hand or derived from a contract specification
 * (see specification.ts). Nothing here touches the network or the SDK.
 */

export type PrimitiveKind =
  | 'bool'
  | 'u32'
  | 'i32'
  | 'u64'
  | 'i64'
  | 'u128'
  | 'i128'
  | 'u256'
  | 'i256'
  | 'string'
  | 'symbol'
  | 'bytes'
  | 'address';

export const PRIMITIVE_KINDS: readonly PrimitiveKind[] = [
  'bool', 'u32', 'i32', 'u64', 'i64', 'u128', 'i128', 'u256', 'i256', 'string', 'symbol', 'bytes', 'address',
];

export interface StructField {
  name: string;
  type: ArgType;
}

/** `#[contracttype]` enum with integer cases; encoded as a `u32`. */
export interface EnumCase {
  name: string;
  value: number;
}

/** `#[contracttype]` enum with named cases (optionally carrying values); encoded as `Vec[Symbol, ...values]`. */
export interface UnionCase {
  name: string;
  values: readonly ArgType[];
}

export type ArgType =
  | { kind: PrimitiveKind }
  | { kind: 'bytesN'; length: number }
  | { kind: 'option'; value: ArgType }
  | { kind: 'vec'; element: ArgType }
  | { kind: 'tuple'; elements: readonly ArgType[] }
  | { kind: 'map'; key: ArgType; value: ArgType }
  | { kind: 'struct'; name?: string; fields: readonly StructField[] }
  | { kind: 'enum'; name?: string; cases: readonly EnumCase[] }
  | { kind: 'union'; name?: string; cases: readonly UnionCase[] };

export interface ArgumentDefinition {
  name: string;
  type: ArgType;
}

export interface FunctionDefinition {
  name: string;
  args: readonly ArgumentDefinition[];
}

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaError';
  }
}

/** Human-readable type, e.g. `vec<u32>` or `map<symbol, i128>`. */
export function formatType(type: ArgType): string {
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

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SYMBOL_MAX = 32;

function validateType(type: unknown, path: string, errors: string[]): void {
  if (typeof type !== 'object' || type === null || typeof (type as { kind?: unknown }).kind !== 'string') {
    errors.push(`${path}: type must be an object with a "kind"`);
    return;
  }
  const t = type as ArgType;
  switch (t.kind) {
    case 'bytesN':
      if (!Number.isInteger(t.length) || t.length < 1) errors.push(`${path}: bytesN needs a positive integer length`);
      return;
    case 'option':
      validateType(t.value, `${path}.value`, errors);
      return;
    case 'vec':
      validateType(t.element, `${path}.element`, errors);
      return;
    case 'tuple':
      if (!Array.isArray(t.elements) || t.elements.length === 0) errors.push(`${path}: tuple needs at least one element type`);
      else t.elements.forEach((e, i) => validateType(e, `${path}.elements[${i}]`, errors));
      return;
    case 'map':
      validateType(t.key, `${path}.key`, errors);
      validateType(t.value, `${path}.value`, errors);
      return;
    case 'struct': {
      if (!Array.isArray(t.fields) || t.fields.length === 0) {
        errors.push(`${path}: struct needs at least one field`);
        return;
      }
      const seen = new Set<string>();
      t.fields.forEach((f, i) => {
        if (!f || typeof f.name !== 'string' || !IDENTIFIER.test(f.name) || f.name.length > SYMBOL_MAX) {
          errors.push(`${path}.fields[${i}]: invalid field name`);
          return;
        }
        if (seen.has(f.name)) errors.push(`${path}: duplicate field "${f.name}"`);
        seen.add(f.name);
        validateType(f.type, `${path}.fields.${f.name}`, errors);
      });
      return;
    }
    case 'enum': {
      if (!Array.isArray(t.cases) || t.cases.length === 0) {
        errors.push(`${path}: enum needs at least one case`);
        return;
      }
      const names = new Set<string>();
      const values = new Set<number>();
      t.cases.forEach((c, i) => {
        if (!c || typeof c.name !== 'string' || !c.name) errors.push(`${path}.cases[${i}]: invalid case name`);
        else if (names.has(c.name)) errors.push(`${path}: duplicate case "${c.name}"`);
        else names.add(c.name);
        if (!c || !Number.isInteger(c.value) || c.value < 0 || c.value > 0xffffffff) {
          errors.push(`${path}.cases[${i}]: value must be a u32`);
        } else if (values.has(c.value)) errors.push(`${path}: duplicate case value ${c.value}`);
        else values.add(c.value);
      });
      return;
    }
    case 'union': {
      if (!Array.isArray(t.cases) || t.cases.length === 0) {
        errors.push(`${path}: union needs at least one case`);
        return;
      }
      const names = new Set<string>();
      t.cases.forEach((c, i) => {
        if (!c || typeof c.name !== 'string' || !IDENTIFIER.test(c.name) || c.name.length > SYMBOL_MAX) {
          errors.push(`${path}.cases[${i}]: invalid case name`);
          return;
        }
        if (names.has(c.name)) errors.push(`${path}: duplicate case "${c.name}"`);
        names.add(c.name);
        (c.values ?? ([] as readonly ArgType[])).forEach((v: ArgType, j: number) => validateType(v, `${path}.cases.${c.name}[${j}]`, errors));
      });
      return;
    }
    default:
      if (!PRIMITIVE_KINDS.includes((t as { kind: PrimitiveKind }).kind)) {
        errors.push(`${path}: unsupported type kind "${String((t as { kind: string }).kind)}"`);
      }
  }
}

/** Returns a list of problems with a function definition; empty means it is usable. */
export function validateFunctionDefinition(def: unknown): string[] {
  const errors: string[] = [];
  if (typeof def !== 'object' || def === null) return ['function definition must be an object'];
  const d = def as Partial<FunctionDefinition>;
  if (typeof d.name !== 'string' || !IDENTIFIER.test(d.name) || d.name.length > SYMBOL_MAX) {
    errors.push('function name must be a valid identifier of at most 32 characters');
  }
  if (!Array.isArray(d.args)) {
    errors.push('args must be an array');
    return errors;
  }
  const names = new Set<string>();
  d.args.forEach((a, i) => {
    if (!a || typeof a.name !== 'string' || !a.name) {
      errors.push(`args[${i}]: argument name is required`);
      return;
    }
    if (names.has(a.name)) errors.push(`duplicate argument name "${a.name}"`);
    names.add(a.name);
    validateType(a.type, `args.${a.name}`, errors);
  });
  return errors;
}
