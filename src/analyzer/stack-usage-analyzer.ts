/**
 * WASM Stack Usage Analyzer
 * Calculates static stack metrics for WASM functions
 */

export interface StackMetrics {
  functionIndex: number;
  functionName: string;
  minStackDepth: number;
  maxStackDepth: number;
  finalStackDepth: number;
  stackEffectOperations: number;
  analysisStatus: 'exact' | 'estimated' | 'partial' | 'failed';
  unsupportedInstructions: string[];
}

export interface StackComparison {
  functionIndex: number;
  oldMaxDepth: number;
  newMaxDepth: number;
  change: number;
  changeType: 'increased' | 'decreased' | 'unchanged';
}

export class StackUsageAnalyzer {
  private wasmModule: any;
  private importCount: number = 0;
  private stackMetrics: Map<number, StackMetrics> = new Map();

  // Stack effect rules for common WASM instructions
  private static readonly STACK_EFFECTS: { [key: string]: number } = {
    // Constants
    'i32.const': 1,
    'i64.const': 1,
    'f32.const': 1,
    'f64.const': 1,
    
    // Arithmetic (binary ops: pop 2, push 1)
    'i32.add': -1, 'i32.sub': -1, 'i32.mul': -1, 'i32.div_s': -1, 'i32.div_u': -1,
    'i32.rem_s': -1, 'i32.rem_u': -1, 'i32.and': -1, 'i32.or': -1, 'i32.xor': -1,
    'i32.shl': -1, 'i32.shr_s': -1, 'i32.shr_u': -1, 'i32.rotl': -1, 'i32.rotr': -1,
    'i64.add': -1, 'i64.sub': -1, 'i64.mul': -1, 'i64.div_s': -1, 'i64.div_u': -1,
    'i64.rem_s': -1, 'i64.rem_u': -1, 'i64.and': -1, 'i64.or': -1, 'i64.xor': -1,
    'i64.shl': -1, 'i64.shr_s': -1, 'i64.shr_u': -1, 'i64.rotl': -1, 'i64.rotr': -1,
    'f32.add': -1, 'f32.sub': -1, 'f32.mul': -1, 'f32.div': -1,
    'f32.min': -1, 'f32.max': -1, 'f32.copysign': -1,
    'f64.add': -1, 'f64.sub': -1, 'f64.mul': -1, 'f64.div': -1,
    'f64.min': -1, 'f64.max': -1, 'f64.copysign': -1,
    
    // Comparison (binary ops: pop 2, push 1)
    'i32.eq': -1, 'i32.ne': -1, 'i32.lt_s': -1, 'i32.lt_u': -1,
    'i32.gt_s': -1, 'i32.gt_u': -1, 'i32.le_s': -1, 'i32.le_u': -1,
    'i32.ge_s': -1, 'i32.ge_u': -1,
    'i64.eq': -1, 'i64.ne': -1, 'i64.lt_s': -1, 'i64.lt_u': -1,
    'i64.gt_s': -1, 'i64.gt_u': -1, 'i64.le_s': -1, 'i64.le_u': -1,
    'i64.ge_s': -1, 'i64.ge_u': -1,
    'f32.eq': -1, 'f32.ne': -1, 'f32.lt': -1, 'f32.gt': -1, 'f32.le': -1, 'f32.ge': -1,
    'f64.eq': -1, 'f64.ne': -1, 'f64.lt': -1, 'f64.gt': -1, 'f64.le': -1, 'f64.ge': -1,
    
    // Unary ops (pop 1, push 1)
    'i32.eqz': 0, 'i32.clz': 0, 'i32.ctz': 0, 'i32.popcnt': 0,
    'i64.eqz': 0, 'i64.clz': 0, 'i64.ctz': 0, 'i64.popcnt': 0,
    'f32.abs': 0, 'f32.neg': 0, 'f32.ceil': 0, 'f32.floor': 0,
    'f32.trunc': 0, 'f32.nearest': 0, 'f32.sqrt': 0,
    'f64.abs': 0, 'f64.neg': 0, 'f64.ceil': 0, 'f64.floor': 0,
    'f64.trunc': 0, 'f64.nearest': 0, 'f64.sqrt': 0,
    
    // Conversions (pop 1, push 1)
    'i32.wrap_i64': 0, 'i64.extend_i32_s': 0, 'i64.extend_i32_u': 0,
    'f32.convert_i32_s': 0, 'f32.convert_i32_u': 0,
    'f32.convert_i64_s': 0, 'f32.convert_i64_u': 0,
    'f32.demote_f64': 0, 'f64.convert_i32_s': 0, 'f64.convert_i32_u': 0,
    'f64.convert_i64_s': 0, 'f64.convert_i64_u': 0, 'f64.promote_f32': 0,
    'i32.reinterpret_f32': 0, 'i64.reinterpret_f64': 0,
    'f32.reinterpret_i32': 0, 'f64.reinterpret_i64': 0,
    'i32.trunc_f32_s': 0, 'i32.trunc_f32_u': 0,
    'i32.trunc_f64_s': 0, 'i32.trunc_f64_u': 0,
    'i64.trunc_f32_s': 0, 'i64.trunc_f32_u': 0,
    'i64.trunc_f64_s': 0, 'i64.trunc_f64_u': 0,
    
    // Memory (load: pop 1 address, push 1 value; store: pop 2)
    'i32.load': 0, 'i64.load': 0, 'f32.load': 0, 'f64.load': 0,
    'i32.load8_s': 0, 'i32.load8_u': 0, 'i32.load16_s': 0, 'i32.load16_u': 0,
    'i64.load8_s': 0, 'i64.load8_u': 0, 'i64.load16_s': 0, 'i64.load16_u': 0,
    'i64.load32_s': 0, 'i64.load32_u': 0,
    'i32.store': -2, 'i64.store': -2, 'f32.store': -2, 'f64.store': -2,
    'i32.store8': -2, 'i32.store16': -2,
    'i64.store8': -2, 'i64.store16': -2, 'i64.store32': -2,
    'memory.size': 1, 'memory.grow': 0,
    
    // Variables
    'local.get': 1, 'local.set': -1, 'local.tee': 0,
    'global.get': 1, 'global.set': -1,
    
    // Control flow
    'drop': -1, 'select': -2,
    'nop': 0, 'unreachable': 0,
    
    // Table
    'table.get': 0, 'table.set': -2
  };

  constructor(wasmModule: any) {
    this.wasmModule = wasmModule;
    this.countImports();
    this.analyzeStackUsage();
  }

  private countImports(): void {
    if (this.wasmModule.imports) {
      this.importCount = this.wasmModule.imports.filter(
        (imp: any) => imp.kind === 'function'
      ).length;
    }
  }

  getMetrics(): StackMetrics[] {
    return Array.from(this.stackMetrics.values()).sort(
      (a, b) => a.functionIndex - b.functionIndex
    );
  }

  getHighestStackUsage(): StackMetrics | null {
    const metrics = this.getMetrics();
    if (metrics.length === 0) return null;

    return metrics.reduce((max, current) => 
      current.maxStackDepth > max.maxStackDepth ? current : max
    );
  }

  compareStackUsage(otherModule: any): StackComparison[] {
    const otherAnalyzer = new StackUsageAnalyzer(otherModule);
    const otherMetrics = new Map(
      otherAnalyzer.getMetrics().map(m => [m.functionIndex, m])
    );

    const comparisons: StackComparison[] = [];

    this.stackMetrics.forEach((currentMetric, funcIndex) => {
      const otherMetric = otherMetrics.get(funcIndex);
      if (otherMetric) {
        const change = currentMetric.maxStackDepth - otherMetric.maxStackDepth;
        comparisons.push({
          functionIndex: funcIndex,
          oldMaxDepth: otherMetric.maxStackDepth,
          newMaxDepth: currentMetric.maxStackDepth,
          change,
          changeType: change > 0 ? 'increased' : change < 0 ? 'decreased' : 'unchanged'
        });
      }
    });

    return comparisons.sort((a, b) => a.functionIndex - b.functionIndex);
  }

  private analyzeStackUsage(): void {
    if (!this.wasmModule.functions) return;

    this.wasmModule.functions.forEach((func: any, idx: number) => {
      const funcIndex = this.importCount + idx;
      const metrics = this.calculateStackMetrics(func, funcIndex);
      this.stackMetrics.set(funcIndex, metrics);
    });
  }

  private calculateStackMetrics(func: any, funcIndex: number): StackMetrics {
    const unsupportedInstructions: string[] = [];
    let currentDepth = 0;
    let minDepth = 0;
    let maxDepth = 0;
    let stackEffectOps = 0;
    let analysisStatus: StackMetrics['analysisStatus'] = 'exact';

    if (!func.body || !func.body.instructions) {
      return {
        functionIndex: funcIndex,
        functionName: func.name || `func_${funcIndex}`,
        minStackDepth: 0,
        maxStackDepth: 0,
        finalStackDepth: 0,
        stackEffectOperations: 0,
        analysisStatus: 'exact',
        unsupportedInstructions: []
      };
    }

    func.body.instructions.forEach((instr: any) => {
      const instrName = instr.name || '';

      // Check for call instructions (need special handling)
      if (instrName === 'call') {
        // Call pops arguments and pushes results
        // For simplicity, assume it has net zero effect (needs function signature info for exact)
        analysisStatus = 'estimated';
        stackEffectOps++;
      } else if (instrName === 'call_indirect') {
        analysisStatus = 'estimated';
        currentDepth--; // At least pops the table index
        stackEffectOps++;
      } else if (instrName.startsWith('block') || instrName.startsWith('loop') || 
                 instrName.startsWith('if')) {
        // Structured control flow - simplified handling
        stackEffectOps++;
      } else if (instrName === 'br' || instrName === 'br_if' || instrName === 'br_table') {
        // Branch instructions
        if (instrName === 'br_if') {
          currentDepth--; // Pop condition
        }
        stackEffectOps++;
      } else if (instrName === 'return') {
        // Return pops return values but we can't know exactly how many without type info
        analysisStatus = 'estimated';
      } else {
        const effect = StackUsageAnalyzer.STACK_EFFECTS[instrName];
        
        if (effect !== undefined) {
          currentDepth += effect;
          if (effect !== 0) stackEffectOps++;
        } else if (instrName && instrName !== 'end' && instrName !== 'else') {
          // Unknown instruction
          if (!unsupportedInstructions.includes(instrName)) {
            unsupportedInstructions.push(instrName);
          }
          analysisStatus = unsupportedInstructions.length > 3 ? 'partial' : 'estimated';
        }
      }

      // Track min/max
      minDepth = Math.min(minDepth, currentDepth);
      maxDepth = Math.max(maxDepth, currentDepth);
    });

    if (unsupportedInstructions.length > 10) {
      analysisStatus = 'failed';
    }

    return {
      functionIndex: funcIndex,
      functionName: func.name || `func_${funcIndex}`,
      minStackDepth: Math.max(0, minDepth),
      maxStackDepth: Math.max(0, maxDepth),
      finalStackDepth: Math.max(0, currentDepth),
      stackEffectOperations: stackEffectOps,
      analysisStatus,
      unsupportedInstructions: unsupportedInstructions.sort()
    };
  }

  getStatistics() {
    const metrics = this.getMetrics();
    
    const totalFunctions = metrics.length;
    const avgMaxDepth = metrics.length > 0
      ? metrics.reduce((sum, m) => sum + m.maxStackDepth, 0) / metrics.length
      : 0;
    
    const statusCounts = {
      exact: metrics.filter(m => m.analysisStatus === 'exact').length,
      estimated: metrics.filter(m => m.analysisStatus === 'estimated').length,
      partial: metrics.filter(m => m.analysisStatus === 'partial').length,
      failed: metrics.filter(m => m.analysisStatus === 'failed').length
    };

    const highest = this.getHighestStackUsage();

    return {
      totalFunctions,
      averageMaxStackDepth: Math.round(avgMaxDepth * 100) / 100,
      highestStackUsage: highest ? {
        functionIndex: highest.functionIndex,
        functionName: highest.functionName,
        maxDepth: highest.maxStackDepth
      } : null,
      analysisStatusCounts: statusCounts
    };
  }
}
