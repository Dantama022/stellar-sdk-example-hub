import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { WasmValidationError } from '../utils/wasm-static-analysis';
import { formatCsvOutput } from '../utils/output-formatters';

/**
 * Example 272: Soroban Contract WASM Trap Condition Analysis
 *
 * Statically analyzes WebAssembly binaries offline to identify instructions
 * capable of triggering runtime traps (division by zero, signed overflow,
 * out-of-bounds memory/table access, invalid conversions, unreachable traps)
 * and classifies their trap likelihood without executing any code.
 */

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

export type TrapCategory =
  | 'integer-divide-by-zero'
  | 'signed-integer-overflow'
  | 'integer-remainder-by-zero'
  | 'float-to-int-conversion'
  | 'memory-out-of-bounds'
  | 'table-out-of-bounds'
  | 'indirect-call-target'
  | 'explicit-unreachable'
  | 'unknown';

export type TrapClassification =
  | 'proven-trap'
  | 'possibly-trapping'
  | 'proven-safe'
  | 'unknown';

export interface TrapFinding {
  functionIndex: number;
  basicBlock: number;
  instructionIndex: number;
  opcode: string;
  trapCategory: TrapCategory;
  classification: TrapClassification;
  details: string;
  staticOperands?: Record<string, any>;
}

export interface FunctionTrapSummary {
  functionIndex: number;
  totalInstructions: number;
  trapCapableCount: number;
  trapDensity: number;
  findings: TrapFinding[];
  categories: Record<TrapCategory, number>;
}

export interface WasmTrapReport {
  file: string;
  valid: true;
  totalDefinedFunctions: number;
  totalTrapCapableInstructions: number;
  provenTraps: number;
  possibleTraps: number;
  provenSafe: number;
  unknown: number;
  trapCountsByCategory: Record<TrapCategory, number>;
  trapCountsByClassification: Record<TrapClassification, number>;
  functionsWithHighestTrapDensity: Array<{
    functionIndex: number;
    trapCount: number;
    density: number;
  }>;
  findings: TrapFinding[];
}

export interface TrapComparisonReport {
  fileA: string;
  fileB: string;
  newlyIntroducedTrapSites: TrapFinding[];
  removedTrapSites: TrapFinding[];
  changedClassifications: Array<{
    functionIndex: number;
    instructionIndex: number;
    opcode: string;
    before: TrapClassification;
    after: TrapClassification;
  }>;
  summary: {
    totalBefore: number;
    totalAfter: number;
    provenTrapsDelta: number;
    possibleTrapsDelta: number;
  };
}

// ---------------------------------------------------------------------------
// WASM Binary Parser Helpers
// ---------------------------------------------------------------------------

function readByte(buf: Buffer, pos: number): [number, number] {
  if (pos >= buf.length) throw new WasmValidationError('Unexpected end of WASM data');
  return [buf[pos], pos + 1];
}

function readVarU32(buf: Buffer, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  for (let i = 0; i < 5; i++) {
    if (pos >= buf.length) throw new WasmValidationError('Unexpected end of WASM data (LEB128)');
    const b = buf[pos++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result >>> 0, pos];
    shift += 7;
  }
  throw new WasmValidationError('Malformed unsigned LEB128');
}

function readVarI32(buf: Buffer, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  let b = 0;
  do {
    if (pos >= buf.length) throw new WasmValidationError('Unexpected end of WASM data (SLEB128)');
    b = buf[pos++];
    result |= (b & 0x7f) << shift;
    shift += 7;
  } while ((b & 0x80) !== 0 && shift < 35);
  if (shift < 32 && (b & 0x40) !== 0) result |= ~0 << shift;
  return [result, pos];
}

function readVarI64(buf: Buffer, pos: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let b = 0;
  do {
    if (pos >= buf.length) throw new WasmValidationError('Unexpected end of WASM data (SLEB128-64)');
    b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    shift += 7n;
  } while ((b & 0x80) !== 0 && shift < 70n);
  if (shift < 64n && (b & 0x40) !== 0) result |= ~0n << shift;
  return [result, pos];
}

interface RawSection { id: number; payload: Buffer }

function parseSections(wasm: Buffer): RawSection[] {
  if (wasm.length < 8) throw new WasmValidationError('WASM binary too short');
  if (wasm[0] !== 0x00 || wasm[1] !== 0x61 || wasm[2] !== 0x73 || wasm[3] !== 0x6d)
    throw new WasmValidationError('Missing WASM magic header');
  if (wasm.readUInt32LE(4) !== 1)
    throw new WasmValidationError('Unsupported WASM version');
  const sections: RawSection[] = [];
  let pos = 8;
  while (pos < wasm.length) {
    let id: number;
    [id, pos] = readByte(wasm, pos);
    let size: number;
    [size, pos] = readVarU32(wasm, pos);
    if (pos + size > wasm.length) throw new WasmValidationError('Section exceeds WASM data');
    sections.push({ id, payload: wasm.subarray(pos, pos + size) });
    pos += size;
  }
  return sections;
}

function extractFunctionBodies(sections: RawSection[]): Buffer[] {
  const codeSec = sections.find((s) => s.id === 10);
  if (!codeSec) return [];
  const buf = codeSec.payload;
  let pos = 0;
  let count: number;
  [count, pos] = readVarU32(buf, pos);
  const bodies: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    let size: number;
    [size, pos] = readVarU32(buf, pos);
    if (pos + size > buf.length) throw new WasmValidationError('Function body exceeds code section');
    bodies.push(buf.subarray(pos, pos + size));
    pos += size;
  }
  return bodies;
}

function extractMemoryLimits(sections: RawSection[]): { initialPages: number; maxPages: number | null } {
  const memSec = sections.find((s) => s.id === 5);
  if (!memSec) return { initialPages: 1, maxPages: null };
  try {
    const buf = memSec.payload;
    let pos = 0;
    let count: number;
    [count, pos] = readVarU32(buf, pos);
    if (count === 0) return { initialPages: 1, maxPages: null };
    const flag = buf[pos++];
    let initial: number;
    [initial, pos] = readVarU32(buf, pos);
    let max: number | null = null;
    if ((flag & 1) !== 0) {
      [max, pos] = readVarU32(buf, pos);
    }
    return { initialPages: initial, maxPages: max };
  } catch (_) {
    return { initialPages: 1, maxPages: null };
  }
}

// ---------------------------------------------------------------------------
// Trap Analysis Engine
// ---------------------------------------------------------------------------

type ValueEntry =
  | { kind: 'const_i32'; val: number }
  | { kind: 'const_i64'; val: bigint }
  | { kind: 'const_f32'; val: number }
  | { kind: 'const_f64'; val: number }
  | { kind: 'dynamic' };

export class WasmTrapAnalyzer {
  private functionBodies: Buffer[];
  private memoryLimits: { initialPages: number; maxPages: number | null };

  constructor(wasmBuffer: Buffer) {
    const sections = parseSections(wasmBuffer);
    this.functionBodies = extractFunctionBodies(sections);
    this.memoryLimits = extractMemoryLimits(sections);
  }

  public analyze(): WasmTrapReport {
    const findings: TrapFinding[] = [];
    const functionSummaries: FunctionTrapSummary[] = [];

    const categoryCounts: Record<TrapCategory, number> = {
      'integer-divide-by-zero': 0,
      'signed-integer-overflow': 0,
      'integer-remainder-by-zero': 0,
      'float-to-int-conversion': 0,
      'memory-out-of-bounds': 0,
      'table-out-of-bounds': 0,
      'indirect-call-target': 0,
      'explicit-unreachable': 0,
      'unknown': 0,
    };

    const classificationCounts: Record<TrapClassification, number> = {
      'proven-trap': 0,
      'possibly-trapping': 0,
      'proven-safe': 0,
      'unknown': 0,
    };

    for (let fIdx = 0; fIdx < this.functionBodies.length; fIdx++) {
      const summary = this.analyzeFunction(fIdx, this.functionBodies[fIdx]);
      functionSummaries.push(summary);

      for (const finding of summary.findings) {
        findings.push(finding);
        categoryCounts[finding.trapCategory] = (categoryCounts[finding.trapCategory] || 0) + 1;
        classificationCounts[finding.classification] = (classificationCounts[finding.classification] || 0) + 1;
      }
    }

    const highestDensity = functionSummaries
      .map((s) => ({
        functionIndex: s.functionIndex,
        trapCount: s.trapCapableCount,
        density: s.trapDensity,
      }))
      .sort((a, b) => b.density - a.density)
      .slice(0, 10);

    return {
      file: 'analyzed.wasm',
      valid: true,
      totalDefinedFunctions: this.functionBodies.length,
      totalTrapCapableInstructions: findings.length,
      provenTraps: classificationCounts['proven-trap'] || 0,
      possibleTraps: classificationCounts['possibly-trapping'] || 0,
      provenSafe: classificationCounts['proven-safe'] || 0,
      unknown: classificationCounts['unknown'] || 0,
      trapCountsByCategory: categoryCounts,
      trapCountsByClassification: classificationCounts,
      functionsWithHighestTrapDensity: highestDensity,
      findings,
    };
  }

  private analyzeFunction(funcIndex: number, body: Buffer): FunctionTrapSummary {
    let pos = 0;
    // Skip local definitions
    let localCount: number;
    [localCount, pos] = readVarU32(body, pos);
    for (let i = 0; i < localCount; i++) {
      [, pos] = readVarU32(body, pos);
      pos++; // type byte
    }

    const findings: TrapFinding[] = [];
    const simulatedStack: ValueEntry[] = [];
    let currentBlock = 0;
    let instructionIndex = 0;

    const pageSizeBytes = 65536;
    const initialMemoryBytes = this.memoryLimits.initialPages * pageSizeBytes;

    while (pos < body.length) {
      const op = body[pos++];
      instructionIndex++;

      // 0x00: unreachable
      if (op === 0x00) {
        findings.push({
          functionIndex: funcIndex,
          basicBlock: currentBlock,
          instructionIndex,
          opcode: 'unreachable',
          trapCategory: 'explicit-unreachable',
          classification: 'proven-trap',
          details: 'Instruction explicitly traps execution unconditionally.',
        });
      }

      // 0x02: block, 0x03: loop, 0x04: if
      else if (op === 0x02 || op === 0x03 || op === 0x04) {
        currentBlock++;
        pos++; // blocktype byte
      }
      // 0x0B: end
      else if (op === 0x0b) {
        // end of block/function
      }
      // 0x41: i32.const
      else if (op === 0x41) {
        let val: number;
        [val, pos] = readVarI32(body, pos);
        simulatedStack.push({ kind: 'const_i32', val });
      }
      // 0x42: i64.const
      else if (op === 0x42) {
        let val: bigint;
        [val, pos] = readVarI64(body, pos);
        simulatedStack.push({ kind: 'const_i64', val });
      }
      // 0x43: f32.const
      else if (op === 0x43) {
        pos += 4;
        simulatedStack.push({ kind: 'const_f32', val: 0.0 });
      }
      // 0x44: f64.const
      else if (op === 0x44) {
        pos += 8;
        simulatedStack.push({ kind: 'const_f64', val: 0.0 });
      }
      // 0x20: local.get
      else if (op === 0x20) {
        [, pos] = readVarU32(body, pos);
        simulatedStack.push({ kind: 'dynamic' });
      }
      // 0x21: local.set, 0x22: local.tee
      else if (op === 0x21 || op === 0x22) {
        [, pos] = readVarU32(body, pos);
        if (op === 0x21) simulatedStack.pop();
      }
      // 0x28 - 0x3E: Memory loads and stores
      else if (op >= 0x28 && op <= 0x3e) {
        [, pos] = readVarU32(body, pos); // align
        let offset: number;
        [offset, pos] = readVarU32(body, pos);

        const baseVal = simulatedStack.pop();

        let classification: TrapClassification = 'possibly-trapping';
        let details = `Memory access with static offset ${offset}.`;

        if (baseVal && baseVal.kind === 'const_i32') {
          const effectiveAddress = (baseVal.val >>> 0) + offset;
          if (effectiveAddress >= initialMemoryBytes) {
            classification = 'proven-trap';
            details = `Memory address ${effectiveAddress} (base ${baseVal.val} + offset ${offset}) provably exceeds initial memory bounds (${initialMemoryBytes} bytes).`;
          } else {
            classification = 'proven-safe';
            details = `Memory address ${effectiveAddress} is within provably safe initial memory bounds.`;
          }
        } else if (offset >= initialMemoryBytes) {
          classification = 'proven-trap';
          details = `Static offset ${offset} exceeds initial memory size (${initialMemoryBytes} bytes).`;
        }

        findings.push({
          functionIndex: funcIndex,
          basicBlock: currentBlock,
          instructionIndex,
          opcode: `memory.op_0x${op.toString(16)}`,
          trapCategory: 'memory-out-of-bounds',
          classification,
          details,
          staticOperands: { offset, baseKind: baseVal?.kind },
        });

        // Push result for loads (loads are 0x28-0x35)
        if (op <= 0x35) {
          simulatedStack.push({ kind: 'dynamic' });
        }
      }
      // 0x6D: i32.div_s, 0x6E: i32.div_u, 0x6F: i32.rem_s, 0x70: i32.rem_u
      else if (op >= 0x6d && op <= 0x70) {
        const opName =
          op === 0x6d ? 'i32.div_s' :
          op === 0x6e ? 'i32.div_u' :
          op === 0x6f ? 'i32.rem_s' : 'i32.rem_u';

        const isRemainder = op === 0x6f || op === 0x70;
        const isSigned = op === 0x6d || op === 0x6f;
        const category: TrapCategory = isRemainder ? 'integer-remainder-by-zero' : 'integer-divide-by-zero';

        const divisor = simulatedStack.pop();
        const dividend = simulatedStack.pop();

        let classification: TrapClassification = 'possibly-trapping';
        let details = `${opName} divisor cannot be statically verified; depends on runtime value.`;

        if (divisor && divisor.kind === 'const_i32') {
          if (divisor.val === 0) {
            classification = 'proven-trap';
            details = `${opName} with statically proven zero divisor will terminate execution.`;
          } else if (isSigned && divisor.val === -1 && dividend && dividend.kind === 'const_i32' && dividend.val === -2147483648) {
            classification = 'proven-trap';
            details = `i32.div_s with dividend INT32_MIN (-2147483648) and divisor -1 causes signed integer overflow trap.`;
          } else {
            classification = 'proven-safe';
            details = `${opName} with statically proven non-zero divisor (${divisor.val}) is safe from division-by-zero.`;
          }
        }

        findings.push({
          functionIndex: funcIndex,
          basicBlock: currentBlock,
          instructionIndex,
          opcode: opName,
          trapCategory: (isSigned && divisor?.kind === 'const_i32' && divisor.val === -1 && dividend?.kind === 'const_i32' && dividend.val === -2147483648)
            ? 'signed-integer-overflow'
            : category,
          classification,
          details,
          staticOperands: {
            dividend: dividend?.kind === 'const_i32' ? dividend.val : undefined,
            divisor: divisor?.kind === 'const_i32' ? divisor.val : undefined,
          },
        });

        simulatedStack.push({ kind: 'dynamic' });
      }
      // 0x7F: i64.div_s, 0x80: i64.div_u, 0x81: i64.rem_s, 0x82: i64.rem_u
      else if (op >= 0x7f && op <= 0x82) {
        const opName =
          op === 0x7f ? 'i64.div_s' :
          op === 0x80 ? 'i64.div_u' :
          op === 0x81 ? 'i64.rem_s' : 'i64.rem_u';

        const isRemainder = op === 0x81 || op === 0x82;
        const isSigned = op === 0x7f || op === 0x81;
        const category: TrapCategory = isRemainder ? 'integer-remainder-by-zero' : 'integer-divide-by-zero';

        const divisor = simulatedStack.pop();
        const dividend = simulatedStack.pop();

        let classification: TrapClassification = 'possibly-trapping';
        let details = `${opName} divisor cannot be statically verified; depends on runtime value.`;

        if (divisor && divisor.kind === 'const_i64') {
          if (divisor.val === 0n) {
            classification = 'proven-trap';
            details = `${opName} with statically proven zero divisor will terminate execution.`;
          } else if (isSigned && divisor.val === -1n && dividend && dividend.kind === 'const_i64' && dividend.val === -9223372036854775808n) {
            classification = 'proven-trap';
            details = `i64.div_s with dividend INT64_MIN and divisor -1 causes signed integer overflow trap.`;
          } else {
            classification = 'proven-safe';
            details = `${opName} with statically proven non-zero divisor is safe from division-by-zero.`;
          }
        }

        findings.push({
          functionIndex: funcIndex,
          basicBlock: currentBlock,
          instructionIndex,
          opcode: opName,
          trapCategory: (isSigned && divisor?.kind === 'const_i64' && divisor.val === -1n && dividend?.kind === 'const_i64' && dividend.val === -9223372036854775808n)
            ? 'signed-integer-overflow'
            : category,
          classification,
          details,
        });

        simulatedStack.push({ kind: 'dynamic' });
      }
      // 0xA8 - 0xAF: Floating-point-to-integer conversion truncations
      else if (op >= 0xa8 && op <= 0xaf) {
        simulatedStack.pop();
        findings.push({
          functionIndex: funcIndex,
          basicBlock: currentBlock,
          instructionIndex,
          opcode: `trunc_op_0x${op.toString(16)}`,
          trapCategory: 'float-to-int-conversion',
          classification: 'possibly-trapping',
          details: 'Truncation of floating-point to integer can trap on NaN or out-of-range integer values.',
        });
        simulatedStack.push({ kind: 'dynamic' });
      }
      // 0x11: call_indirect
      else if (op === 0x11) {
        let typeIdx: number, tableIdx: number;
        [typeIdx, pos] = readVarU32(body, pos);
        [tableIdx, pos] = readVarU32(body, pos);
        simulatedStack.pop(); // table index operand

        findings.push({
          functionIndex: funcIndex,
          basicBlock: currentBlock,
          instructionIndex,
          opcode: 'call_indirect',
          trapCategory: 'indirect-call-target',
          classification: 'possibly-trapping',
          details: `Indirect call through table ${tableIdx} with signature type ${typeIdx} may trap on invalid index or type mismatch.`,
        });
      }
      // Generic single-byte instructions
      else {
        // Skip opcodes with LEB128 immediates
        if (op === 0x10) { [, pos] = readVarU32(body, pos); } // call
        else if (op === 0x0c || op === 0x0d) { [, pos] = readVarU32(body, pos); } // br, br_if
      }
    }

    const trapDensity = instructionIndex > 0 ? findings.length / instructionIndex : 0;
    const catMap: Record<TrapCategory, number> = {
      'integer-divide-by-zero': 0,
      'signed-integer-overflow': 0,
      'integer-remainder-by-zero': 0,
      'float-to-int-conversion': 0,
      'memory-out-of-bounds': 0,
      'table-out-of-bounds': 0,
      'indirect-call-target': 0,
      'explicit-unreachable': 0,
      'unknown': 0,
    };
    for (const f of findings) {
      catMap[f.trapCategory] = (catMap[f.trapCategory] || 0) + 1;
    }

    return {
      functionIndex: funcIndex,
      totalInstructions: instructionIndex,
      trapCapableCount: findings.length,
      trapDensity,
      findings,
      categories: catMap,
    };
  }

  public compareWith(otherWasmBuffer: Buffer): TrapComparisonReport {
    const reportA = this.analyze();
    const analyzerB = new WasmTrapAnalyzer(otherWasmBuffer);
    const reportB = analyzerB.analyze();

    const makeKey = (f: TrapFinding) => `${f.functionIndex}:${f.instructionIndex}:${f.opcode}`;
    const mapA = new Map<string, TrapFinding>();
    for (const f of reportA.findings) mapA.set(makeKey(f), f);

    const mapB = new Map<string, TrapFinding>();
    for (const f of reportB.findings) mapB.set(makeKey(f), f);

    const newlyIntroduced: TrapFinding[] = [];
    const removed: TrapFinding[] = [];
    const changed: Array<{
      functionIndex: number;
      instructionIndex: number;
      opcode: string;
      before: TrapClassification;
      after: TrapClassification;
    }> = [];

    for (const [key, itemB] of mapB.entries()) {
      if (!mapA.has(key)) {
        newlyIntroduced.push(itemB);
      } else {
        const itemA = mapA.get(key)!;
        if (itemA.classification !== itemB.classification) {
          changed.push({
            functionIndex: itemB.functionIndex,
            instructionIndex: itemB.instructionIndex,
            opcode: itemB.opcode,
            before: itemA.classification,
            after: itemB.classification,
          });
        }
      }
    }

    for (const [key, itemA] of mapA.entries()) {
      if (!mapB.has(key)) {
        removed.push(itemA);
      }
    }

    return {
      fileA: 'baseline.wasm',
      fileB: 'comparison.wasm',
      newlyIntroducedTrapSites: newlyIntroduced,
      removedTrapSites: removed,
      changedClassifications: changed,
      summary: {
        totalBefore: reportA.totalTrapCapableInstructions,
        totalAfter: reportB.totalTrapCapableInstructions,
        provenTrapsDelta: reportB.provenTraps - reportA.provenTraps,
        possibleTrapsDelta: reportB.possibleTraps - reportA.possibleTraps,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Main Analysis Runner
// ---------------------------------------------------------------------------

export function analyzeWasmTraps(wasmBuffer: Buffer): WasmTrapReport {
  const analyzer = new WasmTrapAnalyzer(wasmBuffer);
  return analyzer.analyze();
}

export function compareWasmTraps(wasmBufferA: Buffer, wasmBufferB: Buffer): TrapComparisonReport {
  const analyzerA = new WasmTrapAnalyzer(wasmBufferA);
  return analyzerA.compareWith(wasmBufferB);
}

export async function run(params?: any): Promise<void> {
  const wasmPath = params?.wasmFile || process.argv[2];
  if (!wasmPath) {
    console.log(chalk.yellow('Usage: stellar-sdk-example-hub wasm-traps <wasmFile> [--output json|csv] [--compare <wasmFile>]'));
    return;
  }

  const wasmBuffer = fs.readFileSync(path.resolve(process.cwd(), wasmPath));
  const report = analyzeWasmTraps(wasmBuffer);

  if (params?.output === 'csv') {
    const rows = report.findings.map((f) => ({
      functionIndex: f.functionIndex,
      basicBlock: f.basicBlock,
      instructionIndex: f.instructionIndex,
      opcode: f.opcode,
      category: f.trapCategory,
      classification: f.classification,
      details: f.details,
    }));
    console.log(formatCsvOutput(rows));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}
