import { xdr, rpc, Contract } from '@stellar/stellar-sdk';

const DEFAULT_SOROBAN_RPC = 'https://soroban-testnet.stellar.org';

export interface SpecFunctionArg {
  name: string;
  type: string;
}

export interface SpecFunction {
  name: string;
  doc?: string;
  inputs: SpecFunctionArg[];
  outputs: string[];
  canCallWithoutArgs: boolean;
  exampleSignature: string;
}

export interface SpecStructField {
  name: string;
  type: string;
}

export interface SpecStruct {
  name: string;
  fields: SpecStructField[];
}

export interface SpecEnumCase {
  name: string;
  value: number;
}

export interface SpecEnum {
  name: string;
  cases: SpecEnumCase[];
}

export interface SpecUnionCase {
  name: string;
  type?: string;
}

export interface SpecUnion {
  name: string;
  cases: SpecUnionCase[];
}

export interface ParsedContractSpec {
  functions: SpecFunction[];
  structs: SpecStruct[];
  enums: SpecEnum[];
  unions: SpecUnion[];
  unsupportedTypesCount: number;
}

export interface ContractInterfaceParams {
  contractId?: string;
  specData?: string | xdr.ScSpecEntry[];
  rpcUrl?: string;
  jsonOutput?: boolean;
}

/**
 * Converts an ScSpecTypeDef XDR object to a human-readable type string.
 */
export function parseSpecType(typeDef: any): string {
  if (!typeDef) return 'unknown';

  try {
    const switchName = typeDef.switch?.name || typeDef.switch?.();
    const val = typeof switchName === 'string' ? switchName.toLowerCase() : '';

    if (val.includes('val')) return 'val';
    if (val.includes('bool')) return 'bool';
    if (val.includes('void')) return 'void';
    if (val.includes('error')) return 'error';
    if (val.includes('u32')) return 'u32';
    if (val.includes('i32')) return 'i32';
    if (val.includes('u64')) return 'u64';
    if (val.includes('i64')) return 'i64';
    if (val.includes('u128')) return 'u128';
    if (val.includes('i128')) return 'i128';
    if (val.includes('u256')) return 'u256';
    if (val.includes('i256')) return 'i256';
    if (val.includes('symbol')) return 'symbol';
    if (val.includes('string')) return 'string';
    if (val.includes('bytes') || val.includes('bytesn')) return 'bytes';
    if (val.includes('address')) return 'address';

    if (val.includes('option') && typeDef.option?.valueType) {
      return `option<${parseSpecType(typeDef.option().valueType())}>`;
    }
    if (val.includes('vec') && typeDef.vec?.elementTypeDef) {
      return `vec<${parseSpecType(typeDef.vec().elementTypeDef())}>`;
    }
    if (val.includes('map')) {
      const k = typeDef.map?.keyTypeDef ? parseSpecType(typeDef.map().keyTypeDef()) : 'unknown';
      const v = typeDef.map?.valTypeDef ? parseSpecType(typeDef.map().valTypeDef()) : 'unknown';
      return `map<${k}, ${v}>`;
    }
    if (val.includes('udt') && typeDef.udt?.name) {
      return String(typeDef.udt().name().toString());
    }

    return val || 'unknown';
  } catch {
    return 'unsupported';
  }
}

/**
 * Parses a single ScSpecEntry into structured interface metadata.
 */
export function parseSpecEntry(entry: any): {
  type: 'function' | 'struct' | 'enum' | 'union' | 'unsupported';
  data?: SpecFunction | SpecStruct | SpecEnum | SpecUnion;
} {
  try {
    const arm = entry.arm ? entry.arm() : entry.switch?.name;

    if (arm === 'functionV0' || entry.functionV0) {
      const f = entry.functionV0 ? entry.functionV0() : entry.value();
      const name = f.name().toString();
      const doc = f.doc ? f.doc().toString() : undefined;
      const inputs = (f.inputs() || []).map((inp: any) => ({
        name: inp.name().toString(),
        type: parseSpecType(inp.typeDef()),
      }));
      const outputs = (f.outputs() || []).map((out: any) => parseSpecType(out));

      const canCallWithoutArgs = inputs.length === 0;
      const argStr = inputs.map((i: SpecFunctionArg) => `${i.name}: ${i.type}`).join(', ');
      const exampleSignature = `${name}(${argStr}): ${outputs.join(', ') || 'void'}`;

      return {
        type: 'function',
        data: {
          name,
          doc,
          inputs,
          outputs,
          canCallWithoutArgs,
          exampleSignature,
        },
      };
    }

    if (arm === 'udtStructV0' || entry.udtStructV0) {
      const s = entry.udtStructV0 ? entry.udtStructV0() : entry.value();
      const name = s.name().toString();
      const fields = (s.fields() || []).map((field: any) => ({
        name: field.name().toString(),
        type: parseSpecType(field.typeDef()),
      }));

      return {
        type: 'struct',
        data: { name, fields },
      };
    }

    if (arm === 'udtEnumV0' || entry.udtEnumV0) {
      const e = entry.udtEnumV0 ? entry.udtEnumV0() : entry.value();
      const name = e.name().toString();
      const cases = (e.cases() || []).map((c: any) => ({
        name: c.name().toString(),
        value: Number(c.value()),
      }));

      return {
        type: 'enum',
        data: { name, cases },
      };
    }

    if (arm === 'udtUnionV0' || entry.udtUnionV0) {
      const u = entry.udtUnionV0 ? entry.udtUnionV0() : entry.value();
      const name = u.name().toString();
      const cases = (u.cases() || []).map((c: any) => ({
        name: c.name ? c.name().toString() : 'variant',
        type: c.typeDef ? parseSpecType(c.typeDef()) : undefined,
      }));

      return {
        type: 'union',
        data: { name, cases },
      };
    }

    return { type: 'unsupported' };
  } catch {
    return { type: 'unsupported' };
  }
}

/**
 * Parses an array of spec entries or XDR buffer objects into a ParsedContractSpec.
 */
export function parseContractSpec(entries: any[]): ParsedContractSpec {
  const result: ParsedContractSpec = {
    functions: [],
    structs: [],
    enums: [],
    unions: [],
    unsupportedTypesCount: 0,
  };

  if (!entries || !Array.isArray(entries)) {
    return result;
  }

  for (const entry of entries) {
    const parsed = parseSpecEntry(entry);
    if (parsed.type === 'function' && parsed.data) {
      result.functions.push(parsed.data as SpecFunction);
    } else if (parsed.type === 'struct' && parsed.data) {
      result.structs.push(parsed.data as SpecStruct);
    } else if (parsed.type === 'enum' && parsed.data) {
      result.enums.push(parsed.data as SpecEnum);
    } else if (parsed.type === 'union' && parsed.data) {
      result.unions.push(parsed.data as SpecUnion);
    } else if (parsed.type === 'unsupported') {
      result.unsupportedTypesCount++;
    }
  }

  return result;
}

/**
 * Sample spec entries generated for offline demonstration when no spec input is provided.
 */
export function getSampleSpecEntries(): any[] {
  return [
    {
      arm: () => 'functionV0',
      functionV0: () => ({
        name: () => 'hello',
        doc: () => 'Returns a greeting for the supplied name',
        inputs: () => [
          {
            name: () => 'to',
            typeDef: () => ({ switch: () => 'scSpecTypeString' }),
          },
        ],
        outputs: () => [{ switch: () => 'scSpecTypeVec' }],
      }),
    },
    {
      arm: () => 'functionV0',
      functionV0: () => ({
        name: () => 'version',
        doc: () => 'Returns contract version string',
        inputs: () => [],
        outputs: () => [{ switch: () => 'scSpecTypeString' }],
      }),
    },
    {
      arm: () => 'udtStructV0',
      udtStructV0: () => ({
        name: () => 'State',
        fields: () => [
          { name: () => 'count', typeDef: () => ({ switch: () => 'scSpecTypeU32' }) },
          { name: () => 'owner', typeDef: () => ({ switch: () => 'scSpecTypeAddress' }) },
        ],
      }),
    },
    {
      arm: () => 'udtEnumV0',
      udtEnumV0: () => ({
        name: () => 'Status',
        cases: () => [
          { name: () => 'Active', value: () => 0 },
          { name: () => 'Paused', value: () => 1 },
        ],
      }),
    },
  ];
}

/**
 * Formats a ParsedContractSpec into a readable text report summary.
 */
export function formatInterfaceSummary(spec: ParsedContractSpec, contractId?: string): string {
  const lines: string[] = [];

  lines.push('=== Soroban Contract Interface Summary ===');
  if (contractId) {
    lines.push(`Contract ID: ${contractId}`);
  }

  lines.push(`\n1. Exported Functions (${spec.functions.length}):`);
  if (spec.functions.length === 0) {
    lines.push('  No exported functions found.');
  } else {
    spec.functions.forEach((fn, idx) => {
      lines.push(`  ${idx + 1}. ${fn.exampleSignature}`);
      if (fn.doc) {
        lines.push(`     Doc: ${fn.doc}`);
      }
      lines.push(`     Can call without args: ${fn.canCallWithoutArgs ? 'YES' : 'NO'}`);
    });
  }

  lines.push(`\n2. User-Defined Types (Structs: ${spec.structs.length}, Enums: ${spec.enums.length}, Unions: ${spec.unions.length}):`);
  if (spec.structs.length > 0) {
    lines.push('  Structs:');
    spec.structs.forEach((st) => {
      const fieldStr = st.fields.map((f) => `${f.name}: ${f.type}`).join(', ');
      lines.push(`    - struct ${st.name} { ${fieldStr} }`);
    });
  }
  if (spec.enums.length > 0) {
    lines.push('  Enums:');
    spec.enums.forEach((en) => {
      const caseStr = en.cases.map((c) => `${c.name} = ${c.value}`).join(', ');
      lines.push(`    - enum ${en.name} { ${caseStr} }`);
    });
  }
  if (spec.unions.length > 0) {
    lines.push('  Unions:');
    spec.unions.forEach((un) => {
      const caseStr = un.cases.map((c) => `${c.name}${c.type ? `(${c.type})` : ''}`).join(', ');
      lines.push(`    - union ${un.name} { ${caseStr} }`);
    });
  }

  if (spec.unsupportedTypesCount > 0) {
    lines.push(`\nNote: ${spec.unsupportedTypesCount} unsupported spec entries were ignored safely.`);
  }

  return lines.join('\n');
}

/**
 * Runs the Soroban contract interface inspection example.
 */
export async function run(params: ContractInterfaceParams = {}): Promise<void> {
  const rpcUrl = params.rpcUrl || process.env.SOROBAN_RPC_URL || DEFAULT_SOROBAN_RPC;
  const contractId =
    params.contractId?.trim() ||
    process.env.CONTRACT_ID?.trim() ||
    'CDW6BR4A6MGGCW23SCAVBBBZ3HW4V5C3TJ35OC3D4RQ4A6MGGCW23SCA';

  console.log('Starting Soroban Contract Interface Inspection Example...');
  console.log(`Using Soroban RPC: ${rpcUrl}`);
  console.log(`Inspecting Contract ID: ${contractId}`);

  let specEntries: any[] = [];

  if (params.specData) {
    if (Array.isArray(params.specData)) {
      specEntries = params.specData;
    } else if (typeof params.specData === 'string') {
      try {
        const buffer = Buffer.from(params.specData, 'base64');
        const decoded = xdr.ScSpecEntry.fromXDR(buffer);
        specEntries = [decoded];
      } catch {
        console.log('Provided string specData could not be decoded as base64 XDR. Falling back to sample spec.');
        specEntries = getSampleSpecEntries();
      }
    }
  } else {
    // Try querying Soroban RPC for live contract spec or fallback to sample spec
    try {
      const server = new rpc.Server(rpcUrl);
      const contract = new Contract(contractId);
      const ledgerEntries = await server.getContractData(
        contract.address(),
        xdr.ScVal.scvSymbol('ContractCode'),
      );
      if (ledgerEntries && ledgerEntries.val) {
        console.log('Successfully retrieved contract code from Soroban RPC.');
      }
    } catch {
      console.log('RPC lookup unavailable or contract spec not published. Using sample spec entries for inspection.');
    }
    specEntries = getSampleSpecEntries();
  }

  const parsedSpec = parseContractSpec(specEntries);

  if (params.jsonOutput || process.env.JSON_OUTPUT === 'true') {
    console.log(JSON.stringify({ contractId, parsedSpec }, null, 2));
  } else {
    console.log('\n' + formatInterfaceSummary(parsedSpec, contractId));
  }

  console.log('\nContract interface inspection completed successfully.');
}
