import {
  analyzeWasmTraps,
  compareWasmTraps,
} from '../src/examples/272-wasm-traps';
import { formatCsvOutput } from '../src/utils/output-formatters';
import { WasmValidationError } from '../src/utils/wasm-static-analysis';

// ---------------------------------------------------------------------------
// WASM Binary Builder Helpers
// ---------------------------------------------------------------------------

function uLEB(value: number): number[] {
  const bytes: number[] = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return bytes;
}

function sLEB(value: number): number[] {
  const bytes: number[] = [];
  let more = true;
  let v = value;
  while (more) {
    let byte = v & 0x7f;
    v >>= 7;
    if ((v === 0 && (byte & 0x40) === 0) || (v === -1 && (byte & 0x40) !== 0)) {
      more = false;
    } else {
      byte |= 0x80;
    }
    bytes.push(byte);
  }
  return bytes;
}

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

function buildWasm(bodyBytes: number[], options?: { memoryPages?: number }): Buffer {
  const typeSec = [0x01, 0x04, 0x01, 0x60, 0x00, 0x00];
  const funcSec = [0x03, 0x02, 0x01, 0x00];

  let memSec: number[] = [];
  if (options?.memoryPages !== undefined) {
    const memPayload = [0x01, 0x00, ...uLEB(options.memoryPages)];
    memSec = [0x05, ...uLEB(memPayload.length), ...memPayload];
  }

  const exportName = [...Buffer.from('testFn', 'utf8')];
  const exportSec = [0x07, 2 + exportName.length + 2, 0x01, exportName.length, ...exportName, 0x00, 0x00];

  const body = [0x00, ...bodyBytes, 0x0b]; // 0 locals + body + end
  const bodyWithSize = [...uLEB(body.length), ...body];
  const codePayload = [0x01, ...bodyWithSize];
  const codeSec = [0x0a, ...uLEB(codePayload.length), ...codePayload];

  return Buffer.from([
    ...WASM_MAGIC,
    ...typeSec,
    ...funcSec,
    ...memSec,
    ...exportSec,
    ...codeSec,
  ]);
}

describe('ISSUE-272: Soroban Contract WASM Trap Condition Analysis', () => {
  it('detects integer division by zero with constant zero divisor as proven-trap', () => {
    // i32.const 10, i32.const 0, i32.div_s
    const wasm = buildWasm([0x41, ...sLEB(10), 0x41, ...sLEB(0), 0x6d]);
    const report = analyzeWasmTraps(wasm);

    expect(report.valid).toBe(true);
    expect(report.totalTrapCapableInstructions).toBeGreaterThan(0);

    const divTrap = report.findings.find((f) => f.opcode === 'i32.div_s');
    expect(divTrap).toBeDefined();
    expect(divTrap?.classification).toBe('proven-trap');
    expect(divTrap?.trapCategory).toBe('integer-divide-by-zero');
  });

  it('detects integer remainder by zero as proven-trap', () => {
    // i32.const 42, i32.const 0, i32.rem_s
    const wasm = buildWasm([0x41, ...sLEB(42), 0x41, ...sLEB(0), 0x6f]);
    const report = analyzeWasmTraps(wasm);

    const remTrap = report.findings.find((f) => f.opcode === 'i32.rem_s');
    expect(remTrap).toBeDefined();
    expect(remTrap?.classification).toBe('proven-trap');
    expect(remTrap?.trapCategory).toBe('integer-remainder-by-zero');
  });

  it('classifies integer division by non-zero constant as proven-safe', () => {
    // i32.const 100, i32.const 5, i32.div_s
    const wasm = buildWasm([0x41, ...sLEB(100), 0x41, ...sLEB(5), 0x6d]);
    const report = analyzeWasmTraps(wasm);

    const divTrap = report.findings.find((f) => f.opcode === 'i32.div_s');
    expect(divTrap).toBeDefined();
    expect(divTrap?.classification).toBe('proven-safe');
    expect(report.provenSafe).toBeGreaterThan(0);
  });

  it('classifies runtime-dependent divisor as possibly-trapping', () => {
    // local.get 0, i32.const 10, i32.div_u (where divisor comes from stack without const)
    const wasm = buildWasm([0x20, 0x00, 0x20, 0x00, 0x6e]);
    const report = analyzeWasmTraps(wasm);

    const divTrap = report.findings.find((f) => f.opcode === 'i32.div_u');
    expect(divTrap).toBeDefined();
    expect(divTrap?.classification).toBe('possibly-trapping');
    expect(report.possibleTraps).toBeGreaterThan(0);
  });

  it('detects signed integer division overflow (INT32_MIN / -1) as proven-trap', () => {
    // i32.const -2147483648, i32.const -1, i32.div_s
    const wasm = buildWasm([0x41, ...sLEB(-2147483648), 0x41, ...sLEB(-1), 0x6d]);
    const report = analyzeWasmTraps(wasm);

    const overflowTrap = report.findings.find((f) => f.trapCategory === 'signed-integer-overflow');
    expect(overflowTrap).toBeDefined();
    expect(overflowTrap?.classification).toBe('proven-trap');
  });

  it('detects unreachable opcode as proven-trap', () => {
    // unreachable
    const wasm = buildWasm([0x00]);
    const report = analyzeWasmTraps(wasm);

    const unreach = report.findings.find((f) => f.opcode === 'unreachable');
    expect(unreach).toBeDefined();
    expect(unreach?.classification).toBe('proven-trap');
    expect(unreach?.trapCategory).toBe('explicit-unreachable');
  });

  it('detects memory out-of-bounds access with provably excessive offset', () => {
    // memory with 1 page (65536 bytes)
    // i32.const 0, i32.load with offset 70000 (exceeds 65536)
    const wasm = buildWasm([0x41, ...sLEB(0), 0x28, 0x02, ...uLEB(70000)], { memoryPages: 1 });
    const report = analyzeWasmTraps(wasm);

    const memTrap = report.findings.find((f) => f.trapCategory === 'memory-out-of-bounds');
    expect(memTrap).toBeDefined();
    expect(memTrap?.classification).toBe('proven-trap');
  });

  it('detects statically safe fixed memory access within page bounds', () => {
    // memory with 1 page (65536 bytes)
    // i32.const 1024, i32.load with offset 16 (1040 < 65536)
    const wasm = buildWasm([0x41, ...sLEB(1024), 0x28, 0x02, ...uLEB(16)], { memoryPages: 1 });
    const report = analyzeWasmTraps(wasm);

    const memTrap = report.findings.find((f) => f.trapCategory === 'memory-out-of-bounds');
    expect(memTrap).toBeDefined();
    expect(memTrap?.classification).toBe('proven-safe');
  });

  it('detects dynamic memory access as possibly-trapping', () => {
    // local.get 0, i32.load offset 0
    const wasm = buildWasm([0x20, 0x00, 0x28, 0x02, ...uLEB(0)], { memoryPages: 1 });
    const report = analyzeWasmTraps(wasm);

    const memTrap = report.findings.find((f) => f.trapCategory === 'memory-out-of-bounds');
    expect(memTrap).toBeDefined();
    expect(memTrap?.classification).toBe('possibly-trapping');
  });

  it('detects floating point truncation instructions as possibly-trapping', () => {
    // i32.trunc_f32_s (0xa8)
    const wasm = buildWasm([0x43, 0x00, 0x00, 0x00, 0x00, 0xa8]);
    const report = analyzeWasmTraps(wasm);

    const truncTrap = report.findings.find((f) => f.trapCategory === 'float-to-int-conversion');
    expect(truncTrap).toBeDefined();
    expect(truncTrap?.classification).toBe('possibly-trapping');
  });

  it('detects indirect call instructions as possibly-trapping', () => {
    // call_indirect (0x11, type 0, table 0)
    const wasm = buildWasm([0x41, 0x00, 0x11, 0x00, 0x00]);
    const report = analyzeWasmTraps(wasm);

    const callTrap = report.findings.find((f) => f.trapCategory === 'indirect-call-target');
    expect(callTrap).toBeDefined();
    expect(callTrap?.classification).toBe('possibly-trapping');
  });

  it('produces valid CSV output from findings', () => {
    const wasm = buildWasm([0x41, ...sLEB(10), 0x41, ...sLEB(0), 0x6d]);
    const report = analyzeWasmTraps(wasm);

    const csv = formatCsvOutput(
      report.findings.map((f) => ({
        functionIndex: f.functionIndex,
        opcode: f.opcode,
        classification: f.classification,
      }))
    );

    expect(csv).toContain('functionIndex,opcode,classification');
    expect(csv).toContain('i32.div_s');
    expect(csv).toContain('proven-trap');
  });

  it('supports two-artifact comparison mode and identifies differences', () => {
    // Wasm A: safe division
    const wasmA = buildWasm([0x41, ...sLEB(10), 0x41, ...sLEB(2), 0x6d]);
    // Wasm B: trapping division
    const wasmB = buildWasm([0x41, ...sLEB(10), 0x41, ...sLEB(0), 0x6d]);

    const comparison = compareWasmTraps(wasmA, wasmB);
    expect(comparison.changedClassifications.length).toBeGreaterThan(0);
    expect(comparison.changedClassifications[0].before).toBe('proven-safe');
    expect(comparison.changedClassifications[0].after).toBe('proven-trap');
  });

  it('throws WasmValidationError on malformed WASM binaries', () => {
    const malformed = Buffer.from([0x00, 0x11, 0x22, 0x33]);
    expect(() => analyzeWasmTraps(malformed)).toThrow(WasmValidationError);
  });

  it('executes deterministically across repeated runs', () => {
    const wasm = buildWasm([
      0x41, ...sLEB(100), 0x41, ...sLEB(0), 0x6d, // div by zero
      0x00,                                         // unreachable
    ]);

    const run1 = analyzeWasmTraps(wasm);
    const run2 = analyzeWasmTraps(wasm);

    expect(JSON.stringify(run1)).toEqual(JSON.stringify(run2));
  });
});
