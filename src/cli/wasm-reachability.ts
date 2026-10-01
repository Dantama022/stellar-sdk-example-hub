import { Command } from 'commander';
import { readFileSync } from 'fs';
import { parse } from 'wasm-parser';
import { CallGraphBuilder } from '../analyzer/call-graph-builder';
import { ReachabilityAnalyzer, ReachabilityResult } from '../analyzer/reachability-analyzer';

export function setupWasmReachabilityCommand() {
  const program = new Command('wasm-reachability')
    .description('Analyze WASM function reachability from exported entry points')
    .argument('<wasmFile>', 'Path to WASM file')
    .option('-o, --output <format>', 'Output format (json|text)', 'text')
    .option('-r, --root <functionIndex>', 'Analyze from specific function index (comma-separated)', parseRoots)
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

        // Build call graph
        const builder = new CallGraphBuilder(wasmModule);
        const callGraph = builder.build();

        // Analyze reachability
        const analyzer = new ReachabilityAnalyzer(callGraph, options.root);
        const result = analyzer.analyze();

        // Output results
        if (options.output === 'json') {
          console.log(formatJsonOutput(result, callGraph));
        } else {
          console.log(formatTextOutput(result, callGraph));
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

function parseRoots(value: string): number[] {
  return value.split(',').map(v => parseInt(v.trim(), 10)).filter(n => !isNaN(n));
}

function formatJsonOutput(result: ReachabilityResult, callGraph: any): string {
  // Convert Map to object for JSON serialization
  const reachabilityMapObj: any = {};
  result.reachabilityMap.forEach((value, key) => {
    reachabilityMapObj[key] = {
      isReachable: value.isReachable,
      reachedFrom: value.reachedFrom,
      depth: value.depth
    };
  });

  return JSON.stringify({
    ...result,
    reachabilityMap: reachabilityMapObj
  }, null, 2);
}

function formatTextOutput(result: ReachabilityResult, callGraph: any): string {
  const lines: string[] = [];
  
  lines.push('=== WASM Function Reachability Analysis ===\n');
  
  // Statistics
  lines.push('Statistics:');
  lines.push(`  Total Functions: ${result.statistics.totalFunctions}`);
  lines.push(`  Reachable Functions: ${result.statistics.reachableFunctions}`);
  lines.push(`  Unreachable Functions: ${result.statistics.unreachableFunctions}`);
  lines.push(`  Average Depth: ${result.statistics.averageDepth.toFixed(2)}`);
  lines.push(`  Max Depth: ${result.statistics.maxDepth}`);
  lines.push('');
  
  // Root functions
  const rootFunctions: number[] = [];
  result.reachabilityMap.forEach((value, key) => {
    if (value.depth === 0) {
      rootFunctions.push(key);
    }
  });
  
  if (rootFunctions.length > 0) {
    lines.push('Root Functions (Entry Points):');
    rootFunctions.sort((a, b) => a - b).forEach(idx => {
      const node = callGraph.nodes.find((n: any) => n.index === idx);
      const name = node ? node.name : `func_${idx}`;
      const exportNames = node?.exportNames ? ` [${node.exportNames.join(', ')}]` : '';
      lines.push(`  [${idx}] ${name}${exportNames}`);
    });
    lines.push('');
  }
  
  // Roots with no outgoing calls
  if (result.rootsWithNoOutgoing.length > 0) {
    lines.push('Root Functions with No Outgoing Calls:');
    result.rootsWithNoOutgoing.forEach(idx => {
      const node = callGraph.nodes.find((n: any) => n.index === idx);
      const name = node ? node.name : `func_${idx}`;
      lines.push(`  [${idx}] ${name}`);
    });
    lines.push('');
  }
  
  // Reachable functions
  if (result.reachableFunctions.length > 0) {
    lines.push(`Reachable Functions (${result.reachableFunctions.length}):`);
    result.reachableFunctions.forEach(idx => {
      const node = callGraph.nodes.find((n: any) => n.index === idx);
      const name = node ? node.name : `func_${idx}`;
      const entry = result.reachabilityMap.get(idx);
      const depth = entry ? entry.depth : -1;
      const depthStr = depth >= 0 ? ` (depth: ${depth})` : '';
      lines.push(`  [${idx}] ${name}${depthStr}`);
    });
    lines.push('');
  }
  
  // Functions reachable from multiple roots
  if (result.reachableFromMultipleRoots.length > 0) {
    lines.push('Functions Reachable from Multiple Roots:');
    result.reachableFromMultipleRoots.forEach(item => {
      const node = callGraph.nodes.find((n: any) => n.index === item.functionIndex);
      const name = node ? node.name : `func_${item.functionIndex}`;
      lines.push(`  [${item.functionIndex}] ${name}`);
      lines.push(`    Reached from roots: [${item.roots.join(', ')}]`);
    });
    lines.push('');
  }
  
  // Unreachable functions
  if (result.unreachableFunctions.length > 0) {
    lines.push(`Unreachable Functions (${result.unreachableFunctions.length}):`);
    result.unreachableFunctions.forEach(idx => {
      const node = callGraph.nodes.find((n: any) => n.index === idx);
      const name = node ? node.name : `func_${idx}`;
      lines.push(`  [${idx}] ${name}`);
    });
    lines.push('');
  }
  
  return lines.join('\n');
}
