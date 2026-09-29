import {
  SideEffectType,
  SideEffectEvidence,
  FunctionAnalysis,
  AnalysisResult
} from './types';
import { parseWasm, WasmModule, FunctionBody, Instruction } from '@wasm-tool/wasm-parser';

export class WasmAnalyzer {
  private module: WasmModule;
  private functionBodies: Map<string, FunctionBody> = new Map();
  private functionTypes: Map<string, number> = new Map();
  private mutableGlobals: Set<string> = new Set();
  private importedFunctions: Set<string> = new Set();
  private functionCalls: Map<string, Set<string>> = new Map();
  private callGraph: Map<string, Set<string>> = new Map();

  constructor(module: WasmModule) {
    this.module = module;
    this.initialize();
  }

  private initialize(): void {
    // Extract mutable globals
    for (const global of this.module.globals) {
      if (global.mutable) {
        this.mutableGlobals.add(global.name || `global_${global.index}`);
      }
    }

    // Extract imported functions
    for (const imp of this.module.imports) {
      if (imp.kind === 'function') {
        this.importedFunctions.add(imp.name || `import_${imp.index}`);
      }
    }

    // Build function body map and call graph
    for (const func of this.module.functions) {
      if (func.body) {
        const funcName = func.name || `func_${func.index}`;
        this.functionBodies.set(funcName, func.body);
        this.functionTypes.set(funcName, func.typeIndex);
        this.functionCalls.set(funcName, new Set());
        this.callGraph.set(funcName, new Set());
      }
    }

    // Build initial call graph
    this.buildCallGraph();
  }

  private buildCallGraph(): void {
    for (const [funcName, body] of this.functionBodies) {
      const calls = this.extractCalls(body);
      this.functionCalls.set(funcName, calls);
      
      for (const callee of calls) {
        if (this.callGraph.has(callee)) {
          this.callGraph.get(funcName)?.add(callee);
        }
      }
    }
  }

  private extractCalls(body: FunctionBody): Set<string> {
    const calls = new Set<string>();
    const stack: Instruction[] = [...body.code];

    while (stack.length > 0) {
      const instr = stack.pop()!;
      
      if (instr.opcode === 'call') {
        const funcIndex = instr.args[0] as number;
        const funcName = this.module.functions[funcIndex]?.name || `func_${funcIndex}`;
        calls.add(funcName);
      } else if (instr.opcode === 'call_indirect') {
        // Mark as having indirect calls
        calls.add('__indirect__');
      }
    }

    return calls;
  }

  private analyzeFunction(funcName: string): FunctionAnalysis {
    const body = this.functionBodies.get(funcName);
    if (!body) {
      return {
        name: funcName,
        classification: 'unknown',
        evidence: this.createEmptyEvidence(),
        callees: [],
        callers: []
      };
    }

    const evidence: SideEffectEvidence = this.createEmptyEvidence();
    const callees = this.functionCalls.get(funcName) || new Set();
    const callers = this.findCallers(funcName);

    // Analyze instructions
    this.analyzeInstructions(body.code, evidence);

    // Determine classification
    const classification = this.classifyFunction(evidence, callees);

    return {
      name: funcName,
      classification,
      evidence,
      callees: Array.from(callees),
      callers: Array.from(callers)
    };
  }

  private findCallers(funcName: string): Set<string> {
    const callers = new Set<string>();
    for (const [caller, callees] of this.callGraph) {
      if (callees.has(funcName)) {
        callers.add(caller);
      }
    }
    return callers;
  }

  private createEmptyEvidence(): SideEffectEvidence {
    return {
      memoryWrites: false,
      memoryReads: false,
      mutableGlobalWrites: [],
      mutableGlobalReads: [],
      tableMutations: false,
      importedCalls: [],
      indirectCalls: false,
      trappingOps: false,
      transitiveEffects: []
    };
  }

  private analyzeInstructions(instructions: Instruction[], evidence: SideEffectEvidence): void {
    for (const instr of instructions) {
      switch (instr.opcode) {
        case 'i32.store':
        case 'i64.store':
        case 'f32.store':
        case 'f64.store':
        case 'i32.store8':
        case 'i32.store16':
        case 'i64.store8':
        case 'i64.store16':
        case 'i64.store32':
          evidence.memoryWrites = true;
          break;
        case 'i32.load':
        case 'i64.load':
        case 'f32.load':
        case 'f64.load':
        case 'i32.load8_s':
        case 'i32.load8_u':
        case 'i32.load16_s':
        case 'i32.load16_u':
        case 'i64.load8_s':
        case 'i64.load8_u':
        case 'i64.load16_s':
        case 'i64.load16_u':
        case 'i64.load32_s':
        case 'i64.load32_u':
          evidence.memoryReads = true;
          break;
        case 'global.set':
          {
            const globalIndex = instr.args[0] as number;
            const globalName = this.module.globals[globalIndex]?.name || `global_${globalIndex}`;
            if (this.mutableGlobals.has(globalName)) {
              evidence.mutableGlobalWrites.push(globalName);
            }
          }
          break;
        case 'global.get':
          {
            const globalIndex = instr.args[0] as number;
            const globalName = this.module.globals[globalIndex]?.name || `global_${globalIndex}`;
            if (this.mutableGlobals.has(globalName)) {
              evidence.mutableGlobalReads.push(globalName);
            }
          }
          break;
        case 'table.set':
        case 'table.grow':
        case 'table.fill':
        case 'table.copy':
          evidence.tableMutations = true;
          break;
        case 'call':
          {
            const funcIndex = instr.args[0] as number;
            const funcName = this.module.functions[funcIndex]?.name || `func_${funcIndex}`;
            if (this.importedFunctions.has(funcName)) {
              evidence.importedCalls.push(funcName);
            }
          }
          break;
        case 'call_indirect':
          evidence.indirectCalls = true;
          break;
        case 'unreachable':
        case 'br_table':
          evidence.trappingOps = true;
          break;
      }
    }
  }

  private classifyFunction(evidence: SideEffectEvidence, callees: Set<string>): SideEffectType {
    // Check for direct side effects
    if (evidence.memoryWrites || 
        evidence.mutableGlobalWrites.length > 0 || 
        evidence.tableMutations ||
        evidence.indirectCalls) {
      return 'state-mutating';
    }

    // Check for imported calls
    if (evidence.importedCalls.length > 0) {
      return 'externally-dependent';
    }

    // Check for transitive effects
    for (const callee of callees) {
      if (callee === '__indirect__') {
        return 'unknown';
      }
      
      const calleeAnalysis = this.analyzeFunction(callee);
      if (calleeAnalysis.classification !== 'pure' && 
          calleeAnalysis.classification !== 'read-only') {
        evidence.transitiveEffects.push(calleeAnalysis.classification);
      }
    }

    if (evidence.transitiveEffects.some(e => e === 'state-mutating' || e === 'externally-dependent')) {
      return 'effectful';
    }

    if (evidence.transitiveEffects.some(e => e === 'effectful')) {
      return 'effectful';
    }

    // Check for read-only
    if (evidence.memoryReads || 
        evidence.mutableGlobalReads.length > 0 ||
        evidence.transitiveEffects.some(e => e === 'read-only')) {
      return 'read-only';
    }

    // If no side effects found
    return 'pure';
  }

  public analyzeAll(): AnalysisResult {
    const functionNames = Array.from(this.functionBodies.keys());
    const analyses: FunctionAnalysis[] = [];

    // First pass: analyze all functions
    for (const funcName of functionNames) {
      analyses.push(this.analyzeFunction(funcName));
    }

    // Second pass: propagate transitive effects
    let changed = true;
    while (changed) {
      changed = false;
      
      for (const analysis of analyses) {
        const originalClassification = analysis.classification;
        
        // Re-classify based on updated callee information
        const calleeClassifications = analysis.callees
          .map(calleeName => analyses.find(a => a.name === calleeName)?.classification)
          .filter((c): c is SideEffectType => c !== undefined);

        if (calleeClassifications.some(c => c === 'state-mutating' || c === 'externally-dependent')) {
          analysis.classification = 'effectful';
        } else if (calleeClassifications.some(c => c === 'effectful')) {
          analysis.classification = 'effectful';
        } else if (calleeClassifications.some(c => c === 'read-only') && 
                   analysis.classification === 'pure') {
          analysis.classification = 'read-only';
        }

        if (analysis.classification !== originalClassification) {
          changed = true;
        }
      }
    }

    // Calculate summary
    const summary = {
      total: analyses.length,
      pure: analyses.filter(a => a.classification === 'pure').length,
      readOnly: analyses.filter(a => a.classification === 'read-only').length,
      stateMutating: analyses.filter(a => a.classification === 'state-mutating').length,
      externallyDependent: analyses.filter(a => a.classification === 'externally-dependent').length,
      effectful: analyses.filter(a => a.classification === 'effectful').length,
      unknown: analyses.filter(a => a.classification === 'unknown').length,
      transitiveEffectful: analyses.filter(a => 
        a.evidence.transitiveEffects.length > 0 && 
        (a.classification === 'effectful' || a.classification === 'state-mutating' || a.classification === 'externally-dependent')
      ).length
    };

    return { functions: analyses, summary };
  }
}

export async function analyzeWasm(filePath: string): Promise<AnalysisResult> {
  const buffer = await require('fs').promises.readFile(filePath);
  const module = parseWasm(buffer);
  const analyzer = new WasmAnalyzer(module);
  return analyzer.analyzeAll();
}