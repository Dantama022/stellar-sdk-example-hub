import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

describe('wasm-literals CLI', () => {
  const cliPath = path.resolve(__dirname, '../../src/cli/wasm-literals.js');
  const testWasmPath = path.resolve(__dirname, './test.wasm');

  beforeAll(() => {
    // Create a test WASM file
    const wasmBinary = Buffer.from([
      0x00, 0x61, 0x73, 0x6D, // Magic: \0asm
      0x01, 0x00, 0x00, 0x00, // Version: 1
      0x01, 0x07, 0x01,       // Type section
      0x60, 0x00, 0x00,       // Func type: [] -> []
      0x03, 0x02, 0x01, 0x00, // Function section
      0x0A, 0x0B, 0x01,       // Code section
      0x07, 0x00, 0x00,       // Body size 7, 0 locals
      0x41, 0x2A, 0x00,       // i32.const 42
      0x42, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // i64.const 100
      0x0B                    // end
    ]);

    fs.writeFileSync(testWasmPath, wasmBinary);
  });

  afterAll(() => {
    // Clean up test file
    if (fs.existsSync(testWasmPath)) {
      fs.unlinkSync(testWasmPath);
    }
  });

  it('should output JSON by default', () => {
    const output = execSync(`node ${cliPath} ${testWasmPath}`).toString();
    const result = JSON.parse(output);

    expect(result).toHaveProperty('literals');
    expect(result).toHaveProperty('statistics');
    expect(result.statistics.totalOccurrences).toBe(2);
  });

  it('should output CSV when specified', () => {
    const output = execSync(`node ${cliPath} ${testWasmPath} -f csv`).toString();

    expect(output).toContain('value,type,signed,unsigned,hex');
    expect(output).toContain('42');
    expect(output).toContain('100');
  });

  it('should write to file when output path is specified', () => {
    const outputPath = path.resolve(__dirname, './output.json');
    execSync(`node ${cliPath} ${testWasmPath} -o ${outputPath}`);

    expect(fs.existsSync(outputPath)).toBe(true);
    const content = fs.readFileSync(outputPath, 'utf-8');
    const result = JSON.parse(content);
    expect(result.statistics.totalOccurrences).toBe(2);

    // Clean up
    fs.unlinkSync(outputPath);
  });

  it('should handle non-existent file', () => {
    try {
      execSync(`node ${cliPath} non-existent.wasm`);
      fail('Should have thrown an error');
    } catch (error: any) {
      expect(error.stderr.toString()).toContain('File not found');
    }
  });

  it('should filter by minimum occurrences', () => {
    const output = execSync(`node ${cliPath} ${testWasmPath} --min-occurrences 2`).toString();
    const result = JSON.parse(output);

    expect(result.literals.length).toBe(0);
  });

  it('should include hex representations by default', () => {
    const output = execSync(`node ${cliPath} ${testWasmPath}`).toString();
    const result = JSON.parse(output);

    const literal42 = result.literals.find((l: any) => l.normalizedValue === '42');
    expect(literal42.hexValue).toBe('0x2a');
  });

  it('should exclude hex representations when disabled', () => {
    const output = execSync(`node ${cliPath} ${testWasmPath} --include-hex false`).toString();
    const result = JSON.parse(output);

    const literal42 = result.literals.find((l: any) => l.normalizedValue === '42');
    expect(literal42.hexValue).toBeNull();
  });
});
