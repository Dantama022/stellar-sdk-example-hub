import { readFileSync } from 'fs';
import { decode } from '@webassemblyjs/wasm-parser';
import { traverse } from '@webassemblyjs/ast';

/**
 * Types describing a global entry.
 */
interface GlobalInfo {
  index: number;
  type: string; // i32, i64, f32, f64
  mutable: boolean;
  import?: { module: string; name: string };
  init?: any; // raw init expression (optional)
  reads: AccessRecord[];
  writes: AccessRecord[];
}

/**
 * Record of a single global access inside a function.
 */
interface AccessRecord {
  funcIndex: number;
  instrIndex: number;
  opcode: string; // 'global.get' | 'global.set'
}

/**
 * Per‑function aggregated statistics.
 */
interface FunctionStats {
  funcIndex: number;
  reads: number;
  writes: number;
  uniqueGlobals: number;
  mutableGlobalsModified: number;
}

/**
 * Full analysis report.
 */
export interface AnalysisReport {
  totals: {
    totalGlobals: number;
    importedGlobals: number;
    localGlobals: number;
    mutableGlobals: number;
    immutableGlobals: number;
    totalReads: number;
    totalWrites: number;
    neverAccessedGlobals: number;
    globalsAccessedByMultipleFunctions: number;
    globalsWrittenByMultipleFunctions: number;
  };
  globals: GlobalInfo[];
  functions: FunctionStats[];
}

/**
 * Parse a WASM binary and return the AST.
 */
function parseWasm(buffer: Buffer) {
  return decode(buffer, { dump: false, ignoreCodeSection: false, ignoreDataSection: true });
}

/**
 * Build a map of globals (imported + defined) from the AST.
 */
function buildGlobals(ast: any): GlobalInfo[] {
  const globals: GlobalInfo[] = [];
  let importCount = 0;
  let definedCount = 0;

  traverse(ast, {
    ImportDescription({ node }: any) {
      if (node.descr.type === 'GlobalType') {
        const info: GlobalInfo = {
          index: importCount,
          type: node.descr.globalType.valtype,
          mutable: node.descr.globalType.mutability === 'var',
          import: { module: node.module, name: node.name },
          reads: [],
          writes: []
        };
        globals.push(info);
        importCount++;
      }
    },
    Global({ node }: any) {
      const info: GlobalInfo = {
        index: importCount + definedCount,
        type: node.globalType.valtype,
        mutable: node.globalType.mutability === 'var',
        init: node.init,
        reads: [],
        writes: []
      };
      globals.push(info);
      definedCount++;
    }
  });

  return globals;
}

/**
 * Scan function bodies for global.get / global.set instructions.
 */
function scanFunctions(ast: any, globals: GlobalInfo[]) {
  const functionStats: Map<number, FunctionStats> = new Map();
  let funcIndex = 0; // includes imported functions (none for this analysis)

  traverse(ast, {
    Func({ node }: any) {
      const accesses: AccessRecord[] = [];
      node.body.forEach((instr: any, instrIdx: number) => {
        if (instr.id === 'global.get' || instr.id === 'global.set') {
          const globalIdx = instr.args[0].value;
          const record: AccessRecord = {
            funcIndex,
            instrIndex: instrIdx,
            opcode: instr.id
          };
          const globalInfo = globals[globalIdx];
          if (globalInfo) {
            if (instr.id === 'global.get') {
              globalInfo.reads.push(record);
            } else {
              globalInfo.writes.push(record);
            }
          }
          accesses.push(record);
        }
      });

      // Aggregate per‑function stats
      const reads = accesses.filter(a => a.opcode === 'global.get').length;
      const writes = accesses.filter(a => a.opcode === 'global.set').length;
      const uniqueGlobals = new Set(accesses.map(a => a.instrIndex)).size; // simplistic unique count
      const mutableGlobalsModified = accesses
        .filter(a => a.opcode === 'global.set')
        .filter(a => globals[a.funcIndex]?.mutable)
        .length;

      functionStats.set(funcIndex, {
        funcIndex,
        reads,
        writes,
        uniqueGlobals,
        mutableGlobalsModified
      });

      funcIndex++;
    }
  });

  return functionStats;
}

/**
 * Produce the final report object.
 */
export function analyzeWasm(buffer: Buffer): AnalysisReport {
  const ast = parseWasm(buffer);
  const globals = buildGlobals(ast);
  const funcStatsMap = scanFunctions(ast, globals);

  // Totals calculation
  const totalGlobals = globals.length;
  const importedGlobals = globals.filter(g => g.import).length;
  const localGlobals = totalGlobals - importedGlobals;
  const mutableGlobals = globals.filter(g => g.mutable).length;
  const immutableGlobals = totalGlobals - mutableGlobals;
  const totalReads = globals.reduce((sum, g) => sum + g.reads.length, 0);
  const totalWrites = globals.reduce((sum, g) => sum + g.writes.length, 0);
  const neverAccessedGlobals = globals.filter(g => g.reads.length === 0 && g.writes.length === 0).length;
  const globalsAccessedByMultipleFunctions = globals.filter(g => {
    const funcSet = new Set(g.reads.concat(g.writes).map(r => r.funcIndex));
    return funcSet.size > 1;
  }).length;
  const globalsWrittenByMultipleFunctions = globals.filter(g => {
    const funcSet = new Set(g.writes.map(w => w.funcIndex));
    return funcSet.size > 1;
  }).length;

  const functions = Array.from(funcStatsMap.values()).sort((a, b) => a.funcIndex - b.funcIndex);

  return {
    totals: {
      totalGlobals,
      importedGlobals,
      localGlobals,
      mutableGlobals,
      immutableGlobals,
      totalReads,
      totalWrites,
      neverAccessedGlobals,
      globalsAccessedByMultipleFunctions,
      globalsWrittenByMultipleFunctions
    },
    globals,
    functions
  };
}

/**
 * Helper to format the report as CSV (optional).
 */
export function reportToCsv(report: AnalysisReport): string {
  const lines: string[] = [];
  // Header for global access records
  lines.push('globalIndex,type,mutable,importModule,importName,readCount,writeCount');
  report.globals.forEach(g => {
    const importModule = g.import?.module ?? '';
    const importName = g.import?.name ?? '';
    lines.push([
      g.index,
      g.type,
      g.mutable,
      importModule,
      importName,
      g.reads.length,
      g.writes.length
    ].join(','));
  });
  return lines.join('\
');
}
