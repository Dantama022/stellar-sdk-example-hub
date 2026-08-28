import { contract, xdr } from '@stellar/stellar-sdk';

export interface ParsedArgument {
  name: string;
  type: string;
}

export interface ParsedFunction {
  name: string;
  documentation: string;
  inputs: ParsedArgument[];
  outputs: string[];
}

export interface ParsedStructField {
  name: string;
  type: string;
}

export interface ParsedStruct {
  name: string;
  documentation: string;
  fields: ParsedStructField[];
}

export interface ParsedEnumCase {
  name: string;
  value: number;
  documentation?: string;
}

export interface ParsedEnum {
  name: string;
  documentation: string;
  cases: ParsedEnumCase[];
}

export interface ParsedUnionCase {
  name: string;
  payloadTypes: string[];
}

export interface ParsedUnion {
  name: string;
  documentation: string;
  cases: ParsedUnionCase[];
}

export interface ParsedContractSpec {
  contractName: string | null;
  functions: ParsedFunction[];
  structs: ParsedStruct[];
  enums: ParsedEnum[];
  unions: ParsedUnion[];
  errorEnums: ParsedEnum[];
  rawEntryCount: number;
}

/** Resolves a human-readable type name from an XDR ScSpecTypeDef. */
export function resolveTypeName(typeDef: xdr.ScSpecTypeDef): string {
  const t = typeDef.switch();

  switch (t.name) {
    case 'scSpecTypeVoid':
      return 'void';
    case 'scSpecTypeBool':
      return 'bool';
    case 'scSpecTypeU32':
      return 'u32';
    case 'scSpecTypeI32':
      return 'i32';
    case 'scSpecTypeU64':
      return 'u64';
    case 'scSpecTypeI64':
      return 'i64';
    case 'scSpecTypeU128':
      return 'u128';
    case 'scSpecTypeI128':
      return 'i128';
    case 'scSpecTypeU256':
      return 'u256';
    case 'scSpecTypeI256':
      return 'i256';
    case 'scSpecTypeBytes':
      return 'bytes';
    case 'scSpecTypeString':
      return 'string';
    case 'scSpecTypeSymbol':
      return 'symbol';
    case 'scSpecTypeAddress':
      return 'address';
    case 'scSpecTypeMuxedAddress':
      return 'muxed_address';
    case 'scSpecTypeTimepoint':
      return 'timepoint';
    case 'scSpecTypeDuration':
      return 'duration';
    case 'scSpecTypeVal':
      return 'val';
    case 'scSpecTypeError':
      return 'error';
    case 'scSpecTypeOption':
      return `Option<${resolveTypeName(typeDef.option().valueType())}>`;
    case 'scSpecTypeResult':
      return `Result<${resolveTypeName(typeDef.result().okType())}, ${resolveTypeName(typeDef.result().errorType())}>`;
    case 'scSpecTypeVec':
      return `Vec<${resolveTypeName(typeDef.vec().elementType())}>`;
    case 'scSpecTypeMap':
      return `Map<${resolveTypeName(typeDef.map().keyType())}, ${resolveTypeName(typeDef.map().valueType())}>`;
    case 'scSpecTypeTuple': {
      const types = typeDef.tuple().valueTypes().map(resolveTypeName);
      return `Tuple<${types.join(', ')}>`;
    }
    case 'scSpecTypeBytesN':
      return `BytesN<${typeDef.bytesN().n()}>`;
    case 'scSpecTypeUdt':
      return typeDef.udt().name().toString();
    default:
      return t.name ?? 'unknown';
  }
}

function parseFunction(entry: xdr.ScSpecFunctionV0): ParsedFunction {
  return {
    name: entry.name().toString(),
    documentation: entry.doc().toString().trim(),
    inputs: entry.inputs().map((input) => ({
      name: input.name().toString(),
      type: resolveTypeName(input.type()),
    })),
    outputs: entry.outputs().map((output) => resolveTypeName(output)),
  };
}

function parseStruct(entry: xdr.ScSpecUdtStructV0): ParsedStruct {
  return {
    name: entry.name().toString(),
    documentation: entry.doc().toString().trim(),
    fields: entry.fields().map((field) => ({
      name: field.name().toString(),
      type: resolveTypeName(field.type()),
    })),
  };
}

function parseEnum(entry: xdr.ScSpecUdtEnumV0): ParsedEnum {
  return {
    name: entry.name().toString(),
    documentation: entry.doc().toString().trim(),
    cases: entry.cases().map((item) => ({
      name: item.name().toString(),
      value: item.value(),
    })),
  };
}

function parseErrorEnum(entry: xdr.ScSpecUdtErrorEnumV0): ParsedEnum {
  return {
    name: entry.name().toString(),
    documentation: entry.doc().toString().trim(),
    cases: entry.cases().map((item) => ({
      name: item.name().toString(),
      value: item.value(),
      documentation: item.doc().toString().trim() || undefined,
    })),
  };
}

function parseUnion(entry: xdr.ScSpecUdtUnionV0): ParsedUnion {
  const cases: ParsedUnionCase[] = entry.cases().map((item) => {
    switch (item.switch().value) {
      case xdr.ScSpecUdtUnionCaseV0Kind.scSpecUdtUnionCaseVoidV0().value:
        return { name: item.voidCase().name().toString(), payloadTypes: [] };
      case xdr.ScSpecUdtUnionCaseV0Kind.scSpecUdtUnionCaseTupleV0().value:
        return {
          name: item.tupleCase().name().toString(),
          payloadTypes: item.tupleCase().type().map(resolveTypeName),
        };
      default:
        return { name: 'unknown', payloadTypes: [] };
    }
  });

  return {
    name: entry.name().toString(),
    documentation: entry.doc().toString().trim(),
    cases,
  };
}

/** Parses a contract.Spec into a structured, display-ready representation. */
export function parseContractSpec(spec: contract.Spec): ParsedContractSpec {
  const functions = spec.funcs().map(parseFunction);
  const structs: ParsedStruct[] = [];
  const enums: ParsedEnum[] = [];
  const unions: ParsedUnion[] = [];
  const errorEnums: ParsedEnum[] = [];

  for (const entry of spec.entries) {
    switch (entry.switch().value) {
      case xdr.ScSpecEntryKind.scSpecEntryUdtStructV0().value:
        structs.push(parseStruct(entry.udtStructV0()));
        break;
      case xdr.ScSpecEntryKind.scSpecEntryUdtEnumV0().value:
        enums.push(parseEnum(entry.udtEnumV0()));
        break;
      case xdr.ScSpecEntryKind.scSpecEntryUdtUnionV0().value:
        unions.push(parseUnion(entry.udtUnionV0()));
        break;
      case xdr.ScSpecEntryKind.scSpecEntryUdtErrorEnumV0().value:
        errorEnums.push(parseErrorEnum(entry.udtErrorEnumV0()));
        break;
      default:
        break;
    }
  }

  const contractName =
    functions.find((fn) => !fn.name.startsWith('__'))?.name ??
    structs[0]?.name ??
    null;

  return {
    contractName,
    functions,
    structs,
    enums,
    unions,
    errorEnums,
    rawEntryCount: spec.entries.length,
  };
}

/** Selects a function by name for dynamic discovery demos. */
export function selectFunction(
  parsed: ParsedContractSpec,
  functionName?: string,
): ParsedFunction | null {
  if (!functionName?.trim()) {
    return parsed.functions.find((fn) => !fn.name.startsWith('__')) ?? parsed.functions[0] ?? null;
  }

  const normalized = functionName.trim();
  return parsed.functions.find((fn) => fn.name === normalized) ?? null;
}

/** Formats a parsed contract specification for console output. */
export function formatContractSpecReport(parsed: ParsedContractSpec, contractId: string): string {
  const lines: string[] = [];
  lines.push('=== Soroban Contract Specification ===');
  lines.push(`Contract ID : ${contractId}`);
  lines.push(`Spec entries: ${parsed.rawEntryCount}`);
  if (parsed.contractName) {
    lines.push(`Primary name: ${parsed.contractName}`);
  }

  lines.push('');
  lines.push(`Functions (${parsed.functions.length}):`);
  if (parsed.functions.length === 0) {
    lines.push('  (none)');
  } else {
    parsed.functions.forEach((fn) => {
      const params = fn.inputs.map((input) => `${input.name}: ${input.type}`).join(', ');
      const returns = fn.outputs.length ? fn.outputs.join(', ') : 'void';
      lines.push(`  ${fn.name}(${params}) -> ${returns}`);
      if (fn.documentation) lines.push(`    // ${fn.documentation}`);
    });
  }

  if (parsed.structs.length) {
    lines.push('');
    lines.push('Structs:');
    parsed.structs.forEach((item) => {
      lines.push(`  ${item.name} {`);
      item.fields.forEach((field) => lines.push(`    ${field.name}: ${field.type}`));
      lines.push('  }');
    });
  }

  if (parsed.enums.length) {
    lines.push('');
    lines.push('Enums:');
    parsed.enums.forEach((item) => {
      lines.push(`  ${item.name} {`);
      item.cases.forEach((c) => lines.push(`    ${c.name} = ${c.value}`));
      lines.push('  }');
    });
  }

  if (parsed.unions.length) {
    lines.push('');
    lines.push('Unions:');
    parsed.unions.forEach((item) => {
      lines.push(`  ${item.name} {`);
      item.cases.forEach((c) => {
        const payload = c.payloadTypes.length ? `(${c.payloadTypes.join(', ')})` : '';
        lines.push(`    ${c.name}${payload}`);
      });
      lines.push('  }');
    });
  }

  if (parsed.errorEnums.length) {
    lines.push('');
    lines.push('Error enums:');
    parsed.errorEnums.forEach((item) => {
      lines.push(`  ${item.name} {`);
      item.cases.forEach((c) => {
        const doc = c.documentation ? ` // ${c.documentation}` : '';
        lines.push(`    ${c.name} = ${c.value}${doc}`);
      });
      lines.push('  }');
    });
  }

  return lines.join('\n');
}

/** Parses WASM bytes into a contract.Spec, returning null when metadata is absent. */
export function specFromWasm(wasm: Buffer): contract.Spec | null {
  try {
    return contract.Spec.fromWasm(wasm);
  } catch {
    return null;
  }
}
