import fs from 'fs';
import os from 'os';
import path from 'path';

import { compareProvenanceReports } from '../src/examples/250-wasm-provenance';
import { analyzeWasmProvenance } from '../src/utils/wasm-static-analysis';

function u32(value: number): number[] {
  const bytes: number[] = [];
  let current = value >>> 0;
  do {
    let byte = current & 0x7f;
    current >>>= 7;
    if (current !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (current !== 0);
  return bytes;
}

function str(value: string): number[] {
  const bytes = Buffer.from(value, 'utf8');
  return [...u32(bytes.length), ...bytes];
}

function section(id: number, payload: number[]): number[] {
  return [id, ...u32(payload.length), ...payload];
}

function producerSection(
  fields: Array<{ name: string; producers: Array<{ name: string; version: string }> }>,
): number[] {
  const payload = [...str('producers'), ...u32(fields.length)];
  fields.forEach((field) => {
    payload.push(...str(field.name), ...u32(field.producers.length));
    field.producers.forEach((producer) => {
      payload.push(...str(producer.name), ...str(producer.version));
    });
  });
  return section(0, payload);
}

function fixture(producerSections: number[][] = []): Buffer {
  return Buffer.from([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...producerSections.flat(),
    ...section(0, [...str('build-info'), 0x2a]),
    ...section(1, [0x01, 0x60, 0x00, 0x00]),
    ...section(2, [0x01, ...str('env'), ...str('host'), 0x00, 0x00]),
    ...section(3, [0x01, 0x00]),
    ...section(7, [0x01, ...str('run'), 0x00, 0x01]),
    ...section(10, [0x01, 0x04, 0x00, 0x41, 0x00, 0x0b]),
  ]);
}

function writeWasm(wasm: Buffer): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wasm-provenance-'));
  const file = path.join(directory, 'fixture.wasm');
  fs.writeFileSync(file, wasm);
  return file;
}

const completeFields = [
  { name: 'language', producers: [{ name: 'Rust', version: '1.80.0' }] },
  {
    name: 'processed-by',
    producers: [
      { name: 'rustc', version: '1.80.0' },
      { name: 'wasm-ld', version: '18.1' },
    ],
  },
];

describe('WASM compiler provenance analysis', () => {
  it('parses standard producer records in artifact order and correlates module information', () => {
    const file = writeWasm(fixture([producerSection(completeFields)]));
    const report = analyzeWasmProvenance(file);

    expect(report.provenanceStatus).toBe('available');
    expect(report.producers.map(({ field, name, category }) => [field, name, category])).toEqual([
      ['language', 'Rust', 'language'],
      ['processed-by', 'rustc', 'compiler'],
      ['processed-by', 'wasm-ld', 'linker'],
    ]);
    expect(report.rawProducerMetadata[0].fields).toEqual(completeFields);
    expect(
      Buffer.from(report.rawProducerMetadata[0].payloadBase64, 'base64').length,
    ).toBeGreaterThan(0);
    expect(report.module).toEqual({
      wasmVersion: 1,
      functionCount: 2,
      importCount: 1,
      exportCount: 1,
      codeSize: 6,
      customSections: { present: true, count: 2, names: ['producers', 'build-info'] },
    });
    expect(report.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('reports partial metadata when one producer section is malformed', () => {
    const malformed = section(0, [
      ...str('producers'),
      ...u32(1),
      ...str('language'),
      ...u32(1),
      ...str('Rust'),
    ]);
    const report = analyzeWasmProvenance(
      writeWasm(fixture([producerSection(completeFields), malformed])),
    );

    expect(report.provenanceStatus).toBe('partial');
    expect(report.producers).toHaveLength(3);
    expect(report.rawProducerMetadata[1].error).toMatch(/Unexpected end/);
    expect(report.warnings.join(' ')).toMatch(/malformed/);
  });

  it('reports absent provenance without inferring a missing language or compiler', () => {
    const report = analyzeWasmProvenance(writeWasm(fixture()));

    expect(report.provenanceStatus).toBe('absent');
    expect(report.producers).toEqual([]);
    expect(report.warnings).toContain('No standard producers custom section was found');

    const incomplete = analyzeWasmProvenance(
      writeWasm(fixture([producerSection([{ name: 'sdk', producers: [] }])])),
    );
    expect(incomplete.provenanceStatus).toBe('partial');
    expect(incomplete.fingerprint).not.toBe(report.fingerprint);
  });

  it('compares additions, removals, version and category changes, and unchanged fingerprints', () => {
    const before = writeWasm(fixture([producerSection(completeFields)]));
    const after = writeWasm(
      fixture([
        producerSection([
          { name: 'language', producers: [{ name: 'Rust', version: '1.80.0' }] },
          {
            name: 'language',
            producers: [{ name: 'rustc', version: '1.81.0' }],
          },
          {
            name: 'processed-by',
            producers: [
              { name: 'wasm-opt', version: '120' },
              { name: 'clang', version: '18.0' },
            ],
          },
        ]),
      ]),
    );
    const comparison = compareProvenanceReports(before, after).comparison;

    expect(comparison.versionChanges).toHaveLength(1);
    expect(comparison.categoryChanges).toHaveLength(1);
    expect(comparison.addedProducers.map(({ name }) => name)).toEqual(['wasm-opt', 'clang']);
    expect(comparison.addedProducers[0].category).toBe('binary-tool');
    expect(comparison.removedProducers.map(({ name }) => name)).toEqual(['wasm-ld']);
    expect(comparison.materiallyDifferentProducerChains).toBe(true);

    const unchanged = compareProvenanceReports(before, before).comparison;
    expect(unchanged.unchangedProvenance).toBe(true);
    expect(unchanged.materiallyDifferentProducerChains).toBe(false);
  });
});
