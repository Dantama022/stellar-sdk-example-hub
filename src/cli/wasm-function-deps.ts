import { Command } from 'commander';
import { readFileSync } from 'fs';
import { parse } from 'wasm-parser';
import { FunctionDependencyAnalyzer, FunctionDependencies } from '../analyzer/function-dependency-analyzer';

export function setupWasmFunctionDepsCommand() {
  const program = new Command('wasm-function-deps')
    .description('Analyze WASM function dependencies on module resources')
    .argument('<wasmFile>', 'Path to WASM file')
    .option('-o, --output <format>', 'Output format (json|text)', 'text')
    .option('-t, --transitive <functionIndex>', 'Show transitive dependencies for function', parseInt)
    .option('-c, --compare <wasmFile>', 'Compare dependencies with another WASM file')
    .action(async (wasmFile: string, options: any) => {
      try {
        const wasmBuffer = readFileSync(wasmFile);
        
        // Validate WASM
        let wasmModule;
        try {
          wasmModule = parse(wasmBuffer);
        } catch (error) {
          console.error('Invalid WASM file:', error instanceof Error ? error.message : 'Unknown error');
          process.exit(1);
        }

        const analyzer = new FunctionDependencyAnalyzer(wasmModule);

        if (options.compare) {
          // Comparison mode
          const compareBuffer = readFileSync(options.compare);
          let compareModule;
          try {
            compareModule = parse(compareBuffer);
          } catch (error) {
            console.error('Invalid comparison WASM file:', error instanceof Error ? error.message : 'Unknown error');
            process.exit(1);
          }

          const comparison = analyzer.compareDependencies(compareModule);
          
          if (options.output === 'json') {
            console.log(JSON.stringify(comparison, null, 2));
          } else {
            console.log(formatComparisonOutput(comparison));
          }
        } else if (options.transitive !== undefined) {
          // Transitive dependency analysis
          const transitive = analyzer.getTransitiveDependencies(options.transitive);
          
          if (options.output === 'json') {
            console.log(JSON.stringify(transitive, null, 2));
          } else {
            console.log(formatTransitiveOutput(transitive));
          }
        } else {
          // Standard dependency analysis
          const dependencies = analyzer.getDependencies();
          
          if (options.output === 'json') {
            console.log(JSON.stringify(dependencies, null, 2));
          } else {
            console.log(formatTextOutput(dependencies));
          }
        }

      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          console.error(`File not found: ${wasmFile}`);
        } else {
          console.error('Analysis failed:', error instanceof Error ? error.message : 'Unknown error');
        }
        process.exit(1);
      }
    });

  return program;
}

function formatTextOutput(dependencies: FunctionDependencies[]): string {
  const lines: string[] = [];
  
  lines.push('=== WASM Function Dependencies Analysis ===\n');
  
  dependencies.forEach(dep => {
    lines.push(`Function [${dep.functionIndex}] ${dep.functionName}:`);
    lines.push(`  Total Dependencies: ${dep.totalDependencyCount}`);
    
    if (dep.directFunctionCalls.length > 0) {
      lines.push(`  Direct Function Calls: [${dep.directFunctionCalls.join(', ')}]`);
    }
    
    if (dep.importedFunctionCalls.length > 0) {
      lines.push('  Imported Function Calls:');
      dep.importedFunctionCalls.forEach(imp => {
        lines.push(`    [${imp.index}] ${imp.module}.${imp.name}`);
      });
    }
    
    if (dep.globalReferences.length > 0) {
      lines.push(`  Global References: [${dep.globalReferences.join(', ')}]`);
    }
    
    const memOps = dep.memoryOperations;
    if (memOps.loads + memOps.stores + memOps.sizes + memOps.grows > 0) {
      lines.push('  Memory Operations:');
      if (memOps.loads > 0) lines.push(`    Loads: ${memOps.loads}`);
      if (memOps.stores > 0) lines.push(`    Stores: ${memOps.stores}`);
      if (memOps.sizes > 0) lines.push(`    Size queries: ${memOps.sizes}`);
      if (memOps.grows > 0) lines.push(`    Grow operations: ${memOps.grows}`);
    }
    
    if (dep.tableReferences.length > 0) {
      lines.push(`  Table References: [${dep.tableReferences.join(', ')}]`);
    }
    
    lines.push('');
  });
  
  return lines.join('\n');
}

function formatTransitiveOutput(transitive: any): string {
  const lines: string[] = [];
  
  lines.push('=== Transitive Dependency Analysis ===\n');
  lines.push(`Function: [${transitive.functionIndex}]`);
  lines.push(`Dependency Depth: ${transitive.depth}`);
  lines.push('');
  
  if (transitive.allReachableFunctions.length > 0) {
    lines.push(`All Reachable Functions (${transitive.allReachableFunctions.length}):`);
    lines.push(`  [${transitive.allReachableFunctions.join(', ')}]`);
    lines.push('');
  }
  
  if (transitive.allImportedFunctions.length > 0) {
    lines.push(`All Imported Functions (${transitive.allImportedFunctions.length}):`);
    lines.push(`  [${transitive.allImportedFunctions.join(', ')}]`);
    lines.push('');
  }
  
  if (transitive.allGlobals.length > 0) {
    lines.push(`All Globals (${transitive.allGlobals.length}):`);
    lines.push(`  [${transitive.allGlobals.join(', ')}]`);
    lines.push('');
  }
  
  return lines.join('\n');
}

function formatComparisonOutput(comparison: any): string {
  const lines: string[] = [];
  
  lines.push('=== Dependency Comparison ===\n');
  
  if (comparison.addedDependencies.length > 0) {
    lines.push('Added Dependencies:');
    comparison.addedDependencies.forEach((item: any) => {
      lines.push(`  Function [${item.functionIndex}]:`);
      if (item.added.functions.length > 0) {
        lines.push(`    Functions: [${item.added.functions.join(', ')}]`);
      }
      if (item.added.imports.length > 0) {
        lines.push(`    Imports: [${item.added.imports.join(', ')}]`);
      }
      if (item.added.globals.length > 0) {
        lines.push(`    Globals: [${item.added.globals.join(', ')}]`);
      }
    });
    lines.push('');
  }
  
  if (comparison.removedDependencies.length > 0) {
    lines.push('Removed Dependencies:');
    comparison.removedDependencies.forEach((item: any) => {
      lines.push(`  Function [${item.functionIndex}]:`);
      if (item.removed.functions.length > 0) {
        lines.push(`    Functions: [${item.removed.functions.join(', ')}]`);
      }
      if (item.removed.imports.length > 0) {
        lines.push(`    Imports: [${item.removed.imports.join(', ')}]`);
      }
      if (item.removed.globals.length > 0) {
        lines.push(`    Globals: [${item.removed.globals.join(', ')}]`);
      }
    });
    lines.push('');
  }
  
  if (comparison.unchangedFunctions.length > 0) {
    lines.push(`Unchanged Functions (${comparison.unchangedFunctions.length}):`);
    lines.push(`  [${comparison.unchangedFunctions.join(', ')}]`);
    lines.push('');
  }
  
  return lines.join('\n');
}
