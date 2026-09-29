import { readWasmModule } from './wasm-parser';

export interface MemoryAccess {
  functionIndex: number;
  basicBlock: number;
  instructionIndex: number;
  opcode: string;
  accessWidth: number;
  alignment: number;
  staticOffset: number | null;
  memoryIndex: number | null;
  isLoad: boolean;
  isStore: boolean;
}

export interface FunctionMemoryStats {
  functionIndex: number;
  totalLoads: number;
  totalStores: number;
  totalAccesses: number;
  readWriteRatio: number;
  uniqueAccessWidths: Set<number>;
  uniqueStaticOffsets: Set<number | null>;
  maxStaticOffset: number | null;
  isReadOnly: boolean;
  isWriteOnly: boolean;
}

export interface ModuleMemoryStats {
  totalFunctions: number;
  totalLoads: number;
  totalStores: number;
  totalAccesses: number;
  overallReadWriteRatio: number;
  functionsWithHighestAccessCount: number[];
  functionsWithHighestReadWriteRatio: number[];
  frequentStaticOffsets: { offset: number | null; count: number }[];
  accessByOpcodeAndWidth: { [key: string]: number };
}

export interface MemoryAccessAnalysis {
  moduleName: string;
  accesses: MemoryAccess[];
  functionStats: FunctionMemoryStats[];
  moduleStats: ModuleMemoryStats;
}

export function analyzeWasmMemory(wasmBuffer: Buffer): MemoryAccessAnalysis {
  const module = readWasmModule(wasmBuffer);
  const accesses: MemoryAccess[] = [];
  const functionStatsMap = new Map<number, FunctionMemoryStats>();

  // Initialize function stats
  for (let i = 0; i < module.functions.length; i++) {
    functionStatsMap.set(i, {
      functionIndex: i,
      totalLoads: 0,
      totalStores: 0,
      totalAccesses: 0,
      readWriteRatio: 0,
      uniqueAccessWidths: new Set(),
      uniqueStaticOffsets: new Set(),
      maxStaticOffset: null,
      isReadOnly: true,
      isWriteOnly: true
    });
  }

  // Process each function body
  for (let funcIndex = 0; funcIndex < module.functions.length; funcIndex++) {
    const func = module.functions[funcIndex];
    if (!func.body) continue;

    let basicBlock = 0;
    for (let instrIndex = 0; instrIndex < func.body.length; instrIndex++) {
      const instr = func.body[instrIndex];

      // Check for memory load instructions
      if (isMemoryLoadOpcode(instr.opcode)) {
        const access = createMemoryAccess(
          funcIndex, basicBlock, instrIndex, instr, true, false
        );
        if (access) {
          accesses.push(access);
          updateFunctionStats(functionStatsMap, funcIndex, access);
        }
      }
      // Check for memory store instructions
      else if (isMemoryStoreOpcode(instr.opcode)) {
        const access = createMemoryAccess(
          funcIndex, basicBlock, instrIndex, instr, false, true
        );
        if (access) {
          accesses.push(access);
          updateFunctionStats(functionStatsMap, funcIndex, access);
        }
      }

      // Basic block detection would be more sophisticated in a real implementation
      if (isControlFlowOpcode(instr.opcode)) {
        basicBlock++;
      }
    }
  }

  // Calculate derived statistics
  const functionStats = Array.from(functionStatsMap.values()).map(stats => {
    stats.readWriteRatio = stats.totalLoads / (stats.totalStores || 1);
    stats.isReadOnly = stats.totalStores === 0 && stats.totalLoads > 0;
    stats.isWriteOnly = stats.totalLoads === 0 && stats.totalStores > 0;
    return stats;
  });

  const moduleStats = calculateModuleStats(functionStats, accesses);

  return {
    moduleName: module.name || 'unnamed',
    accesses,
    functionStats,
    moduleStats
  };
}

function isMemoryLoadOpcode(opcode: string): boolean {
  const loadOpcodes = [
    'i32.load', 'i64.load', 'f32.load', 'f64.load',
    'i32.load8_s', 'i32.load8_u', 'i32.load16_s', 'i32.load16_u',
    'i64.load8_s', 'i64.load8_u', 'i64.load16_s', 'i64.load16_u', 'i64.load32_s', 'i64.load32_u'
  ];
  return loadOpcodes.includes(opcode);
}

function isMemoryStoreOpcode(opcode: string): boolean {
  const storeOpcodes = [
    'i32.store', 'i64.store', 'f32.store', 'f64.store',
    'i32.store8', 'i32.store16',
    'i64.store8', 'i64.store16', 'i64.store32'
  ];
  return storeOpcodes.includes(opcode);
}

function isControlFlowOpcode(opcode: string): boolean {
  const controlOpcodes = ['block', 'loop', 'if', 'else', 'end', 'br', 'br_if', 'br_table', 'return'];
  return controlOpcodes.includes(opcode);
}

function createMemoryAccess(
  funcIndex: number,
  basicBlock: number,
  instrIndex: number,
  instr: any,
  isLoad: boolean,
  isStore: boolean
): MemoryAccess | null {
  const opcode = instr.opcode;
  const args = instr.args || [];

  // Extract memory access parameters
  let accessWidth = 0;
  let alignment = 0;
  let staticOffset: number | null = null;
  let memoryIndex: number | null = null;

  // Determine access width based on opcode
  if (opcode.includes('i32') || opcode.includes('f32')) {
    accessWidth = 4;
  } else if (opcode.includes('i64') || opcode.includes('f64')) {
    accessWidth = 8;
  } else if (opcode.includes('16')) {
    accessWidth = 2;
  } else if (opcode.includes('8')) {
    accessWidth = 1;
  } else if (opcode.includes('32')) {
    accessWidth = 4;
  }

  // Extract alignment (default to access width if not specified)
  if (args.length > 0 && typeof args[0] === 'number') {
    alignment = args[0];
  } else {
    alignment = accessWidth;
  }

  // Extract offset (second argument for load/store)
  if (args.length > 1 && typeof args[1] === 'number') {
    staticOffset = args[1];
  }

  // Memory index is usually 0 for most WASM modules
  memoryIndex = 0;

  return {
    functionIndex: funcIndex,
    basicBlock,
    instructionIndex: instrIndex,
    opcode,
    accessWidth,
    alignment,
    staticOffset,
    memoryIndex,
    isLoad,
    isStore
  };
}

function updateFunctionStats(
  statsMap: Map<number, FunctionMemoryStats>,
  funcIndex: number,
  access: MemoryAccess
) {
  const stats = statsMap.get(funcIndex);
  if (!stats) return;

  if (access.isLoad) {
    stats.totalLoads++;
    stats.isWriteOnly = false;
  }
  if (access.isStore) {
    stats.totalStores++;
    stats.isReadOnly = false;
  }

  stats.totalAccesses++;
  stats.uniqueAccessWidths.add(access.accessWidth);

  if (access.staticOffset !== null) {
    stats.uniqueStaticOffsets.add(access.staticOffset);
    if (stats.maxStaticOffset === null || access.staticOffset > stats.maxStaticOffset) {
      stats.maxStaticOffset = access.staticOffset;
    }
  }
}

function calculateModuleStats(
  functionStats: FunctionMemoryStats[],
  accesses: MemoryAccess[]
): ModuleMemoryStats {
  const totalLoads = functionStats.reduce((sum, stats) => sum + stats.totalLoads, 0);
  const totalStores = functionStats.reduce((sum, stats) => sum + stats.totalStores, 0);
  const totalAccesses = totalLoads + totalStores;

  // Calculate overall read/write ratio
  const overallReadWriteRatio = totalLoads / (totalStores || 1);

  // Find functions with highest access count
  const sortedByAccessCount = [...functionStats]
    .sort((a, b) => b.totalAccesses - a.totalAccesses);
  const maxAccessCount = sortedByAccessCount[0]?.totalAccesses || 0;
  const functionsWithHighestAccessCount = sortedByAccessCount
    .filter(stats => stats.totalAccesses === maxAccessCount)
    .map(stats => stats.functionIndex);

  // Find functions with highest read/write ratio
  const sortedByRatio = [...functionStats]
    .sort((a, b) => b.readWriteRatio - a.readWriteRatio);
  const maxRatio = sortedByRatio[0]?.readWriteRatio || 0;
  const functionsWithHighestReadWriteRatio = sortedByRatio
    .filter(stats => stats.readWriteRatio === maxRatio)
    .map(stats => stats.functionIndex);

  // Count frequent static offsets
  const offsetCounts = new Map<number | null, number>();
  for (const access of accesses) {
    if (access.staticOffset !== null) {
      offsetCounts.set(access.staticOffset, (offsetCounts.get(access.staticOffset) || 0) + 1);
    }
  }
  const frequentStaticOffsets = Array.from(offsetCounts.entries())
    .map(([offset, count]) => ({ offset, count }))
    .sort((a, b) => b.count - a.count);

  // Group accesses by opcode and width
  const accessByOpcodeAndWidth: { [key: string]: number } = {};
  for (const access of accesses) {
    const key = `${access.opcode}:${access.accessWidth}`;
    accessByOpcodeAndWidth[key] = (accessByOpcodeAndWidth[key] || 0) + 1;
  }

  return {
    totalFunctions: functionStats.length,
    totalLoads,
    totalStores,
    totalAccesses,
    overallReadWriteRatio,
    functionsWithHighestAccessCount,
    functionsWithHighestReadWriteRatio,
    frequentStaticOffsets,
    accessByOpcodeAndWidth
  };
}