/**
 * WASM Function Dependency Analyzer
 * Analyzes dependencies of each function on other module resources
 */

export interface FunctionDependencies {
  functionIndex: number;
  functionName: string;
  directFunctionCalls: number[];
  importedFunctionCalls: Array<{
    index: number;
    module: string;
    name: string;
  }>;
  globalReferences: number[];
  memoryOperations: {
    loads: number;
    stores: number;
    sizes: number;
    grows: number;
  };
  tableReferences: number[];
  totalDependencyCount: number;
}

export interface TransitiveDependencies {
  functionIndex: number;
  allReachableFunctions: number[];
  allImportedFunctions: number[];
  allGlobals: number[];
  depth: number;
}

export interface DependencyComparison {
  addedDependencies: {
    functionIndex: number;
    added: {
      functions: number[];
      imports: number[];
      globals: number[];
    };
  }[];
  removedDependencies: {
    functionIndex: number;
    removed: {
      functions: number[];
      imports: number[];
      globals: number[];
    };
  }[];
  unchangedFunctions: number[];
}

export class FunctionDependencyAnalyzer {
  private wasmModule: any;
  private importCount: number = 0;
  private functionDependencies: Map<number, FunctionDependencies> = new Map();

  constructor(wasmModule: any) {
    this.wasmModule = wasmModule;
    this.countImports();
    this.analyzeDependencies();
  }

  private countImports(): void {
    if (this.wasmModule.imports) {
      this.importCount = this.wasmModule.imports.filter(
        (imp: any) => imp.kind === 'function'
      ).length;
    }
  }

  getDependencies(): FunctionDependencies[] {
    return Array.from(this.functionDependencies.values()).sort(
      (a, b) => a.functionIndex - b.functionIndex
    );
  }

  getTransitiveDependencies(functionIndex: number): TransitiveDependencies {
    const visited = new Set<number>();
    const allFunctions: number[] = [];
    const allImports: number[] = [];
    const allGlobals = new Set<number>();

    const traverse = (funcIndex: number, depth: number): number => {
      if (visited.has(funcIndex)) return depth;
      visited.add(funcIndex);

      const deps = this.functionDependencies.get(funcIndex);
      if (!deps) return depth;

      allFunctions.push(funcIndex);
      
      deps.importedFunctionCalls.forEach(imp => {
        if (!allImports.includes(imp.index)) {
          allImports.push(imp.index);
        }
      });

      deps.globalReferences.forEach(g => allGlobals.add(g));

      let maxDepth = depth;
      deps.directFunctionCalls.forEach(targetIndex => {
        const childDepth = traverse(targetIndex, depth + 1);
        maxDepth = Math.max(maxDepth, childDepth);
      });

      return maxDepth;
    };

    const maxDepth = traverse(functionIndex, 0);

    return {
      functionIndex,
      allReachableFunctions: allFunctions.sort((a, b) => a - b),
      allImportedFunctions: allImports.sort((a, b) => a - b),
      allGlobals: Array.from(allGlobals).sort((a, b) => a - b),
      depth: maxDepth
    };
  }

  compareDependencies(otherModule: any): DependencyComparison {
    const otherAnalyzer = new FunctionDependencyAnalyzer(otherModule);
    const otherDeps = new Map(
      otherAnalyzer.getDependencies().map(d => [d.functionIndex, d])
    );

    const added: DependencyComparison['addedDependencies'] = [];
    const removed: DependencyComparison['removedDependencies'] = [];
    const unchanged: number[] = [];

    this.functionDependencies.forEach((currentDep, funcIndex) => {
      const otherDep = otherDeps.get(funcIndex);

      if (!otherDep) {
        // Function exists in current but not in other
        removed.push({
          functionIndex: funcIndex,
          removed: {
            functions: currentDep.directFunctionCalls,
            imports: currentDep.importedFunctionCalls.map(i => i.index),
            globals: currentDep.globalReferences
          }
        });
      } else {
        const addedFuncs = currentDep.directFunctionCalls.filter(
          f => !otherDep.directFunctionCalls.includes(f)
        );
        const removedFuncs = otherDep.directFunctionCalls.filter(
          f => !currentDep.directFunctionCalls.includes(f)
        );
        const addedImports = currentDep.importedFunctionCalls.filter(
          i => !otherDep.importedFunctionCalls.some(oi => oi.index === i.index)
        ).map(i => i.index);
        const removedImports = otherDep.importedFunctionCalls.filter(
          i => !currentDep.importedFunctionCalls.some(ci => ci.index === i.index)
        ).map(i => i.index);
        const addedGlobals = currentDep.globalReferences.filter(
          g => !otherDep.globalReferences.includes(g)
        );
        const removedGlobals = otherDep.globalReferences.filter(
          g => !currentDep.globalReferences.includes(g)
        );

        if (addedFuncs.length > 0 || addedImports.length > 0 || addedGlobals.length > 0) {
          added.push({
            functionIndex: funcIndex,
            added: {
              functions: addedFuncs,
              imports: addedImports,
              globals: addedGlobals
            }
          });
        }

        if (removedFuncs.length > 0 || removedImports.length > 0 || removedGlobals.length > 0) {
          removed.push({
            functionIndex: funcIndex,
            removed: {
              functions: removedFuncs,
              imports: removedImports,
              globals: removedGlobals
            }
          });
        }

        if (addedFuncs.length === 0 && removedFuncs.length === 0 &&
            addedImports.length === 0 && removedImports.length === 0 &&
            addedGlobals.length === 0 && removedGlobals.length === 0) {
          unchanged.push(funcIndex);
        }
      }
    });

    // Check for new functions in other module
    otherDeps.forEach((_, funcIndex) => {
      if (!this.functionDependencies.has(funcIndex)) {
        const otherDep = otherDeps.get(funcIndex)!;
        added.push({
          functionIndex: funcIndex,
          added: {
            functions: otherDep.directFunctionCalls,
            imports: otherDep.importedFunctionCalls.map(i => i.index),
            globals: otherDep.globalReferences
          }
        });
      }
    });

    return {
      addedDependencies: added.sort((a, b) => a.functionIndex - b.functionIndex),
      removedDependencies: removed.sort((a, b) => a.functionIndex - b.functionIndex),
      unchangedFunctions: unchanged.sort((a, b) => a - b)
    };
  }

  private analyzeDependencies(): void {
    if (!this.wasmModule.functions) return;

    this.wasmModule.functions.forEach((func: any, idx: number) => {
      const funcIndex = this.importCount + idx;
      const deps = this.extractDependencies(func, funcIndex);
      this.functionDependencies.set(funcIndex, deps);
    });
  }

  private extractDependencies(func: any, funcIndex: number): FunctionDependencies {
    const directFunctionCalls: number[] = [];
    const importedFunctionCalls: Array<{ index: number; module: string; name: string }> = [];
    const globalReferences: number[] = [];
    const memoryOps = {
      loads: 0,
      stores: 0,
      sizes: 0,
      grows: 0
    };
    const tableReferences: number[] = [];

    if (!func.body || !func.body.instructions) {
      return {
        functionIndex: funcIndex,
        functionName: func.name || `func_${funcIndex}`,
        directFunctionCalls: [],
        importedFunctionCalls: [],
        globalReferences: [],
        memoryOperations: memoryOps,
        tableReferences: [],
        totalDependencyCount: 0
      };
    }

    func.body.instructions.forEach((instr: any) => {
      // Function calls
      if (instr.name === 'call' && typeof instr.index === 'number') {
        const targetIndex = instr.index;
        
        if (targetIndex < this.importCount) {
          // Imported function
          const importDef = this.getImportDefinition(targetIndex);
          if (importDef && !importedFunctionCalls.some(i => i.index === targetIndex)) {
            importedFunctionCalls.push({
              index: targetIndex,
              module: importDef.module,
              name: importDef.name
            });
          }
        } else {
          // Local function
          if (!directFunctionCalls.includes(targetIndex)) {
            directFunctionCalls.push(targetIndex);
          }
        }
      }

      // Global references
      if ((instr.name === 'global.get' || instr.name === 'global.set') &&
          typeof instr.index === 'number') {
        if (!globalReferences.includes(instr.index)) {
          globalReferences.push(instr.index);
        }
      }

      // Memory operations
      if (instr.name && instr.name.includes('.load')) {
        memoryOps.loads++;
      } else if (instr.name && instr.name.includes('.store')) {
        memoryOps.stores++;
      } else if (instr.name === 'memory.size') {
        memoryOps.sizes++;
      } else if (instr.name === 'memory.grow') {
        memoryOps.grows++;
      }

      // Table references
      if (instr.name === 'table.get' || instr.name === 'table.set') {
        if (typeof instr.index === 'number' && !tableReferences.includes(instr.index)) {
          tableReferences.push(instr.index);
        }
      }
    });

    // Sort for determinism
    directFunctionCalls.sort((a, b) => a - b);
    importedFunctionCalls.sort((a, b) => a.index - b.index);
    globalReferences.sort((a, b) => a - b);
    tableReferences.sort((a, b) => a - b);

    const totalDependencyCount = 
      directFunctionCalls.length + 
      importedFunctionCalls.length + 
      globalReferences.length +
      (memoryOps.loads + memoryOps.stores + memoryOps.sizes + memoryOps.grows > 0 ? 1 : 0) +
      tableReferences.length;

    return {
      functionIndex: funcIndex,
      functionName: func.name || `func_${funcIndex}`,
      directFunctionCalls,
      importedFunctionCalls,
      globalReferences,
      memoryOperations: memoryOps,
      tableReferences,
      totalDependencyCount
    };
  }

  private getImportDefinition(index: number): { module: string; name: string } | null {
    if (!this.wasmModule.imports) return null;

    let funcImportIndex = 0;
    for (const imp of this.wasmModule.imports) {
      if (imp.kind === 'function') {
        if (funcImportIndex === index) {
          return { module: imp.module, name: imp.name };
        }
        funcImportIndex++;
      }
    }

    return null;
  }
}
