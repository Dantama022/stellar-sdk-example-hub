import { Command } from 'commander';
import * as fs from 'fs';
import { WasmNameAnalyzer, NameSectionAnalysis, ComparisonResult } from '../lib/wasm-name-analyzer';

interface CLIOptions {
  json: boolean;
  compare: string | undefined;
}

export function createWasmNamesCommand() {
  const command = new Command()
    .name('wasm-names')
    .description('Analyze WASM name section metadata in Soroban contracts')
    .argument('<wasmFile>', 'Path to WASM file')
    .option('-j, --json', 'Output in JSON format', false)
    .option('-c, --compare <wasmFile2>', 'Compare with another WASM file')
    .action(async (wasmFile: string, options: CLIOptions) => {
      try {
        const analyzer = new WasmNameAnalyzer();
        const wasmBuffer = fs.readFileSync(wasmFile);
        
        if (options.compare) {
          const compareBuffer = fs.readFileSync(options.compare);
          const result: ComparisonResult = analyzer.compareWasmModules(
            wasmBuffer,
            compareBuffer
          );
          
          if (options.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            printComparisonResult(result);
          }
        } else {
          const analysis: NameSectionAnalysis = analyzer.analyzeWasmModule(wasmBuffer);
          
          if (options.json) {
            console.log(JSON.stringify(analysis, null, 2));
          } else {
            printAnalysisResult(analysis);
          }
        }
      } catch (error) {
        console.error('Error:', error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  return command;
}

function printAnalysisResult(analysis: NameSectionAnalysis) {
  console.log('WASM Name Section Analysis');
  console.log('===========================');
  console.log(`Total functions: ${analysis.totalFunctions}`);
  console.log(`Named functions: ${analysis.namedFunctions.length}`);
  console.log(`Unnamed functions: ${analysis.unnamedFunctions.length}`);
  console.log(`Functions with local names: ${analysis.functionsWithLocals.length}`);
  console.log(`Total named locals: ${analysis.totalNamedLocals}`);
  
  if (analysis.namedFunctions.length > 0) {
    console.log('\nFunction Names:');
    analysis.namedFunctions.forEach(fn => {
      console.log(`  [${fn.index}] ${fn.name}`);
    });
  }
  
  if (analysis.unnamedFunctions.length > 0) {
    console.log('\nUnnamed Functions:');
    analysis.unnamedFunctions.forEach(index => {
      console.log(`  [${index}]`);
    });
  }
  
  if (analysis.functionLocals.length > 0) {
    console.log('\nLocal Names:');
    analysis.functionLocals.forEach(fnLocal => {
      console.log(`  Function [${fnLocal.functionIndex}]:`);
      fnLocal.locals.forEach(local => {
        console.log(`    [${local.index}] ${local.name}`);
      });
    });
  }
  
  if (analysis.functionsWithMostLocals.length > 0) {
    console.log('\nFunctions with Most Named Locals:');
    analysis.functionsWithMostLocals.forEach(fn => {
      console.log(`  [${fn.functionIndex}] ${fn.name || '(unnamed)'}: ${fn.localCount} locals`);
    });
  }
}

function printComparisonResult(result: ComparisonResult) {
  console.log('WASM Name Section Comparison');
  console.log('=============================');
  
  if (result.addedFunctionNames.length > 0) {
    console.log('\nAdded Function Names:');
    result.addedFunctionNames.forEach(fn => {
      console.log(`  [${fn.index}] ${fn.name}`);
    });
  }
  
  if (result.removedFunctionNames.length > 0) {
    console.log('\nRemoved Function Names:');
    result.removedFunctionNames.forEach(fn => {
      console.log(`  [${fn.index}] ${fn.name}`);
    });
  }
  
  if (result.renamedFunctions.length > 0) {
    console.log('\nRenamed Functions:');
    result.renamedFunctions.forEach(rename => {
      console.log(`  [${rename.index}] ${rename.oldName} -> ${rename.newName}`);
    });
  }
  
  if (result.addedLocalNames.length > 0) {
    console.log('\nAdded Local Names:');
    result.addedLocalNames.forEach(local => {
      console.log(`  Function [${local.functionIndex}], Local [${local.index}] ${local.name}`);
    });
  }
  
  if (result.removedLocalNames.length > 0) {
    console.log('\nRemoved Local Names:');
    result.removedLocalNames.forEach(local => {
      console.log(`  Function [${local.functionIndex}], Local [${local.index}] ${local.name}`);
    });
  }
  
  if (result.changedLocalNames.length > 0) {
    console.log('\nChanged Local Names:');
    result.changedLocalNames.forEach(change => {
      console.log(`  Function [${change.functionIndex}], Local [${change.index}] ${change.oldName} -> ${change.newName}`);
    });
  }
}