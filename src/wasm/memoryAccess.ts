/**
 * WASM linear-memory access pattern analysis (ISSUE-267).
 *
 * A WebAssembly memory section only says *how much* linear memory a module
 * provides. It does not say how the compiled contract code actually uses
 * that memory. This analysis scans the load and store instructions of every
 * function and builds a normalized inventory of the linear-memory traffic of
 * a Soroban contract artifact.
 *
 * The analysis is completely offline: the artifact is decoded, the
 * instructions are inspected and the values are derived statically. No
 * instruction is ever executed and no module is instantiated.
 */

import { readFileSync } from 'fs';
import { analyzeModuleFunctions, type AnalyzedFunction } from './moduleAnalysis';
import { parseWasmModule, WasmParseError, type WasmModule } from './wasmBinary';

/** Whether an access reads or writes linear memory. */
export type AccessType = 'load' | 'store';

/** Human readable label of an access width. */
export type WidthLabel = 'byte' | 'half-word' | 'word' | 'double-word' | 'quad-word' | 'vector';

/** How the effective address of an access could be determined. */
export type AddressType = 'static' | 'dynamic';

/** One normalized memory access. */
export interface MemoryAccessRecord {
  /** Index of the function in the module function index space. */
  functionIndex: number;
  /** Display name of the function. */
  functionName: string;
  /** Index of the basic block that contains the access. */
  blockIndex: number;
  /** Index of the instruction inside the function. */
  instructionIndex: number;
  /** Ordinal of the access inside its function. */
  ordinal: number;
  /** Mnemonic of the instruction, e.g. `i32.load`. */
  opcode: string;
  /** Whether the access reads or writes memory. */
  accessType: AccessType;
  /** Value type moved by the access. */
  valueType: 'i32' | 'i64' | 'f32' | 'f64' | 'v128';
  /** Width of the access in bits. */
  widthBits: number;
  /** Human readable width. */
  widthLabel: WidthLabel;
  /** Alignment exponent as encoded in the instruction. */
  alignment: number;
  /** Alignment in bytes (`2^alignment`). */
  alignmentBytes: number;
  /** Static offset immediate of the access. */
  staticOffset: number;
  /** Index of the memory the access targets. */
  memoryIndex: number;
  /** Whether the effective address is statically known. */
  addressType: AddressType;
  /** The statically known effective address, when it could be determined. */
  effectiveAddress?: string;
  /** The statically known base address, when it could be determined. */
  baseAddress?: string;
}

/** Statistics of a single function. */
export interface FunctionMemoryStats {
  functionIndex: number;
  functionName: string;
  /** Number of load instructions. */
  totalLoads: number;
  /** Number of store instructions. */
  totalStores: number;
  /** Total number of memory accesses. */
  totalAccesses: number;
  /** Ratio of loads to stores (`0` when the function does not write memory). */
  readWriteRatio: number;
  /** Access widths used by the function, in bits. */
  uniqueWidths: number[];
  /** Static offsets used by the function. */
  uniqueStaticOffsets: number[];
  /** Largest static offset used by the function. */
  maxStaticOffset: number;
  /** Classification of the memory behaviour of the function. */
  accessPattern: 'read-only' | 'write-only' | 'read-write' | 'none';
}

/** Module level statistics. */
export interface MemoryAccessTotals {
  /** Number of functions in the module. */
  totalFunctions: number;
  /** Number of functions that access linear memory. */
  functionsWithMemoryAccess: number;
  /** Total number of load instructions. */
  totalLoads: number;
  /** Total number of store instructions. */
  totalStores: number;
  /** Total number of memory accesses. */
  totalAccesses: number;
  /** Number of distinct static offsets. */
  uniqueStaticOffsets: number;
  /** Largest static offset used anywhere in the module. */
  maxStaticOffset: number;
  /** Number of accesses whose effective address is statically known. */
  staticAddresses: number;
  /** Number of accesses whose effective address depends on runtime values. */
  dynamicAddresses: number;
  /** Number of functions that only read memory. */
  readOnlyFunctions: number;
  /** Number of functions that only write memory. */
  writeOnlyFunctions: number;
  /** Number of functions that both read and write memory. */
  readWriteFunctions: number;
  /** Access counts grouped by opcode. */
  byOpcode: Record<string, number>;
  /** Access counts grouped by opcode and width. */
  byOpcodeAndWidth: Record<string, number>;
  /** Access counts grouped by width label. */
  byWidth: Record<string, number>;
}

/** A function ranked by the number of memory accesses. */
export interface RankedFunction {
  functionIndex: number;
  functionName: string;
  /** Number of memory accesses. */
  count: number;
  /** Ratio of loads to stores. */
  readWriteRatio: number;
}

/** A static offset and how often it is used. */
export interface OffsetUsage {
  /** The static offset. */
  offset: number;
  /** Number of accesses that use the offset. */
  count: number;
}

/** The complete memory-access report. */
export interface MemoryAccessReport {
  /** Path of the analyzed artifact. */
  file: string;
  /** Normalized inventory of every memory access. */
  accesses: MemoryAccessRecord[];
  /** Per-function statistics. */
  functions: FunctionMemoryStats[];
  /** Module level statistics. */
  totals: MemoryAccessTotals;
  /** Functions with the highest number of memory accesses. */
  topFunctionsByAccessCount: RankedFunction[];
  /** Functions with the highest ratio of reads to writes. */
  topFunctionsByReadWriteRatio: RankedFunction[];
  /** Static offsets that are used most often. */
  frequentlyUsedOffsets: OffsetUsage[];
}

/** Maps an access width in bits to a human readable label. */
export function widthLabel(widthBits: number): WidthLabel {
  switch (widthBits) {
    case 8:
      return 'byte';
    case 16:
      return 'half-word';
    case 32:
      return 'word';
    case 64:
      return 'double-word';
    case 128:
      return 'vector';
    default:
      return 'vector';
  }
}

/** Builds the normalized access records of a single function. */
function collectFunctionAccesses(analyzed: AnalyzedFunction): MemoryAccessRecord[] {
  const records: MemoryAccessRecord[] = [];
  const { func, cfg, observations } = analyzed;

  for (const block of cfg.blocks) {
    for (const instruction of block.instructions) {
      const access = instruction.memoryAccess;
      if (!access || !instruction.memarg) continue;

      const observation = observations.get(instruction.index);
      const base = observation?.stackTop;
      const baseKnown = base?.known === true && base?.value !== undefined;

      const record: MemoryAccessRecord = {
        functionIndex: func.index,
        functionName: func.name ?? `func_${func.index}`,
        blockIndex: block.index,
        instructionIndex: instruction.index,
        ordinal: records.length,
        opcode: instruction.name,
        accessType: access.kind,
        valueType: access.valueType,
        widthBits: access.widthBits,
        widthLabel: widthLabel(access.widthBits),
        alignment: instruction.memarg.align,
        alignmentBytes: Math.pow(2, instruction.memarg.align),
        staticOffset: instruction.memarg.offset,
        memoryIndex: instruction.memarg.memoryIndex,
        addressType: baseKnown ? 'static' : 'dynamic',
      };

      if (baseKnown && base?.value !== undefined) {
        record.baseAddress = base.value.toString();
        record.effectiveAddress = (base.value + BigInt(instruction.memarg.offset)).toString();
      }

      records.push(record);
    }
  }

  return records;
}

/** Computes the per-function statistics of a function. */
export function computeFunctionStats(
  functionIndex: number,
  functionName: string,
  accesses: MemoryAccessRecord[],
): FunctionMemoryStats {
  const totalLoads = accesses.filter((access) => access.accessType === 'load').length;
  const totalStores = accesses.filter((access) => access.accessType === 'store').length;
  const widths = Array.from(new Set(accesses.map((access) => access.widthBits))).sort(
    (a, b) => a - b,
  );
  const offsets = Array.from(new Set(accesses.map((access) => access.staticOffset))).sort(
    (a, b) => a - b,
  );

  let accessPattern: FunctionMemoryStats['accessPattern'] = 'none';
  if (totalLoads > 0 && totalStores > 0) accessPattern = 'read-write';
  else if (totalLoads > 0) accessPattern = 'read-only';
  else if (totalStores > 0) accessPattern = 'write-only';

  return {
    functionIndex,
    functionName,
    totalLoads,
    totalStores,
    totalAccesses: accesses.length,
    readWriteRatio:
      totalStores > 0
        ? Number((totalLoads / totalStores).toFixed(4))
        : totalLoads > 0
          ? totalLoads
          : 0,
    uniqueWidths: widths,
    uniqueStaticOffsets: offsets,
    maxStaticOffset: offsets.length > 0 ? offsets[offsets.length - 1] : 0,
    accessPattern,
  };
}

/** Analyzes the memory access patterns of a decoded module. */
export function analyzeMemoryAccesses(
  module: WasmModule,
  file = 'contract.wasm',
): MemoryAccessReport {
  const analyzed = analyzeModuleFunctions(module);

  const accesses: MemoryAccessRecord[] = [];
  const functions: FunctionMemoryStats[] = [];

  for (const entry of analyzed) {
    const functionAccesses = collectFunctionAccesses(entry);
    accesses.push(...functionAccesses);
    functions.push(
      computeFunctionStats(
        entry.func.index,
        entry.func.name ?? `func_${entry.func.index}`,
        functionAccesses,
      ),
    );
  }

  const byOpcode: Record<string, number> = {};
  const byOpcodeAndWidth: Record<string, number> = {};
  const byWidth: Record<string, number> = {};
  const offsetCounts = new Map<number, number>();

  for (const access of accesses) {
    byOpcode[access.opcode] = (byOpcode[access.opcode] ?? 0) + 1;
    const opcodeWidthKey = `${access.opcode}:${access.widthBits}`;
    byOpcodeAndWidth[opcodeWidthKey] = (byOpcodeAndWidth[opcodeWidthKey] ?? 0) + 1;
    byWidth[access.widthLabel] = (byWidth[access.widthLabel] ?? 0) + 1;
    offsetCounts.set(access.staticOffset, (offsetCounts.get(access.staticOffset) ?? 0) + 1);
  }

  const totalLoads = accesses.filter((access) => access.accessType === 'load').length;
  const totalStores = accesses.filter((access) => access.accessType === 'store').length;
  const offsets = Array.from(offsetCounts.keys()).sort((a, b) => a - b);

  const totals: MemoryAccessTotals = {
    totalFunctions: functions.length,
    functionsWithMemoryAccess: functions.filter((fn) => fn.totalAccesses > 0).length,
    totalLoads,
    totalStores,
    totalAccesses: accesses.length,
    uniqueStaticOffsets: offsets.length,
    maxStaticOffset: offsets.length > 0 ? offsets[offsets.length - 1] : 0,
    staticAddresses: accesses.filter((access) => access.addressType === 'static').length,
    dynamicAddresses: accesses.filter((access) => access.addressType === 'dynamic').length,
    readOnlyFunctions: functions.filter((fn) => fn.accessPattern === 'read-only').length,
    writeOnlyFunctions: functions.filter((fn) => fn.accessPattern === 'write-only').length,
    readWriteFunctions: functions.filter((fn) => fn.accessPattern === 'read-write').length,
    byOpcode: sortRecord(byOpcode),
    byOpcodeAndWidth: sortRecord(byOpcodeAndWidth),
    byWidth: sortRecord(byWidth),
  };

  const topFunctionsByAccessCount: RankedFunction[] = functions
    .filter((fn) => fn.totalAccesses > 0)
    .map((fn) => ({
      functionIndex: fn.functionIndex,
      functionName: fn.functionName,
      count: fn.totalAccesses,
      readWriteRatio: fn.readWriteRatio,
    }))
    .sort((a, b) => (b.count === a.count ? a.functionIndex - b.functionIndex : b.count - a.count));

  const topFunctionsByReadWriteRatio: RankedFunction[] = functions
    .filter((fn) => fn.totalAccesses > 0)
    .map((fn) => ({
      functionIndex: fn.functionIndex,
      functionName: fn.functionName,
      count: fn.totalAccesses,
      readWriteRatio: fn.readWriteRatio,
    }))
    .sort((a, b) =>
      b.readWriteRatio === a.readWriteRatio
        ? a.functionIndex - b.functionIndex
        : b.readWriteRatio - a.readWriteRatio,
    );

  const frequentlyUsedOffsets: OffsetUsage[] = Array.from(offsetCounts.entries())
    .map(([offset, count]) => ({ offset, count }))
    .sort((a, b) => (b.count === a.count ? a.offset - b.offset : b.count - a.count));

  return {
    file,
    accesses,
    functions,
    totals,
    topFunctionsByAccessCount,
    topFunctionsByReadWriteRatio,
    frequentlyUsedOffsets,
  };
}

/** Sorts the keys of a counter object so the output is deterministic. */
function sortRecord(record: Record<string, number>): Record<string, number> {
  const sorted: Record<string, number> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = record[key];
  }
  return sorted;
}

/** Analyzes the memory access patterns of a `.wasm` file. */
export function analyzeMemoryAccessFile(file: string): MemoryAccessReport {
  const buffer = readFileSync(file);
  const module = parseWasmModule(buffer);
  return analyzeMemoryAccesses(module, file);
}

/** A single change between two memory-access inventories. */
export interface AccessChange {
  /** Stable key of the access site. */
  key: string;
  /** Index of the function. */
  functionIndex: number;
  /** Display name of the function. */
  functionName: string;
  /** The access in the old artifact. */
  oldAccess?: MemoryAccessRecord;
  /** The access in the new artifact. */
  newAccess?: MemoryAccessRecord;
}

/** The result of comparing the memory access patterns of two artifacts. */
export interface MemoryAccessComparison {
  oldFile: string;
  newFile: string;
  /** Access sites that only exist in the new artifact. */
  addedAccesses: MemoryAccessRecord[];
  /** Access sites that only exist in the old artifact. */
  removedAccesses: MemoryAccessRecord[];
  /** Access sites that changed from a load to a store or vice versa. */
  changedAccessType: AccessChange[];
  /** Access sites whose access width changed. */
  changedWidth: AccessChange[];
  /** Access sites whose static offset changed. */
  changedStaticOffset: AccessChange[];
  /** Functions that gained at least one memory access. */
  functionsWithNewAccess: number[];
  /** Functions that lost all of their memory accesses. */
  functionsWithoutAccess: number[];
  /** Summary counters. */
  summary: {
    oldAccessCount: number;
    newAccessCount: number;
    added: number;
    removed: number;
    changedAccessType: number;
    changedWidth: number;
    changedStaticOffset: number;
    functionsWithNewAccess: number;
    functionsWithoutAccess: number;
  };
}

/** Stable key of an access site inside a function. */
export function accessKey(access: MemoryAccessRecord): string {
  return `${access.functionIndex}#${access.ordinal}`;
}

/** Compares the memory access patterns of two artifacts. */
export function compareMemoryAccesses(
  oldReport: MemoryAccessReport,
  newReport: MemoryAccessReport,
): MemoryAccessComparison {
  const oldByKey = new Map(oldReport.accesses.map((access) => [accessKey(access), access]));
  const newByKey = new Map(newReport.accesses.map((access) => [accessKey(access), access]));
  const keys = Array.from(new Set([...oldByKey.keys(), ...newByKey.keys()])).sort();

  const addedAccesses: MemoryAccessRecord[] = [];
  const removedAccesses: MemoryAccessRecord[] = [];
  const changedAccessType: AccessChange[] = [];
  const changedWidth: AccessChange[] = [];
  const changedStaticOffset: AccessChange[] = [];
  const functionsWithNewAccess = new Set<number>();
  const functionsWithoutAccess = new Set<number>();

  for (const key of keys) {
    const oldAccess = oldByKey.get(key);
    const newAccess = newByKey.get(key);

    if (oldAccess && !newAccess) {
      removedAccesses.push(oldAccess);
      continue;
    }
    if (!oldAccess && newAccess) {
      addedAccesses.push(newAccess);
      functionsWithNewAccess.add(newAccess.functionIndex);
      continue;
    }

    const oldEntry = oldAccess as MemoryAccessRecord;
    const newEntry = newAccess as MemoryAccessRecord;

    if (oldEntry.accessType !== newEntry.accessType) {
      changedAccessType.push({
        key,
        functionIndex: oldEntry.functionIndex,
        functionName: oldEntry.functionName,
        oldAccess: oldEntry,
        newAccess: newEntry,
      });
    }
    if (oldEntry.widthBits !== newEntry.widthBits) {
      changedWidth.push({
        key,
        functionIndex: oldEntry.functionIndex,
        functionName: oldEntry.functionName,
        oldAccess: oldEntry,
        newAccess: newEntry,
      });
    }
    if (oldEntry.staticOffset !== newEntry.staticOffset) {
      changedStaticOffset.push({
        key,
        functionIndex: oldEntry.functionIndex,
        functionName: oldEntry.functionName,
        oldAccess: oldEntry,
        newAccess: newEntry,
      });
    }
  }

  for (const fn of oldReport.functions) {
    if (
      fn.totalAccesses > 0 &&
      !newReport.functions.some(
        (other) => other.functionIndex === fn.functionIndex && other.totalAccesses > 0,
      )
    ) {
      functionsWithoutAccess.add(fn.functionIndex);
    }
  }

  return {
    oldFile: oldReport.file,
    newFile: newReport.file,
    addedAccesses,
    removedAccesses,
    changedAccessType,
    changedWidth,
    changedStaticOffset,
    functionsWithNewAccess: Array.from(functionsWithNewAccess).sort((a, b) => a - b),
    functionsWithoutAccess: Array.from(functionsWithoutAccess).sort((a, b) => a - b),
    summary: {
      oldAccessCount: oldReport.accesses.length,
      newAccessCount: newReport.accesses.length,
      added: addedAccesses.length,
      removed: removedAccesses.length,
      changedAccessType: changedAccessType.length,
      changedWidth: changedWidth.length,
      changedStaticOffset: changedStaticOffset.length,
      functionsWithNewAccess: functionsWithNewAccess.size,
      functionsWithoutAccess: functionsWithoutAccess.size,
    },
  };
}

/** Renders a human-readable memory access report. */
export function formatMemoryAccessReport(report: MemoryAccessReport): string {
  const lines: string[] = [];
  const { totals } = report;

  lines.push('WASM memory access analysis');
  lines.push('===========================');
  lines.push(`Artifact: ${report.file}`);
  lines.push('');
  lines.push('Module totals');
  lines.push('-------------');
  lines.push(`Functions:                 ${totals.totalFunctions}`);
  lines.push(`Functions with memory use: ${totals.functionsWithMemoryAccess}`);
  lines.push(`Total memory accesses:      ${totals.totalAccesses}`);
  lines.push(`Loads / stores:             ${totals.totalLoads} / ${totals.totalStores}`);
  lines.push(`Statically addressable:     ${totals.staticAddresses}`);
  lines.push(`Runtime dependent address:  ${totals.dynamicAddresses}`);
  lines.push(`Unique static offsets:      ${totals.uniqueStaticOffsets}`);
  lines.push(`Maximum static offset:      ${totals.maxStaticOffset}`);
  lines.push(`Read-only functions:        ${totals.readOnlyFunctions}`);
  lines.push(`Write-only functions:       ${totals.writeOnlyFunctions}`);
  lines.push(`Read/write functions:       ${totals.readWriteFunctions}`);
  lines.push('');

  lines.push('Accesses by opcode');
  lines.push('-------------------');
  const opcodes = Object.keys(totals.byOpcode);
  if (opcodes.length === 0) {
    lines.push('  (none)');
  } else {
    for (const opcode of opcodes) {
      lines.push(`  ${opcode}: ${totals.byOpcode[opcode]}`);
    }
  }
  lines.push('');

  lines.push('Accesses by width');
  lines.push('-----------------');
  const widths = Object.keys(totals.byWidth);
  if (widths.length === 0) {
    lines.push('  (none)');
  } else {
    for (const width of widths) {
      lines.push(`  ${width}: ${totals.byWidth[width]}`);
    }
  }
  lines.push('');

  lines.push('Top functions by access count');
  lines.push('-----------------------------');
  if (report.topFunctionsByAccessCount.length === 0) {
    lines.push('  (none)');
  } else {
    for (const fn of report.topFunctionsByAccessCount.slice(0, 10)) {
      lines.push(`  [${fn.functionIndex}] ${fn.functionName}: ${fn.count}`);
    }
  }
  lines.push('');

  lines.push('Most reused static offsets');
  lines.push('---------------------------');
  if (report.frequentlyUsedOffsets.length === 0) {
    lines.push('  (none)');
  } else {
    for (const usage of report.frequentlyUsedOffsets.slice(0, 10)) {
      lines.push(`  offset ${usage.offset}: ${usage.count} access(es)`);
    }
  }
  lines.push('');

  lines.push('Per-function statistics');
  lines.push('-----------------------');
  for (const fn of report.functions) {
    lines.push(
      `  [${fn.functionIndex}] ${fn.functionName}: loads=${fn.totalLoads} stores=${fn.totalStores} ` +
        `ratio=${fn.readWriteRatio} widths=[${fn.uniqueWidths.join(', ')}] pattern=${fn.accessPattern}`,
    );
  }

  return lines.join('\n');
}

/** Renders the access-level inventory as CSV. */
export function memoryAccessToCsv(report: MemoryAccessReport): string {
  const header = [
    'function_index',
    'function_name',
    'block_index',
    'instruction_index',
    'ordinal',
    'opcode',
    'access_type',
    'value_type',
    'width_bits',
    'width_label',
    'alignment',
    'alignment_bytes',
    'static_offset',
    'memory_index',
    'address_type',
    'base_address',
    'effective_address',
  ].join(',');

  const rows = report.accesses.map((access) =>
    [
      access.functionIndex,
      access.functionName,
      access.blockIndex,
      access.instructionIndex,
      access.ordinal,
      access.opcode,
      access.accessType,
      access.valueType,
      access.widthBits,
      access.widthLabel,
      access.alignment,
      access.alignmentBytes,
      access.staticOffset,
      access.memoryIndex,
      access.addressType,
      access.baseAddress ?? '',
      access.effectiveAddress ?? '',
    ].join(','),
  );

  return [header, ...rows].join('\n');
}

/** Renders a human-readable comparison of two memory-access inventories. */
export function formatMemoryAccessComparison(comparison: MemoryAccessComparison): string {
  const lines: string[] = [];
  lines.push('WASM memory access comparison');
  lines.push('=============================');
  lines.push(`Old artifact: ${comparison.oldFile}`);
  lines.push(`New artifact: ${comparison.newFile}`);
  lines.push('');
  lines.push(
    `Accesses (old/new):        ${comparison.summary.oldAccessCount}/${comparison.summary.newAccessCount}`,
  );
  lines.push(`Added access sites:         ${comparison.summary.added}`);
  lines.push(`Removed access sites:       ${comparison.summary.removed}`);
  lines.push(`Changed load/store:         ${comparison.summary.changedAccessType}`);
  lines.push(`Changed access width:       ${comparison.summary.changedWidth}`);
  lines.push(`Changed static offset:      ${comparison.summary.changedStaticOffset}`);
  lines.push(`Functions with new access:  ${comparison.summary.functionsWithNewAccess}`);
  lines.push(`Functions without access:   ${comparison.summary.functionsWithoutAccess}`);

  if (comparison.addedAccesses.length > 0) {
    lines.push('');
    lines.push('Added access sites');
    lines.push('-------------------');
    for (const access of comparison.addedAccesses) {
      lines.push(
        `  [${access.functionIndex}] ${access.functionName} @${access.instructionIndex}: ` +
          `${access.opcode} offset=${access.staticOffset}`,
      );
    }
  }

  if (comparison.removedAccesses.length > 0) {
    lines.push('');
    lines.push('Removed access sites');
    lines.push('---------------------');
    for (const access of comparison.removedAccesses) {
      lines.push(
        `  [${access.functionIndex}] ${access.functionName} @${access.instructionIndex}: ` +
          `${access.opcode} offset=${access.staticOffset}`,
      );
    }
  }

  return lines.join('\n');
}

export { WasmParseError };
