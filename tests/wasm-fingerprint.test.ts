import { compareWasmFingerprints, fingerprintWasm } from '../src/examples/251-wasm-fingerprint';

function uleb(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value >>> 0;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);
  return bytes;
}

function section(id: number, payload: number[]): number[] {
  return [id, ...uleb(payload.length), ...payload];
}

function customSection(name: string, payload: number[]): number[] {
  const nameBytes = Array.from(Buffer.from(name, 'utf8'));
  return section(0, [...uleb(nameBytes.length), ...nameBytes, ...payload]);
}

function moduleWithInstruction(instruction: number[], custom: number[] = []): Buffer {
  const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  const type = section(1, [1, 0x60, 0, 0]);
  const functionSection = section(3, [1, 0]);
  const exportName = Array.from(Buffer.from('run', 'utf8'));
  const exportSection = section(7, [1, exportName.length, ...exportName, 0, 0]);
  const body = [0, ...instruction, 0x0b];
  const code = section(10, [1, ...uleb(body.length), ...body]);
  return Buffer.from([
    ...header,
    ...custom,
    ...type,
    ...functionSection,
    ...exportSection,
    ...code,
  ]);
}

function moduleWithStructure(
  options: {
    memoryMinimum?: number;
    globalValue?: number;
    dataByte?: number;
    reverseExports?: boolean;
    typeResult?: boolean;
    importName?: string;
  } = {},
): Buffer {
  const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  const importName = Array.from(Buffer.from(options.importName ?? 'f', 'utf8'));
  const functionBody = options.typeResult ? [0, 0x41, 0, 0x0b] : [0, 0x0b];
  const sections = [
    section(1, options.typeResult ? [1, 0x60, 0, 1, 0x7f] : [1, 0x60, 0, 0]),
    section(2, [1, 3, 0x65, 0x6e, 0x76, importName.length, ...importName, 0, 0]),
    section(3, [1, 0]),
    section(4, [1, 0x70, 1, 1, 2]),
    section(5, [1, 1, options.memoryMinimum ?? 1, 2]),
    section(6, [1, 0x7f, 1, 0x41, options.globalValue ?? 0, 0x0b]),
  ];
  const exports = [
    [3, 0x72, 0x75, 0x6e, 0, 1],
    [5, 0x73, 0x74, 0x61, 0x74, 0x65, 3, 0],
  ];
  if (options.reverseExports) exports.reverse();
  sections.push(
    section(7, [2, ...exports.flat()]),
    section(8, [1]),
    section(9, [1, 0, 0x41, 0, 0x0b, 1, 1]),
    section(10, [1, functionBody.length, ...functionBody]),
    section(11, [1, 0, 0x41, 0, 0x0b, 1, options.dataByte ?? 0xaa]),
  );
  return Buffer.from([...header, ...sections.flat()]);
}

describe('WASM semantic fingerprints', () => {
  it('identifies byte-identical modules', () => {
    const bytes = moduleWithInstruction([0x01]);
    const comparison = compareWasmFingerprints(fingerprintWasm(bytes), fingerprintWasm(bytes));
    expect(comparison.classification).toBe('identical');
    expect(comparison.changedComponents).toEqual([]);
  });

  it('classifies debug-name custom-section changes as metadata-only', () => {
    const left = fingerprintWasm(moduleWithInstruction([0x01], customSection('name', [1, 2])));
    const right = fingerprintWasm(moduleWithInstruction([0x01], customSection('name', [3, 4])));
    const comparison = compareWasmFingerprints(left, right);
    expect(left.rawBinaryFingerprint).not.toBe(right.rawBinaryFingerprint);
    expect(left.semanticModuleFingerprint).toBe(right.semanticModuleFingerprint);
    expect(comparison.classification).toBe('metadata-only');
    expect(comparison.changedComponents).toEqual([]);
  });

  it('normalizes equivalent signed LEB128 encodings', () => {
    const canonical = fingerprintWasm(moduleWithInstruction([0x41, 0x2a]));
    const extended = fingerprintWasm(moduleWithInstruction([0x41, 0xaa, 0x00]));
    const comparison = compareWasmFingerprints(canonical, extended);
    expect(canonical.rawBinaryFingerprint).not.toBe(extended.rawBinaryFingerprint);
    expect(canonical.codeFingerprint).toBe(extended.codeFingerprint);
    expect(comparison.classification).toBe('binary-only');
  });

  it('identifies executable changes and the code component', () => {
    const left = fingerprintWasm(moduleWithInstruction([0x41, 0x2a]));
    const right = fingerprintWasm(moduleWithInstruction([0x41, 0x2b]));
    const comparison = compareWasmFingerprints(left, right);
    expect(comparison.classification).toBe('semantic');
    expect(comparison.changedComponents).toEqual(['code']);
    expect(left.semanticModuleFingerprint).not.toBe(right.semanticModuleFingerprint);
  });

  it('includes unknown custom sections in semantic comparisons', () => {
    const left = fingerprintWasm(moduleWithInstruction([0x01], customSection('vendor.data', [1])));
    const right = fingerprintWasm(moduleWithInstruction([0x01], customSection('vendor.data', [2])));
    const comparison = compareWasmFingerprints(left, right);
    expect(comparison.classification).toBe('semantic');
    expect(comparison.changedComponents).toEqual(['customSections']);
  });

  it('normalizes resource, global, import/export, data, and element structures', () => {
    const baseline = fingerprintWasm(moduleWithStructure());
    const changedMemory = fingerprintWasm(moduleWithStructure({ memoryMinimum: 2 }));
    const changedGlobal = fingerprintWasm(moduleWithStructure({ globalValue: 1 }));
    const changedData = fingerprintWasm(moduleWithStructure({ dataByte: 0xab }));
    const changedType = fingerprintWasm(moduleWithStructure({ typeResult: true }));
    const changedImport = fingerprintWasm(moduleWithStructure({ importName: 'g' }));
    const reorderedExports = fingerprintWasm(moduleWithStructure({ reverseExports: true }));

    expect(baseline.typeFingerprint).not.toBe(changedType.typeFingerprint);
    expect(compareWasmFingerprints(baseline, changedImport).changedComponents).toEqual([
      'importsExports',
    ]);
    expect(compareWasmFingerprints(baseline, changedMemory).changedComponents).toEqual([
      'memoryTables',
    ]);
    expect(compareWasmFingerprints(baseline, changedGlobal).changedComponents).toEqual(['globals']);
    expect(compareWasmFingerprints(baseline, changedData).changedComponents).toEqual([
      'dataElements',
    ]);
    expect(baseline.importExportFingerprint).toBe(reorderedExports.importExportFingerprint);
    expect(baseline.memoryTableFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces deterministic fingerprints across repeated runs', () => {
    const bytes = moduleWithInstruction([0x41, 0x2a]);
    expect(fingerprintWasm(bytes)).toEqual(fingerprintWasm(bytes));
  });
});
