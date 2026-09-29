import {
  analyzeWasmFeatures,
  compareWasmFeatureProfiles,
} from '../src/utils/wasm-feature-analysis';
import { parseWasmFeatureArgs } from '../src/examples/252-wasm-features';
import { readFileSync } from 'fs';
import path from 'path';

function uleb(value: number): number[] {
  const bytes: number[] = [];
  do {
    let next = value & 0x7f;
    value >>>= 7;
    if (value !== 0) next |= 0x80;
    bytes.push(next);
  } while (value !== 0);
  return bytes;
}

function section(id: number, payload: number[]): number[] {
  return [id, ...uleb(payload.length), ...payload];
}

function wasmModule(
  options: {
    instructions?: number[][];
    tables?: number;
    memories?: number[];
    typedReference?: boolean;
    passiveData?: boolean;
    passiveElements?: boolean;
    importedFunction?: boolean;
  } = {},
): Buffer {
  const instructions = options.instructions ?? [[]];
  const type = options.typedReference
    ? section(1, [1, 0x60, 1, 0x63, 0, 0])
    : section(1, [1, 0x60, 0, 0]);
  const functions = section(3, [instructions.length, ...instructions.map(() => 0)]);
  const sections = [type];
  if (options.importedFunction) sections.push(section(2, [1, 1, 0x6d, 1, 0x66, 0, 0]));
  sections.push(functions);
  if (options.tables) {
    sections.push(
      section(4, [
        options.tables,
        ...Array.from({ length: options.tables }, () => [0x70, 0, 1]).flat(),
      ]),
    );
  }
  if (options.memories) sections.push(section(5, options.memories));
  if (options.passiveElements) sections.push(section(9, [1, 1, 0, 0]));
  const codeBodies = instructions.flatMap((body) => {
    const functionBody = [0, ...body, 0x0b];
    return [...uleb(functionBody.length), ...functionBody];
  });
  sections.push(section(10, [instructions.length, ...codeBodies]));
  if (options.passiveData) sections.push(section(11, [1, 1, 0]));
  return Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, ...sections.flat()]);
}

describe('offline WASM feature profiles', () => {
  it('detects bulk memory, SIMD, references, and indirect calls with locations', () => {
    const profile = analyzeWasmFeatures(
      wasmModule({
        instructions: [[0xfc, 8, 0, 0, 0x11, 0, 0, 0xfd, 12, ...Array(16).fill(0), 0xd0, 0x70]],
        passiveData: true,
      }),
    );

    expect(profile.features['bulk-memory'].status).toBe('detected');
    expect(profile.features['bulk-memory'].occurrenceCount).toBe(2);
    expect(profile.features['memory-initialization'].occurrenceCount).toBe(2);
    expect(profile.features['indirect-calls'].functionsUsing).toEqual([0]);
    expect(profile.features.simd.occurrences[0]).toMatchObject({
      section: 'code',
      functionIndex: 0,
    });
    expect(profile.features['reference-types'].status).toBe('detected');
    expect(profile.warnings).toEqual([]);
  });

  it('uses module function indices after imported functions', () => {
    const profile = analyzeWasmFeatures(
      wasmModule({ instructions: [[0x11, 0, 0]], importedFunction: true }),
    );

    expect(profile.functionsScanned).toBe(1);
    expect(profile.features['indirect-calls'].functionsUsing).toEqual([1]);
  });

  it('detects multiple resources, shared memory, memory64, and typed references', () => {
    const profile = analyzeWasmFeatures(
      wasmModule({
        tables: 2,
        memories: [2, 4, 1, 3, 1, 2],
        typedReference: true,
      }),
    );

    expect(profile.features['multiple-tables'].status).toBe('detected');
    expect(profile.features['multiple-memories'].status).toBe('detected');
    expect(profile.features['memory64'].status).toBe('detected');
    expect(profile.features['shared-memory'].status).toBe('detected');
    expect(profile.features['typed-function-references'].status).toBe('detected');
  });

  it('detects atomics, exception instructions, table operations, and element initialization', () => {
    const profile = analyzeWasmFeatures(
      wasmModule({
        instructions: [
          [0xfe, 0x10, 0, 0, 0xfc, 12, 0, 0, 0x25, 0, 0x08, 0, 0x1f, 0x40, 1, 0, 0, 0, 0x0b],
        ],
        tables: 1,
        memories: [1, 0, 1],
        passiveElements: true,
      }),
    );

    expect(profile.features['atomic-instructions'].status).toBe('detected');
    expect(profile.features.exceptions.status).toBe('detected');
    expect(profile.features['table-instructions'].status).toBe('detected');
    expect(profile.features['element-initialization'].status).toBe('detected');
    expect(profile.features['shared-memory'].status).toBe('detected');
  });

  it('reports unknown opcodes without treating unscanned features as absent', () => {
    const profile = analyzeWasmFeatures(wasmModule({ instructions: [[0xff, 0x0b]] }));

    expect(profile.instructionScanComplete).toBe(false);
    expect(profile.features['bulk-memory'].status).toBe('could-not-be-determined');
    expect(profile.features['indirect-calls'].status).toBe('could-not-be-determined');
    expect(profile.features['multiple-tables'].status).toBe('not-detected');
    expect(profile.warnings[0]).toContain('Unknown opcode 0xff');
  });

  it('marks features indeterminate when their structural section is malformed', () => {
    const malformedTypeSection = Buffer.from([
      0,
      97,
      115,
      109,
      1,
      0,
      0,
      0,
      ...section(1, [1, 0xff]),
    ]);
    const profile = analyzeWasmFeatures(malformedTypeSection);

    expect(profile.features.simd.status).toBe('could-not-be-determined');
    expect(profile.features['typed-function-references'].status).toBe('could-not-be-determined');
    expect(profile.features.memory64.status).toBe('not-detected');
  });

  it('compares introduced features, counts, and function usage deterministically', () => {
    const before = analyzeWasmFeatures(wasmModule({ instructions: [[], []] }));
    const after = analyzeWasmFeatures(
      wasmModule({ instructions: [[], [0x11, 0, 0], [0x11, 0, 0]] }),
    );
    const comparison = compareWasmFeatureProfiles(before, after);

    expect(comparison.newlyIntroducedFeatures).toEqual(['indirect-calls']);
    expect(comparison.changedUsageCounts[0]).toMatchObject({
      feature: 'indirect-calls',
      beforeCount: 0,
      afterCount: 2,
    });
    expect(comparison.functionsNewlyUsingFeatures[0].newlyUsingFunctions).toEqual([1, 2]);
    expect(compareWasmFeatureProfiles(before, after)).toEqual(comparison);

    const reversed = compareWasmFeatureProfiles(after, before);
    expect(reversed.removedFeatures).toEqual(['indirect-calls']);
    expect(reversed.functionsNoLongerUsingFeatures[0].noLongerUsingFunctions).toEqual([1, 2]);
  });

  it('parses CLI options and registers the runnable example', () => {
    expect(parseWasmFeatureArgs(['old.wasm', 'new.wasm', '--json'])).toEqual({
      wasmFile: 'old.wasm',
      compareFile: 'new.wasm',
      json: true,
    });
    expect(() => parseWasmFeatureArgs(['a.wasm', 'b.wasm', 'c.wasm'])).toThrow();
    const catalog = readFileSync(path.resolve(__dirname, '../src/runner/catalog.ts'), 'utf8');
    expect(catalog).toContain("'252-wasm-features': {");
    expect(catalog).toContain('offline feature-usage profile');
  });
});
