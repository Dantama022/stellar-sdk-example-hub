import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { createRequire } from 'module';

interface WasmNode {
  type: string;
  [key: string]: unknown;
}

interface WasmParser {
  decode(bytes: Uint8Array, options: { ignoreCustomNameSection: boolean }): { body: WasmNode[] };
}

const decode = (createRequire(__filename)('@webassemblyjs/wasm-parser') as WasmParser).decode;

export type SemanticComponentName =
  | 'types'
  | 'importsExports'
  | 'code'
  | 'memoryTables'
  | 'globals'
  | 'dataElements'
  | 'customSections';

export interface WasmFingerprint {
  file?: string;
  rawBinaryFingerprint: string;
  semanticModuleFingerprint: string;
  typeFingerprint: string;
  importExportFingerprint: string;
  codeFingerprint: string;
  memoryTableFingerprint: string;
  globalFingerprint: string;
  dataElementFingerprint: string;
  customSectionFingerprint: string;
  nonSemanticMetadataFingerprint: string;
}

export interface WasmFingerprintComparison {
  classification: 'identical' | 'binary-only' | 'metadata-only' | 'semantic';
  left: WasmFingerprint;
  right: WasmFingerprint;
  changedComponents: SemanticComponentName[];
}

interface CustomSection {
  name: string;
  payload: Buffer;
  classification: 'non-semantic' | 'semantic';
}

interface ParsedArtifact {
  standardSections: Buffer;
  customSections: CustomSection[];
}

const DEBUG_SECTION_NAMES = new Set([
  'name',
  'producers',
  'sourceMappingURL',
  'external_debug_info',
  'build_id',
]);

const COMPONENT_NODE: Record<string, SemanticComponentName> = {
  TypeInstruction: 'types',
  ModuleImport: 'importsExports',
  ModuleExport: 'importsExports',
  Start: 'importsExports',
  Func: 'code',
  Table: 'memoryTables',
  Memory: 'memoryTables',
  Global: 'globals',
  Elem: 'dataElements',
  Data: 'dataElements',
};

const COMPONENT_FIELDS = {
  types: 'typeFingerprint',
  importsExports: 'importExportFingerprint',
  code: 'codeFingerprint',
  memoryTables: 'memoryTableFingerprint',
  globals: 'globalFingerprint',
  dataElements: 'dataElementFingerprint',
} as const;

function readVarUint32(bytes: Buffer, offset: number): [number, number] {
  let value = 0;
  let shift = 0;
  for (let index = 0; index < 5; index += 1) {
    if (offset >= bytes.length) throw new Error('Truncated WASM unsigned LEB128 value.');
    const byte = bytes[offset++];
    if (index === 4 && byte > 0x0f) throw new Error('Invalid WASM unsigned LEB128 value.');
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value >>> 0, offset];
    shift += 7;
  }
  throw new Error('Invalid WASM unsigned LEB128 value.');
}

function customSectionIsNonSemantic(name: string): boolean {
  return DEBUG_SECTION_NAMES.has(name) || name.startsWith('.debug_');
}

function parseArtifact(wasm: Buffer): ParsedArtifact {
  if (wasm.length < 8) throw new Error('Invalid WASM binary: too short.');
  if (!wasm.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))) {
    throw new Error('Invalid WASM binary: missing magic header.');
  }
  if (wasm.readUInt32LE(4) !== 1) throw new Error('Unsupported WASM binary version.');

  const standardSections: Buffer[] = [wasm.subarray(0, 8)];
  const customSections: CustomSection[] = [];
  let offset = 8;
  while (offset < wasm.length) {
    const sectionStart = offset;
    const id = wasm[offset++];
    let sectionLength: number;
    [sectionLength, offset] = readVarUint32(wasm, offset);
    const payloadStart = offset;
    const payloadEnd = payloadStart + sectionLength;
    if (!Number.isSafeInteger(payloadEnd) || payloadEnd > wasm.length) {
      throw new Error('WASM section exceeds the binary length.');
    }

    if (id === 0) {
      const [nameLength, nameStart] = readVarUint32(wasm.subarray(payloadStart, payloadEnd), 0);
      const payload = wasm.subarray(payloadStart, payloadEnd);
      if (nameStart + nameLength > payload.length)
        throw new Error('Invalid WASM custom section name.');
      const name = new TextDecoder('utf-8', { fatal: true }).decode(
        payload.subarray(nameStart, nameStart + nameLength),
      );
      customSections.push({
        name,
        payload: Buffer.from(payload.subarray(nameStart + nameLength)),
        classification: customSectionIsNonSemantic(name) ? 'non-semantic' : 'semantic',
      });
    } else {
      standardSections.push(wasm.subarray(sectionStart, payloadEnd));
    }

    offset = payloadEnd;
  }

  return { standardSections: Buffer.concat(standardSections), customSections };
}

function canonicalize(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (Object.is(value, -0)) return '-0';
    if (Number.isNaN(value)) return 'NaN';
    if (value === Infinity) return 'Infinity';
    if (value === -Infinity) return '-Infinity';
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) {
      if (key === 'loc' || key === 'metadata' || key === 'raw') continue;
      normalized[key] = canonicalize(object[key]);
    }
    return normalized;
  }
  return value;
}

function hashCanonical(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function customSectionFingerprint(
  sections: CustomSection[],
  classification: CustomSection['classification'],
): string {
  const normalized = sections
    .filter((section) => section.classification === classification)
    .map((section) => ({ name: section.name, payload: section.payload.toString('hex') }))
    .sort((left, right) =>
      left.name < right.name
        ? -1
        : left.name > right.name
          ? 1
          : left.payload < right.payload
            ? -1
            : left.payload > right.payload
              ? 1
              : 0,
    );
  return hashCanonical(normalized);
}

function normalizeModule(
  standardSections: Buffer,
): Record<Exclude<SemanticComponentName, 'customSections'>, WasmNode[]> {
  const program = decode(standardSections, { ignoreCustomNameSection: true });
  const module = program.body.find((node) => node.type === 'Module');
  if (!module || !Array.isArray(module.fields))
    throw new Error('WASM parser did not return a module.');

  const components: Record<Exclude<SemanticComponentName, 'customSections'>, WasmNode[]> = {
    types: [],
    importsExports: [],
    code: [],
    memoryTables: [],
    globals: [],
    dataElements: [],
  };
  for (const field of module.fields as WasmNode[]) {
    const component = COMPONENT_NODE[field.type];
    if (!component) throw new Error(`Unsupported WASM AST node in semantic module: ${field.type}.`);
    if (component !== 'customSections') components[component].push(field);
  }
  const exports = components.importsExports.filter((field) => field.type === 'ModuleExport');
  const nonExports = components.importsExports.filter((field) => field.type !== 'ModuleExport');
  exports.sort((left, right) => {
    const leftName = String(left.name ?? '');
    const rightName = String(right.name ?? '');
    return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
  });
  components.importsExports = [...nonExports, ...exports];
  return components;
}

export function fingerprintWasm(wasm: Buffer, file?: string): WasmFingerprint {
  const artifact = parseArtifact(wasm);
  const components = normalizeModule(artifact.standardSections);
  const componentFingerprints = Object.fromEntries(
    Object.entries(components).map(([name, entries]) => [name, hashCanonical(entries)]),
  ) as Record<Exclude<SemanticComponentName, 'customSections'>, string>;
  const customSemanticFingerprint = customSectionFingerprint(artifact.customSections, 'semantic');
  const semanticComponents = {
    ...componentFingerprints,
    customSections: customSemanticFingerprint,
  };
  const result: WasmFingerprint = {
    ...(file ? { file } : {}),
    rawBinaryFingerprint: createHash('sha256').update(wasm).digest('hex'),
    semanticModuleFingerprint: hashCanonical(semanticComponents),
    typeFingerprint: componentFingerprints.types,
    importExportFingerprint: componentFingerprints.importsExports,
    codeFingerprint: componentFingerprints.code,
    memoryTableFingerprint: componentFingerprints.memoryTables,
    globalFingerprint: componentFingerprints.globals,
    dataElementFingerprint: componentFingerprints.dataElements,
    customSectionFingerprint: customSemanticFingerprint,
    nonSemanticMetadataFingerprint: customSectionFingerprint(
      artifact.customSections,
      'non-semantic',
    ),
  };
  return result;
}

export function compareWasmFingerprints(
  left: WasmFingerprint,
  right: WasmFingerprint,
): WasmFingerprintComparison {
  const changedComponents: SemanticComponentName[] = (
    Object.keys(COMPONENT_FIELDS) as Array<keyof typeof COMPONENT_FIELDS>
  ).filter((component) => left[COMPONENT_FIELDS[component]] !== right[COMPONENT_FIELDS[component]]);
  if (left.customSectionFingerprint !== right.customSectionFingerprint)
    changedComponents.push('customSections');
  let classification: WasmFingerprintComparison['classification'];
  if (left.rawBinaryFingerprint === right.rawBinaryFingerprint) classification = 'identical';
  else if (left.semanticModuleFingerprint !== right.semanticModuleFingerprint)
    classification = 'semantic';
  else if (left.nonSemanticMetadataFingerprint !== right.nonSemanticMetadataFingerprint)
    classification = 'metadata-only';
  else classification = 'binary-only';

  return { classification, left, right, changedComponents };
}

export function parseWasmFingerprintArgs(args: string[]): {
  wasmFile?: string;
  compareFile?: string;
  json: boolean;
} {
  const files = args.filter((arg) => arg !== '--json' && arg !== '--json=true');
  return {
    wasmFile: files[0],
    compareFile: files[1],
    json: args.includes('--json') || args.includes('--json=true'),
  };
}

export function run(options: { wasmFile?: string; compareFile?: string; json?: boolean }): void {
  if (!options.wasmFile)
    throw new Error('Usage: wasm-fingerprint <wasmFile> [compareWasmFile] [--json].');
  const first = fingerprintWasm(readFileSync(options.wasmFile), options.wasmFile);
  const result = options.compareFile
    ? compareWasmFingerprints(
        first,
        fingerprintWasm(readFileSync(options.compareFile), options.compareFile),
      )
    : first;

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const reports = 'classification' in result ? [result.left, result.right] : [first];
  reports.forEach((report, index) => {
    console.log(
      `${index === 0 ? 'Artifact' : 'Compared artifact'}${report.file ? ` (${report.file})` : ''}:`,
    );
    console.log(`Raw binary fingerprint: ${report.rawBinaryFingerprint}`);
    console.log(`Semantic module fingerprint: ${report.semanticModuleFingerprint}`);
    console.log(`Type fingerprint: ${report.typeFingerprint}`);
    console.log(`Import/export fingerprint: ${report.importExportFingerprint}`);
    console.log(`Code fingerprint: ${report.codeFingerprint}`);
    console.log(`Memory/table fingerprint: ${report.memoryTableFingerprint}`);
    console.log(`Global fingerprint: ${report.globalFingerprint}`);
    console.log(`Data/element fingerprint: ${report.dataElementFingerprint}`);
  });
  if ('classification' in result) {
    console.log(`Comparison: ${result.classification}`);
    console.log(`Changed semantic components: ${result.changedComponents.join(', ') || 'none'}`);
  }
}
